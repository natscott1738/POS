import { boolean, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, pk, tsCol, updatedAt } from './columns.js';
import { users } from './identity.js';

export const customers = pgTable(
  'customers',
  {
    id: pk(),
    clientCustomerId: uuid('client_customer_id'),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    email: text('email'),
    taxPin: text('tax_pin'),
    address: text('address'),
    dateOfBirth: date('date_of_birth'),
    notes: text('notes'),
    /** Explicit, timestamped consent. Marketing without it is a DPA breach. */
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    marketingConsentAt: tsCol('marketing_consent_at'),
    creditLimit: cents('credit_limit').notNull().default(0),
    balance: cents('balance').notNull().default(0),
    loyaltyPoints: integer('loyalty_points').notNull().default(0),
    totalSpent: cents('total_spent').notNull().default(0),
    visitCount: integer('visit_count').notNull().default(0),
    lastVisitAt: tsCol('last_visit_at'),
    qbCustomerId: text('qb_customer_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tsCol('deleted_at'),
  },
  (t) => [
    uniqueIndex('customers_phone_uq').on(t.phone),
    uniqueIndex('customers_client_id_uq').on(t.clientCustomerId),
    index('customers_name_idx').on(t.fullName),
    index('customers_email_idx').on(t.email),
  ],
);

/** Append-only points ledger; `customers.loyaltyPoints` is the running cache. */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: pk(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    saleId: uuid('sale_id'),
    /** Positive on earn, negative on redeem/expiry. */
    points: integer('points').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason'),
    expiresAt: tsCol('expires_at'),
    performedBy: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('loyalty_tx_customer_idx').on(t.customerId, t.createdAt),
    index('loyalty_tx_expiry_idx').on(t.expiresAt),
  ],
);
