import { z } from 'zod';
import { uuid, safeText, isoDate } from './common.js';
import { QB_ENTITY } from '../enums.js';

export const qbConnectQuery = z.object({ storeId: uuid, returnTo: z.string().max(500).optional() });

export const qbCallbackQuery = z.object({
  code: z.string().min(4).max(1024),
  state: z.string().min(8).max(512),
  realmId: z.string().min(1).max(64),
});

/**
 * Maps POS concepts onto the customer's chart of accounts. Nothing syncs until
 * every required mapping is filled, so we never post to a guessed account.
 */
export const qbMappingSchema = z.object({
  storeId: uuid,
  incomeAccountId: safeText(64),
  incomeAccountName: safeText(140),
  undepositedFundsAccountId: safeText(64),
  taxCodeIdStandard: safeText(64).nullable().optional(),
  taxCodeIdZeroRated: safeText(64).nullable().optional(),
  taxCodeIdExempt: safeText(64).nullable().optional(),
  inventoryAssetAccountId: safeText(64).nullable().optional(),
  cogsAccountId: safeText(64).nullable().optional(),
  discountAccountId: safeText(64).nullable().optional(),
  roundingAccountId: safeText(64).nullable().optional(),
  /** Payment method to QuickBooks deposit account, e.g. MPESA -> "M-PESA Settlement". */
  paymentAccounts: z.record(z.string().max(30), safeText(64)),
  defaultCustomerId: safeText(64).nullable().optional(),
  /** Post each sale individually, or one summary journal per day. */
  postingMode: z.enum(['PER_SALE', 'DAILY_SUMMARY']).default('PER_SALE'),
  autoSyncEnabled: z.boolean().default(true),
});

export const qbSyncTriggerSchema = z.object({
  storeId: uuid,
  entity: z.enum(QB_ENTITY).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Re-push records already marked SYNCED (used after a mapping correction). */
  force: z.boolean().default(false),
});

export const qbQueueQuery = z.object({
  storeId: uuid.optional(),
  status: z.enum(['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'DEAD_LETTER']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type QbMappingInput = z.infer<typeof qbMappingSchema>;
