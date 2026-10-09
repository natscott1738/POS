import { and, eq, gt, sql, inArray, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { SyncOperation, SyncOperationResult, SyncPushInput } from '@pos/shared';
import { db, type Tx } from '../../db/client.js';
import {
  syncDevices,
  syncBatches,
  changeLog,
  sales,
  refunds,
  shifts,
  customers,
  idempotencyKeys,
  productVariants,
  products,
  stockLevels,
} from '../../db/schema/index.js';
import { createSale } from '../sales/service.js';
import { createRefund, voidSale } from '../sales/refunds.js';
import { applyStockMovement } from '../inventory/service.js';
import { AppError } from '../../core/errors.js';
import { forbidden, notFound } from '../../core/errors.js';
import { stableStringify } from '../../core/idempotency.js';
import { sha256Hex } from '../../core/crypto.js';
import type { AuthContext } from '../../auth/context.js';

/**
 * Applies a batch of operations recorded while a till was offline.
 *
 * Design rules that make this safe:
 *  - Each operation is applied in its OWN transaction, so one bad record cannot
 *    block the rest of the day's takings from syncing.
 *  - Each operation is keyed by a client-minted opId recorded in idempotency_keys,
 *    so replaying the whole batch after a dropped connection changes nothing.
 *  - Rejections are reported per operation rather than failing the batch, and the
 *    till keeps them locally for a human to resolve.
 */
export async function applySyncBatch(
  request: FastifyRequest,
  input: SyncPushInput,
  auth: AuthContext,
): Promise<{ results: SyncOperationResult[]; batchId: string | null; serverTime: string }> {
  const [device] = await db
    .select()
    .from(syncDevices)
    .where(eq(syncDevices.deviceId, input.deviceId))
    .limit(1);

  if (!device) throw notFound('Device');
  if (device.revokedAt) throw forbidden('This device has been revoked');
  if (device.storeId !== input.storeId) throw forbidden('Device is registered to another store');
  if (auth.role !== 'ADMIN' && !auth.storeIds.includes(input.storeId)) {
    throw forbidden('You do not have access to that store');
  }

  // A batch we have already fully processed is answered from its stored results.
  const [seen] = await db
    .select()
    .from(syncBatches)
    .where(and(eq(syncBatches.deviceId, input.deviceId), eq(syncBatches.batchSequence, input.batchSequence)))
    .limit(1);

  if (seen?.results) {
    return {
      results: seen.results as SyncOperationResult[],
      batchId: seen.id,
      serverTime: new Date().toISOString(),
    };
  }

  const results: SyncOperationResult[] = [];

  for (const operation of input.operations) {
    try {
      results.push(await applyOperation(request, operation, auth, input));
    } catch (err) {
      // A single failed operation is reported and the batch continues.
      const appError = err instanceof AppError ? err : null;
      request.log.warn(
        { err, opId: operation.opId, type: operation.type },
        'sync operation rejected',
      );
      results.push({
        opId: operation.opId,
        status: 'REJECTED',
        serverId: null,
        error: {
          code: appError?.code ?? 'INTERNAL',
          message: appError?.message ?? 'Could not apply this operation',
        },
      });
    }
  }

  const applied = results.filter((r) => r.status === 'APPLIED').length;
  const duplicates = results.filter((r) => r.status === 'DUPLICATE').length;
  const rejected = results.filter((r) => r.status === 'REJECTED').length;

  const [batch] = await db
    .insert(syncBatches)
    .values({
      deviceId: input.deviceId,
      storeId: input.storeId,
      batchSequence: input.batchSequence,
      operationCount: input.operations.length,
      appliedCount: applied,
      duplicateCount: duplicates,
      rejectedCount: rejected,
      results: results as never,
    })
    .onConflictDoNothing()
    .returning({ id: syncBatches.id });

  await db
    .update(syncDevices)
    .set({
      lastBatchSequence: sql`GREATEST(${syncDevices.lastBatchSequence}, ${input.batchSequence})`,
      lastPushAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncDevices.deviceId, input.deviceId));

  return { results, batchId: batch?.id ?? null, serverTime: new Date().toISOString() };
}

async function applyOperation(
  request: FastifyRequest,
  operation: SyncOperation,
  auth: AuthContext,
  batch: SyncPushInput,
): Promise<SyncOperationResult> {
  const scope = `sync:${operation.type}`;
  const requestHash = sha256Hex(stableStringify(operation.payload));

  // Fast path: this exact operation was already applied on an earlier attempt.
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, operation.opId)))
    .limit(1);

  if (existing?.status === 'COMPLETED') {
    const body = existing.responseBody as { receiptNumber?: string } | null;
    return {
      opId: operation.opId,
      status: 'DUPLICATE',
      serverId: existing.resourceId,
      receiptNumber: body?.receiptNumber ?? null,
    };
  }

  return db.transaction(async (tx) => {
    const outcome = await dispatch(tx, request, operation, auth, batch);

    await tx
      .insert(idempotencyKeys)
      .values({
        key: operation.opId,
        scope,
        requestHash,
        status: 'COMPLETED',
        responseStatus: 200,
        responseBody: outcome as never,
        resourceId: outcome.serverId,
        userId: auth.userId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      })
      .onConflictDoNothing();

    return outcome;
  });
}

