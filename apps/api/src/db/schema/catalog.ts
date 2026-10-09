import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, pk, qty, tsCol, updatedAt } from './columns.js';
import { taxCodeEnum, uomEnum } from './enums.js';
import { users } from './identity.js';

export const categories = pgTable(
  'categories',
  {
    id: pk(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    qbIncomeAccountId: text('qb_income_account_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('categories_parent_idx').on(t.parentId)],
);

export const products = pgTable(
  'products',
  {
    id: pk(),
    name: text('name').notNull(),
    description: text('description'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull().default(1600),
    taxCode: taxCodeEnum('tax_code').notNull().default('STANDARD'),
    unitOfMeasure: uomEnum('unit_of_measure').notNull().default('EACH'),
    trackInventory: boolean('track_inventory').notNull().default(true),
    /** Variant axes, e.g. [{ name: "Size", values: ["S","M"] }]. */
    axes: jsonb('axes').notNull().default([]),
    qbItemId: text('qb_item_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tsCol('deleted_at'),
  },
  (t) => [
    index('products_category_idx').on(t.categoryId),
    index('products_active_idx').on(t.isActive),
  ],
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: pk(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    barcode: text('barcode'),
    /** { Size: "M", Color: "Navy" } */
    attributes: jsonb('attributes').notNull().default({}),
    unitPrice: cents('unit_price').notNull(),
    costPrice: cents('cost_price').notNull().default(0),
    reorderPoint: qty('reorder_point').notNull().default(0),
    reorderQuantity: qty('reorder_quantity').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tsCol('deleted_at'),
  },
  (t) => [
    uniqueIndex('variants_sku_uq').on(t.sku),
    uniqueIndex('variants_barcode_uq').on(t.barcode),
    index('variants_product_idx').on(t.productId),
  ],
);

/**
 * Every price change is recorded. An offline sale that arrives days late is
 * re-priced against the price that was effective when it happened, not today's.
 */
export const priceHistory = pgTable(
  'price_history',
  {
    id: pk(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    unitPrice: cents('unit_price').notNull(),
    costPrice: cents('cost_price').notNull().default(0),
    effectiveFrom: tsCol('effective_from').notNull().defaultNow(),
    effectiveTo: tsCol('effective_to'),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('price_history_variant_idx').on(t.variantId, t.effectiveFrom)],
);
