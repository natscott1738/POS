import { and, eq, inArray, isNull, lte, or, gt, desc } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { priceHistory, productVariants, products } from '../../db/schema/index.js';
import { badRequest } from '../../core/errors.js';

export interface AuthoritativeVariant {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  variantLabel: string | null;
  unitPrice: number;
  costPrice: number;
  taxRateBasisPoints: number;
  taxCode: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  trackInventory: boolean;
  isActive: boolean;
}

/**
 * Loads the price that was authoritative at `soldAt`, not the price today.
 * An offline sale that syncs three days later must be booked at the price the
 * customer actually paid, and a client-supplied price is never trusted.
 */
export async function loadAuthoritativeVariants(
  exec: Executor,
  variantIds: string[],
  soldAt: Date,
): Promise<Map<string, AuthoritativeVariant>> {
  if (variantIds.length === 0) return new Map();

  const rows = await exec
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
      attributes: productVariants.attributes,
      currentPrice: productVariants.unitPrice,
      costPrice: productVariants.costPrice,
      taxRateBasisPoints: products.taxRateBasisPoints,
      taxCode: products.taxCode,
      trackInventory: products.trackInventory,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
      variantDeleted: productVariants.deletedAt,
      productDeleted: products.deletedAt,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));

  const missing = variantIds.filter((id) => !rows.some((r) => r.variantId === id));
  if (missing.length > 0) {
    throw badRequest(
      'One or more items no longer exist',
      missing.map((id) => ({ path: `variantId:${id}`, message: 'unknown product variant' })),
    );
  }

  // Price rows effective at soldAt. The window is closed (effectiveTo) or open (null).
  const historical = await exec
    .select({
      variantId: priceHistory.variantId,
      unitPrice: priceHistory.unitPrice,
      costPrice: priceHistory.costPrice,
      effectiveFrom: priceHistory.effectiveFrom,
    })
    .from(priceHistory)
    .where(
      and(
        inArray(priceHistory.variantId, variantIds),
        lte(priceHistory.effectiveFrom, soldAt),
        or(isNull(priceHistory.effectiveTo), gt(priceHistory.effectiveTo, soldAt)),
      ),
    )
    .orderBy(desc(priceHistory.effectiveFrom));

  const effective = new Map<string, { unitPrice: number; costPrice: number }>();
  for (const row of historical) {
    // Ordered newest-first, so the first hit for a variant is the right one.
    if (!effective.has(row.variantId)) {
      effective.set(row.variantId, { unitPrice: row.unitPrice, costPrice: row.costPrice });
    }
  }

  const out = new Map<string, AuthoritativeVariant>();
  for (const row of rows) {
    const historic = effective.get(row.variantId);
    out.set(row.variantId, {
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
      sku: row.sku,
      variantLabel: labelFor(row.attributes),
      unitPrice: historic?.unitPrice ?? row.currentPrice,
      costPrice: historic?.costPrice ?? row.costPrice,
      taxRateBasisPoints: row.taxRateBasisPoints,
      taxCode: row.taxCode,
      trackInventory: row.trackInventory,
      isActive: row.variantActive && row.productActive && !row.variantDeleted && !row.productDeleted,
    });
  }
  return out;
}

/** "Size: M / Colour: Navy" — snapshotted onto the sale line for faithful reprints. */
export function labelFor(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object') return null;
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' / ');
}