async function dispatch(
  tx: Tx,
  request: FastifyRequest,
  operation: SyncOperation,
  auth: AuthContext,
  batch: SyncPushInput,
): Promise<SyncOperationResult> {
  switch (operation.type) {
    case 'SALE_CREATE': {
      const result = await createSale(tx, operation.payload, {
        request,
        cashierId: auth.userId,
        permissions: auth.permissions,
        offline: true,
      });
      return {
        opId: operation.opId,
        status: 'APPLIED',
        serverId: result.saleId,
        receiptNumber: result.receiptNumber,
      };
    }

    case 'REFUND_CREATE': {
      const result = await createRefund(tx, operation.payload, {
        request,
        processedBy: auth.userId,
        offline: true,
      });
      return {
        opId: operation.opId,
        status: 'APPLIED',
        serverId: result.refundId,
        receiptNumber: result.refundNumber,
      };
    }

    case 'SALE_VOID': {
      // An offline void may reference a sale that only exists by its client id.
      const saleId = operation.payload.saleId ?? (await resolveSaleId(tx, operation.payload.clientSaleId));
      if (!saleId) throw notFound('Sale');
      const result = await voidSale(tx, saleId, operation.payload.reason, {
        request,
        processedBy: auth.userId,
        offline: true,
      });
      return { opId: operation.opId, status: 'APPLIED', serverId: result.saleId };
    }

    case 'CUSTOMER_CREATE': {
      const payload = operation.payload;
      const [customer] = await tx
        .insert(customers)
        .values({
          clientCustomerId: payload.clientCustomerId,
          fullName: payload.fullName,
          phone: payload.phone ?? null,
          email: payload.email ?? null,
          taxPin: payload.taxPin?.toUpperCase() ?? null,
          address: payload.address ?? null,
          notes: payload.notes ?? null,
          marketingConsent: payload.marketingConsent,
          marketingConsentAt: payload.marketingConsent ? new Date(operation.occurredAt) : null,
          creditLimit: payload.creditLimit,
          createdBy: auth.userId,
        })
        // A customer captured on two tills offline resolves to one record.
        .onConflictDoNothing({ target: customers.clientCustomerId })
        .returning({ id: customers.id });

      const resolved =
        customer?.id ??
        (
          await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.clientCustomerId, payload.clientCustomerId))
            .limit(1)
        )[0]?.id ??
        null;

      return { opId: operation.opId, status: customer ? 'APPLIED' : 'DUPLICATE', serverId: resolved };
    }

    case 'STOCK_ADJUST': {
      const payload = operation.payload;
      if (!auth.permissions.has('inventory:adjust')) throw forbidden('You may not adjust stock');
      const result = await applyStockMovement(tx, {
        storeId: payload.storeId,
        variantId: payload.variantId,
        quantityDelta: payload.quantityDelta,
        reason: payload.reason,
        note: payload.note,
        unitCost: payload.unitCost ?? null,
        performedBy: auth.userId,
        occurredAt: new Date(operation.occurredAt),
        allowNegative: true,
      });
      return { opId: operation.opId, status: 'APPLIED', serverId: result.variantId };
    }

    case 'SHIFT_OPEN': {
      const payload = operation.payload;
      const [shift] = await tx
        .insert(shifts)
        .values({
          clientShiftId: payload.clientShiftId,
          storeId: payload.storeId,
          terminalId: payload.terminalId,
          cashierId: auth.userId,
          openingFloat: payload.openingFloat,
          note: payload.note ?? null,
          openedAt: new Date(operation.occurredAt),
        })
        .onConflictDoNothing({ target: shifts.clientShiftId })
        .returning({ id: shifts.id });
      return { opId: operation.opId, status: shift ? 'APPLIED' : 'DUPLICATE', serverId: shift?.id ?? null };
    }

    case 'SHIFT_CLOSE': {
      const payload = operation.payload;
      const [shift] = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.clientShiftId, payload.clientShiftId))
        .limit(1);
      if (!shift) throw notFound('Shift');
      if (shift.status !== 'OPEN') {
        return { opId: operation.opId, status: 'DUPLICATE', serverId: shift.id };
      }
      await tx
        .update(shifts)
        .set({
          status: 'CLOSED',
          countedCash: payload.countedCash,
          denominations: payload.denominations ?? null,
          note: payload.note ?? shift.note,
          closedAt: new Date(operation.occurredAt),
          closedBy: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(shifts.id, shift.id));
      return { opId: operation.opId, status: 'APPLIED', serverId: shift.id };
    }

    default: {
      // Exhaustiveness guard: a new operation type must be handled explicitly.
      const never: never = operation;
      throw new Error(`Unhandled sync operation: ${JSON.stringify(never)}`);
    }
  }
}

