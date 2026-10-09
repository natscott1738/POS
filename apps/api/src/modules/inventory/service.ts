import { and, eq, sql, inArray, desc, isNull } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client.js';
import {
  stockLevels,
  stockMovements,
  stockAlerts,
  productVariants,
  products,
  goodsReceipts,
  goodsReceiptLines,
} from '../../db/schema/index.js';
import { conflict } from '../../core/errors.js';
import type { StockMovementReason } from '@pos/shared';

export interface MovementInput {
  storeId: string;
  variantId: string;
  /** Signed, in thousandths of a unit. */
  quantityDelta: number;
  reason: StockMovementReason;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  unitCost?: number | null;
  performedBy?: string | null;
  occurredAt?: Date;
  /** Sales may drive stock negative rather than being refused; receipts may not. */
  allowNegative?: boolean;
}

export interface MovementResult {
  variantId: string;
  balanceAfter: number;
  wentNegative: boolean;
}

/**
 * The single writer for stock. Every change goes through here so the ledger and
 * the cached balance can never diverge: the row is locked, the movement is
 * appended, and the cache is updated inside one transaction.
 */
export async function applyStockMovement(tx: Tx, input: MovementInput): Promise<MovementResult> {
  // SELECT ... FOR UPDATE serialises concurrent sales of the same variant, which
  // is what stops two tills overselling the last unit.
  let [level] = await tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, input.variantId)))
    .limit(1)
    .for('update');

  if (!level) {
    await tx
      .insert(stockLevels)
      .values({ storeId: input.storeId, variantId: input.variantId, quantityOnHand: 0 })
      .onConflictDoNothing();
    [level] = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, input.variantId)))
      .limit(1)
      .for('update');
  }

  const current = level?.quantityOnHand ?? 0;
  const balanceAfter = current + input.quantityDelta;
  const wentNegative = balanceAfter < 0;

  if (wentNegative && !input.allowNegative) {
    throw conflict('Insufficient stock', {
      variantId: input.variantId,
      available: current,
      requested: Math.abs(input.quantityDelta),
    });
  }

  await tx.insert(stockMovements).values({
    storeId: input.storeId,
    variantId: input.variantId,
    quantityDelta: input.quantityDelta,
    balanceAfter,
    reason: input.reason,
    unitCost: input.unitCost ?? null,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    note: input.note ?? null,
    performedBy: input.performedBy ?? null,
    occurredAt: input.occurredAt ?? new Date(),
  });

  await tx
    .update(stockLevels)
    .set({ quantityOnHand: balanceAfter, updatedAt: new Date() })
    .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, input.variantId)));

  await refreshLowStockAlert(tx, input.storeId, input.variantId, balanceAfter);

  return { variantId: input.variantId, balanceAfter, wentNegative };
}

/**
 * Opens a low-stock alert when the balance crosses the reorder point and closes it
 * once stock recovers, so the alert list reflects reality without a sweep job.
 */
async function refreshLowStockAlert(
  tx: Tx,
  storeId: string,
  variantId: string,
  balance: number,
): Promise<void> {
  const [variant] = await tx
    .select({ reorderPoint: productVariants.reorderPoint })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!variant) return;
  const threshold = variant.reorderPoint;

  const [open] = await tx
    .select({ id: stockAlerts.id })
    .from(stockAlerts)
    .where(
      and(
        eq(stockAlerts.storeId, storeId),
        eq(stockAlerts.variantId, variantId),
        isNull(stockAlerts.resolvedAt),
      ),
    )
    .limit(1);

  const isLow = threshold > 0 && balance <= threshold;

  if (isLow && !open) {
    await tx
      .insert(stockAlerts)
      .values({
        storeId,
        variantId,
        kind: balance <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        quantityAtTrigger: balance,
        reorderPoint: threshold,
      })
      .onConflictDoNothing();
  } else if (!isLow && open) {
    await tx.update(stockAlerts).set({ resolvedAt: new Date() }).where(eq(stockAlerts.id, open.id));
  }
}

/** Reads current on-hand for a set of variants, for pre-flight checks at the till. */
export async function getStockLevels(
  exec: Executor,
  storeId: string,
  variantIds: string[],
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await exec
    .select({ variantId: stockLevels.variantId, quantityOnHand: stockLevels.quantityOnHand })
    .from(stockLevels)
    .where(and(eq(stockLevels.storeId, storeId), inArray(stockLevels.variantId, variantIds)));
  return new Map(rows.map((r) => [r.variantId, r.quantityOnHand]));
}

