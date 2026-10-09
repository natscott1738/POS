import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, pk, qty, tsCol, updatedAt } from './columns.js';
import { discountTypeEnum, paymentMethodEnum, paymentStatusEnum, saleStatusEnum, shiftStatusEnum } from './enums.js';
import { stores, terminals } from './org.js';
import { users } from './identity.js';
import { productVariants } from './catalog.js';
import { customers } from './customers.js';

export const shifts = pgTable(
  'shifts',
  {
    id: pk(),
    /** Client-minted id so a shift opened offline keeps its identity. */
    clientShiftId: uuid('client_shift_id'),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id')
      .notNull()
      .references(() => terminals.id, { onDelete: 'restrict' }),
    cashierId: uuid('cashier_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: shiftStatusEnum('status').notNull().default('OPEN'),
    openingFloat: cents('opening_float').notNull().default(0),
    /** Counted at close; variance = countedCash - expectedCash. */
    countedCash: cents('counted_cash'),
    expectedCash: cents('expected_cash'),
    cashVariance: cents('cash_variance'),
    denominations: jsonb('denominations'),
    openedAt: tsCol('opened_at').notNull().defaultNow(),
    closedAt: tsCol('closed_at'),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('shifts_client_id_uq').on(t.clientShiftId),
    index('shifts_terminal_status_idx').on(t.terminalId, t.status),
    index('shifts_store_opened_idx').on(t.storeId, t.openedAt),
  ],
);

export const sales = pgTable(
  'sales',
  {
    id: pk(),
    /** Minted on the till. The uniqueness constraint here is what makes sync idempotent. */
    clientSaleId: uuid('client_sale_id').notNull(),
    receiptNumber: text('receipt_number').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id')
      .notNull()
      .references(() => terminals.id, { onDelete: 'restrict' }),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
    cashierId: uuid('cashier_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    status: saleStatusEnum('status').notNull().default('COMPLETED'),

    grossSubtotal: cents('gross_subtotal').notNull(),
    lineDiscountTotal: cents('line_discount_total').notNull().default(0),
    orderDiscountTotal: cents('order_discount_total').notNull().default(0),
    netTotal: cents('net_total').notNull(),
    taxTotal: cents('tax_total').notNull(),
    roundingAdjustment: cents('rounding_adjustment').notNull().default(0),
    total: cents('total').notNull(),
    /** Cash given back; informational, not part of the ledger balance. */
    changeGiven: cents('change_given').notNull().default(0),
    amountRefunded: cents('amount_refunded').notNull().default(0),

    orderDiscountType: discountTypeEnum('order_discount_type'),
    orderDiscountValue: integer('order_discount_value'),
    orderDiscountReason: text('order_discount_reason'),
    taxBreakdown: jsonb('tax_breakdown').notNull().default([]),

    currency: text('currency').notNull().default('KES'),
    note: text('note'),
    receiptEmail: text('receipt_email'),
    receiptPhone: text('receipt_phone'),
    loyaltyPointsEarned: integer('loyalty_points_earned').notNull().default(0),
    loyaltyPointsRedeemed: integer('loyalty_points_redeemed').notNull().default(0),

    /** True when the till was offline; these get a reconciliation review. */
    createdOffline: boolean('created_offline').notNull().default(false),
    /** Set when stock went negative because the till could not see live levels. */
    oversold: boolean('oversold').notNull().default(false),
    /** Set when the till's price disagreed with the authoritative price at soldAt. */
    repricedOnSync: boolean('repriced_on_sync').notNull().default(false),

    voidedAt: tsCol('voided_at'),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),
    /** Manager who authorised a void/refund/override on this sale. */
    overrideByUserId: uuid('override_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    soldAt: tsCol('sold_at').notNull(),
    syncedAt: tsCol('synced_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sales_client_id_uq').on(t.clientSaleId),
    uniqueIndex('sales_receipt_number_uq').on(t.receiptNumber),
    index('sales_store_sold_idx').on(t.storeId, t.soldAt),
    index('sales_cashier_idx').on(t.cashierId, t.soldAt),
    index('sales_customer_idx').on(t.customerId),
    index('sales_shift_idx').on(t.shiftId),
    index('sales_status_idx').on(t.status),
  ],
);

export const saleLines = pgTable(
  'sale_lines',
  {
    id: pk(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    clientLineId: uuid('client_line_id').notNull(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    lineNumber: integer('line_number').notNull(),

    /** Descriptive fields are snapshotted so a receipt reprint years later is faithful. */
    productName: text('product_name').notNull(),
    variantSku: text('variant_sku').notNull(),
    variantLabel: text('variant_label'),

    quantity: qty('quantity').notNull(),
    unitPrice: cents('unit_price').notNull(),
    unitCost: cents('unit_cost').notNull().default(0),
    grossSubtotal: cents('gross_subtotal').notNull(),
    lineDiscount: cents('line_discount').notNull().default(0),
    allocatedOrderDiscount: cents('allocated_order_discount').notNull().default(0),
    lineTotal: cents('line_total').notNull(),
    taxAmount: cents('tax_amount').notNull(),
    netAmount: cents('net_amount').notNull(),
    taxRateBasisPoints: integer('tax_rate_basis_points').notNull(),
    taxCode: text('tax_code').notNull(),

    discountType: discountTypeEnum('discount_type'),
    discountValue: integer('discount_value'),
    discountReason: text('discount_reason'),

    quantityRefunded: qty('quantity_refunded').notNull().default(0),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sale_lines_sale_client_uq').on(t.saleId, t.clientLineId),
    index('sale_lines_sale_idx').on(t.saleId),
    index('sale_lines_variant_idx').on(t.variantId),
  ],
);

/** One row per tender. A split payment is simply several rows against one sale. */
export const payments = pgTable(
  'payments',
  {
    id: pk(),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'cascade' }),
    refundId: uuid('refund_id'),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    method: paymentMethodEnum('method').notNull(),
    status: paymentStatusEnum('status').notNull().default('CAPTURED'),
    /** Negative for refunds, so summing this column always gives net takings. */
    amount: cents('amount').notNull(),
    tenderedAmount: cents('tendered_amount'),
    changeAmount: cents('change_amount').notNull().default(0),

    /** Links to the provider-specific record. */
    mpesaTransactionId: uuid('mpesa_transaction_id'),
    pdqTransactionId: uuid('pdq_transaction_id'),
    /** M-PESA confirmation code / PDQ auth code / bank reference. */
    externalReference: text('external_reference'),
    maskedPan: text('masked_pan'),
    cardScheme: text('card_scheme'),
    giftCardCode: text('gift_card_code'),
    loyaltyPoints: integer('loyalty_points'),

    reversedAt: tsCol('reversed_at'),
    reversalReason: text('reversal_reason'),
    capturedAt: tsCol('captured_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('payments_sale_idx').on(t.saleId),
    index('payments_refund_idx').on(t.refundId),
    index('payments_store_method_idx').on(t.storeId, t.method, t.capturedAt),
    index('payments_external_ref_idx').on(t.externalReference),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: pk(),
    clientRefundId: uuid('client_refund_id').notNull(),
    refundNumber: text('refund_number').notNull(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),
    processedBy: uuid('processed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    overrideByUserId: uuid('override_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    subtotal: cents('subtotal').notNull(),
    taxTotal: cents('tax_total').notNull(),
    total: cents('total').notNull(),
    reason: text('reason').notNull(),
    createdOffline: boolean('created_offline').notNull().default(false),
    refundedAt: tsCol('refunded_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refunds_client_id_uq').on(t.clientRefundId),
    uniqueIndex('refunds_number_uq').on(t.refundNumber),
    index('refunds_sale_idx').on(t.saleId),
    index('refunds_store_date_idx').on(t.storeId, t.refundedAt),
  ],
);

export const refundLines = pgTable(
  'refund_lines',
  {
    id: pk(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    saleLineId: uuid('sale_line_id')
      .notNull()
      .references(() => saleLines.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantity: qty('quantity').notNull(),
    unitPrice: cents('unit_price').notNull(),
    lineTotal: cents('line_total').notNull(),
    taxAmount: cents('tax_amount').notNull(),
    restocked: boolean('restocked').notNull().default(true),
    reason: text('reason').notNull().default('OTHER'),
    createdAt: createdAt(),
  },
  (t) => [
    index('refund_lines_refund_idx').on(t.refundId),
    index('refund_lines_sale_line_idx').on(t.saleLineId),
  ],
);
