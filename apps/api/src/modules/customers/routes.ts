import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { customerSchema, updateCustomerSchema, customerSearchQuery, loyaltyAdjustmentSchema, uuid } from '@pos/shared';
import { db } from '../../db/client.js';
import { customers, loyaltyTransactions, sales, creditAccounts } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth } from '../../auth/context.js';
import { conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { isUniqueViolation } from '../../core/idempotency.js';

const idParam = z.object({ id: uuid });

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requirePermissions('customer:read') }, async (request) => {
    const query = parseQuery(request, customerSearchQuery);
    const conditions = [isNull(customers.deletedAt)];

    if (query.phone) {
      conditions.push(eq(customers.phone, query.phone.replace(/^0/, '254')));
    } else if (query.q) {
      const term = `%${query.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      conditions.push(or(ilike(customers.fullName, term), ilike(customers.email, term), ilike(customers.phone, term))!);
    }
    if (query.cursor) conditions.push(sql`${customers.fullName} > ${query.cursor}`);

    const rows = await db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        phone: customers.phone,
        email: customers.email,
        loyaltyPoints: customers.loyaltyPoints,
        totalSpent: customers.totalSpent,
        visitCount: customers.visitCount,
        lastVisitAt: customers.lastVisitAt,
        balance: customers.balance,
        creditLimit: customers.creditLimit,
        isActive: customers.isActive,
      })
      .from(customers)
      .where(and(...conditions))
      .orderBy(customers.fullName)
      .limit(query.limit);

    const last = rows[rows.length - 1];
    return { customers: rows, nextCursor: rows.length === query.limit && last ? last.fullName : null };
  });

  app.get('/:id', { preHandler: requirePermissions('customer:read') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!customer) throw notFound('Customer');

    const [history, loyalty] = await Promise.all([
      db
        .select({
          id: sales.id,
          receiptNumber: sales.receiptNumber,
          total: sales.total,
          status: sales.status,
          soldAt: sales.soldAt,
        })
        .from(sales)
        .where(eq(sales.customerId, id))
        .orderBy(desc(sales.soldAt))
        .limit(25),
      db
        .select()
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.customerId, id))
        .orderBy(desc(loyaltyTransactions.createdAt))
        .limit(25),
    ]);

    return { customer, recentSales: history, loyaltyHistory: loyalty };
  });

  app.post('/', { preHandler: requirePermissions('customer:write') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, customerSchema);

    try {
      const [customer] = await db
        .insert(customers)
        .values({
          fullName: input.fullName,
          phone: input.phone ?? null,
          email: input.email ?? null,
          taxPin: input.taxPin?.toUpperCase() ?? null,
          address: input.address ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          notes: input.notes ?? null,
          marketingConsent: input.marketingConsent,
          // Consent is only meaningful with a timestamp proving when it was given.
          marketingConsentAt: input.marketingConsent ? new Date() : null,
          creditLimit: input.creditLimit,
          isActive: input.isActive,
          createdBy: auth.userId,
        })
        .returning();

      await writeAudit(db, request, {
        action: 'CUSTOMER_CREATED',
        entityType: 'CUSTOMER',
        entityId: customer?.id ?? null,
        changes: { fullName: input.fullName },
      });

      return reply.status(201).send({ customer });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A customer with that phone number already exists');
      throw err;
    }
  });

  app.patch('/:id', { preHandler: requirePermissions('customer:write') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const input = parseBody(request, updateCustomerSchema);

    const [existing] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!existing) throw notFound('Customer');

    const consentChanged =
      input.marketingConsent !== undefined && input.marketingConsent !== existing.marketingConsent;

    const [customer] = await db
      .update(customers)
      .set({
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.taxPin !== undefined ? { taxPin: input.taxPin?.toUpperCase() ?? null } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.marketingConsent !== undefined ? { marketingConsent: input.marketingConsent } : {}),
        ...(consentChanged ? { marketingConsentAt: input.marketingConsent ? new Date() : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, id))
      .returning();

    if (input.isActive === false) {
      await db.update(creditAccounts).set({ isActive: false, updatedAt: new Date() }).where(eq(creditAccounts.customerId, id));
    }

    await writeAudit(db, request, {
      action: 'CUSTOMER_UPDATED',
      entityType: 'CUSTOMER',
      entityId: id,
      changes: input,
    });

    return { customer };
  });

  /** Right-to-erasure: identifiers are cleared but the sales ledger stays intact. */
  app.delete('/:id', { preHandler: requirePermissions('customer:delete') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const [existing] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!existing) throw notFound('Customer');

    await db
      .update(customers)
      .set({
        deletedAt: new Date(),
        isActive: false,
        fullName: 'Deleted customer',
        phone: null,
        email: null,
        taxPin: null,
        address: null,
        notes: null,
        dateOfBirth: null,
        marketingConsent: false,
      })
      .where(eq(customers.id, id));
    await db.update(creditAccounts).set({ isActive: false, updatedAt: new Date() }).where(eq(creditAccounts.customerId, id));

    await writeAudit(db, request, {
      action: 'CUSTOMER_ERASED',
      entityType: 'CUSTOMER',
      entityId: id,
      changes: { reason: 'data subject erasure' },
    });

    return { ok: true };
  });

  app.post('/loyalty/adjust', { preHandler: requirePermissions('loyalty:adjust') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, loyaltyAdjustmentSchema);

    const result = await db.transaction(async (tx) => {
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1)
        .for('update');
      if (!customer) throw notFound('Customer');

      const balance = customer.loyaltyPoints + input.points;
      if (balance < 0) throw conflict('That adjustment would take the balance below zero');

      await tx.update(customers).set({ loyaltyPoints: balance }).where(eq(customers.id, input.customerId));
      await tx.insert(loyaltyTransactions).values({
        customerId: input.customerId,
        points: input.points,
        balanceAfter: balance,
        kind: 'MANUAL_ADJUSTMENT',
        reason: input.reason,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        performedBy: auth.userId,
      });

      await writeAudit(tx, request, {
        action: 'LOYALTY_ADJUSTED',
        entityType: 'CUSTOMER',
        entityId: input.customerId,
        reason: input.reason,
        changes: { points: input.points, balanceAfter: balance },
      });

      return { balance };
    });

    return result;
  });
}