export async function adjustStock(input: MovementInput & { note: string }): Promise<MovementResult> {
  return db.transaction((tx) => applyStockMovement(tx, { ...input, allowNegative: false }));
}

/**
 * Receives goods and rolls the moving-average cost forward. Average cost matters
 * because it feeds COGS in QuickBooks and the stock valuation report.
 */
export async function receiveGoods(input: {
  storeId: string;
  supplierName: string;
  reference: string;
  receivedAt?: Date;
  receivedBy: string;
  lines: Array<{ variantId: string; quantity: number; unitCost: number }>;
}): Promise<{ receiptId: string; totalCost: number }> {
  return db.transaction(async (tx) => {
    const totalCost = input.lines.reduce((acc, l) => acc + Math.round((l.unitCost * l.quantity) / 1000), 0);

    const [receipt] = await tx
      .insert(goodsReceipts)
      .values({
        storeId: input.storeId,
        supplierName: input.supplierName,
        reference: input.reference,
        totalCost,
        receivedBy: input.receivedBy,
        receivedAt: input.receivedAt ?? new Date(),
      })
      .returning({ id: goodsReceipts.id });

    if (!receipt) throw conflict('Could not create goods receipt');

    for (const line of input.lines) {
      await tx.insert(goodsReceiptLines).values({
        receiptId: receipt.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitCost: line.unitCost,
      });

      const [level] = await tx
        .select()
        .from(stockLevels)
        .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, line.variantId)))
        .limit(1)
        .for('update');

      const onHand = level?.quantityOnHand ?? 0;
      const previousAvg = level?.averageCost ?? 0;
      const newQty = onHand + line.quantity;
      // Weighted average; when stock was zero or negative the incoming cost wins.
      const newAvg =
        newQty > 0 && onHand > 0
          ? Math.round((onHand * previousAvg + line.quantity * line.unitCost) / newQty)
          : line.unitCost;

      await applyStockMovement(tx, {
        storeId: input.storeId,
        variantId: line.variantId,
        quantityDelta: line.quantity,
        reason: 'PURCHASE_RECEIPT',
        unitCost: line.unitCost,
        referenceType: 'GOODS_RECEIPT',
        referenceId: receipt.id,
        performedBy: input.receivedBy,
        occurredAt: input.receivedAt ?? new Date(),
        allowNegative: true,
      });

      await tx
        .update(stockLevels)
        .set({ averageCost: newAvg })
        .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, line.variantId)));
    }

    return { receiptId: receipt.id, totalCost };
  });
}

/** Reconciles a physical count into the ledger as a single adjustment per variant. */
export async function applyStockCount(input: {
  storeId: string;
  reference: string;
  performedBy: string;
  lines: Array<{ variantId: string; countedQuantity: number }>;
}): Promise<Array<{ variantId: string; delta: number; balanceAfter: number }>> {
  return db.transaction(async (tx) => {
    const results: Array<{ variantId: string; delta: number; balanceAfter: number }> = [];
    for (const line of input.lines) {
      const [level] = await tx
        .select({ quantityOnHand: stockLevels.quantityOnHand })
        .from(stockLevels)
        .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, line.variantId)))
        .limit(1)
        .for('update');

      const current = level?.quantityOnHand ?? 0;
      const delta = line.countedQuantity - current;
      if (delta === 0) {
        results.push({ variantId: line.variantId, delta: 0, balanceAfter: current });
        continue;
      }

      const movement = await applyStockMovement(tx, {
        storeId: input.storeId,
        variantId: line.variantId,
        quantityDelta: delta,
        reason: 'STOCK_COUNT',
        referenceType: 'STOCK_COUNT',
        note: `Count ${input.reference}: system ${current}, counted ${line.countedQuantity}`,
        performedBy: input.performedBy,
        allowNegative: true,
      });

      await tx
        .update(stockLevels)
        .set({ lastCountedAt: new Date() })
        .where(and(eq(stockLevels.storeId, input.storeId), eq(stockLevels.variantId, line.variantId)));

      results.push({ variantId: line.variantId, delta, balanceAfter: movement.balanceAfter });
    }
    return results;
  });
}

