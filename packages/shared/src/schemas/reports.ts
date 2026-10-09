import { z } from 'zod';
import { uuid, isoDate } from './common.js';

export const reportFormat = z.enum(['json', 'csv', 'pdf']);

export const salesSummaryQuery = z.object({
  from: isoDate,
  to: isoDate,
  storeId: uuid.optional(),
  terminalId: uuid.optional(),
  cashierId: uuid.optional(),
  granularity: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  format: reportFormat.default('json'),
});

export const paymentBreakdownQuery = z.object({
  from: isoDate,
  to: isoDate,
  storeId: uuid.optional(),
  format: reportFormat.default('json'),
});

export const stockReportQuery = z.object({
  storeId: uuid.optional(),
  /** BESTSELLERS and DEAD_STOCK need a window; LOW_STOCK and VALUATION are point-in-time. */
  kind: z.enum(['LOW_STOCK', 'BESTSELLERS', 'DEAD_STOCK', 'VALUATION', 'MOVEMENTS']),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Days without a sale before an item counts as dead stock. */
  deadStockDays: z.coerce.number().int().min(7).max(3650).default(90),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  format: reportFormat.default('json'),
});

export const taxReportQuery = z.object({
  from: isoDate,
  to: isoDate,
  storeId: uuid.optional(),
  format: reportFormat.default('json'),
});

export const zReportQuery = z.object({ shiftId: uuid, format: reportFormat.default('json') });

export type SalesSummaryQuery = z.infer<typeof salesSummaryQuery>;
export type StockReportQuery = z.infer<typeof stockReportQuery>;
export type ReportFormat = z.infer<typeof reportFormat>;
