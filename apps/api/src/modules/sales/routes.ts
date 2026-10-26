import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createSaleSchema,
  createRefundSchema,
  voidSaleSchema,
  saleSearchQuery,
  openShiftSchema,
  closeShiftSchema,
  overrideSchema,
  uuid,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { sales, saleLines, payments, refunds, refundLines, shifts, stores, customers, users, creditTransactions } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess, visibleStoreIds } from '../../auth/context.js';
import { requirePermissionOrOverride } from '../../auth/override.js';
import { withIdempotency } from '../../core/idempotency.js';
import { conflict, notFound, shiftRequired } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { createSale } from './service.js';
import { createRefund, voidSale } from './refunds.js';

const idParam = z.object({ id: uuid });

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Creates a sale. Keyed on the till-generated clientSaleId so a retry after a
   * timeout returns the original receipt rather than charging the customer twice.
   */
  app.post('/', { preHandler: requirePermissions('sale:create') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, createSaleSchema);
    assertStoreAccess(request, input.storeId);

    const { result, replayed } = await withIdempotency(
      { scope: 'sale:create', key: input.clientSaleId, request: input, userId: auth.userId },
      async (tx) => {
        const outcome = await createSale(tx, input, {
          request,
          cashierId: auth.userId,
          permissions: auth.permissions,
          offline: false,
        });
        return { result: outcome, resourceId: outcome.saleId };
      },
    );

    return reply.status(replayed ? 200 : 201).send({ ...result, replayed });
  });

  app.get('/', { preHandler: requirePermissions('sale:read') }, async (request) => {
    const query = parseQuery(request, saleSearchQuery);
    const allowed = visibleStoreIds(request);

    const conditions = [];
    if (query.storeId) {
      assertStoreAccess(request, query.storeId);
      conditions.push(eq(sales.storeId, query.storeId));
    } else if (allowed) {
      if (allowed.length === 0) return { sales: [], nextCursor: null };
      conditions.push(inArray(sales.storeId, allowed));
    }
    if (query.terminalId) conditions.push(eq(sales.terminalId, query.terminalId));
    if (query.cashierId) conditions.push(eq(sales.cashierId, query.cashierId));
    if (query.customerId) conditions.push(eq(sales.customerId, query.customerId));
    if (query.receiptNumber) conditions.push(eq(sales.receiptNumber, query.receiptNumber));
    if (query.status) conditions.push(sql`${sales.status}::text = ${query.status}`);
    if (query.from) conditions.push(gte(sales.soldAt, new Date(query.from)));
    if (query.to) conditions.push(lte(sales.soldAt, new Date(query.to)));
    // Keyset pagination: stable under concurrent inserts, unlike OFFSET.
    if (query.cursor) conditions.push(sql`${sales.soldAt} < ${new Date(query.cursor)}`);

    const rows = await db
      .select({
        id: sales.id,
        receiptNumber: sales.receiptNumber,
        storeId: sales.storeId,
        status: sales.status,
        total: sales.total,
        taxTotal: sales.taxTotal,
        amountRefunded: sales.amountRefunded,
        customerId: sales.customerId,
        cashierId: sales.cashierId,
        cashierName: users.fullName,
        soldAt: sales.soldAt,
        createdOffline: sales.createdOffline,
        oversold: sales.oversold,
      })
      .from(sales)
      .leftJoin(users, eq(users.id, sales.cashierId))
      .where(conditions.length > 0 ? and(...conditions) : sql`true`)
      .orderBy(desc(sales.soldAt))
      .limit(query.limit);

    const last = rows[rows.length - 1];
    return {
      sales: rows,
      nextCursor: rows.length === query.limit && last ? last.soldAt.toISOString() : null,
    };
  });

  /** Full sale detail, used by receipt reprint and the refund screen. */
  app.get('/:id', { preHandler: requirePermissions('sale:read') }, async (request) => {
    const { id } = parseParams(request, idParam);

    const [sale] = await db.select().from(sales).where(eq(sales.id, id)).limit(1);
    if (!sale) throw notFound('Sale');
    assertStoreAccess(request, sale.storeId);

    const [lines, tenders, saleRefunds, store, cashier] = await Promise.all([
      db.select().from(saleLines).where(eq(saleLines.saleId, id)).orderBy(saleLines.lineNumber),
      db.select().from(payments).where(eq(payments.saleId, id)),
      db.select().from(refunds).where(eq(refunds.saleId, id)).orderBy(desc(refunds.refundedAt)),
      db.select().from(stores).where(eq(stores.id, sale.storeId)).limit(1),
      db.select({ fullName: users.fullName }).from(users).where(eq(users.id, sale.cashierId)).limit(1),
    ]);

    const customer = sale.customerId
      ? (await db.select().from(customers).where(eq(customers.id, sale.customerId)).limit(1))[0]
      : null;

    return {
      sale,
      lines,
      payments: tenders,
      refunds: saleRefunds,
      store: store[0] ?? null,
      cashierName: cashier[0]?.fullName ?? null,
      customer: customer ?? null,
    };
  });

  /** Look up a sale by receipt number: what a cashier actually has in hand. */
  app.get('/by-receipt/:receiptNumber', { preHandler: requirePermissions('sale:read') }, async (request) => {
    const { receiptNumber } = parseParams(request, z.object({ receiptNumber: z.string().trim().max(40) }));
    const [sale] = await db.select().from(sales).where(eq(sales.receiptNumber, receiptNumber)).limit(1);
    if (!sale) throw notFound('Sale');
    assertStoreAccess(request, sale.storeId);
    const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
    return { sale, lines };
  });

  app.post('/:id/void', { preHandler: requirePermissions('sale:read') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const input = parseBody(request, voidSaleSchema.extend({ override: overrideSchema.optional() }));

    const [sale] = await db.select().from(sales).where(eq(sales.id, id)).limit(1);
    if (!sale) throw notFound('Sale');
    assertStoreAccess(request, sale.storeId);

    // A cashier may initiate a void, but only a manager's credentials authorise it.
    const overrideBy = await requirePermissionOrOverride(request, 'sale:void', input.override);

    return db.transaction((tx) =>
      voidSale(tx, id, input.reason, {
        request,
        processedBy: auth.userId,
        overrideByUserId: overrideBy,
      }),
    );
  });

  app.post('/refunds', { preHandler: requirePermissions('sale:read') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, createRefundSchema.extend({ override: overrideSchema.optional() }));

    const [sale] = await db.select().from(sales).where(eq(sales.id, input.saleId)).limit(1);
    if (!sale) throw notFound('Sale');
    assertStoreAccess(request, sale.storeId);

    const overrideBy = await requirePermissionOrOverride(request, 'sale:refund', input.override);

    const { result, replayed } = await withIdempotency(
      { scope: 'refund:create', key: input.clientRefundId, request: input, userId: auth.userId },
      async (tx) => {
        const outcome = await createRefund(tx, input, {
          request,
          processedBy: auth.userId,
          overrideByUserId: overrideBy,
        });
        return { result: outcome, resourceId: outcome.refundId };
      },
    );

    return reply.status(replayed ? 200 : 201).send({ ...result, replayed });
  });

  app.get('/refunds/:id', { preHandler: requirePermissions('sale:read') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const [refund] = await db.select().from(refunds).where(eq(refunds.id, id)).limit(1);
    if (!refund) throw notFound('Refund');
    assertStoreAccess(request, refund.storeId);
    const lines = await db.select().from(refundLines).where(eq(refundLines.refundId, id));
    return { refund, lines };
  });
}