export async function transferStock(input: {
  fromStoreId: string;
  toStoreId: string;
  reference: string;
  performedBy: string;
  lines: Array<{ variantId: string; quantity: number }>;
}): Promise<void> {
  await db.transaction(async (tx) => {
    for (const line of input.lines) {
      await applyStockMovement(tx, {
        storeId: input.fromStoreId,
        variantId: line.variantId,
        quantityDelta: -line.quantity,
        reason: 'TRANSFER_OUT',
        referenceType: 'TRANSFER',
        note: input.reference,
        performedBy: input.performedBy,
        allowNegative: false,
      });
      await applyStockMovement(tx, {
        storeId: input.toStoreId,
        variantId: line.variantId,
        quantityDelta: line.quantity,
        reason: 'TRANSFER_IN',
        referenceType: 'TRANSFER',
        note: input.reference,
        performedBy: input.performedBy,
        allowNegative: true,
      });
    }
  });
}

export async function listLowStock(storeIds: string[] | null, limit: number) {
  const conditions = [
    sql`${stockLevels.quantityOnHand} <= ${productVariants.reorderPoint}`,
    sql`${productVariants.reorderPoint} > 0`,
    eq(productVariants.isActive, true),
  ];
  if (storeIds) conditions.push(inArray(stockLevels.storeId, storeIds));

  return db
    .select({
      storeId: stockLevels.storeId,
      variantId: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      productName: products.name,
      attributes: productVariants.attributes,
      quantityOnHand: stockLevels.quantityOnHand,
      reorderPoint: productVariants.reorderPoint,
      reorderQuantity: productVariants.reorderQuantity,
      unitPrice: productVariants.unitPrice,
      averageCost: stockLevels.averageCost,
    })
    .from(stockLevels)
    .innerJoin(productVariants, eq(productVariants.id, stockLevels.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions))
    .orderBy(sql`${stockLevels.quantityOnHand} - ${productVariants.reorderPoint} ASC`)
    .limit(limit);
}

export async function listOpenAlerts(storeIds: string[] | null, limit = 200) {
  const conditions = [isNull(stockAlerts.resolvedAt)];
  if (storeIds) conditions.push(inArray(stockAlerts.storeId, storeIds));
  return db
    .select({
      id: stockAlerts.id,
      storeId: stockAlerts.storeId,
      variantId: stockAlerts.variantId,
      kind: stockAlerts.kind,
      quantityAtTrigger: stockAlerts.quantityAtTrigger,
      reorderPoint: stockAlerts.reorderPoint,
      acknowledgedAt: stockAlerts.acknowledgedAt,
      createdAt: stockAlerts.createdAt,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(stockAlerts)
    .innerJoin(productVariants, eq(productVariants.id, stockAlerts.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions))
    .orderBy(desc(stockAlerts.createdAt))
    .limit(limit);
}

export async function listStockMovements(filters: {
  storeIds: string[] | null;
  variantId?: string;
  from?: Date;
  to?: Date;
  limit: number;
}) {
  const conditions = [];
  if (filters.storeIds) conditions.push(inArray(stockMovements.storeId, filters.storeIds));
  if (filters.variantId) conditions.push(eq(stockMovements.variantId, filters.variantId));
  if (filters.from) conditions.push(sql`${stockMovements.occurredAt} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${stockMovements.occurredAt} <= ${filters.to}`);

  return db
    .select({
      id: stockMovements.id,
      storeId: stockMovements.storeId,
      variantId: stockMovements.variantId,
      sku: productVariants.sku,
      productName: products.name,
      quantityDelta: stockMovements.quantityDelta,
      balanceAfter: stockMovements.balanceAfter,
      reason: stockMovements.reason,
      referenceType: stockMovements.referenceType,
      referenceId: stockMovements.referenceId,
      note: stockMovements.note,
      occurredAt: stockMovements.occurredAt,
    })
    .from(stockMovements)
    .innerJoin(productVariants, eq(productVariants.id, stockMovements.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(conditions.length > 0 ? and(...conditions) : sql`true`)
    .orderBy(desc(stockMovements.occurredAt))
    .limit(filters.limit);
}
