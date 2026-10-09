import { z } from 'zod';
import { uuid, safeText } from './common.js';
import { ROLES } from '../permissions.js';

/**
 * Password policy: length beats composition rules (NIST SP 800-63B).
 * Breach-list screening happens server-side; this is the structural floor.
 */
export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(200, 'password must be at most 200 characters');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
  /** Physical till this session is bound to; drives shift + receipt numbering. */
  terminalId: uuid.optional(),
});

/** Cashiers sign in at the till with a short PIN scoped to an already-trusted terminal. */
export const pinLoginSchema = z.object({
  terminalId: uuid,
  staffCode: z.string().trim().regex(/^[A-Z0-9]{3,12}$/),
  pin: z.string().regex(/^\d{4,8}$/),
});

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: safeText(120),
  role: z.enum(ROLES),
  password: passwordSchema,
  staffCode: z.string().trim().regex(/^[A-Z0-9]{3,12}$/).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  storeIds: z.array(uuid).min(1),
  requireMfa: z.boolean().default(false),
});

export const updateUserSchema = createUserSchema
  .partial()
  .omit({ password: true })
  .extend({ isActive: z.boolean().optional() });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const enrollMfaSchema = z.object({ totp: z.string().regex(/^\d{6}$/) });

/** A manager authorising a privileged action performed on a cashier's session. */
export const overrideSchema = z.object({
  staffCode: z.string().trim().regex(/^[A-Z0-9]{3,12}$/),
  pin: z.string().regex(/^\d{4,8}$/),
  reason: safeText(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type PinLoginInput = z.infer<typeof pinLoginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type OverrideInput = z.infer<typeof overrideSchema>;
