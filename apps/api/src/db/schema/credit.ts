import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cents, createdAt, pk, tsCol, updatedAt } from './columns.js';
import { creditTransactionTypeEnum, paymentMethodEnum } from './enums.js';
import { customers } from './customers.js';
import { sales, shifts } from './sales.js';
import { stores } from './org.js';
import { users } from './identity.js';

/** A customer's account is scoped to one store; its balance is a cache of the ledger. */
export const creditAccounts = pgTable(
  'credit_accounts',
  {
    id: pk(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    creditLimit: cents('credit_limit').notNull().default(0),
    balance: cents('balance').notNull().default(0),
    termsDays: integer('terms_days').notNull().default(30),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('credit_accounts_customer_store_uq').on(t.customerId, t.storeId),
    index('credit_accounts_store_balance_idx').on(t.storeId, t.balance),
  ],
);

/** Signed, append-only accounts receivable ledger. Debits are positive; credits negative. */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: pk(),
    accountId: uuid('account_id').notNull().references(() => creditAccounts.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
    type: creditTransactionTypeEnum('type').notNull(),
    /** Positive creates debt; negative is a repayment, credit note or reversal. */
    amount: cents('amount').notNull(),
    balanceAfter: cents('balance_after').notNull(),
    paymentMethod: paymentMethodEnum('payment_method'),
    reference: text('reference'),
    note: text('note'),
    dueAt: tsCol('due_at'),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('credit_transactions_sale_charge_uq')
      .on(t.accountId, t.saleId)
      .where(sql`${t.type} = 'CHARGE'`),
    uniqueIndex('credit_transactions_reference_uq')
      .on(t.storeId, t.paymentMethod, t.reference)
      .where(sql`${t.reference} IS NOT NULL`),
    index('credit_transactions_account_created_idx').on(t.accountId, t.createdAt),
    index('credit_transactions_account_due_idx').on(t.accountId, t.dueAt),
    index('credit_transactions_shift_idx').on(t.shiftId, t.createdAt),
  ],
);

/** Assign repayments and credit notes to specific open charges for statements and aging. */
export const creditAllocations = pgTable(
  'credit_allocations',
  {
    id: pk(),
    creditTransactionId: uuid('credit_transaction_id')
      .notNull().references(() => creditTransactions.id, { onDelete: 'restrict' }),
    chargeTransactionId: uuid('charge_transaction_id')
      .notNull().references(() => creditTransactions.id, { onDelete: 'restrict' }),
    amount: cents('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('credit_allocations_pair_uq').on(t.creditTransactionId, t.chargeTransactionId),
    index('credit_allocations_charge_idx').on(t.chargeTransactionId),
  ],
);
