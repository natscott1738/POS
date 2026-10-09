import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsCol, updatedAt } from './columns.js';
import { qbEntityEnum, syncStatusEnum } from './enums.js';
import { stores } from './org.js';
import { users } from './identity.js';

/**
 * OAuth connection to a QuickBooks Online company. Tokens are stored as
 * AES-256-GCM ciphertext; the plaintext exists only in memory during a request.
 */
export const qbConnections = pgTable(
  'qb_connections',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    realmId: text('realm_id').notNull(),
    companyName: text('company_name'),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    accessTokenExpiresAt: tsCol('access_token_expires_at').notNull(),
    /** QBO refresh tokens expire after ~100 days of disuse; we warn before that. */
    refreshTokenExpiresAt: tsCol('refresh_token_expires_at').notNull(),
    environment: text('environment').notNull().default('sandbox'),
    isActive: boolean('is_active').notNull().default(true),
    lastSyncAt: tsCol('last_sync_at'),
    lastSyncError: text('last_sync_error'),
    connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
    disconnectedAt: tsCol('disconnected_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('qb_connections_store_uq').on(t.storeId),
    index('qb_connections_realm_idx').on(t.realmId),
  ],
);

/** Short-lived, single-use OAuth state; defeats CSRF on the authorisation callback. */
export const qbOauthStates = pgTable(
  'qb_oauth_states',
  {
    id: pk(),
    state: text('state').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    returnTo: text('return_to'),
    consumedAt: tsCol('consumed_at'),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('qb_oauth_states_state_uq').on(t.state)],
);

/** POS concept to chart-of-accounts mapping. Sync refuses to run until complete. */
export const qbMappings = pgTable(
  'qb_mappings',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    incomeAccountId: text('income_account_id').notNull(),
    incomeAccountName: text('income_account_name').notNull(),
    undepositedFundsAccountId: text('undeposited_funds_account_id').notNull(),
    taxCodeIdStandard: text('tax_code_id_standard'),
    taxCodeIdZeroRated: text('tax_code_id_zero_rated'),
    taxCodeIdExempt: text('tax_code_id_exempt'),
    inventoryAssetAccountId: text('inventory_asset_account_id'),
    cogsAccountId: text('cogs_account_id'),
    discountAccountId: text('discount_account_id'),
    roundingAccountId: text('rounding_account_id'),
    /** { CASH: "35", MPESA: "77", PDQ: "78" } — payment method to deposit account. */
    paymentAccounts: jsonb('payment_accounts').notNull().default({}),
    defaultCustomerId: text('default_customer_id'),
    postingMode: text('posting_mode').notNull().default('PER_SALE'),
    autoSyncEnabled: boolean('auto_sync_enabled').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('qb_mappings_store_uq').on(t.storeId)],
);

/** Durable link between a local record and its QuickBooks counterpart. */
export const qbEntityLinks = pgTable(
  'qb_entity_links',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    entity: qbEntityEnum('entity').notNull(),
    localId: uuid('local_id').notNull(),
    qbId: text('qb_id').notNull(),
    /** QBO optimistic-concurrency token, required on every update. */
    syncToken: text('sync_token'),
    lastSyncedAt: tsCol('last_synced_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('qb_entity_links_local_uq').on(t.storeId, t.entity, t.localId),
    index('qb_entity_links_qb_idx').on(t.storeId, t.entity, t.qbId),
  ],
);

/**
 * Outbound work queue. Failures back off exponentially and land in DEAD_LETTER
 * rather than blocking the queue head, so one bad record cannot stop accounting.
 */
export const qbSyncQueue = pgTable(
  'qb_sync_queue',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    entity: qbEntityEnum('entity').notNull(),
    localId: uuid('local_id').notNull(),
    operation: text('operation').notNull().default('CREATE'),
    status: syncStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: tsCol('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    lastErrorCode: text('last_error_code'),
    payloadSnapshot: jsonb('payload_snapshot'),
    qbId: text('qb_id'),
    /** Sent as a QBO request id so a retried POST cannot create a duplicate. */
    requestIdempotencyKey: text('request_idempotency_key').notNull(),
    lockedAt: tsCol('locked_at'),
    lockedBy: text('locked_by'),
    completedAt: tsCol('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('qb_queue_entity_local_uq').on(t.storeId, t.entity, t.localId, t.operation),
    index('qb_queue_ready_idx').on(t.status, t.nextAttemptAt),
    index('qb_queue_store_idx').on(t.storeId, t.status),
  ],
);
