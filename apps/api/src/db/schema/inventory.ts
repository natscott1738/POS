import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cents, createdAt, pk, qty, tsCol, updatedAt } from './columns.js';
import { stockReasonEnum } from './enums.js';
import { productVariants } from './catalog.js';
import { stores } from './org.js';
import { users } from './identity.js';

/**
 * Current on-hand per variant per store. This is a *cache* of the movement ledger,
 * kept correct by updating it inside the same transaction that writes the movement.
 */
export const stockLevels = pgTable(
  'stock_levels',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    quantityOnHand: qty('quantity_on_hand').notNull().default(0),
    /** Held by parked/unsettled sales so two tills cannot promise the same last unit. */
    quantityReserved: qty('quantity_reserved').notNull().default(0),
    /** Moving-average cost, maintained on every receipt. */
    averageCost: cents('average_cost').notNull().default(0),
    lastCountedAt: tsCol('last_counted_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('stock_levels_store_variant_uq').on(t.storeId, t.variantId),
    index('stock_levels_variant_idx').on(t.variantId),
  ],
);

/** Append-only ledger. Stock on hand is always reconstructable by summing this. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    /** Signed delta in thousandths. */
    quantityDelta: qty('quantity_delta').notNull(),
    /** Running balance after this movement, for point-in-time reporting without replay. */
    balanceAfter: qty('balance_after').notNull(),
    reason: stockReasonEnum('reason').notNull(),
    unitCost: cents('unit_cost'),
    /** Sale, refund, receipt or transfer that caused this. */
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    note: text('note'),
    performedBy: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: tsCol('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_movements_variant_idx').on(t.storeId, t.variantId, t.occurredAt),
    index('stock_movements_reference_idx').on(t.referenceType, t.referenceId),
    index('stock_movements_occurred_idx').on(t.occurredAt),
  ],
);

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    supplierName: text('supplier_name').notNull(),
    reference: text('reference').notNull(),
    totalCost: cents('total_cost').notNull().default(0),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    receivedAt: tsCol('received_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('goods_receipts_store_idx').on(t.storeId, t.receivedAt)],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: pk(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantity: qty('quantity').notNull(),
    unitCost: cents('unit_cost').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('goods_receipt_lines_receipt_idx').on(t.receiptId)],
);

/** Raised when on-hand crosses the reorder point; resolved when it recovers. */
export const stockAlerts = pgTable(
  'stock_alerts',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    quantityAtTrigger: qty('quantity_at_trigger').notNull(),
    reorderPoint: qty('reorder_point').notNull(),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: tsCol('acknowledged_at'),
    resolvedAt: tsCol('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_alerts_open_idx').on(t.storeId, t.resolvedAt),
    // At most one unresolved alert per (store, variant, kind).
    uniqueIndex('stock_alerts_active_uq')
      .on(t.storeId, t.variantId, t.kind)
      .where(sql`resolved_at IS NULL`),
  ],
);

