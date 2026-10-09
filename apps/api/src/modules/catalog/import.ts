import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../../db/client.js';
import { products, productVariants, priceHistory, categories, changeLog } from '../../db/schema/index.js';
import { applyStockMovement } from '../inventory/service.js';
import { writeAudit } from '../../core/audit.js';
import { badRequest } from '../../core/errors.js';

/**
 * CSV catalogue import.
 *
 * Every shop arrives with a spreadsheet, and typing several hundred products by
 * hand is where go-live timelines go to die. Import is deliberately strict:
 * it validates the whole file first and applies nothing unless every row is
 * sound, because a half-imported catalogue is worse than none.
 */

export interface ImportRow {
  name: string;
  sku: string;
  barcode?: string;
  category?: string;
  variantLabel?: string;
  unitPrice: number;
  costPrice: number;
  taxCode: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  unitOfMeasure: 'EACH' | 'KG' | 'LITRE' | 'METRE' | 'PACK';
  reorderPoint: number;
  openingStock: number;
}

export interface ImportIssue {
  row: number;
  field: string;
  message: string;
}

export interface ImportPreview {
  rows: ImportRow[];
  issues: ImportIssue[];
  summary: { products: number; variants: number; withStock: number };
}

/** Parses CSV, including quoted fields containing commas and embedded quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip a UTF-8 BOM, which Excel adds and which otherwise corrupts the first header.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADERS = [
  'name', 'sku', 'barcode', 'category', 'variant', 'price', 'cost',
  'tax', 'unit', 'reorder_point', 'opening_stock',
] as const;

/** Money arrives as "1,234.50" from spreadsheets; convert without float maths. */
function toCents(raw: string): number | null {
  const clean = raw.replace(/[,\s]/g, '').replace(/^KES/i, '');
  if (!clean) return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', frac = ''] = clean.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return clean.startsWith('-') ? -cents : cents;
}

function toMilli(raw: string): number | null {
  const clean = raw.replace(/[,\s]/g, '');
  if (!clean) return 0;
  if (!/^-?\d+(\.\d{1,3})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 1000);
}

export function validateImport(text: string): ImportPreview {
  const grid = parseCsv(text);
  if (grid.length < 2) throw badRequest('The file has no data rows');

  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = ['name', 'sku', 'price'].filter((required) => !header.includes(required));
  if (missing.length > 0) {
    throw badRequest(
      `The file is missing required columns: ${missing.join(', ')}`,
      HEADERS.map((h) => ({ path: h, message: header.includes(h) ? 'present' : 'not found' })),
    );
  }

  const index = (name: string) => header.indexOf(name);
  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seenSku = new Set<string>();
  const seenBarcode = new Set<string>();

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    const at = (name: string) => (index(name) >= 0 ? (cells[index(name)] ?? '').trim() : '');
    const rowNumber = i + 1;

    const name = at('name');
    const sku = at('sku').toUpperCase();
    const barcode = at('barcode');
    const price = toCents(at('price'));
    const cost = toCents(at('cost'));
    const reorder = toMilli(at('reorder_point'));
    const opening = toMilli(at('opening_stock'));

    if (!name) issues.push({ row: rowNumber, field: 'name', message: 'required' });
    if (!/^[A-Z0-9._-]{2,64}$/.test(sku)) {
      issues.push({ row: rowNumber, field: 'sku', message: 'must be 2-64 letters, digits, dot, dash or underscore' });
    }
    if (seenSku.has(sku)) issues.push({ row: rowNumber, field: 'sku', message: `duplicate of an earlier row` });
    seenSku.add(sku);

    if (barcode) {
      if (!/^[A-Za-z0-9._-]{4,64}$/.test(barcode)) {
        issues.push({ row: rowNumber, field: 'barcode', message: 'invalid characters' });
      }
      if (seenBarcode.has(barcode)) {
        issues.push({ row: rowNumber, field: 'barcode', message: 'duplicate of an earlier row' });
      }
      seenBarcode.add(barcode);
    }

    if (price === null) issues.push({ row: rowNumber, field: 'price', message: 'not a valid amount' });
    if (cost === null) issues.push({ row: rowNumber, field: 'cost', message: 'not a valid amount' });
    if (reorder === null) issues.push({ row: rowNumber, field: 'reorder_point', message: 'not a valid quantity' });
    if (opening === null) issues.push({ row: rowNumber, field: 'opening_stock', message: 'not a valid quantity' });

    const taxRaw = at('tax').toUpperCase().replace(/[\s-]/g, '_');
    const taxCode =
      taxRaw === '' || taxRaw === 'STANDARD' || taxRaw === '16' || taxRaw === '16%'
        ? 'STANDARD'
        : taxRaw === 'ZERO' || taxRaw === 'ZERO_RATED' || taxRaw === '0' || taxRaw === '0%'
          ? 'ZERO_RATED'
          : taxRaw === 'EXEMPT'
            ? 'EXEMPT'
            : null;
    if (!taxCode) {
      issues.push({ row: rowNumber, field: 'tax', message: 'use STANDARD, ZERO_RATED or EXEMPT' });
    }

    const unitRaw = at('unit').toUpperCase();
    const unitOfMeasure = (unitRaw === '' ? 'EACH' : unitRaw) as ImportRow['unitOfMeasure'];
    if (!['EACH', 'KG', 'LITRE', 'METRE', 'PACK'].includes(unitOfMeasure)) {
      issues.push({ row: rowNumber, field: 'unit', message: 'use EACH, KG, LITRE, METRE or PACK' });
    }

    rows.push({
      name,
      sku,
      ...(barcode ? { barcode } : {}),
      ...(at('category') ? { category: at('category') } : {}),
      ...(at('variant') ? { variantLabel: at('variant') } : {}),
      unitPrice: price ?? 0,
      costPrice: cost ?? 0,
      taxCode: taxCode ?? 'STANDARD',
      unitOfMeasure,
      reorderPoint: reorder ?? 0,
      openingStock: opening ?? 0,
    });
  }

  // Rows sharing a product name are variants of one product.
  const productNames = new Set(rows.map((r) => r.name));

  return {
    rows,
    issues,
    summary: {
      products: productNames.size,
      variants: rows.length,
      withStock: rows.filter((r) => r.openingStock > 0).length,
    },
  };
}

