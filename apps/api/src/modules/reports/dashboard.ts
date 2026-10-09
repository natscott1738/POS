import { and, eq, gte, inArray, lte, sql, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sales, payments, saleLines, stockAlerts, shifts, users, qbSyncQueue } from '../../db/schema/index.js';

/**
 * The owner's landing view: what happened today, what needs attention now.
 * One round trip rather than six, because this is polled while the shop trades.
 */
export async function dashboard(storeIds: string[] | null, storeId?: string) {
  // "Today" means the trading day in Nairobi, not UTC midnight.
  const scope = storeId
    ? eq(sales.storeId, storeId)
    : storeIds
      ? inArray(sales.storeId, storeIds)
      : sql`true`;

  const startOfToday = sql`date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'`;
  const startOfYesterday = sql`${startOfToday} - interval '1 day'`;

  const [today] = await db
    .select({
      saleCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} <> 'VOIDED')::int`.as('saleCount'),
      gross: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('gross'),
      tax: sql<number>`COALESCE(SUM(${sales.taxTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('tax'),
      discounts: sql<number>`COALESCE(SUM(${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('discounts'),
      refunds: sql<number>`COALESCE(SUM(${sales.amountRefunded}), 0)::bigint`.as('refunds'),
      voids: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} = 'VOIDED')::int`.as('voids'),
      basket: sql<number>`COALESCE(ROUND(AVG(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED')), 0)::bigint`.as('basket'),
    })
    .from(sales)
    .where(and(scope, gte(sales.soldAt, startOfToday)));

  const [yesterday] = await db
    .select({
      gross: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('gross'),
    })
    .from(sales)
    .where(and(scope, gte(sales.soldAt, startOfYesterday), lte(sales.soldAt, startOfToday)));

  const tenders = await db
    .select({
      method: payments.method,
      total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::bigint`.as('total'),
    })
    .from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId))
    .where(and(scope, gte(sales.soldAt, startOfToday), sql`${payments.status} <> 'REVERSED'`))
    .groupBy(payments.method);

  const topSellers = await db
    .select({
      sku: saleLines.variantSku,
      productName: saleLines.productName,
      quantity: sql<number>`COALESCE(SUM(${saleLines.quantity}), 0)::bigint`.as('quantity'),
      revenue: sql<number>`COALESCE(SUM(${saleLines.lineTotal}), 0)::bigint`.as('revenue'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(and(scope, gte(sales.soldAt, startOfToday), sql`${sales.status} <> 'VOIDED'`))
    .groupBy(saleLines.variantSku, saleLines.productName)
    .orderBy(desc(sql`SUM(${saleLines.quantity})`))
    .limit(5);

  // Hourly shape, so an owner can see when the shop is actually busy.
  const hourly = await db
    .select({
      hour: sql<string>`to_char(date_trunc('hour', ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi'), 'HH24:00')`.as('hour'),
      gross: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('gross'),
      count: sql<number>`COUNT(*)::int`.as('count'),
    })
    .from(sales)
    .where(and(scope, gte(sales.soldAt, startOfToday), sql`${sales.status} <> 'VOIDED'`))
    .groupBy(sql`date_trunc('hour', ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi')`)
    .orderBy(sql`date_trunc('hour', ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi')`);

  /* ------------------------------ Needs attention --------------------------- */

  const [alerts] = await db
    .select({ count: sql<number>`COUNT(*)::int`.as('count') })
    .from(stockAlerts)
    .where(and(storeIds ? inArray(stockAlerts.storeId, storeIds) : sql`true`, sql`${stockAlerts.resolvedAt} IS NULL`));

  const openShifts = await db
    .select({
      id: shifts.id,
      cashierName: users.fullName,
      openedAt: shifts.openedAt,
      openingFloat: shifts.openingFloat,
    })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.cashierId))
    .where(and(storeIds ? inArray(shifts.storeId, storeIds) : sql`true`, eq(shifts.status, 'OPEN')))
    .limit(10);

  const [flagged] = await db
    .select({
      oversold: sql<number>`COUNT(*) FILTER (WHERE ${sales.oversold})::int`.as('oversold'),
      repriced: sql<number>`COUNT(*) FILTER (WHERE ${sales.repricedOnSync})::int`.as('repriced'),
      offline: sql<number>`COUNT(*) FILTER (WHERE ${sales.createdOffline})::int`.as('offline'),
    })
    .from(sales)
    .where(and(scope, gte(sales.soldAt, sql`now() - interval '7 days'`)));

  const [qbQueue] = await db
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE ${qbSyncQueue.status} = 'PENDING')::int`.as('pending'),
      dead: sql<number>`COUNT(*) FILTER (WHERE ${qbSyncQueue.status} = 'DEAD_LETTER')::int`.as('dead'),
    })
    .from(qbSyncQueue)
    .where(storeIds ? inArray(qbSyncQueue.storeId, storeIds) : sql`true`);

  const grossToday = Number(today?.gross ?? 0);
  const grossYesterday = Number(yesterday?.gross ?? 0);

  return {
    today: {
      saleCount: today?.saleCount ?? 0,
      gross: grossToday,
      tax: Number(today?.tax ?? 0),
      discounts: Number(today?.discounts ?? 0),
      refunds: Number(today?.refunds ?? 0),
      voids: today?.voids ?? 0,
      averageBasket: Number(today?.basket ?? 0),
    },
    comparison: {
      yesterdayGross: grossYesterday,
      // Basis points avoids float percentages on the client.
      changeBasisPoints:
        grossYesterday > 0 ? Math.round(((grossToday - grossYesterday) / grossYesterday) * 10_000) : null,
    },
    tenders: tenders.map((t) => ({ method: t.method, total: Number(t.total) })),
    topSellers: topSellers.map((t) => ({ ...t, quantity: Number(t.quantity), revenue: Number(t.revenue) })),
    hourly: hourly.map((h) => ({ hour: h.hour, gross: Number(h.gross), count: h.count })),
    attention: {
      stockAlerts: alerts?.count ?? 0,
      openShifts,
      oversoldLast7Days: flagged?.oversold ?? 0,
      repricedLast7Days: flagged?.repriced ?? 0,
      offlineLast7Days: flagged?.offline ?? 0,
      quickbooksPending: qbQueue?.pending ?? 0,
      quickbooksDead: qbQueue?.dead ?? 0,
    },
  };
}
