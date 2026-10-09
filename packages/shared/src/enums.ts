export const SALE_STATUS = ['DRAFT', 'PENDING_PAYMENT', 'COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export type SaleStatus = (typeof SALE_STATUS)[number];

export const PAYMENT_METHOD = ['CASH', 'MPESA', 'PDQ', 'STORE_CREDIT', 'LOYALTY_POINTS', 'GIFT_CARD', 'BANK_TRANSFER', 'ON_ACCOUNT'] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export const PAYMENT_STATUS = ['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REVERSED', 'EXPIRED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const DISCOUNT_TYPE = ['PERCENTAGE', 'FIXED_AMOUNT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPE)[number];

export const STOCK_MOVEMENT_REASON = [
  'SALE', 'SALE_VOID', 'REFUND', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT',
  'STOCK_COUNT', 'DAMAGE', 'THEFT', 'EXPIRY', 'MANUAL_ADJUSTMENT', 'OPENING_BALANCE',
] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASON)[number];

export const SYNC_STATUS = ['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'DEAD_LETTER'] as const;
export type SyncStatus = (typeof SYNC_STATUS)[number];

export const QB_ENTITY = ['SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'ITEM', 'CUSTOMER', 'INVENTORY_ADJUSTMENT', 'JOURNAL_ENTRY'] as const;
export type QbEntity = (typeof QB_ENTITY)[number];
