import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  salesSummaryQuery,
  paymentBreakdownQuery,
  stockReportQuery,
  taxReportQuery,
  zReportQuery,
  dateRangeQuery,
  type ReportFormat,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { shifts, stores, users } from '../../db/schema/index.js';
import { parseQuery } from '../../core/validation.js';
import { requirePermissions, visibleStoreIds, assertStoreAccess } from '../../auth/context.js';
import { badRequest, notFound } from '../../core/errors.js';
import { writeAuditSafe } from '../../core/audit.js';
import { toCsv, renderPdf, safeFilename, type PdfSection } from './export.js';
import {
  salesSummary,
  paymentBreakdown,
  taxReport,
  bestsellers,
  deadStock,
  stockValuation,
  cashierPerformance,
  stockMovementReport,
  storeName,
} from './service.js';
import { listLowStock } from '../inventory/service.js';
import { dashboard } from './dashboard.js';
import {
  profitReport,
  productPerformance,
  exceptionsReport,
  tradingPattern,
  customerInsights,
  refundAnalysis,
  periodComparison,
} from './analysis.js';
import { shiftSummary } from '../sales/routes.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /** Owner's landing view. Polled while trading, so it is one query set. */
  app.get('/dashboard', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: z.string().uuid().optional() }));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return dashboard(visibleStoreIds(request), query.storeId);
  });

  app.get('/sales-summary', { preHandler: requirePermissions('report:sales') }, async (request, reply) => {
    const query = parseQuery(request, salesSummaryQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const data = await salesSummary({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.terminalId ? { terminalId: query.terminalId } : {}),
      ...(query.cashierId ? { cashierId: query.cashierId } : {}),
      granularity: query.granularity,
    });

    if (query.format === 'json') return data;

    const label = `sales-summary-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`;
    audit(request, 'sales-summary', query.format);

    if (query.format === 'csv') {
      return sendCsv(reply, label, toCsv(data.periods));
    }

    return sendPdf(
      reply,
      label,
      await renderPdf({
        title: 'Sales summary',
        subtitle: await storeName(query.storeId),
        meta: [
          ['Period', `${query.from} to ${query.to}`],
          ['Granularity', query.granularity],
          ['Transactions', String(data.totals.saleCount)],
          ['Gross sales', String(data.totals.grossSales / 100)],
        ],
        sections: [
          {
            title: 'By period',
            columns: [
              { key: 'period', label: 'Period' },
              { key: 'saleCount', label: 'Sales', align: 'right' },
              { key: 'grossSales', label: 'Gross', money: true },
              { key: 'discountTotal', label: 'Discounts', money: true },
              { key: 'taxTotal', label: 'VAT', money: true },
              { key: 'netSales', label: 'Net', money: true },
              { key: 'refundTotal', label: 'Refunds', money: true },
            ],
            rows: data.periods,
          },
        ],
      }),
    );
  });

  app.get('/payments', { preHandler: requirePermissions('report:payments') }, async (request, reply) => {
    const query = parseQuery(request, paymentBreakdownQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const data = await paymentBreakdown({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });

    if (query.format === 'json') return data;
    const label = `payment-breakdown-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`;
    audit(request, 'payments', query.format);

    if (query.format === 'csv') return sendCsv(reply, label, toCsv(data.methods));

    return sendPdf(
      reply,
      label,
      await renderPdf({
        title: 'Payment breakdown',
        subtitle: await storeName(query.storeId),
        meta: [
          ['Period', `${query.from} to ${query.to}`],
          ['Net takings', String(data.totals.net / 100)],
        ],
        sections: [
          {
            title: 'By payment method',
            columns: [
              { key: 'method', label: 'Method' },
              { key: 'transactionCount', label: 'Count', align: 'right' },
              { key: 'collected', label: 'Collected', money: true },
              { key: 'refunded', label: 'Refunded', money: true },
              { key: 'net', label: 'Net', money: true },
            ],
            rows: data.methods,
          },
        ],
      }),
    );
  });

  app.get('/tax', { preHandler: requirePermissions('report:tax') }, async (request, reply) => {
    const query = parseQuery(request, taxReportQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const data = await taxReport({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });

    if (query.format === 'json') return data;
    const label = `vat-report-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`;
    audit(request, 'tax', query.format);

    if (query.format === 'csv') return sendCsv(reply, label, toCsv(data.bands));

    return sendPdf(
      reply,
      label,
      await renderPdf({
        title: 'VAT report',
        subtitle: await storeName(query.storeId),
        meta: [
          ['Period', `${query.from} to ${query.to}`],
          ['Net of refunds', String(data.totals.net / 100)],
          ['VAT due', String(data.totals.tax / 100)],
        ],
        sections: [
          {
            title: 'Output tax by band',
            columns: [
              { key: 'taxCode', label: 'Tax code' },
              { key: 'rateBasisPoints', label: 'Rate (bp)', align: 'right' },
              { key: 'net', label: 'Net', money: true },
              { key: 'tax', label: 'VAT', money: true },
              { key: 'gross', label: 'Gross', money: true },
            ],
            rows: data.bands,
          },
        ],
      }),
    );
  });

  app.get('/stock', { preHandler: requirePermissions('report:inventory') }, async (request, reply) => {
    const query = parseQuery(request, stockReportQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const storeIds = query.storeId ? [query.storeId] : visibleStoreIds(request);
    let rows: Array<Record<string, unknown>> = [];
    let title = '';
    let columns: PdfSection['columns'] = [];

    switch (query.kind) {
      case 'LOW_STOCK': {
        rows = (await listLowStock(storeIds, query.limit)) as Array<Record<string, unknown>>;
        title = 'Low stock';
        columns = [
          { key: 'sku', label: 'SKU' },
          { key: 'productName', label: 'Product' },
          { key: 'quantityOnHand', label: 'On hand', align: 'right' },
          { key: 'reorderPoint', label: 'Reorder at', align: 'right' },
          { key: 'reorderQuantity', label: 'Order qty', align: 'right' },
        ];
        break;
      }
      case 'BESTSELLERS': {
        const range = requireRange(query.from, query.to);
        rows = (await bestsellers(
          { from: range.from, to: range.to, storeIds, ...(query.storeId ? { storeId: query.storeId } : {}) },
          query.limit,
        )) as Array<Record<string, unknown>>;
        title = 'Bestsellers';
        columns = [
          { key: 'sku', label: 'SKU' },
          { key: 'productName', label: 'Product' },
          { key: 'quantitySold', label: 'Qty sold', align: 'right' },
          { key: 'revenue', label: 'Revenue', money: true },
          { key: 'grossProfit', label: 'Gross profit', money: true },
        ];
        break;
      }
      case 'DEAD_STOCK': {
        rows = (await deadStock(storeIds, query.deadStockDays, query.limit)) as Array<Record<string, unknown>>;
        title = `Dead stock (no sale in ${query.deadStockDays} days)`;
        columns = [
          { key: 'sku', label: 'SKU' },
          { key: 'productName', label: 'Product' },
          { key: 'quantityOnHand', label: 'On hand', align: 'right' },
          { key: 'tiedUpCapital', label: 'Capital tied up', money: true },
          { key: 'lastSoldAt', label: 'Last sold' },
        ];
        break;
      }
      case 'VALUATION': {
        const valuation = await stockValuation(storeIds, query.limit);
        rows = valuation.items as Array<Record<string, unknown>>;
        title = 'Stock valuation';
        columns = [
          { key: 'sku', label: 'SKU' },
          { key: 'productName', label: 'Product' },
          { key: 'quantityOnHand', label: 'On hand', align: 'right' },
          { key: 'costValue', label: 'At cost', money: true },
          { key: 'retailValue', label: 'At retail', money: true },
        ];
        if (query.format === 'json') return valuation;
        break;
      }
      case 'MOVEMENTS': {
        const range = requireRange(query.from, query.to);
        rows = (await stockMovementReport(storeIds, range.from, range.to, query.limit)) as Array<Record<string, unknown>>;
        title = 'Stock movements';
        columns = [
          { key: 'occurredAt', label: 'When' },
          { key: 'sku', label: 'SKU' },
          { key: 'productName', label: 'Product' },
          { key: 'reason', label: 'Reason' },
          { key: 'quantityDelta', label: 'Change', align: 'right' },
          { key: 'balanceAfter', label: 'Balance', align: 'right' },
        ];
        break;
      }
    }

    if (query.format === 'json') return { kind: query.kind, items: rows };
    const label = `${query.kind.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
    audit(request, `stock:${query.kind}`, query.format);

    if (query.format === 'csv') return sendCsv(reply, label, toCsv(rows));

    return sendPdf(
      reply,
      label,
      await renderPdf({
        title,
        subtitle: await storeName(query.storeId),
        meta: [['Generated', new Date().toISOString()], ['Rows', String(rows.length)]],
        sections: [{ title, columns, rows }],
      }),
    );
  });

  /** Revenue, cost and margin, overall and by category. */
  app.get('/profit', { preHandler: requirePermissions('report:sales') }, async (request, reply) => {
    const query = parseQuery(request, dateRangeQuery.and(z.object({ format: z.enum(['json', 'csv']).default('json') })));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const data = await profitReport({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });

    if (query.format === 'csv') {
      audit(request, 'profit', 'csv');
      return sendCsv(reply, `profit-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`, toCsv(data.byCategory));
    }
    return data;
  });

  /** Per-product sales with margin, so volume and profit can be compared. */
  app.get('/products', { preHandler: requirePermissions('report:sales') }, async (request, reply) => {
    const query = parseQuery(
      request,
      dateRangeQuery.and(
        z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          format: z.enum(['json', 'csv']).default('json'),
        }),
      ),
    );
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const rows = await productPerformance(
      {
        from: new Date(query.from),
        to: new Date(query.to),
        storeIds: visibleStoreIds(request),
        ...(query.storeId ? { storeId: query.storeId } : {}),
      },
      query.limit,
    );

    if (query.format === 'csv') {
      audit(request, 'product-performance', 'csv');
      return sendCsv(reply, `products-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`, toCsv(rows));
    }
    return { products: rows };
  });

  /** Discounts, voids, refunds and overrides per cashier. */
  app.get('/exceptions', { preHandler: requirePermissions('report:sales') }, async (request, reply) => {
    const query = parseQuery(request, dateRangeQuery.and(z.object({ format: z.enum(['json', 'csv']).default('json') })));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    assertExportAllowed(request, query.format);

    const rows = await exceptionsReport({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });

    if (query.format === 'csv') {
      audit(request, 'exceptions', 'csv');
      return sendCsv(reply, `exceptions-${query.from.slice(0, 10)}-to-${query.to.slice(0, 10)}`, toCsv(rows));
    }
    return { cashiers: rows };
  });

  /** Busiest hours and days, for staffing and opening hours. */
  app.get('/trading-pattern', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, dateRangeQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return tradingPattern({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });
  });

  app.get('/customers', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, dateRangeQuery.and(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return customerInsights(
      {
        from: new Date(query.from),
        to: new Date(query.to),
        storeIds: visibleStoreIds(request),
        ...(query.storeId ? { storeId: query.storeId } : {}),
      },
      query.limit,
    );
  });

  /** Why goods come back, and which products come back most. */
  app.get('/refund-analysis', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, dateRangeQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return refundAnalysis({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });
  });

  /** This period against the previous one of the same length. */
  app.get('/comparison', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, dateRangeQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return periodComparison({
      from: new Date(query.from),
      to: new Date(query.to),
      storeIds: visibleStoreIds(request),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    });
  });

  app.get('/cashiers', { preHandler: requirePermissions('report:sales') }, async (request) => {
    const query = parseQuery(request, dateRangeQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return {
      cashiers: await cashierPerformance({
        from: new Date(query.from),
        to: new Date(query.to),
        storeIds: visibleStoreIds(request),
        ...(query.storeId ? { storeId: query.storeId } : {}),
      }),
    };
  });

  /** Z-report: the end-of-shift statement a cashier signs off on. */
  app.get('/z-report', { preHandler: requirePermissions('report:sales') }, async (request, reply) => {
    const query = parseQuery(request, zReportQuery);

    const [shift] = await db.select().from(shifts).where(eq(shifts.id, query.shiftId)).limit(1);
    if (!shift) throw notFound('Shift');
    assertStoreAccess(request, shift.storeId);

    const [summary, store, cashier] = await Promise.all([
      shiftSummary(shift.id),
      db.select().from(stores).where(eq(stores.id, shift.storeId)).limit(1),
      db.select({ fullName: users.fullName }).from(users).where(eq(users.id, shift.cashierId)).limit(1),
    ]);

    const expectedCash = shift.openingFloat + summary.cashNet;
    const payload = {
      shift,
      summary,
      expectedCash,
      variance: shift.countedCash !== null ? shift.countedCash - expectedCash : null,
      cashierName: cashier[0]?.fullName ?? null,
      store: store[0] ?? null,
    };

    if (query.format === 'json') return payload;
    const label = `z-report-${shift.id.slice(0, 8)}`;
    audit(request, 'z-report', query.format);

    if (query.format === 'csv') return sendCsv(reply, label, toCsv(summary.tenders));

    return sendPdf(
      reply,
      label,
      await renderPdf({
        title: 'Z-Report',
        subtitle: store[0]?.name ?? '',
        meta: [
          ['Shift', shift.id],
          ['Cashier', cashier[0]?.fullName ?? ''],
          ['Opened', shift.openedAt.toISOString()],
          ['Closed', shift.closedAt?.toISOString() ?? 'still open'],
          ['Opening float', String(shift.openingFloat / 100)],
          ['Expected cash', String(expectedCash / 100)],
          ['Counted cash', shift.countedCash !== null ? String(shift.countedCash / 100) : 'not counted'],
          ['Variance', payload.variance !== null ? String(payload.variance / 100) : 'n/a'],
        ],
        sections: [
          {
            title: 'Takings by tender',
            columns: [
              { key: 'method', label: 'Method' },
              { key: 'count', label: 'Count', align: 'right' },
              { key: 'total', label: 'Total', money: true },
            ],
            rows: summary.tenders,
          },
        ],
      }),
    );
  });
}

function requireRange(from?: string, to?: string): { from: Date; to: Date } {
  if (!from || !to) throw badRequest('This report needs a from and to date');
  return { from: new Date(from), to: new Date(to) };
}

/** Exporting bulk data is a distinct privilege from viewing a report on screen. */
function assertExportAllowed(request: { auth?: { permissions: Set<string> } }, format: ReportFormat): void {
  if (format === 'json') return;
  if (!request.auth?.permissions.has('report:export')) {
    throw badRequest('You do not have permission to export reports');
  }
}

function audit(request: Parameters<typeof writeAuditSafe>[0], report: string, format: string): void {
  writeAuditSafe(request, {
    action: 'REPORT_EXPORTED',
    entityType: 'REPORT',
    entityId: report,
    changes: { format },
  });
}

function sendCsv(reply: FastifyReply, label: string, body: string) {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${safeFilename(label, 'csv')}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .send(body);
}

function sendPdf(reply: FastifyReply, label: string, body: Buffer) {
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `attachment; filename="${safeFilename(label, 'pdf')}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .send(body);
}
