import { and, eq, gte, inArray, lte, sql, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sales, saleLines, payments, refunds, refundLines, customers, products, productVariants, users, categories } from '../../db/schema/index.js';

type Scope = { from: Date; to: Date; storeIds: string[] | null; storeId?: string };

function scopeFilter(scope: Scope) {
  if (scope.storeId) return eq(sales.storeId, scope.storeId);
  if (scope.storeIds) return inArray(sales.storeId, scope.storeIds);
  return sql`true`;
}

const EXCLUDE_VOIDED = sql`${sales.status} <> 'VOIDED'`;

/**
 * Profit and margin.
 *
 * Turnover on its own tells an owner very little — a shop can grow takings while
 * losing money. Cost is taken from what was snapshotted on the sale line, not
 * today's cost, so last month's margin does not change when a supplier raises a
 * price this month.
 */
export async function profitReport(scope: Scope) {
  const where = and(scopeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to), EXCLUDE_VOIDED);

  const [totals] = await db
    .select({
      revenue: sql<number>`COALESCE(SUM(${saleLines.netAmount}), 0)::bigint`.as('revenue'),
      // Quantity is in thousandths, so divide it back out with the unit cost.
      cost: sql<number>`COALESCE(SUM(${saleLines.unitCost} * ${saleLines.quantity} / 1000), 0)::bigint`.as('cost'),
      tax: sql<number>`COALESCE(SUM(${saleLines.taxAmount}), 0)::bigint`.as('tax'),
      discount: sql<number>`COALESCE(SUM(${saleLines.lineDiscount} + ${saleLines.allocatedOrderDiscount}), 0)::bigint`.as('discount'),
      units: sql<number>`COALESCE(SUM(${saleLines.quantity}), 0)::bigint`.as('units'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(where);

  const byCategory = await db
    .select({
      categoryId: products.categoryId,
      categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorised')`.as('categoryName'),
      revenue: sql<number>`COALESCE(SUM(${saleLines.netAmount}), 0)::bigint`.as('revenue'),
      cost: sql<number>`COALESCE(SUM(${saleLines.unitCost} * ${saleLines.quantity} / 1000), 0)::bigint`.as('cost'),
      units: sql<number>`COALESCE(SUM(${saleLines.quantity}), 0)::bigint`.as('units'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .innerJoin(productVariants, eq(productVariants.id, saleLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(where)
    .groupBy(products.categoryId, categories.name)
    .orderBy(desc(sql`SUM(${saleLines.netAmount})`));

  const revenue = Number(totals?.revenue ?? 0);
  const cost = Number(totals?.cost ?? 0);
  const profit = revenue - cost;

  return {
    totals: {
      revenue,
      cost,
      grossProfit: profit,
      // Basis points so the client never does float maths on a percentage.
      marginBasisPoints: revenue > 0 ? Math.round((profit / revenue) * 10_000) : 0,
      tax: Number(totals?.tax ?? 0),
      discountGiven: Number(totals?.discount ?? 0),
      unitsSold: Number(totals?.units ?? 0),
    },
    byCategory: byCategory.map((row) => {
      const catRevenue = Number(row.revenue);
      const catCost = Number(row.cost);
      return {
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        revenue: catRevenue,
        cost: catCost,
        grossProfit: catRevenue - catCost,
        marginBasisPoints: catRevenue > 0 ? Math.round(((catRevenue - catCost) / catRevenue) * 10_000) : 0,
        unitsSold: Number(row.units),
        shareBasisPoints: revenue > 0 ? Math.round((catRevenue / revenue) * 10_000) : 0,
      };
    }),
  };
}

/**
 * Per-product performance, with margin.
 *
 * Deliberately shows margin alongside volume: the best-selling line is often not
 * the one making the money, and an owner cannot see that from a bestsellers list.
 */
export async function productPerformance(scope: Scope, limit = 100) {
  const rows = await db
    .select({
      variantId: saleLines.variantId,
      sku: saleLines.variantSku,
      productName: saleLines.productName,
      variantLabel: saleLines.variantLabel,
      unitsSold: sql<number>`COALESCE(SUM(${saleLines.quantity} - ${saleLines.quantityRefunded}), 0)::bigint`.as('unitsSold'),
      revenue: sql<number>`COALESCE(SUM(${saleLines.netAmount}), 0)::bigint`.as('revenue'),
      cost: sql<number>`COALESCE(SUM(${saleLines.unitCost} * ${saleLines.quantity} / 1000), 0)::bigint`.as('cost'),
      discount: sql<number>`COALESCE(SUM(${saleLines.lineDiscount} + ${saleLines.allocatedOrderDiscount}), 0)::bigint`.as('discount'),
      transactions: sql<number>`COUNT(DISTINCT ${saleLines.saleId})::int`.as('transactions'),
      refundedUnits: sql<number>`COALESCE(SUM(${saleLines.quantityRefunded}), 0)::bigint`.as('refundedUnits'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(and(scopeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to), EXCLUDE_VOIDED))
    .groupBy(saleLines.variantId, saleLines.variantSku, saleLines.productName, saleLines.variantLabel)
    .orderBy(desc(sql`SUM(${saleLines.netAmount})`))
    .limit(limit);

  return rows.map((row) => {
    const revenue = Number(row.revenue);
    const cost = Number(row.cost);
    return {
      variantId: row.variantId,
      sku: row.sku,
      productName: row.productName,
      variantLabel: row.variantLabel,
      unitsSold: Number(row.unitsSold),
      revenue,
      cost,
      grossProfit: revenue - cost,
      marginBasisPoints: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10_000) : 0,
      discountGiven: Number(row.discount),
      transactions: row.transactions,
      refundedUnits: Number(row.refundedUnits),
    };
  });
}

/**
 * Discounts, voids and refunds per cashier.
 *
 * These three are the usual signals of either a training problem or something
 * worse, and they are only meaningful compared across people doing the same job.
 */
export async function exceptionsReport(scope: Scope) {
  const rows = await db
    .select({
      cashierId: sales.cashierId,
      cashierName: users.fullName,
      saleCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} <> 'VOIDED')::int`.as('saleCount'),
      grossSales: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('grossSales'),
      discountGiven: sql<number>`COALESCE(SUM(${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('discountGiven'),
      discountedSales: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} <> 'VOIDED' AND (${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}) > 0)::int`.as('discountedSales'),
      voidCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} = 'VOIDED')::int`.as('voidCount'),
      voidValue: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} = 'VOIDED'), 0)::bigint`.as('voidValue'),
      refundValue: sql<number>`COALESCE(SUM(${sales.amountRefunded}), 0)::bigint`.as('refundValue'),
      overrides: sql<number>`COUNT(*) FILTER (WHERE ${sales.overrideByUserId} IS NOT NULL)::int`.as('overrides'),
    })
    .from(sales)
    .leftJoin(users, eq(users.id, sales.cashierId))
    .where(and(scopeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to)))
    .groupBy(sales.cashierId, users.fullName)
    .orderBy(desc(sql`COUNT(*)`));

  return rows.map((row) => {
    const gross = Number(row.grossSales);
    const discount = Number(row.discountGiven);
    return {
      cashierId: row.cashierId,
      cashierName: row.cashierName ?? 'Unknown',
      saleCount: row.saleCount,
      grossSales: gross,
      discountGiven: discount,
      // Discount as a share of their own takings, which is the comparable figure.
      discountRateBasisPoints: gross > 0 ? Math.round((discount / gross) * 10_000) : 0,
      discountedSales: row.discountedSales,
      voidCount: row.voidCount,
      voidValue: Number(row.voidValue),
      refundValue: Number(row.refundValue),
      overrides: row.overrides,
      averageBasket: row.saleCount > 0 ? Math.round(gross / row.saleCount) : 0,
    };
  });
}

/**
 * Trading pattern by hour and weekday, so staffing and opening hours can be set
 * from evidence rather than impression.
 */
export async function tradingPattern(scope: Scope) {
  const where = and(scopeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to), EXCLUDE_VOIDED);
  const local = sql`${sales.soldAt} AT TIME ZONE 'Africa/Nairobi'`;

  const byHour = await db
    .select({
      hour: sql<number>`EXTRACT(HOUR FROM ${local})::int`.as('hour'),
      sales: sql<number>`COUNT(*)::int`.as('sales'),
      revenue: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('revenue'),
    })
    .from(sales)
    .where(where)
    .groupBy(sql`EXTRACT(HOUR FROM ${local})`)
    .orderBy(sql`EXTRACT(HOUR FROM ${local})`);

  const byWeekday = await db
    .select({
      weekday: sql<number>`EXTRACT(ISODOW FROM ${local})::int`.as('weekday'),
      sales: sql<number>`COUNT(*)::int`.as('sales'),
      revenue: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('revenue'),
    })
    .from(sales)
    .where(where)
    .groupBy(sql`EXTRACT(ISODOW FROM ${local})`)
    .orderBy(sql`EXTRACT(ISODOW FROM ${local})`);

  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  return {
    byHour: byHour.map((r) => ({ hour: r.hour, sales: r.sales, revenue: Number(r.revenue) })),
    byWeekday: byWeekday.map((r) => ({
      weekday: r.weekday,
      name: names[r.weekday - 1] ?? String(r.weekday),
      sales: r.sales,
      revenue: Number(r.revenue),
    })),
  };
}

/** Who the regulars are, and what they are worth. */
export async function customerInsights(scope: Scope, limit = 50) {
  const where = and(scopeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to), EXCLUDE_VOIDED);

  const top = await db
    .select({
      customerId: sales.customerId,
      fullName: customers.fullName,
      phone: customers.phone,
      visits: sql<number>`COUNT(*)::int`.as('visits'),
      spend: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('spend'),
      lastVisit: sql<string>`MAX(${sales.soldAt})`.as('lastVisit'),
      loyaltyPoints: customers.loyaltyPoints,
    })
    .from(sales)
    .innerJoin(customers, eq(customers.id, sales.customerId))
    .where(where)
    .groupBy(sales.customerId, customers.fullName, customers.phone, customers.loyaltyPoints)
    .orderBy(desc(sql`SUM(${sales.total})`))
    .limit(limit);

  const [split] = await db
    .select({
      identifiedSales: sql<number>`COUNT(*) FILTER (WHERE ${sales.customerId} IS NOT NULL)::int`.as('identifiedSales'),
      anonymousSales: sql<number>`COUNT(*) FILTER (WHERE ${sales.customerId} IS NULL)::int`.as('anonymousSales'),
      identifiedRevenue: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.customerId} IS NOT NULL), 0)::bigint`.as('identifiedRevenue'),
      anonymousRevenue: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.customerId} IS NULL), 0)::bigint`.as('anonymousRevenue'),
    })
    .from(sales)
    .where(where);

  return {
    topCustomers: top.map((row) => ({
      customerId: row.customerId,
      fullName: row.fullName,
      phone: row.phone,
      visits: row.visits,
      spend: Number(row.spend),
      averageBasket: row.visits > 0 ? Math.round(Number(row.spend) / row.visits) : 0,
      lastVisit: row.lastVisit,
      loyaltyPoints: row.loyaltyPoints,
    })),
    identified: {
      sales: split?.identifiedSales ?? 0,
      revenue: Number(split?.identifiedRevenue ?? 0),
    },
    anonymous: {
      sales: split?.anonymousSales ?? 0,
      revenue: Number(split?.anonymousRevenue ?? 0),
    },
  };
}

/** Why customers bring things back. */
export async function refundAnalysis(scope: Scope) {
  const storeFilter = scope.storeId
    ? eq(refunds.storeId, scope.storeId)
    : scope.storeIds
      ? inArray(refunds.storeId, scope.storeIds)
      : sql`true`;
  const where = and(storeFilter, gte(refunds.refundedAt, scope.from), lte(refunds.refundedAt, scope.to));

  const byReason = await db
    .select({
      reason: refundLines.reason,
      count: sql<number>`COUNT(*)::int`.as('count'),
      value: sql<number>`COALESCE(SUM(${refundLines.lineTotal}), 0)::bigint`.as('value'),
      units: sql<number>`COALESCE(SUM(${refundLines.quantity}), 0)::bigint`.as('units'),
    })
    .from(refundLines)
    .innerJoin(refunds, eq(refunds.id, refundLines.refundId))
    .where(where)
    .groupBy(refundLines.reason)
    .orderBy(desc(sql`SUM(${refundLines.lineTotal})`));

  const worstProducts = await db
    .select({
      sku: saleLines.variantSku,
      productName: saleLines.productName,
      refundedUnits: sql<number>`COALESCE(SUM(${refundLines.quantity}), 0)::bigint`.as('refundedUnits'),
      refundedValue: sql<number>`COALESCE(SUM(${refundLines.lineTotal}), 0)::bigint`.as('refundedValue'),
    })
    .from(refundLines)
    .innerJoin(refunds, eq(refunds.id, refundLines.refundId))
    .innerJoin(saleLines, eq(saleLines.id, refundLines.saleLineId))
    .where(where)
    .groupBy(saleLines.variantSku, saleLines.productName)
    .orderBy(desc(sql`SUM(${refundLines.lineTotal})`))
    .limit(20);

  return {
    byReason: byReason.map((r) => ({
      reason: r.reason,
      count: r.count,
      value: Number(r.value),
      units: Number(r.units),
    })),
    worstProducts: worstProducts.map((r) => ({
      sku: r.sku,
      productName: r.productName,
      refundedUnits: Number(r.refundedUnits),
      refundedValue: Number(r.refundedValue),
    })),
  };
}

/**
 * This period against the one before it, of the same length. Growth is the
 * question an owner actually asks, and it needs a like-for-like comparison.
 */
export async function periodComparison(scope: Scope) {
  const span = scope.to.getTime() - scope.from.getTime();
  const previousFrom = new Date(scope.from.getTime() - span);
  const previousTo = new Date(scope.from.getTime());

  const measure = async (from: Date, to: Date) => {
    const [row] = await db
      .select({
        sales: sql<number>`COUNT(*)::int`.as('sales'),
        revenue: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('revenue'),
        units: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('units'),
      })
      .from(sales)
      .where(and(scopeFilter(scope), gte(sales.soldAt, from), lte(sales.soldAt, to), EXCLUDE_VOIDED));

    const [margin] = await db
      .select({
        revenue: sql<number>`COALESCE(SUM(${saleLines.netAmount}), 0)::bigint`.as('revenue'),
        cost: sql<number>`COALESCE(SUM(${saleLines.unitCost} * ${saleLines.quantity} / 1000), 0)::bigint`.as('cost'),
      })
      .from(saleLines)
      .innerJoin(sales, eq(sales.id, saleLines.saleId))
      .where(and(scopeFilter(scope), gte(sales.soldAt, from), lte(sales.soldAt, to), EXCLUDE_VOIDED));

    const net = Number(margin?.revenue ?? 0);
    const cost = Number(margin?.cost ?? 0);
    return {
      sales: row?.sales ?? 0,
      revenue: Number(row?.revenue ?? 0),
      grossProfit: net - cost,
      averageBasket: (row?.sales ?? 0) > 0 ? Math.round(Number(row?.revenue ?? 0) / (row?.sales ?? 1)) : 0,
    };
  };

  const current = await measure(scope.from, scope.to);
  const previous = await measure(previousFrom, previousTo);

  const change = (now: number, before: number) =>
    before > 0 ? Math.round(((now - before) / before) * 10_000) : null;

  return {
    current,
    previous,
    previousPeriod: { from: previousFrom.toISOString(), to: previousTo.toISOString() },
    changeBasisPoints: {
      revenue: change(current.revenue, previous.revenue),
      sales: change(current.sales, previous.sales),
      grossProfit: change(current.grossProfit, previous.grossProfit),
      averageBasket: change(current.averageBasket, previous.averageBasket),
    },
  };
}
