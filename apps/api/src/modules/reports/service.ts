import { and, eq, gte, inArray, lte, sql, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  sales,
  saleLines,
  payments,
  refunds,
  products,
  productVariants,
  stockLevels,
  stockMovements,
  users,
  stores,
  creditTransactions,
} from '../../db/schema/index.js';

type Scope = { from: Date; to: Date; storeIds: string[] | null; storeId?: string };

function storeFilter(scope: Scope) {
  if (scope.storeId) return eq(sales.storeId, scope.storeId);
  if (scope.storeIds) return inArray(sales.storeId, scope.storeIds);
  return sql`true`;
}

/**
 * Daily/weekly/monthly takings. `date_trunc` runs in the store's own timezone so
 * a "day" matches the trading day a manager actually worked, not UTC midnight.
 */
export async function salesSummary(
  scope: Scope & { granularity: 'hour' | 'day' | 'week' | 'month'; terminalId?: string; cashierId?: string },
) {
  const conditions = [
    storeFilter(scope),
    gte(sales.soldAt, scope.from),
    lte(sales.soldAt, scope.to),
    sql`${sales.status} <> 'VOIDED'`,
  ];
  if (scope.terminalId) conditions.push(eq(sales.terminalId, scope.terminalId));
  if (scope.cashierId) conditions.push(eq(sales.cashierId, scope.cashierId));

  const bucket = sql.raw(`'${scope.granularity}'`);

  const rows = await db
    .select({
      period: sql<string>`to_char(date_trunc(${bucket}, ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi'), 'YYYY-MM-DD"T"HH24:MI:SS')`.as('period'),
      saleCount: sql<number>`COUNT(*)::int`.as('saleCount'),
      grossSales: sql<number>`COALESCE(SUM(${sales.total}), 0)::bigint`.as('grossSales'),
      netSales: sql<number>`COALESCE(SUM(${sales.netTotal}), 0)::bigint`.as('netSales'),
      taxTotal: sql<number>`COALESCE(SUM(${sales.taxTotal}), 0)::bigint`.as('taxTotal'),
      discountTotal: sql<number>`COALESCE(SUM(${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}), 0)::bigint`.as('discountTotal'),
      refundTotal: sql<number>`COALESCE(SUM(${sales.amountRefunded}), 0)::bigint`.as('refundTotal'),
      averageSale: sql<number>`COALESCE(ROUND(AVG(${sales.total})), 0)::bigint`.as('averageSale'),
    })
    .from(sales)
    .where(and(...conditions))
    .groupBy(sql`date_trunc(${bucket}, ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi')`)
    .orderBy(sql`date_trunc(${bucket}, ${sales.soldAt} AT TIME ZONE 'Africa/Nairobi')`);

  const periods = rows.map((r) => ({
    period: r.period,
    saleCount: r.saleCount,
    grossSales: Number(r.grossSales),
    netSales: Number(r.netSales),
    taxTotal: Number(r.taxTotal),
    discountTotal: Number(r.discountTotal),
    refundTotal: Number(r.refundTotal),
    averageSale: Number(r.averageSale),
  }));

  return {
    periods,
    totals: periods.reduce(
      (acc, p) => ({
        saleCount: acc.saleCount + p.saleCount,
        grossSales: acc.grossSales + p.grossSales,
        netSales: acc.netSales + p.netSales,
        taxTotal: acc.taxTotal + p.taxTotal,
        discountTotal: acc.discountTotal + p.discountTotal,
        refundTotal: acc.refundTotal + p.refundTotal,
      }),
      { saleCount: 0, grossSales: 0, netSales: 0, taxTotal: 0, discountTotal: 0, refundTotal: 0 },
    ),
  };
}

