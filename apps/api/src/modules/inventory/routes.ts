import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  stockAdjustmentSchema,
  goodsReceiptSchema,
  stockCountSchema,
  stockTransferSchema,
  lowStockQuery,
  overrideSchema,
  uuid,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { stockAlerts, stockLevels, productVariants, products } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess, visibleStoreIds } from '../../auth/context.js';
import { requirePermissionOrOverride } from '../../auth/override.js';
import { writeAudit } from '../../core/audit.js';
import { notFound } from '../../core/errors.js';
import {
  adjustStock,
  receiveGoods,
  applyStockCount,
  transferStock,
  listLowStock,
  listOpenAlerts,
  listStockMovements,
  getStockLevels,
} from './service.js';

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/levels', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    const query = parseQuery(
      request,
      z.object({ storeId: uuid, variantIds: z.string().optional() }),
    );
    assertStoreAccess(request, query.storeId);
    const ids = query.variantIds?.split(',').filter(Boolean) ?? [];
    const levels = await getStockLevels(db, query.storeId, ids);
    return { levels: Object.fromEntries(levels) };
  });

  app.get('/low-stock', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    const query = parseQuery(request, lowStockQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    const storeIds = query.storeId ? [query.storeId] : visibleStoreIds(request);
    return { items: await listLowStock(storeIds, query.limit) };
  });

  app.get('/alerts', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    return { alerts: await listOpenAlerts(visibleStoreIds(request)) };
  });

  app.post('/alerts/:id/acknowledge', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, z.object({ id: uuid }));
    const [alert] = await db.select().from(stockAlerts).where(eq(stockAlerts.id, id)).limit(1);
    if (!alert) throw notFound('Alert');
    assertStoreAccess(request, alert.storeId);
    await db
      .update(stockAlerts)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: auth.userId })
      .where(eq(stockAlerts.id, id));
    return { ok: true };
  });

  app.get('/movements', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        variantId: uuid.optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    );
    return {
      movements: await listStockMovements({
        storeIds: visibleStoreIds(request),
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        limit: query.limit,
      }),
    };
  });

  /** Manual adjustments are the main shrinkage vector, so they need an override. */
  app.post('/adjust', { preHandler: requirePermissions('inventory:read') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, stockAdjustmentSchema.extend({ override: overrideSchema.optional() }));
    assertStoreAccess(request, input.storeId);

    const overrideBy = await requirePermissionOrOverride(request, 'inventory:adjust', input.override);

    const result = await adjustStock({
      storeId: input.storeId,
      variantId: input.variantId,
      quantityDelta: input.quantityDelta,
      reason: input.reason,
      note: input.note,
      unitCost: input.unitCost ?? null,
      performedBy: auth.userId,
    });

    await writeAudit(db, request, {
      action: 'STOCK_ADJUSTED',
      entityType: 'VARIANT',
      entityId: input.variantId,
      storeId: input.storeId,
      overrideByUserId: overrideBy,
      reason: input.note,
      changes: { delta: input.quantityDelta, balanceAfter: result.balanceAfter, reason: input.reason },
    });

    return result;
  });

  app.post('/receipts', { preHandler: requirePermissions('inventory:receive') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, goodsReceiptSchema);
    assertStoreAccess(request, input.storeId);

    const result = await receiveGoods({
      storeId: input.storeId,
      supplierName: input.supplierName,
      reference: input.reference,
      ...(input.receivedAt ? { receivedAt: new Date(input.receivedAt) } : {}),
      receivedBy: auth.userId,
      lines: input.lines,
    });

    await writeAudit(db, request, {
      action: 'GOODS_RECEIVED',
      entityType: 'GOODS_RECEIPT',
      entityId: result.receiptId,
      storeId: input.storeId,
      changes: { supplier: input.supplierName, lines: input.lines.length, totalCost: result.totalCost },
    });

    return reply.status(201).send(result);
  });

  app.post('/counts', { preHandler: requirePermissions('inventory:count') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, stockCountSchema);
    assertStoreAccess(request, input.storeId);

    const results = await applyStockCount({
      storeId: input.storeId,
      reference: input.reference,
      performedBy: auth.userId,
      lines: input.lines,
    });

    const changed = results.filter((r) => r.delta !== 0);
    await writeAudit(db, request, {
      action: 'STOCK_COUNTED',
      entityType: 'STOCK_COUNT',
      entityId: null,
      storeId: input.storeId,
      changes: { reference: input.reference, counted: results.length, adjusted: changed.length },
    });

    return { results, adjustedCount: changed.length };
  });

  app.post('/transfers', { preHandler: requirePermissions('inventory:transfer') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, stockTransferSchema);
    assertStoreAccess(request, input.fromStoreId);
    assertStoreAccess(request, input.toStoreId);

    await transferStock({
      fromStoreId: input.fromStoreId,
      toStoreId: input.toStoreId,
      reference: input.reference,
      performedBy: auth.userId,
      lines: input.lines,
    });

    await writeAudit(db, request, {
      action: 'STOCK_TRANSFERRED',
      entityType: 'TRANSFER',
      entityId: null,
      storeId: input.fromStoreId,
      changes: { to: input.toStoreId, reference: input.reference, lines: input.lines.length },
    });

    return reply.status(201).send({ ok: true });
  });
}