export interface ImportResult {
  productsCreated: number;
  variantsCreated: number;
  variantsSkipped: number;
  stockMovements: number;
}

/**
 * Applies a validated import. Runs in one transaction: either the whole
 * catalogue lands or none of it does.
 */
export async function applyImport(
  request: FastifyRequest,
  input: { storeId: string; rows: ImportRow[]; userId: string },
): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const result: ImportResult = { productsCreated: 0, variantsCreated: 0, variantsSkipped: 0, stockMovements: 0 };

    // Reuse categories by name rather than creating duplicates.
    const categoryCache = new Map<string, string>();
    for (const row of input.rows) {
      if (!row.category || categoryCache.has(row.category)) continue;
      const [existing] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.name, row.category)).limit(1);
      if (existing) {
        categoryCache.set(row.category, existing.id);
      } else {
        const [created] = await tx.insert(categories).values({ name: row.category }).returning({ id: categories.id });
        if (created) categoryCache.set(row.category, created.id);
      }
    }

    // Group rows into products by name, so sizes and colours become variants.
    const byProduct = new Map<string, ImportRow[]>();
    for (const row of input.rows) {
      const list = byProduct.get(row.name) ?? [];
      list.push(row);
      byProduct.set(row.name, list);
    }

    for (const [name, variantRows] of byProduct) {
      const first = variantRows[0] as ImportRow;

      const [product] = await tx
        .insert(products)
        .values({
          name,
          categoryId: first.category ? (categoryCache.get(first.category) ?? null) : null,
          taxCode: first.taxCode,
          taxRateBasisPoints: first.taxCode === 'STANDARD' ? 1600 : 0,
          unitOfMeasure: first.unitOfMeasure,
          trackInventory: true,
          axes: [],
        })
        .returning({ id: products.id });

      if (!product) continue;
      result.productsCreated++;

      for (const row of variantRows) {
        // An existing SKU is skipped rather than overwritten: re-running an
        // import must not silently reprice live products.
        const [clash] = await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(and(eq(productVariants.sku, row.sku), isNull(productVariants.deletedAt)))
          .limit(1);
        if (clash) {
          result.variantsSkipped++;
          continue;
        }

        const [variant] = await tx
          .insert(productVariants)
          .values({
            productId: product.id,
            sku: row.sku,
            barcode: row.barcode ?? null,
            attributes: row.variantLabel ? { Variant: row.variantLabel } : {},
            unitPrice: row.unitPrice,
            costPrice: row.costPrice,
            reorderPoint: row.reorderPoint,
            reorderQuantity: row.reorderPoint * 2,
          })
          .returning({ id: productVariants.id });

        if (!variant) continue;
        result.variantsCreated++;

        await tx.insert(priceHistory).values({
          variantId: variant.id,
          unitPrice: row.unitPrice,
          costPrice: row.costPrice,
          changedBy: input.userId,
          reason: 'Catalogue import',
        });

        if (row.openingStock > 0) {
          await applyStockMovement(tx, {
            storeId: input.storeId,
            variantId: variant.id,
            quantityDelta: row.openingStock,
            reason: 'OPENING_BALANCE',
            unitCost: row.costPrice,
            note: 'Catalogue import',
            performedBy: input.userId,
            allowNegative: true,
          });
          result.stockMovements++;
        }

        await tx.insert(changeLog).values({
          entityType: 'PRODUCT',
          entityId: product.id,
          operation: 'CREATE',
          payload: { name, sku: row.sku },
        });
      }
    }

    await writeAudit(tx, request, {
      action: 'CATALOGUE_IMPORTED',
      entityType: 'PRODUCT',
      entityId: null,
      storeId: input.storeId,
      changes: result,
    });

    return result;
  });
}

/** The template a shop fills in. Kept here so it cannot drift from the parser. */
export function importTemplate(): string {
  return [
    'name,sku,barcode,category,variant,price,cost,tax,unit,reorder_point,opening_stock',
    'Kenyan AA Coffee 500g,COF-AA-500,6001234500024,Beverages,,1200.00,780.00,STANDARD,EACH,10,50',
    'Cotton T-Shirt,TSH-NVY-M,6001234500048,Apparel,Navy / M,850.00,420.00,STANDARD,EACH,5,20',
    'Cotton T-Shirt,TSH-NVY-L,6001234500055,Apparel,Navy / L,850.00,420.00,STANDARD,EACH,5,20',
    'Maize Flour 2kg,FLR-2KG,6001234500086,Groceries,,180.00,140.00,ZERO_RATED,EACH,24,100',
    '',
  ].join('\n');
}
