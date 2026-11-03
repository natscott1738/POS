import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  creditAccountCreateSchema,
  creditAccountUpdateSchema,
  creditAccountsQuery,
  creditAdjustmentSchema,
  creditPaymentSchema,
  uuid,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { creditAccounts, creditAllocations, creditTransactions, customers, shifts, payments, mpesaTransactions } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { assertStoreAccess, getAuth, requirePermissions, visibleStoreIds } from '../../auth/context.js';
import { conflict, forbidden, notFound } from '../../core/errors.js';
import { isUniqueViolation, withIdempotency } from '../../core/idempotency.js';
import { writeAudit } from '../../core/audit.js';
import { allocationsForCharges, postCreditNote } from './service.js';
import { enqueueQbSync } from '../quickbooks/queue.js';

const accountIdParam = z.object({ id: uuid });
const eligibilityQuery = z.object({ customerId: uuid, storeId: uuid });

export async function creditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/eligibility', { preHandler: requirePermissions('credit:charge') }, async (request) => {
    const query = parseQuery(request, eligibilityQuery);
    assertStoreAccess(request, query.storeId);
    const [account] = await db.select({
      id: creditAccounts.id,
      customerId: creditAccounts.customerId,
      storeId: creditAccounts.storeId,
      creditLimit: creditAccounts.creditLimit,
      balance: creditAccounts.balance,
      termsDays: creditAccounts.termsDays,
      isActive: creditAccounts.isActive,
      customerActive: customers.isActive,
    }).from(creditAccounts)
      .innerJoin(customers, eq(customers.id, creditAccounts.customerId))
      .where(and(eq(creditAccounts.customerId, query.customerId), eq(creditAccounts.storeId, query.storeId), isNull(customers.deletedAt)))
      .limit(1);
    if (!account) return { account: null, available: 0 };
    const available = account.isActive && account.customerActive ? Math.max(0, account.creditLimit - account.balance) : 0;
    return { account, available };
  });

  app.get('/accounts', { preHandler: requirePermissions('credit:read') }, async (request) => {
    const query = parseQuery(request, creditAccountsQuery);
    const allowed = visibleStoreIds(request);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    if (allowed && allowed.length === 0) return { accounts: [] };

    const conditions = [
      isNull(customers.deletedAt),
      query.storeId ? eq(creditAccounts.storeId, query.storeId) : allowed ? inArray(creditAccounts.storeId, allowed) : sql`true`,
    ];
    if (query.q) {
      const term = `%${query.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      conditions.push(sql`(${ilike(customers.fullName, term)} OR ${ilike(customers.phone, term)} OR ${ilike(customers.email, term)})`);
    }
    if (query.status === 'OPEN') conditions.push(gt(creditAccounts.balance, 0));
    if (query.status === 'CLOSED') conditions.push(eq(creditAccounts.isActive, false));
    if (query.status === 'OVERDUE') conditions.push(eq(creditAccounts.isActive, true));

    const rows = await db.select({
      id: creditAccounts.id,
      customerId: creditAccounts.customerId,
      storeId: creditAccounts.storeId,
      customerName: customers.fullName,
      phone: customers.phone,
      creditLimit: creditAccounts.creditLimit,
      balance: creditAccounts.balance,
      termsDays: creditAccounts.termsDays,
      isActive: creditAccounts.isActive,
      createdAt: creditAccounts.createdAt,
    }).from(creditAccounts)
      .innerJoin(customers, eq(customers.id, creditAccounts.customerId))
      .where(and(...conditions))
      .orderBy(desc(creditAccounts.balance), asc(customers.fullName))
      .limit(query.limit);

    const metrics = await accountMetrics(rows.map((row) => row.id));
    const accounts = rows.map((row) => ({
      ...row,
      balance: Number(row.balance),
      creditLimit: Number(row.creditLimit),
      available: row.isActive ? Math.max(0, Number(row.creditLimit) - Number(row.balance)) : 0,
      overdue: metrics.get(row.id)?.overdue ?? 0,
      openInvoices: metrics.get(row.id)?.openInvoices ?? 0,
    })).filter((row) => query.status !== 'OVERDUE' || row.overdue > 0);
    return { accounts };
  });

  app.post('/accounts', { preHandler: requirePermissions('credit:manage') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, creditAccountCreateSchema);
    assertStoreAccess(request, input.storeId);
    if (input.newCustomer && !auth.permissions.has('customer:write')) {
      throw forbidden('You may not create a customer profile while opening a credit account');
    }

    try {
      const result = await db.transaction(async (tx) => {
        let customerId = input.customerId;
        let customerCreated = false;

        if (input.newCustomer) {
          const [createdCustomer] = await tx.insert(customers).values({
            fullName: input.newCustomer.fullName,
            phone: input.newCustomer.phone ?? null,
            email: input.newCustomer.email ?? null,
            isActive: true,
            createdBy: auth.userId,
          }).returning({ id: customers.id });
          if (!createdCustomer) throw conflict('Could not create the customer profile');
          customerId = createdCustomer.id;
          customerCreated = true;

          await writeAudit(tx, request, {
            action: 'CUSTOMER_CREATED_FOR_CREDIT',
            entityType: 'CUSTOMER',
            entityId: customerId,
            changes: {
              fullName: input.newCustomer.fullName,
              hasPhone: Boolean(input.newCustomer.phone),
              hasEmail: Boolean(input.newCustomer.email),
            },
          });
        }

        if (!customerId) throw conflict('Choose a customer before opening the account');

        const [customer] = await tx.select({ id: customers.id, isActive: customers.isActive, deletedAt: customers.deletedAt })
          .from(customers).where(eq(customers.id, customerId)).limit(1).for('update');
        if (!customer || customer.deletedAt) throw notFound('Customer');

        // Opening an account is the manager's approval to use customer credit.
        // Reactivate an existing profile so its new account can be used at checkout.
        if (!customer.isActive) {
          await tx.update(customers).set({ isActive: true, updatedAt: new Date() }).where(eq(customers.id, customerId));
          await writeAudit(tx, request, {
            action: 'CUSTOMER_REACTIVATED_FOR_CREDIT',
            entityType: 'CUSTOMER',
            entityId: customerId,
            storeId: input.storeId,
            changes: { isActive: true },
          });
        }

        const [existing] = await tx.select().from(creditAccounts)
          .where(and(eq(creditAccounts.customerId, customerId), eq(creditAccounts.storeId, input.storeId)))
          .limit(1).for('update');
        if (existing) {
          const [updated] = await tx.update(creditAccounts).set({
            creditLimit: input.creditLimit,
            termsDays: input.termsDays,
            isActive: true,
            updatedAt: new Date(),
          }).where(eq(creditAccounts.id, existing.id)).returning();
          return { account: updated!, customerId, customerCreated };
        }
        const [created] = await tx.insert(creditAccounts).values({
          customerId,
          storeId: input.storeId,
          creditLimit: input.creditLimit,
          termsDays: input.termsDays,
          createdBy: auth.userId,
        }).returning();
        if (!created) throw conflict('Could not open a credit account');
        return { account: created, customerId, customerCreated };
      });

      await writeAudit(db, request, {
        action: 'CREDIT_ACCOUNT_OPENED', entityType: 'CREDIT_ACCOUNT', entityId: result.account.id,
        storeId: input.storeId, changes: {
          customerId: result.customerId,
          customerCreated: result.customerCreated,
          creditLimit: input.creditLimit,
          termsDays: input.termsDays,
        },
      });
      return reply.status(201).send({ account: result.account, customerCreated: result.customerCreated });
    } catch (err) {
      if (isUniqueViolation(err)) {
        if (input.newCustomer?.phone) {
          throw conflict('A customer with that phone number already exists. Find the existing profile and open the account on it.');
        }
        throw conflict('A credit account already exists for this customer at this store');
      }
      throw err;
    }
  });

  app.get('/accounts/:id', { preHandler: requirePermissions('credit:read') }, async (request) => {
    const { id } = parseParams(request, accountIdParam);
    const [row] = await db.select({ account: creditAccounts, customer: customers })
      .from(creditAccounts).innerJoin(customers, eq(customers.id, creditAccounts.customerId))
      .where(and(eq(creditAccounts.id, id), isNull(customers.deletedAt))).limit(1);
    if (!row) throw notFound('Credit account');
    assertStoreAccess(request, row.account.storeId);

    const transactions = await db.select().from(creditTransactions)
      .where(eq(creditTransactions.accountId, id))
      .orderBy(desc(creditTransactions.createdAt)).limit(500);
    const chargeIds = transactions.filter((entry) => entry.amount > 0).map((entry) => entry.id);
    const applied = await allocationsForCharges(db, chargeIds);
    const creditIds = transactions.filter((entry) => entry.amount < 0).map((entry) => entry.id);
    const creditAppliedRows = creditIds.length > 0
      ? await db.select({
          id: creditAllocations.creditTransactionId,
          amount: sql<number>`COALESCE(SUM(${creditAllocations.amount}), 0)::bigint`.as('amount'),
        }).from(creditAllocations).where(inArray(creditAllocations.creditTransactionId, creditIds))
          .groupBy(creditAllocations.creditTransactionId)
      : [];
    const creditApplied = new Map(creditAppliedRows.map((entry) => [entry.id, Number(entry.amount)]));

    return {
      account: { ...row.account, creditLimit: Number(row.account.creditLimit), balance: Number(row.account.balance) },
      customer: row.customer,
      transactions: transactions.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        balanceAfter: Number(entry.balanceAfter),
        openAmount: entry.amount > 0 ? Math.max(0, Number(entry.amount) - (applied.get(entry.id) ?? 0)) : 0,
        unappliedAmount: entry.amount < 0 ? Math.max(0, -Number(entry.amount) - (creditApplied.get(entry.id) ?? 0)) : 0,
      })),
    };
  });

  app.patch('/accounts/:id', { preHandler: requirePermissions('credit:manage') }, async (request) => {
    const { id } = parseParams(request, accountIdParam);
    const input = parseBody(request, creditAccountUpdateSchema);
    const [existing] = await db.select().from(creditAccounts).where(eq(creditAccounts.id, id)).limit(1);
    if (!existing) throw notFound('Credit account');
    assertStoreAccess(request, existing.storeId);
    const [account] = await db.update(creditAccounts).set({
      ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}),
      ...(input.termsDays !== undefined ? { termsDays: input.termsDays } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(eq(creditAccounts.id, id)).returning();
    await writeAudit(db, request, {
      action: 'CREDIT_ACCOUNT_UPDATED', entityType: 'CREDIT_ACCOUNT', entityId: id,
      storeId: existing.storeId, changes: input,
    });
    return { account };
  });

  app.post('/accounts/:id/payments', { preHandler: requirePermissions('credit:collect') }, async (request, reply) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, accountIdParam);
    const input = parseBody(request, creditPaymentSchema);
    const { result, replayed } = await withIdempotency(
      { scope: 'credit:payment', key: input.clientPaymentId, request: input, userId: auth.userId },
      async (tx) => {
      const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.id, id)).limit(1).for('update');
      if (!account) throw notFound('Credit account');
      assertStoreAccess(request, account.storeId);

      if (input.reference) {
        const [alreadyCaptured] = await tx.select({ id: payments.id }).from(payments)
          .where(eq(payments.externalReference, input.reference.toUpperCase())).limit(1);
        const [alreadyInDaraja] = input.method === 'MPESA'
          ? await tx.select({ id: mpesaTransactions.id }).from(mpesaTransactions)
              .where(eq(mpesaTransactions.confirmationCode, input.reference.toUpperCase())).limit(1)
          : [];
        const [alreadyOnAccount] = await tx.select({ id: creditTransactions.id }).from(creditTransactions)
          .where(and(eq(creditTransactions.paymentMethod, input.method), eq(creditTransactions.reference, input.reference.toUpperCase()))).limit(1);
        if (alreadyCaptured || alreadyInDaraja || alreadyOnAccount) throw conflict('That payment reference has already been recorded');
      }

      let shiftId: string | null = null;
      if (input.method === 'CASH') {
        if (!input.shiftId) throw conflict('Open a shift before receiving a cash payment');
        const [shift] = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).limit(1).for('update');
        if (!shift || shift.storeId !== account.storeId || shift.status !== 'OPEN') {
          throw conflict('Cash payments must be assigned to an open shift at this store');
        }
        shiftId = shift.id;
      }

      const payment = await postCreditNote(tx, {
        accountId: id,
        storeId: account.storeId,
        type: 'PAYMENT',
        amount: -input.amount,
        paymentMethod: input.method,
        reference: input.reference?.toUpperCase() ?? null,
        note: input.note ?? null,
        shiftId,
        recordedBy: auth.userId,
        rejectOverpayment: true,
      });
      await enqueueQbSync(tx, { storeId: account.storeId, entity: 'PAYMENT', localId: payment.transactionId });
      await writeAudit(tx, request, {
        action: 'CREDIT_PAYMENT_RECEIVED', entityType: 'CREDIT_ACCOUNT', entityId: id,
        storeId: account.storeId,
        changes: { amount: input.amount, method: input.method, reference: input.reference ?? null, balance: payment.balance },
      });
      return { result: payment, resourceId: payment.transactionId };
    });
    return reply.status(replayed ? 200 : 201).send({ ...result, replayed });
  });

  app.post('/accounts/:id/adjustments', { preHandler: requirePermissions('credit:manage') }, async (request, reply) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, accountIdParam);
    const input = parseBody(request, creditAdjustmentSchema);
    const result = await db.transaction(async (tx) => {
      const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.id, id)).limit(1).for('update');
      if (!account) throw notFound('Credit account');
      assertStoreAccess(request, account.storeId);
      const newBalance = account.balance + input.amount;
      if (input.amount > 0 && newBalance > account.creditLimit) throw conflict('Adjustment would exceed the credit limit');
      if (input.amount < 0) {
        return postCreditNote(tx, {
          accountId: id, storeId: account.storeId, type: 'ADJUSTMENT', amount: input.amount,
          note: input.reason, recordedBy: auth.userId,
        });
      }
      const [entry] = await tx.insert(creditTransactions).values({
        accountId: id, storeId: account.storeId, type: 'ADJUSTMENT', amount: input.amount,
        balanceAfter: newBalance, dueAt: input.dueAt ? new Date(input.dueAt) : new Date(),
        note: input.reason, recordedBy: auth.userId,
      }).returning({ id: creditTransactions.id });
      await tx.update(creditAccounts).set({ balance: newBalance, updatedAt: new Date() }).where(eq(creditAccounts.id, id));
      await tx.update(customers).set({ balance: sql`${customers.balance} + ${input.amount}`, updatedAt: new Date() })
        .where(eq(customers.id, account.customerId));
      return { transactionId: entry!.id, balance: newBalance };
    });

    await writeAudit(db, request, {
      action: 'CREDIT_ADJUSTED', entityType: 'CREDIT_ACCOUNT', entityId: id,
      changes: { amount: input.amount, reason: input.reason, balance: result.balance },
    });
    return reply.status(201).send(result);
  });
}

async function accountMetrics(accountIds: string[]): Promise<Map<string, { overdue: number; openInvoices: number }>> {
  if (accountIds.length === 0) return new Map();
  const charges = await db.select().from(creditTransactions)
    .where(and(inArray(creditTransactions.accountId, accountIds), gt(creditTransactions.amount, 0)));
  const applied = await allocationsForCharges(db, charges.map((entry) => entry.id));
  const now = Date.now();
  const metrics = new Map<string, { overdue: number; openInvoices: number }>();
  for (const charge of charges) {
    const open = Math.max(0, Number(charge.amount) - (applied.get(charge.id) ?? 0));
    if (open === 0) continue;
    const metric = metrics.get(charge.accountId) ?? { overdue: 0, openInvoices: 0 };
    metric.openInvoices += 1;
    if (charge.dueAt && charge.dueAt.getTime() < now) metric.overdue += open;
    metrics.set(charge.accountId, metric);
  }
  return metrics;
}