/* ---------------------------------- Shifts --------------------------------- */

export async function shiftRoutes(app: FastifyInstance): Promise<void> {
  app.post('/open', { preHandler: requirePermissions('shift:open') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, openShiftSchema);
    assertStoreAccess(request, input.storeId);

    // One open shift per terminal keeps cash accountability unambiguous.
    const [existing] = await db
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.terminalId, input.terminalId), eq(shifts.status, 'OPEN')))
      .limit(1);
    if (existing) throw conflict('This till already has an open shift');

    const [shift] = await db
      .insert(shifts)
      .values({
        storeId: input.storeId,
        terminalId: input.terminalId,
        cashierId: auth.userId,
        openingFloat: input.openingFloat,
        note: input.note ?? null,
      })
      .returning();

    await writeAudit(db, request, {
      action: 'SHIFT_OPENED',
      entityType: 'SHIFT',
      entityId: shift?.id ?? null,
      storeId: input.storeId,
      terminalId: input.terminalId,
      changes: { openingFloat: input.openingFloat },
    });

    return reply.status(201).send({ shift });
  });

  app.get('/current', { preHandler: requirePermissions('shift:read:own') }, async (request) => {
    const auth = getAuth(request);
    const terminalId = (request.query as { terminalId?: string }).terminalId ?? auth.terminalId;
    if (!terminalId) throw shiftRequired();

    const [shift] = await db
      .select()
      .from(shifts)
      .where(and(eq(shifts.terminalId, terminalId), eq(shifts.status, 'OPEN')))
      .limit(1);

    if (!shift) return { shift: null, summary: null };
    return { shift, summary: await shiftSummary(shift.id) };
  });

  /**
   * Closes a shift and computes the cash variance. Expected cash is derived from
   * the payments ledger rather than trusted from the client.
   */
  app.post('/:id/close', { preHandler: requirePermissions('shift:close') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const input = parseBody(request, closeShiftSchema);

    const [shift] = await db.select().from(shifts).where(eq(shifts.id, id)).limit(1);
    if (!shift) throw notFound('Shift');
    assertStoreAccess(request, shift.storeId);
    if (shift.status !== 'OPEN') throw conflict('That shift is already closed');
    if (shift.cashierId !== auth.userId && !auth.permissions.has('shift:read:all')) {
      throw conflict('Only the cashier who opened this shift, or a manager, may close it');
    }

    const summary = await shiftSummary(id);
    const expectedCash = shift.openingFloat + summary.cashNet;
    const variance = input.countedCash - expectedCash;

    const [updated] = await db
      .update(shifts)
      .set({
        status: 'CLOSED',
        countedCash: input.countedCash,
        expectedCash,
        cashVariance: variance,
        denominations: input.denominations ?? null,
        closedAt: new Date(),
        closedBy: auth.userId,
        note: input.note ?? shift.note,
        updatedAt: new Date(),
      })
      .where(eq(shifts.id, id))
      .returning();

    await writeAudit(db, request, {
      action: 'SHIFT_CLOSED',
      entityType: 'SHIFT',
      entityId: id,
      storeId: shift.storeId,
      terminalId: shift.terminalId,
      changes: { expectedCash, countedCash: input.countedCash, variance },
    });

    return { shift: updated, summary: { ...summary, expectedCash, variance } };
  });

  app.get('/:id', { preHandler: requirePermissions('shift:read:own') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const [shift] = await db.select().from(shifts).where(eq(shifts.id, id)).limit(1);
    if (!shift) throw notFound('Shift');
    assertStoreAccess(request, shift.storeId);
    if (shift.cashierId !== auth.userId && !auth.permissions.has('shift:read:all')) {
      throw notFound('Shift');
    }
    return { shift, summary: await shiftSummary(id) };
  });
}

