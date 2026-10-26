import { z } from 'zod';
import { nonNegativeCents, positiveCents, safeText, uuid } from './common.js';

export const creditAccountsQuery = z.object({
  storeId: uuid.optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['OPEN', 'OVERDUE', 'CLOSED', 'ALL']).default('ALL'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const creditAccountCreateSchema = z.object({
  customerId: uuid,
  storeId: uuid,
  creditLimit: positiveCents,
  termsDays: z.number().int().min(0).max(365).default(30),
});

export const creditAccountUpdateSchema = z.object({
  creditLimit: nonNegativeCents.optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  isActive: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one account field is required');

export const creditPaymentSchema = z.object({
  clientPaymentId: uuid,
  amount: positiveCents,
  method: z.enum(['CASH', 'MPESA', 'BANK_TRANSFER']),
  reference: z.string().trim().max(64).optional(),
  shiftId: uuid.nullable().optional(),
  note: safeText(300).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.method === 'MPESA' && !/^[A-Z0-9]{8,15}$/.test(value.reference ?? '')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reference'], message: 'Enter the M-PESA confirmation code' });
  }
  if (value.method === 'BANK_TRANSFER' && !value.reference?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reference'], message: 'Enter the bank transfer reference' });
  }
});

export const creditAdjustmentSchema = z.object({
  amount: z.number().int().safe().refine((value) => value !== 0, 'Adjustment cannot be zero'),
  reason: safeText(300),
  dueAt: z.string().datetime().nullable().optional(),
});

export type CreditAccountCreateInput = z.infer<typeof creditAccountCreateSchema>;
export type CreditPaymentInput = z.infer<typeof creditPaymentSchema>;
