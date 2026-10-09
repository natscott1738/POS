import { z } from 'zod';
import { uuid, safeText, quantityMilli, nonNegativeCents } from './common.js';
import { STOCK_MOVEMENT_REASON } from '../enums.js';

export const stockAdjustmentSchema = z.object({
  storeId: uuid,
  variantId: uuid,
  /** Signed delta in thousandths of a unit. */
  quantityDelta: quantityMilli.refine((v) => v !== 0, 'delta may not be zero'),
  reason: z.enum(STOCK_MOVEMENT_REASON),
  note: safeText(300),
  unitCost: nonNegativeCents.optional(),
});

export const goodsReceiptSchema = z.object({
  storeId: uuid,
  supplierName: safeText(120),
  reference: safeText(64),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  lines: z
    .array(
      z.object({
        variantId: uuid,
        quantity: quantityMilli.min(1),
        unitCost: nonNegativeCents,
      }),
    )
    .min(1)
    .max(500),
});

export const stockCountSchema = z.object({
  storeId: uuid,
  reference: safeText(64),
  lines: z
    .array(z.object({ variantId: uuid, countedQuantity: quantityMilli.min(0) }))
    .min(1)
    .max(2000),
});

export const stockTransferSchema = z.object({
  fromStoreId: uuid,
  toStoreId: uuid,
  reference: safeText(64),
  lines: z.array(z.object({ variantId: uuid, quantity: quantityMilli.min(1) })).min(1).max(500),
}).refine((v) => v.fromStoreId !== v.toStoreId, { message: 'source and destination must differ', path: ['toStoreId'] });

export const lowStockQuery = z.object({
  storeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;