/** Takings split by tender: the report used to reconcile the drawer and the bank. */
export async function paymentBreakdown(scope: Scope) {
  const rows = await db
    .select({
      method: payments.method,
      transactionCount: sql<number>`COUNT(*)::int`.as('transactionCount'),
      total: sql<number>`COALESCE(SUM(${payments.amount}), 0)::bigint`.as('total'),
      refunded: sql<number>`COALESCE(SUM(CASE WHEN ${payments.amount} < 0 THEN -${payments.amount} ELSE 0 END), 0)::bigint`.as('refunded'),
      collected: sql<number>`COALESCE(SUM(CASE WHEN ${payments.amount} > 0 THEN ${payments.amount} ELSE 0 END), 0)::bigint`.as('collected'),
    })
    .from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId))
    .where(
      and(
        storeFilter(scope),
        gte(sales.soldAt, scope.from),
        lte(sales.soldAt, scope.to),
        sql`${payments.status} <> 'REVERSED'`,
        sql`${sales.status} <> 'VOIDED'`,
        sql`${payments.method} <> 'ON_ACCOUNT'`,
      ),
    )
    .groupBy(payments.method)
    .orderBy(desc(sql`SUM(${payments.amount})`));

  const methodMap = new Map(rows.map((r) => [r.method, {
    method: r.method,
    transactionCount: r.transactionCount,
    collected: Number(r.collected),
    refunded: Number(r.refunded),
    net: Number(r.total),
  }]));

  const creditStoreFilter = scope.storeId
    ? eq(creditTransactions.storeId, scope.storeId)
    : scope.storeIds
      ? inArray(creditTransactions.storeId, scope.storeIds)
      : sql`true`;
  const [creditSalesRow] = await db.select({
    amount: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)::bigint`.as('amount'),
  }).from(creditTransactions).innerJoin(sales, eq(sales.id, creditTransactions.saleId)).where(and(
    creditStoreFilter,
    eq(creditTransactions.type, 'CHARGE'),
    sql`${sales.status} <> 'VOIDED'`,
    gte(creditTransactions.createdAt, scope.from),
    lte(creditTransactions.createdAt, scope.to),
  ));
  const creditCollections = await db.select({
    method: creditTransactions.paymentMethod,
    transactionCount: sql<number>`COUNT(*)::int`.as('transactionCount'),
    collected: sql<number>`COALESCE(SUM(-${creditTransactions.amount}), 0)::bigint`.as('collected'),
  }).from(creditTransactions).where(and(
    creditStoreFilter,
    eq(creditTransactions.type, 'PAYMENT'),
    gte(creditTransactions.createdAt, scope.from),
    lte(creditTransactions.createdAt, scope.to),
  )).groupBy(creditTransactions.paymentMethod);

  for (const collection of creditCollections) {
    if (!collection.method) continue;
    const current = methodMap.get(collection.method) ?? {
      method: collection.method, transactionCount: 0, collected: 0, refunded: 0, net: 0,
    };
    current.transactionCount += Number(collection.transactionCount);
    current.collected += Number(collection.collected);
    current.net += Number(collection.collected);
    methodMap.set(collection.method, current);
  }
  const methods = [...methodMap.values()].sort((a, b) => b.net - a.net);

  const net = methods.reduce((a, m) => a + m.net, 0);
  return {
    methods: methods.map((m) => ({
      ...m,
      // Share of net takings, in basis points, so the client needs no float maths.
      shareBasisPoints: net > 0 ? Math.round((m.net / net) * 10_000) : 0,
    })),
    totals: {
      collected: methods.reduce((a, m) => a + m.collected, 0),
      refunded: methods.reduce((a, m) => a + m.refunded, 0),
      net,
      creditSales: Number(creditSalesRow?.amount ?? 0),
      creditCollections: creditCollections.reduce((total, row) => total + Number(row.collected), 0),
    },
  };
}

/** VAT return support: net and tax per rate, which is what a KRA filing needs. */
export async function taxReport(scope: Scope) {
  const rows = await db
    .select({
      taxCode: saleLines.taxCode,
      rateBasisPoints: saleLines.taxRateBasisPoints,
      net: sql<number>`COALESCE(SUM(${saleLines.netAmount}), 0)::bigint`.as('net'),
      tax: sql<number>`COALESCE(SUM(${saleLines.taxAmount}), 0)::bigint`.as('tax'),
      gross: sql<number>`COALESCE(SUM(${saleLines.lineTotal}), 0)::bigint`.as('gross'),
      lineCount: sql<number>`COUNT(*)::int`.as('lineCount'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(
      and(
        storeFilter(scope),
        gte(sales.soldAt, scope.from),
        lte(sales.soldAt, scope.to),
        sql`${sales.status} <> 'VOIDED'`,
      ),
    )
    .groupBy(saleLines.taxCode, saleLines.taxRateBasisPoints)
    .orderBy(saleLines.taxCode);

  const bands = rows.map((r) => ({
    taxCode: r.taxCode,
    rateBasisPoints: r.rateBasisPoints,
    net: Number(r.net),
    tax: Number(r.tax),
    gross: Number(r.gross),
    lineCount: r.lineCount,
  }));

  // Refunds reduce output VAT and must appear on the return.
  const [refundRow] = await db
    .select({
      net: sql<number>`COALESCE(SUM(${refunds.subtotal}), 0)::bigint`.as('net'),
      tax: sql<number>`COALESCE(SUM(${refunds.taxTotal}), 0)::bigint`.as('tax'),
    })
    .from(refunds)
    .where(
      and(
        scope.storeId ? eq(refunds.storeId, scope.storeId) : scope.storeIds ? inArray(refunds.storeId, scope.storeIds) : sql`true`,
        gte(refunds.refundedAt, scope.from),
        lte(refunds.refundedAt, scope.to),
      ),
    );

  return {
    bands,
    refunds: { net: Number(refundRow?.net ?? 0), tax: Number(refundRow?.tax ?? 0) },
    totals: {
      net: bands.reduce((a, b) => a + b.net, 0) - Number(refundRow?.net ?? 0),
      tax: bands.reduce((a, b) => a + b.tax, 0) - Number(refundRow?.tax ?? 0),
    },
  };
}

export async function bestsellers(scope: Scope, limit: number) {
  const rows = await db
    .select({
      variantId: saleLines.variantId,
      sku: saleLines.variantSku,
      productName: saleLines.productName,
      variantLabel: saleLines.variantLabel,
      quantitySold: sql<number>`COALESCE(SUM(${saleLines.quantity} - ${saleLines.quantityRefunded}), 0)::bigint`.as('quantitySold'),
      revenue: sql<number>`COALESCE(SUM(${saleLines.lineTotal}), 0)::bigint`.as('revenue'),
      // Gross margin uses the cost snapshotted on the line, not today's cost.
      grossProfit: sql<number>`COALESCE(SUM(${saleLines.netAmount} - (${saleLines.unitCost} * ${saleLines.quantity} / 1000)), 0)::bigint`.as('grossProfit'),
      transactionCount: sql<number>`COUNT(DISTINCT ${saleLines.saleId})::int`.as('transactionCount'),
    })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(
      and(
        storeFilter(scope),
        gte(sales.soldAt, scope.from),
        lte(sales.soldAt, scope.to),
        sql`${sales.status} <> 'VOIDED'`,
      ),
    )
    .groupBy(saleLines.variantId, saleLines.variantSku, saleLines.productName, saleLines.variantLabel)
    .orderBy(desc(sql`SUM(${saleLines.quantity} - ${saleLines.quantityRefunded})`))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    quantitySold: Number(r.quantitySold),
    revenue: Number(r.revenue),
    grossProfit: Number(r.grossProfit),
  }));
}

/**
 * Stock that has not sold in `days`. Uses a LEFT JOIN against the sales window so
 * items that never sold at all appear, which is the whole point of the report.
 */
export async function deadStock(storeIds: string[] | null, days: number, limit: number) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      storeId: stockLevels.storeId,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
      quantityOnHand: stockLevels.quantityOnHand,
      unitPrice: productVariants.unitPrice,
      averageCost: stockLevels.averageCost,
      tiedUpCapital: sql<number>`(${stockLevels.quantityOnHand} * ${stockLevels.averageCost} / 1000)::bigint`.as('tiedUpCapital'),
      lastSoldAt: sql<string | null>`(
        SELECT MAX(s.sold_at)
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        WHERE sl.variant_id = ${productVariants.id} AND s.status <> 'VOIDED'
      )`.as('lastSoldAt'),
    })
    .from(stockLevels)
    .innerJoin(productVariants, eq(productVariants.id, stockLevels.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        storeIds ? inArray(stockLevels.storeId, storeIds) : sql`true`,
        sql`${stockLevels.quantityOnHand} > 0`,
        eq(productVariants.isActive, true),
        sql`NOT EXISTS (
          SELECT 1 FROM sale_lines sl
          JOIN sales s ON s.id = sl.sale_id
          WHERE sl.variant_id = ${productVariants.id}
            AND s.sold_at >= ${cutoff}
            AND s.status <> 'VOIDED'
        )`,
      ),
    )
    .orderBy(desc(sql`${stockLevels.quantityOnHand} * ${stockLevels.averageCost}`))
    .limit(limit);

  return rows.map((r) => ({ ...r, tiedUpCapital: Number(r.tiedUpCapital) }));
}

export async function stockValuation(storeIds: string[] | null, limit: number) {
  const rows = await db
    .select({
      storeId: stockLevels.storeId,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
      quantityOnHand: stockLevels.quantityOnHand,
      averageCost: stockLevels.averageCost,
      unitPrice: productVariants.unitPrice,
      costValue: sql<number>`(${stockLevels.quantityOnHand} * ${stockLevels.averageCost} / 1000)::bigint`.as('costValue'),
      retailValue: sql<number>`(${stockLevels.quantityOnHand} * ${productVariants.unitPrice} / 1000)::bigint`.as('retailValue'),
    })
    .from(stockLevels)
    .innerJoin(productVariants, eq(productVariants.id, stockLevels.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(storeIds ? inArray(stockLevels.storeId, storeIds) : sql`true`, sql`${stockLevels.quantityOnHand} <> 0`))
    .orderBy(desc(sql`${stockLevels.quantityOnHand} * ${stockLevels.averageCost}`))
    .limit(limit);

  const items = rows.map((r) => ({ ...r, costValue: Number(r.costValue), retailValue: Number(r.retailValue) }));
  return {
    items,
    totals: {
      costValue: items.reduce((a, i) => a + i.costValue, 0),
      retailValue: items.reduce((a, i) => a + i.retailValue, 0),
    },
  };
}

/** Cashier scorecard: takings, discounts given, voids and refunds per person. */
export async function cashierPerformance(scope: Scope) {
  const rows = await db
    .select({
      cashierId: sales.cashierId,
      cashierName: users.fullName,
      saleCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} <> 'VOIDED')::int`.as('saleCount'),
      grossSales: sql<number>`COALESCE(SUM(${sales.total}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('grossSales'),
      discountGiven: sql<number>`COALESCE(SUM(${sales.lineDiscountTotal} + ${sales.orderDiscountTotal}) FILTER (WHERE ${sales.status} <> 'VOIDED'), 0)::bigint`.as('discountGiven'),
      voidCount: sql<number>`COUNT(*) FILTER (WHERE ${sales.status} = 'VOIDED')::int`.as('voidCount'),
      refundTotal: sql<number>`COALESCE(SUM(${sales.amountRefunded}), 0)::bigint`.as('refundTotal'),
    })
    .from(sales)
    .leftJoin(users, eq(users.id, sales.cashierId))
    .where(and(storeFilter(scope), gte(sales.soldAt, scope.from), lte(sales.soldAt, scope.to)))
    .groupBy(sales.cashierId, users.fullName)
    .orderBy(desc(sql`SUM(${sales.total})`));

  return rows.map((r) => ({
    ...r,
    grossSales: Number(r.grossSales),
    discountGiven: Number(r.discountGiven),
    refundTotal: Number(r.refundTotal),
  }));
}

export async function stockMovementReport(storeIds: string[] | null, from: Date, to: Date, limit: number) {
  return db
    .select({
      occurredAt: stockMovements.occurredAt,
      storeId: stockMovements.storeId,
      sku: productVariants.sku,
      productName: products.name,
      reason: stockMovements.reason,
      quantityDelta: stockMovements.quantityDelta,
      balanceAfter: stockMovements.balanceAfter,
      referenceType: stockMovements.referenceType,
      note: stockMovements.note,
    })
    .from(stockMovements)
    .innerJoin(productVariants, eq(productVariants.id, stockMovements.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        storeIds ? inArray(stockMovements.storeId, storeIds) : sql`true`,
        gte(stockMovements.occurredAt, from),
        lte(stockMovements.occurredAt, to),
      ),
    )
    .orderBy(desc(stockMovements.occurredAt))
    .limit(limit);
}

export async function storeName(storeId?: string): Promise<string> {
  if (!storeId) return 'All stores';
  const [store] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId)).limit(1);
  return store?.name ?? 'Unknown store';
}
