import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../../db/client.js';
import { creditAccounts, creditAllocations, creditTransactions, customers } from '../../db/schema/index.js';
import { conflict } from '../../core/errors.js';

/** Post one account charge and consume any unallocated customer credit against it. */
export async function postCreditCharge(tx: Tx, input: {
  accountId: string;
  storeId: string;
  saleId: string;
  amount: number;
  soldAt: Date;
  recordedBy: string;
}): Promise<void> {
  const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.id, input.accountId)).limit(1).for('update');
  if (!account) throw conflict('The customer credit account is no longer available');
  const newBalance = account.balance + input.amount;
  if (Math.max(0, newBalance) > account.creditLimit) {
    throw conflict('This sale would exceed the customer credit limit', {
      balance: account.balance,
      creditLimit: account.creditLimit,
      requested: input.amount,
    });
  }

  const dueAt = new Date(input.soldAt.getTime() + account.termsDays * 24 * 60 * 60 * 1000);
  const [charge] = await tx.insert(creditTransactions).values({
    accountId: account.id,
    storeId: input.storeId,
    saleId: input.saleId,
    type: 'CHARGE',
    amount: input.amount,
    balanceAfter: newBalance,
    dueAt,
    recordedBy: input.recordedBy,
  }).returning({ id: creditTransactions.id });
  if (!charge) throw conflict('Could not record the credit sale');

  await tx.update(creditAccounts).set({ balance: newBalance, updatedAt: new Date() }).where(eq(creditAccounts.id, account.id));
  await tx.update(customers).set({ balance: sql`${customers.balance} + ${input.amount}`, updatedAt: new Date() })
    .where(eq(customers.id, account.customerId));
  await allocateUnappliedCredits(tx, account.id, charge.id, input.amount);
}

/** Add a negative ledger entry and apply it to the oldest open invoices first. */
export async function postCreditNote(tx: Tx, input: {
  accountId: string;
  storeId: string;
  saleId?: string | null;
  type: 'PAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'VOID_REVERSAL';
  amount: number;
  paymentMethod?: 'CASH' | 'MPESA' | 'BANK_TRANSFER' | null;
  reference?: string | null;
  note?: string | null;
  shiftId?: string | null;
  targetChargeId?: string | null;
  recordedBy: string;
  rejectOverpayment?: boolean;
}): Promise<{ transactionId: string; balance: number }> {
  if (input.amount >= 0) throw new Error('Credit note amount must be negative');
  const [account] = await tx.select().from(creditAccounts).where(eq(creditAccounts.id, input.accountId)).limit(1).for('update');
  if (!account) throw conflict('The customer credit account is no longer available');
  if (input.rejectOverpayment && -input.amount > Math.max(0, account.balance)) {
    throw conflict('Payment exceeds the outstanding balance', {
      balance: Math.max(0, account.balance),
      requested: -input.amount,
    });
  }

  const newBalance = account.balance + input.amount;
  const [entry] = await tx.insert(creditTransactions).values({
    accountId: account.id,
    storeId: input.storeId,
    saleId: input.saleId ?? null,
    shiftId: input.shiftId ?? null,
    type: input.type,
    amount: input.amount,
    balanceAfter: newBalance,
    paymentMethod: input.paymentMethod ?? null,
    reference: input.reference ?? null,
    note: input.note ?? null,
    recordedBy: input.recordedBy,
  }).returning({ id: creditTransactions.id });
  if (!entry) throw conflict('Could not record the credit transaction');

  await tx.update(creditAccounts).set({ balance: newBalance, updatedAt: new Date() }).where(eq(creditAccounts.id, account.id));
  await tx.update(customers).set({ balance: sql`${customers.balance} + ${input.amount}`, updatedAt: new Date() })
    .where(eq(customers.id, account.customerId));
  if (input.targetChargeId) {
    const applied = await allocationsForCharges(tx, [input.targetChargeId]);
    const [charge] = await tx.select({ amount: creditTransactions.amount }).from(creditTransactions)
      .where(and(eq(creditTransactions.id, input.targetChargeId), eq(creditTransactions.accountId, account.id)))
      .limit(1);
    if (!charge) throw conflict('The related credit invoice could not be found');
    const open = Math.max(0, Number(charge.amount) - (applied.get(input.targetChargeId) ?? 0));
    const allocated = Math.min(-input.amount, open);
    if (allocated > 0) {
      await tx.insert(creditAllocations).values({ creditTransactionId: entry.id, chargeTransactionId: input.targetChargeId, amount: allocated });
    }
  } else {
    await allocateToOpenCharges(tx, account.id, entry.id, -input.amount);
  }
  return { transactionId: entry.id, balance: newBalance };
}

