import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['ADMIN', 'MANAGER', 'CASHIER', 'AUDITOR']);
export const saleStatusEnum = pgEnum('sale_status', [
  'DRAFT', 'PENDING_PAYMENT', 'COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED',
]);
export const paymentMethodEnum = pgEnum('payment_method', [
  'CASH', 'MPESA', 'PDQ', 'STORE_CREDIT', 'LOYALTY_POINTS', 'GIFT_CARD', 'BANK_TRANSFER', 'ON_ACCOUNT',
]);
export const paymentStatusEnum = pgEnum('payment_status', [
  'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REVERSED', 'EXPIRED',
]);
export const stockReasonEnum = pgEnum('stock_reason', [
  'SALE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT',
  'STOCK_COUNT', 'DAMAGE', 'THEFT', 'EXPIRY', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE',
]);
export const taxCodeEnum = pgEnum('tax_code', ['STANDARD', 'ZERO_RATED', 'EXEMPT']);
export const uomEnum = pgEnum('unit_of_measure', ['EACH', 'KG', 'LITRE', 'METRE', 'PACK']);
export const discountTypeEnum = pgEnum('discount_type', ['PERCENTAGE', 'FIXED_AMOUNT']);
export const syncStatusEnum = pgEnum('sync_status', ['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'DEAD_LETTER']);
export const qbEntityEnum = pgEnum('qb_entity', [
  'SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'ITEM',
  'CUSTOMER', 'INVENTORY_ADJUSTMENT', 'JOURNAL_ENTRY',
]);
export const shiftStatusEnum = pgEnum('shift_status', ['OPEN', 'CLOSED', 'RECONCILED']);
export const backupStatusEnum = pgEnum('backup_status', ['RUNNING', 'SUCCESS', 'FAILED', 'VERIFIED']);
