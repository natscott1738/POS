import { z } from 'zod';
import {
  uuid,
  safeText,
  optionalSafeText,
  nonNegativeCents,
  positiveCents,
  quantityMilli,
  basisPoints,
  isoDate,
  msisdn,
} from './common.js';
import { PAYMENT_METHOD, DISCOUNT_TYPE } from '../enums.js';

export const discountSchema = z.object({
  type: z.enum(DISCOUNT_TYPE),
  /** PERCENTAGE -> basis points; FIXED_AMOUNT -> cents. */
  value: z.number().int().min(0),
  reason: optionalSafeText(160),
  promotionId: uuid.nullable().optional(),
});

export const saleLineSchema = z.object({
  /** Client-generated so an offline line keeps its identity through sync. */
  clientLineId: uuid,
  variantId: uuid,
  quantity: quantityMilli.refine((v) => v > 0, 'quantity must be positive'),
  /**
   * Price the cashier saw. The server re-prices authoritatively and rejects
   * mismatches unless the actor holds `sale:price:override`.
   */
  unitPrice: nonNegativeCents,
  discount: discountSchema.nullable().optional(),
  note: optionalSafeText(200),
});

export const tenderSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('CASH'),
    amount: positiveCents,
    /** What the customer handed over; change = tendered - amount. */
    tendered: positiveCents,
  }),
  z.object({
    method: z.literal('MPESA'),
    amount: positiveCents,
    phone: msisdn,
    /** Present when the cashier keys in a confirmation code manually or replays offline. */
    confirmationCode: z.string().trim().regex(/^[A-Z0-9]{8,15}$/).optional(),
    mpesaTransactionId: uuid.optional(),
  }),
  z.object({
    method: z.literal('PDQ'),
    amount: positiveCents,
    pdqTransactionId: uuid.optional(),
    /** Terminal-returned data, captured for reconciliation. Never holds a PAN. */
    authCode: z.string().trim().max(32).optional(),
    maskedPan: z.string().trim().regex(/^\d{0,6}\*{0,12}\d{4}$/).optional(),
    cardScheme: z.enum(['VISA', 'MASTERCARD', 'AMEX', 'UNIONPAY', 'OTHER']).optional(),
  }),
  z.object({ method: z.literal('STORE_CREDIT'), amount: positiveCents }),
  z.object({ method: z.literal('LOYALTY_POINTS'), amount: positiveCents, points: z.number().int().min(1) }),
  z.object({ method: z.literal('GIFT_CARD'), amount: positiveCents, cardCode: z.string().trim().min(4).max(40) }),
  z.object({ method: z.literal('BANK_TRANSFER'), amount: positiveCents, reference: safeText(64) }),
  z.object({ method: z.literal('ON_ACCOUNT'), amount: positiveCents, customerId: uuid }),
]);

export const createSaleSchema = z.object({
  /** Stable identity minted on the till; makes retries and offline replay idempotent. */
  clientSaleId: uuid,
  storeId: uuid,
  terminalId: uuid,
  shiftId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  lines: z.array(saleLineSchema).min(1).max(500),
  orderDiscount: discountSchema.nullable().optional(),
  tenders: z.array(tenderSchema).min(1).max(10),
  /** Totals the till computed. Server recomputes and refuses to trust these. */
  declaredTotal: nonNegativeCents,
  /** When the sale actually happened; may predate the request by days when offline. */
  soldAt: isoDate,
  note: optionalSafeText(500),
  receiptEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  receiptPhone: msisdn.nullable().optional(),
  loyaltyPointsRedeemed: z.number().int().min(0).default(0),
});

export const voidSaleSchema = z.object({
  reason: safeText(300),
  /** Manager override credentials when the acting session lacks the permission. */
  overrideToken: z.string().max(512).optional(),
});

export const refundLineSchema = z.object({
  saleLineId: uuid,
  quantity: quantityMilli.min(1),
  restock: z.boolean().default(true),
  reason: z.enum(['FAULTY', 'WRONG_ITEM', 'CUSTOMER_CHANGED_MIND', 'EXPIRED', 'OTHER']).default('OTHER'),
});

export const createRefundSchema = z.object({
  clientRefundId: uuid,
  saleId: uuid,
  lines: z.array(refundLineSchema).min(1).max(500),
  /** How the money goes back. Must not exceed what was tendered on that method. */
  refundTenders: z.array(
    z.object({
      method: z.enum(PAYMENT_METHOD),
      amount: positiveCents,
      reference: optionalSafeText(64),
    }),
  ).min(1).max(10),
  reason: safeText(300),
  overrideToken: z.string().max(512).optional(),
});

export const saleSearchQuery = z.object({
  storeId: uuid.optional(),
  terminalId: uuid.optional(),
  cashierId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.string().max(40).optional(),
  receiptNumber: z.string().trim().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

export const openShiftSchema = z.object({
  storeId: uuid,
  terminalId: uuid,
  openingFloat: nonNegativeCents,
  note: optionalSafeText(300),
});

export const closeShiftSchema = z.object({
  /** Physical cash counted at close, used to compute the variance. */
  countedCash: nonNegativeCents,
  note: optionalSafeText(300),
  denominations: z.record(z.string(), z.number().int().min(0)).optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type SaleLineInput = z.infer<typeof saleLineSchema>;
export type TenderInput = z.infer<typeof tenderSchema>;
export type CreateRefundInput = z.infer<typeof createRefundSchema>;
export type DiscountInput = z.infer<typeof discountSchema>;
