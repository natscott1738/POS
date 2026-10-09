import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { productSchema, updateProductSchema, productSearchQuery, categorySchema, uuid, barcodeSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { products, productVariants, categories, priceHistory, stockLevels, changeLog } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth } from '../../auth/context.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { labelFor } from '../sales/pricing-guard.js';
import { isUniqueViolation } from '../../core/idempotency.js';
import { validateImport, applyImport, importTemplate } from './import.js';

const idParam = z.object({ id: uuid });

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Till search. Barcode is matched exactly and first, because that is the
   * fast path a cashier uses hundreds of times a day.
   */
  app.get('/products/search', { preHandler: requirePermissions('product:read') }, async (request) => {
    const query = parseQuery(request, productSearchQuery);
    const storeId = (request.query as { storeId?: string }).storeId;

    const conditions = [isNull(products.deletedAt), isNull(productVariants.deletedAt)];
    if (!query.includeInactive) {
      conditions.push(eq(products.isActive, true), eq(productVariants.isActive, true));
    }
    if (query.categoryId) conditions.push(eq(products.categoryId, query.categoryId));

    if (query.barcode) {
      conditions.push(eq(productVariants.barcode, query.barcode));
    } else if (query.q) {
      const term = `%${query.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      conditions.push(
        or(
          ilike(products.name, term),
          ilike(productVariants.sku, term),
          eq(productVariants.barcode, query.q),
        )!,
      );
    }

    const rows = await db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        name: products.name,
        sku: productVariants.sku,
        barcode: productVariants.barcode,
        attributes: productVariants.attributes,
        unitPrice: productVariants.unitPrice,
        taxRateBasisPoints: products.taxRateBasisPoints,
        taxCode: products.taxCode,
        unitOfMeasure: products.unitOfMeasure,
        trackInventory: products.trackInventory,
        categoryId: products.categoryId,
        quantityOnHand: stockLevels.quantityOnHand,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(
        stockLevels,
        storeId
          ? and(eq(stockLevels.variantId, productVariants.id), eq(stockLevels.storeId, storeId))
          : sql`false`,
      )
      .where(and(...conditions))
      .orderBy(asc(products.name))
      .limit(query.limit);

    return {
      results: rows.map((r) => ({ ...r, variantLabel: labelFor(r.attributes) })),
    };
  });

  /** Barcode scan: one variant or nothing, so the till can act without a picker. */
  app.get('/products/barcode/:barcode', { preHandler: requirePermissions('product:read') }, async (request) => {
    const { barcode } = parseParams(request, z.object({ barcode: barcodeSchema }));
    const [row] = await db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        name: products.name,
        sku: productVariants.sku,
        barcode: productVariants.barcode,
        attributes: productVariants.attributes,
        unitPrice: productVariants.unitPrice,
        taxRateBasisPoints: products.taxRateBasisPoints,
        taxCode: products.taxCode,
        unitOfMeasure: products.unitOfMeasure,
        trackInventory: products.trackInventory,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.barcode, barcode),
          eq(productVariants.isActive, true),
          eq(products.isActive, true),
          isNull(productVariants.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw notFound('Product');
    return { ...row, variantLabel: labelFor(row.attributes) };
  });

  app.get('/products', { preHandler: requirePermissions('product:read') }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(200).optional(),
        includeInactive: z.coerce.boolean().default(false),
        categoryId: uuid.optional(),
      }),
    );

    const conditions = [isNull(products.deletedAt)];
    if (!query.includeInactive) conditions.push(eq(products.isActive, true));
    if (query.categoryId) conditions.push(eq(products.categoryId, query.categoryId));
    if (query.cursor) conditions.push(sql`${products.name} > ${query.cursor}`);

    const rows = await db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.name))
      .limit(query.limit);

    const variants = rows.length
      ? await db
          .select()
          .from(productVariants)
          .where(
            and(
              inArray(
                productVariants.productId,
                rows.map((r) => r.id),
              ),
              isNull(productVariants.deletedAt),
            ),
          )
      : [];

    const last = rows[rows.length - 1];
    return {
      products: rows.map((p) => ({
        ...p,
        variants: variants.filter((v) => v.productId === p.id),
      })),
      nextCursor: rows.length === query.limit && last ? last.name : null,
    };
  });

  app.get('/products/:id', { preHandler: requirePermissions('product:read') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!product) throw notFound('Product');
    const variants = await db.select().from(productVariants).where(eq(productVariants.productId, id));
    return { product, variants };
  });

  app.post('/products', { preHandler: requirePermissions('product:write') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, productSchema);
    assertVariantsMatchAxes(input);

    const created = await db.transaction(async (tx) => {
      const [product] = await tx
        .insert(products)
        .values({
          name: input.name,
          description: input.description ?? null,
          categoryId: input.categoryId ?? null,
          taxRateBasisPoints: input.taxRateBasisPoints,
          taxCode: input.taxCode,
          unitOfMeasure: input.unitOfMeasure,
          trackInventory: input.trackInventory,
          axes: input.axes,
          qbItemId: input.qbItemId ?? null,
          isActive: input.isActive,
        })
        .returning();

      if (!product) throw conflict('Could not create product');

      const variants = [];
      for (const variant of input.variants) {
        const [row] = await tx
          .insert(productVariants)
          .values({
            productId: product.id,
            sku: variant.sku,
            barcode: variant.barcode ?? null,
            attributes: variant.attributes,
            unitPrice: variant.unitPrice,
            costPrice: variant.costPrice,
            reorderPoint: variant.reorderPoint,
            reorderQuantity: variant.reorderQuantity,
            isActive: variant.isActive,
          })
          .returning();
        if (!row) continue;
        variants.push(row);
        // Seed the price timeline so an offline sale can always be re-priced.
        await tx.insert(priceHistory).values({
          variantId: row.id,
          unitPrice: variant.unitPrice,
          costPrice: variant.costPrice,
          changedBy: auth.userId,
          reason: 'Initial price',
        });
      }

      await tx.insert(changeLog).values({
        entityType: 'PRODUCT',
        entityId: product.id,
        operation: 'CREATE',
        payload: { name: product.name },
      });

      await writeAudit(tx, request, {
        action: 'PRODUCT_CREATED',
        entityType: 'PRODUCT',
        entityId: product.id,
        changes: { name: product.name, variantCount: variants.length },
      });

      return { product, variants };
    }).catch((err) => {
      if (isUniqueViolation(err)) throw conflict('A product with that SKU or barcode already exists');
      throw err;
    });

    return reply.status(201).send(created);
  });

  app.patch('/products/:id', { preHandler: requirePermissions('product:write') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const input = parseBody(request, updateProductSchema);

    const [existing] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!existing) throw notFound('Product');

    const updated = await db.transaction(async (tx) => {
      const [product] = await tx
        .update(products)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.taxRateBasisPoints !== undefined ? { taxRateBasisPoints: input.taxRateBasisPoints } : {}),
          ...(input.taxCode !== undefined ? { taxCode: input.taxCode } : {}),
          ...(input.unitOfMeasure !== undefined ? { unitOfMeasure: input.unitOfMeasure } : {}),
          ...(input.trackInventory !== undefined ? { trackInventory: input.trackInventory } : {}),
          ...(input.axes !== undefined ? { axes: input.axes } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(products.id, id))
        .returning();

      await tx.insert(changeLog).values({
        entityType: 'PRODUCT',
        entityId: id,
        operation: 'UPDATE',
        payload: { name: product?.name },
      });

      await writeAudit(tx, request, {
        action: 'PRODUCT_UPDATED',
        entityType: 'PRODUCT',
        entityId: id,
        changes: { before: { name: existing.name, isActive: existing.isActive }, after: input },
      });

      return product;
    });

    return { product: updated };
  });

  /**
   * Price changes close the current history window and open a new one, so an
   * offline sale that arrives later is still booked at the right price.
   */
  app.patch('/variants/:id/price', { preHandler: requirePermissions('product:write') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const input = parseBody(
      request,
      z.object({
        unitPrice: z.number().int().min(0),
        costPrice: z.number().int().min(0).optional(),
        reason: z.string().trim().min(1).max(200),
      }),
    );

    const [variant] = await db.select().from(productVariants).where(eq(productVariants.id, id)).limit(1);
    if (!variant) throw notFound('Variant');

    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(priceHistory)
        .set({ effectiveTo: now })
        .where(and(eq(priceHistory.variantId, id), isNull(priceHistory.effectiveTo)));

      await tx.insert(priceHistory).values({
        variantId: id,
        unitPrice: input.unitPrice,
        costPrice: input.costPrice ?? variant.costPrice,
        effectiveFrom: now,
        changedBy: auth.userId,
        reason: input.reason,
      });

      await tx
        .update(productVariants)
        .set({
          unitPrice: input.unitPrice,
          ...(input.costPrice !== undefined ? { costPrice: input.costPrice } : {}),
          updatedAt: now,
        })
        .where(eq(productVariants.id, id));

      await tx.insert(changeLog).values({
        entityType: 'VARIANT',
        entityId: id,
        operation: 'PRICE_CHANGE',
        payload: { unitPrice: input.unitPrice },
      });

      await writeAudit(tx, request, {
        action: 'PRICE_CHANGED',
        entityType: 'VARIANT',
        entityId: id,
        reason: input.reason,
        changes: { from: variant.unitPrice, to: input.unitPrice },
      });
    });

    return { ok: true };
  });

  app.delete('/products/:id', { preHandler: requirePermissions('product:delete') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const [existing] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!existing) throw notFound('Product');

    // Soft delete only: sale lines reference variants and history must stay intact.
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(products).set({ deletedAt: now, isActive: false }).where(eq(products.id, id));
      await tx
        .update(productVariants)
        .set({ deletedAt: now, isActive: false })
        .where(eq(productVariants.productId, id));
      await writeAudit(tx, request, {
        action: 'PRODUCT_DELETED',
        entityType: 'PRODUCT',
        entityId: id,
        changes: { name: existing.name },
      });
    });

    return { ok: true };
  });

  /* ---------------------------------- Import --------------------------------- */

  /** The CSV shape a shop fills in. Served as a download from the UI. */
  app.get('/import/template', { preHandler: requirePermissions('product:write') }, async (_request, reply) => {
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="product-import-template.csv"')
      .send(importTemplate());
  });

  /**
   * Validates a file without writing anything, so the shop sees every problem
   * before committing. A half-imported catalogue is worse than no import.
   */
  app.post(
    '/import/validate',
    { preHandler: requirePermissions('product:write'), bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const input = parseBody(request, z.object({ csv: z.string().min(1).max(8_000_000) }));
      return validateImport(input.csv);
    },
  );

  app.post(
    '/import/apply',
    { preHandler: requirePermissions('product:write'), bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const auth = getAuth(request);
      const input = parseBody(
        request,
        z.object({ storeId: uuid, csv: z.string().min(1).max(8_000_000) }),
      );

      const preview = validateImport(input.csv);
      // Refuse outright rather than importing the good rows and leaving a mess.
      if (preview.issues.length > 0) {
        throw badRequest(
          `The file has ${preview.issues.length} problem(s); fix them and try again`,
          preview.issues.slice(0, 25).map((i) => ({ path: `row ${i.row} · ${i.field}`, message: i.message })),
        );
      }

      const result = await applyImport(request, {
        storeId: input.storeId,
        rows: preview.rows,
        userId: auth.userId,
      });
      return reply.status(201).send(result);
    },
  );

  /* -------------------------------- Categories ------------------------------- */

  app.get('/categories', { preHandler: requirePermissions('product:read') }, async () => {
    return { categories: await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name)) };
  });

  app.post('/categories', { preHandler: requirePermissions('product:write') }, async (request, reply) => {
    const input = parseBody(request, categorySchema);
    const [category] = await db
      .insert(categories)
      .values({
        name: input.name,
        parentId: input.parentId ?? null,
        qbIncomeAccountId: input.qbIncomeAccountId ?? null,
      })
      .returning();
    await writeAudit(db, request, {
      action: 'CATEGORY_CREATED',
      entityType: 'CATEGORY',
      entityId: category?.id ?? null,
      changes: { name: input.name },
    });
    return reply.status(201).send({ category });
  });
}

/** Every variant must describe exactly the axes the product declares. */
function assertVariantsMatchAxes(input: z.infer<typeof productSchema>): void {
  if (input.axes.length === 0) return;
  const axisNames = input.axes.map((a) => a.name);
  const seen = new Set<string>();

  for (const variant of input.variants) {
    const keys = Object.keys(variant.attributes);
    const missing = axisNames.filter((a) => !keys.includes(a));
    if (missing.length > 0) {
      throw badRequest(`Variant ${variant.sku} is missing ${missing.join(', ')}`);
    }
    for (const axis of input.axes) {
      const value = variant.attributes[axis.name];
      if (value && !axis.values.includes(value)) {
        throw badRequest(`Variant ${variant.sku}: "${value}" is not a valid ${axis.name}`);
      }
    }
    // Two variants with the same attribute combination are indistinguishable at the till.
    const signature = axisNames.map((a) => variant.attributes[a]).join('|');
    if (seen.has(signature)) throw badRequest(`Duplicate variant combination: ${signature}`);
    seen.add(signature);
  }
}