/** Allocate older, unconsumed credit (typically a credit note) when a new invoice arrives. */
async function allocateUnappliedCredits(tx: Tx, accountId: string, chargeId: string, amount: number): Promise<void> {
  const credits = await tx.select().from(creditTransactions)
    .where(and(eq(creditTransactions.accountId, accountId), lt(creditTransactions.amount, 0)))
    .orderBy(asc(creditTransactions.createdAt));
  if (credits.length === 0) return;
  const allocations = await tx.select({
    creditId: creditAllocations.creditTransactionId,
    applied: sql<number>`COALESCE(SUM(${creditAllocations.amount}), 0)::bigint`.as('applied'),
  }).from(creditAllocations)
    .where(inArray(creditAllocations.creditTransactionId, credits.map((credit) => credit.id)))
    .groupBy(creditAllocations.creditTransactionId);
  const appliedByCredit = new Map(allocations.map((row) => [row.creditId, Number(row.applied)]));

  let remaining = amount;
  for (const credit of credits) {
    const available = -credit.amount - (appliedByCredit.get(credit.id) ?? 0);
    const applied = Math.min(remaining, available);
    if (applied <= 0) continue;
    await tx.insert(creditAllocations).values({ creditTransactionId: credit.id, chargeTransactionId: chargeId, amount: applied });
    remaining -= applied;
    if (remaining === 0) break;
  }
}

/** Allocate one payment/credit note to open invoices, oldest due date first. */
async function allocateToOpenCharges(tx: Tx, accountId: string, creditId: string, amount: number): Promise<void> {
  const charges = await tx.select().from(creditTransactions)
    .where(and(eq(creditTransactions.accountId, accountId), gt(creditTransactions.amount, 0)))
    .orderBy(sql`${creditTransactions.dueAt} ASC NULLS LAST`, asc(creditTransactions.createdAt));
  if (charges.length === 0) return;
  const allocations = await tx.select({
    chargeId: creditAllocations.chargeTransactionId,
    applied: sql<number>`COALESCE(SUM(${creditAllocations.amount}), 0)::bigint`.as('applied'),
  }).from(creditAllocations)
    .where(inArray(creditAllocations.chargeTransactionId, charges.map((charge) => charge.id)))
    .groupBy(creditAllocations.chargeTransactionId);
  const appliedByCharge = new Map(allocations.map((row) => [row.chargeId, Number(row.applied)]));

  let remaining = amount;
  for (const charge of charges) {
    const open = charge.amount - (appliedByCharge.get(charge.id) ?? 0);
    const applied = Math.min(remaining, open);
    if (applied <= 0) continue;
    await tx.insert(creditAllocations).values({ creditTransactionId: creditId, chargeTransactionId: charge.id, amount: applied });
    remaining -= applied;
    if (remaining === 0) break;
  }
}

export async function allocationsForCharges(tx: Executor, chargeIds: string[]): Promise<Map<string, number>> {
  if (chargeIds.length === 0) return new Map();
  const rows = await tx.select({
    chargeId: creditAllocations.chargeTransactionId,
    amount: sql<number>`COALESCE(SUM(${creditAllocations.amount}), 0)::bigint`.as('amount'),
  }).from(creditAllocations)
    .where(inArray(creditAllocations.chargeTransactionId, chargeIds))
    .groupBy(creditAllocations.chargeTransactionId);
  return new Map(rows.map((row) => [row.chargeId, Number(row.amount)]));
}
