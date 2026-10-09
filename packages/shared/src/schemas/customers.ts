import { z } from 'zod';
import { uuid, safeText, optionalSafeText, msisdn, isoDate } from './common.js';

export const customerSchema = z.object({
  fullName: safeText(140),
  phone: msisdn.nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  /** KRA PIN, needed on VAT invoices for business customers. */
  taxPin: z.string().trim().regex(/^[A-Z]\d{9}[A-Z]$/i).nullable().optional(),
  address: optionalSafeText(300),
  dateOfBirth: z.string().date().nullable().optional(),
  notes: optionalSafeText(1000),
  /** Consent is recorded explicitly: marketing contact without it is a compliance breach. */
  marketingConsent: z.boolean().default(false),
  creditLimit: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const updateCustomerSchema = customerSchema.partial();

export const customerSearchQuery = z.object({
  q: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export const loyaltyAdjustmentSchema = z.object({
  customerId: uuid,
  points: z.number().int().refine((v) => v !== 0, 'points may not be zero'),
  reason: safeText(200),
  expiresAt: isoDate.nullable().optional(),
});

export type CustomerInput = z.infer<typeof customerSchema>;
