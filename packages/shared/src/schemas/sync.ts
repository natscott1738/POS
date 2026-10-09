import { z } from 'zod';
import { uuid, isoDate } from './common.js';
import { createSaleSchema, createRefundSchema, openShiftSchema, closeShiftSchema } from './sales.js';
import { customerSchema } from './customers.js';
import { stockAdjustmentSchema } from './inventory.js';

/**
 * Offline operations are shipped as an ordered, append-only batch. Every op carries
 * a client-minted UUID that doubles as the idempotency key, so replaying a batch
 * after a flaky connection can never duplicate a sale.
 */
export const syncOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SALE_CREATE'), opId: uuid, occurredAt: isoDate, payload: createSaleSchema }),
  z.object({ type: z.literal('REFUND_CREATE'), opId: uuid, occurredAt: isoDate, payload: createRefundSchema }),
  z.object({
    type: z.literal('SALE_VOID'),
    opId: uuid,
    occurredAt: isoDate,
    payload: z.object({ saleId: uuid.optional(), clientSaleId: uuid.optional(), reason: z.string().min(1).max(300) }),
  }),
  z.object({ type: z.literal('CUSTOMER_CREATE'), opId: uuid, occurredAt: isoDate, payload: customerSchema.extend({ clientCustomerId: uuid }) }),
  z.object({ type: z.literal('STOCK_ADJUST'), opId: uuid, occurredAt: isoDate, payload: stockAdjustmentSchema }),
  z.object({ type: z.literal('SHIFT_OPEN'), opId: uuid, occurredAt: isoDate, payload: openShiftSchema.extend({ clientShiftId: uuid }) }),
  z.object({ type: z.literal('SHIFT_CLOSE'), opId: uuid, occurredAt: isoDate, payload: closeShiftSchema.extend({ clientShiftId: uuid }) }),
]);

export const syncPushSchema = z.object({
  deviceId: uuid,
  storeId: uuid,
  terminalId: uuid,
  /** Monotonic per-device counter; lets the server detect gaps in a replayed batch. */
  batchSequence: z.number().int().min(0),
  operations: z.array(syncOperationSchema).min(1).max(200),
});

export const syncPullQuery = z.object({
  deviceId: uuid,
  storeId: uuid,
  /** Opaque high-water mark returned by the previous pull. */
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const syncOperationResultSchema = z.object({
  opId: uuid,
  status: z.enum(['APPLIED', 'DUPLICATE', 'REJECTED', 'DEFERRED']),
  serverId: uuid.nullable(),
  receiptNumber: z.string().nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
});

export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
export type SyncOperationResult = z.infer<typeof syncOperationResultSchema>;