/** Per-shift takings by tender, derived from the payments ledger. */
export async function shiftSummary(shiftId: string) {
  const byMethod = await db
    .select({
      method: payments.method,
      total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::bigint`.as('total'),
      count: sql<number>`COUNT(*)::int`.as('count'),
    })
    .from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId))
    .where(and(eq(sales.shiftId, shiftId), sql`${payments.status} <> 'REVERSED'`))
    .groupBy(payments.method);

  const creditCash = await db.select({
    total: sql<number>`COALESCE(SUM(-${creditTransactions.amount}), 0)::bigint`.as('total'),
    count: sql<number>`COUNT(*)::int`.as('count'),
  }).from(creditTransactions)
    .where(and(
      eq(creditTransactions.shiftId, shiftId),
      eq(creditTransactions.type, 'PAYMENT'),
      eq(creditTransactions.paymentMethod, 'CASH'),
    ));

  const [totals] = await db
    .select({
      saleCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} <> 'VOIDED')::int`.as('saleCount'),
      voidCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} = 'VOIDED')::int`.as('voidCount'),
      grossSales: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('grossSales'),
      taxTotal: sql<number>`COALESCE(SUM(${sales.taxTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('taxTotal'),
      discountTotal: sql<number>`COALESCE(SUM(${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('discountTotal'),
      refundTotal: sql<number>`COALESCE(SUM(${sales.amountRefunded}), 0)::bigint`.as('refundTotal'),
      changeGiven: sql<number>`COALESCE(SUM(${sales.changeGiven}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('changeGiven'),
    })
    .from(sales)
    .where(eq(sales.shiftId, shiftId));

  const tenders = byMethod.map((row) => ({
    method: row.method,
    total: Number(row.total),
    count: row.count,
  }));
  const cashTender = tenders.find((tender) => tender.method === 'CASH');
  if (Number(creditCash[0]?.count ?? 0) > 0) {
    if (cashTender) {
      cashTender.total += Number(creditCash[0]?.total ?? 0);
      cashTender.count += Number(creditCash[0]?.count ?? 0);
    } else {
      tenders.push({ method: 'CASH', total: Number(creditCash[0]?.total ?? 0), count: Number(creditCash[0]?.count ?? 0) });
    }
  }

  return {
    tenders,
    // Cash the drawer should physically hold, net of refunds and change given.
    cashNet: tenders.find((t) => t.method === 'CASH')?.total ?? 0,
    saleCount: totals?.saleCount ?? 0,
    voidCount: totals?.voidCount ?? 0,
    grossSales: Number(totals?.grossSales ?? 0),
    taxTotal: Number(totals?.taxTotal ?? 0),
    discountTotal: Number(totals?.discountTotal ?? 0),
    refundTotal: Number(totals?.refundTotal ?? 0),
    changeGiven: Number(totals?.changeGiven ?? 0),
  };
}
