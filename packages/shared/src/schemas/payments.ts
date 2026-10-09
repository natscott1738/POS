import { z } from 'zod';
import { uuid, positiveCents, msisdn, safeText, optionalSafeText } from './common.js';

/* ---------------------------------- M-PESA --------------------------------- */

export const mpesaStkPushSchema = z.object({
  saleId: uuid.nullable().optional(),
  clientSaleId: uuid.nullable().optional(),
  storeId: uuid,
  terminalId: uuid,
  phone: msisdn,
  amount: positiveCents,
  reference: safeText(12),
  description: optionalSafeText(60),
});

export const mpesaStatusQuerySchema = z.object({ checkoutRequestId: z.string().trim().min(4).max(120) });

/** Manual capture when the customer paid via paybill before the till asked. */
export const mpesaManualMatchSchema = z.object({
  saleId: uuid,
  confirmationCode: z.string().trim().regex(/^[A-Z0-9]{8,15}$/),
  amount: positiveCents,
  phone: msisdn.optional(),
});

/**
 * Safaricom Daraja STK callback envelope. Validated defensively: this endpoint is
 * internet-facing and unauthenticated apart from the signed path token + IP allowlist.
 */
export const mpesaStkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().max(120),
      CheckoutRequestID: z.string().max(120),
      ResultCode: z.coerce.number().int(),
      ResultDesc: z.string().max(500).optional().default(''),
      CallbackMetadata: z
        .object({
          Item: z.array(
            z.object({
              Name: z.string().max(60),
              Value: z.union([z.string().max(200), z.number()]).optional(),
            }),
          ),
        })
        .optional(),
    }),
  }),
});

/** Daraja C2B confirmation (customer initiated, e.g. paybill push). */
export const mpesaC2bConfirmationSchema = z.object({
  TransactionType: z.string().max(60).optional(),
  TransID: z.string().max(40),
  TransTime: z.string().max(20),
  TransAmount: z.union([z.string(), z.number()]),
  BusinessShortCode: z.string().max(20).optional(),
  BillRefNumber: z.string().max(60).optional().default(''),
  MSISDN: z.string().max(40).optional(),
  FirstName: z.string().max(60).optional(),
  LastName: z.string().max(60).optional(),
});

/* ------------------------------------ PDQ ---------------------------------- */

export const pdqSaleRequestSchema = z.object({
  saleId: uuid.nullable().optional(),
  clientSaleId: uuid.nullable().optional(),
  storeId: uuid,
  terminalId: uuid,
  /** The physical card terminal the amount is pushed to. */
  pdqTerminalId: uuid,
  amount: positiveCents,
  reference: safeText(24),
});

export const pdqCallbackSchema = z.object({
  transactionRef: z.string().trim().min(4).max(120),
  approved: z.boolean(),
  authCode: z.string().trim().max(32).optional(),
  maskedPan: z.string().trim().max(24).optional(),
  cardScheme: z.string().trim().max(20).optional(),
  responseCode: z.string().trim().max(10).optional(),
  responseMessage: z.string().trim().max(200).optional(),
  terminalReceipt: z.string().max(4000).optional(),
});

export const pdqReversalSchema = z.object({
  pdqTransactionId: uuid,
  reason: safeText(200),
});

export type MpesaStkPushInput = z.infer<typeof mpesaStkPushSchema>;
export type MpesaStkCallback = z.infer<typeof mpesaStkCallbackSchema>;
export type PdqSaleRequestInput = z.infer<typeof pdqSaleRequestSchema>;
export type PdqCallback = z.infer<typeof pdqCallbackSchema>;
