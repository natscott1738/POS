import { z } from 'zod';
import { uuid, safeText, optionalSafeText, nonNegativeCents, basisPoints, quantityMilli } from './common.js';

export const barcodeSchema = z.string().trim().regex(/^[A-Za-z0-9._-]{4,64}$/, 'invalid barcode');
export const skuSchema = z.string().trim().regex(/^[A-Za-z0-9._-]{2,64}$/, 'invalid SKU');

export const categorySchema = z.object({
  name: safeText(80),
  parentId: uuid.nullable().optional(),
  qbIncomeAccountId: optionalSafeText(64),
});

/** A variant axis, e.g. { name: "Size", values: ["S","M","L"] }. */
export const variantAxisSchema = z.object({
  name: safeText(40),
  values: z.array(safeText(40)).min(1).max(64),
});

export const variantSchema = z.object({
  id: uuid.optional(),
  sku: skuSchema,
  barcode: barcodeSchema.nullable().optional(),
  /** Axis name to value, e.g. { Size: "M", Color: "Navy" }. */
  attributes: z.record(safeText(40), safeText(40)).default({}),
  unitPrice: nonNegativeCents,
  costPrice: nonNegativeCents.default(0),
  reorderPoint: quantityMilli.min(0).default(0),
  reorderQuantity: quantityMilli.min(0).default(0),
  isActive: z.boolean().default(true),
});

export const productSchema = z.object({
  name: safeText(160),
  description: optionalSafeText(2000),
  categoryId: uuid.nullable().optional(),
  /** 1600 === 16.00% VAT. Zero-rated and exempt goods use 0 with distinct taxCode. */
  taxRateBasisPoints: basisPoints.default(1600),
  taxCode: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']).default('STANDARD'),
  /** Weighted goods priced per kg are sold in fractional quantities. */
  unitOfMeasure: z.enum(['EACH', 'KG', 'LITRE', 'METRE', 'PACK']).default('EACH'),
  trackInventory: z.boolean().default(true),
  axes: z.array(variantAxisSchema).max(3).default([]),
  variants: z.array(variantSchema).min(1).max(256),
  qbItemId: optionalSafeText(64),
  isActive: z.boolean().default(true),
});

export const updateProductSchema = productSchema.partial();

export const productSearchQuery = z.object({
  q: z.string().trim().max(120).optional(),
  categoryId: uuid.optional(),
  barcode: barcodeSchema.optional(),
  includeInactive: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ProductInput = z.infer<typeof productSchema>;
export type VariantInput = z.infer<typeof variantSchema>;