async function resolveSaleId(tx: Tx, clientSaleId?: string): Promise<string | null> {
  if (!clientSaleId) return null;
  const [sale] = await tx.select({ id: sales.id }).from(sales).where(eq(sales.clientSaleId, clientSaleId)).limit(1);
  return sale?.id ?? null;
}

/**
 * Delta pull. Returns the catalogue and stock changes a till needs to keep working
 * offline, plus a cursor. Bounded by `limit` so a till that has been off for weeks
 * catches up in pages rather than one enormous response.
 */
export async function pullChanges(input: {
  deviceId: string;
  storeId: string;
  cursor?: string;
  limit: number;
}): Promise<{
  cursor: string;
  hasMore: boolean;
  products: unknown[];
  stock: unknown[];
  serverTime: string;
}> {
  const since = input.cursor ? Number(input.cursor) : 0;
  const from = Number.isFinite(since) ? since : 0;

  const changes = await db
    .select()
    .from(changeLog)
    .where(
      and(
        gt(changeLog.id, from),
        sql`(${changeLog.storeId} IS NULL OR ${changeLog.storeId} = ${input.storeId})`,
      ),
    )
    .orderBy(changeLog.id)
    .limit(input.limit);

  const productIds = [
    ...new Set(
      changes
        .filter((c) => c.entityType === 'PRODUCT' || c.entityType === 'VARIANT')
        .map((c) => c.entityId),
    ),
  ];

  const changedProducts = productIds.length
    ? await db
        .select({
          id: products.id,
          name: products.name,
          categoryId: products.categoryId,
          taxRateBasisPoints: products.taxRateBasisPoints,
          taxCode: products.taxCode,
          unitOfMeasure: products.unitOfMeasure,
          trackInventory: products.trackInventory,
          isActive: products.isActive,
          deletedAt: products.deletedAt,
          variantId: productVariants.id,
          sku: productVariants.sku,
          barcode: productVariants.barcode,
          attributes: productVariants.attributes,
          unitPrice: productVariants.unitPrice,
          variantActive: productVariants.isActive,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          sql`${products.id} IN ${productIds} OR ${productVariants.id} IN ${productIds}`,
        )
    : [];

  const stock = await db
    .select({
      variantId: stockLevels.variantId,
      quantityOnHand: stockLevels.quantityOnHand,
      updatedAt: stockLevels.updatedAt,
    })
    .from(stockLevels)
    .where(eq(stockLevels.storeId, input.storeId))
    .limit(5000);

  const last = changes[changes.length - 1];
  const nextCursor = last ? String(last.id) : String(from);

  await db
    .update(syncDevices)
    .set({ lastPullAt: new Date(), lastPulledChangeId: nextCursor, updatedAt: new Date() })
    .where(eq(syncDevices.deviceId, input.deviceId));

  return {
    cursor: nextCursor,
    hasMore: changes.length === input.limit,
    products: changedProducts,
    stock,
    serverTime: new Date().toISOString(),
  };
}

/** Full catalogue snapshot for a till being set up or re-seeded from scratch. */
export async function bootstrapSnapshot(storeId: string) {
  const [catalogue, stock, cursorRow] = await Promise.all([
    db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        name: products.name,
        sku: productVariants.sku,
        barcode: productVariants.barcode,
        attributes: productVariants.attributes,
        unitPrice: productVariants.unitPrice,
        taxRateBasisPoints: products.taxRateBasisPoints,
        taxCode: products.taxCode,
        unitOfMeasure: products.unitOfMeasure,
        trackInventory: products.trackInventory,
        categoryId: products.categoryId,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(products.isActive, true),
          eq(productVariants.isActive, true),
          isNull(products.deletedAt),
          isNull(productVariants.deletedAt),
        ),
      ),
    db
      .select({ variantId: stockLevels.variantId, quantityOnHand: stockLevels.quantityOnHand })
      .from(stockLevels)
      .where(eq(stockLevels.storeId, storeId)),
    db.select({ id: sql<number>`COALESCE(MAX(${changeLog.id}), 0)`.as('id') }).from(changeLog),
  ]);

  return {
    catalogue,
    stock,
    cursor: String(cursorRow[0]?.id ?? 0),
    serverTime: new Date().toISOString(),
  };
}
