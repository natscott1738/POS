import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, pk, tsCol, updatedAt } from './columns.js';
import { paymentStatusEnum } from './enums.js';
import { stores, terminals, pdqTerminals } from './org.js';
import { sales } from './sales.js';
import { users } from './identity.js';

/**
 * One row per M-PESA interaction, created the moment the STK push is sent so an
 * unanswered callback still leaves a trace to reconcile against.
 */
export const mpesaTransactions = pgTable(
  'mpesa_transactions',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    /** Set before the sale exists, so the confirmation can be matched on arrival. */
    clientSaleId: uuid('client_sale_id'),

    kind: text('kind').notNull().default('STK_PUSH'),
    status: paymentStatusEnum('status').notNull().default('PENDING'),
    amount: cents('amount').notNull(),
    phone: text('phone').notNull(),
    accountReference: text('account_reference').notNull(),

    /** Daraja identifiers. CheckoutRequestID is the key we poll and match on. */
    merchantRequestId: text('merchant_request_id'),
    checkoutRequestId: text('checkout_request_id'),
    /** The customer-facing confirmation code, e.g. "SFE4G8H2K1". */
    confirmationCode: text('confirmation_code'),
    resultCode: integer('result_code'),
    resultDescription: text('result_description'),
    /** Amount Safaricom actually confirmed; may differ from what was requested. */
    confirmedAmount: cents('confirmed_amount'),
    payerName: text('payer_name'),
    transactionDate: tsCol('transaction_date'),

    /** Raw callback kept verbatim for dispute resolution. */
    rawCallback: jsonb('raw_callback'),
    /** Guards against the same confirmation being applied to two sales. */
    reconciledAt: tsCol('reconciled_at'),
    reconciledBy: uuid('reconciled_by').references(() => users.id, { onDelete: 'set null' }),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tsCol('expires_at'),
    lastPolledAt: tsCol('last_polled_at'),
    pollAttempts: integer('poll_attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mpesa_checkout_request_uq').on(t.checkoutRequestId),
    uniqueIndex('mpesa_confirmation_code_uq').on(t.confirmationCode),
    index('mpesa_sale_idx').on(t.saleId),
    index('mpesa_client_sale_idx').on(t.clientSaleId),
    index('mpesa_status_idx').on(t.status, t.createdAt),
    index('mpesa_phone_idx').on(t.phone, t.createdAt),
  ],
);

/** Unmatched paybill receipts land here until a cashier links them to a sale. */
export const mpesaUnmatchedPayments = pgTable(
  'mpesa_unmatched_payments',
  {
    id: pk(),
    transactionId: text('transaction_id').notNull(),
    amount: cents('amount').notNull(),
    phone: text('phone'),
    payerName: text('payer_name'),
    billReference: text('bill_reference'),
    transactionTime: tsCol('transaction_time'),
    raw: jsonb('raw').notNull(),
    matchedSaleId: uuid('matched_sale_id').references(() => sales.id, { onDelete: 'set null' }),
    matchedAt: tsCol('matched_at'),
    matchedBy: uuid('matched_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mpesa_unmatched_txid_uq').on(t.transactionId),
    index('mpesa_unmatched_open_idx').on(t.matchedSaleId, t.createdAt),
  ],
);

export const pdqTransactions = pgTable(
  'pdq_transactions',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    pdqTerminalId: uuid('pdq_terminal_id').references(() => pdqTerminals.id, { onDelete: 'set null' }),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    clientSaleId: uuid('client_sale_id'),

    /** Our reference, echoed by the terminal so we can match the async result. */
    transactionRef: text('transaction_ref').notNull(),
    kind: text('kind').notNull().default('PURCHASE'),
    status: paymentStatusEnum('status').notNull().default('PENDING'),
    amount: cents('amount').notNull(),

    authCode: text('auth_code'),
    /** Only ever the masked form; a full PAN must never reach this database. */
    maskedPan: text('masked_pan'),
    cardScheme: text('card_scheme'),
    responseCode: text('response_code'),
    responseMessage: text('response_message'),
    /** Printed slip text returned by the terminal, for the customer copy. */
    terminalReceipt: text('terminal_receipt'),
    rawResponse: jsonb('raw_response'),

    reversedAt: tsCol('reversed_at'),
    reversalReason: text('reversal_reason'),
    settledAt: tsCol('settled_at'),
    reconciledAt: tsCol('reconciled_at'),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tsCol('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pdq_transaction_ref_uq').on(t.transactionRef),
    index('pdq_sale_idx').on(t.saleId),
    index('pdq_status_idx').on(t.status, t.createdAt),
    index('pdq_store_date_idx').on(t.storeId, t.createdAt),
  ],
);
