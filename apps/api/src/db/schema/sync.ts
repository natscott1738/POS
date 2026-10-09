import { bigserial, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsCol, updatedAt } from './columns.js';
import { stores, terminals } from './org.js';
import { users } from './identity.js';

/** A till (browser install / tablet) allowed to push offline work. */
export const syncDevices = pgTable(
  'sync_devices',
  {
    id: pk(),
    deviceId: uuid('device_id').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    label: text('label'),
    /** Highest batch we have accepted; lets us spot gaps in a replayed sequence. */
    lastBatchSequence: integer('last_batch_sequence').notNull().default(0),
    lastPushAt: tsCol('last_push_at'),
    lastPullAt: tsCol('last_pull_at'),
    /** Server change-log position this device has caught up to. */
    lastPulledChangeId: text('last_pulled_change_id'),
    registeredBy: uuid('registered_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: tsCol('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sync_devices_device_uq').on(t.deviceId),
    index('sync_devices_store_idx').on(t.storeId),
  ],
);

/**
 * Records the outcome of every client operation keyed by its client-minted opId.
 * A replayed batch reads its previous result here instead of re-executing, which
 * is what makes "retry after timeout" safe for money-moving operations.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: pk(),
    /** opId from the client, or an Idempotency-Key header for online requests. */
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    /** Hash of the request body: a reused key with different content is an error. */
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    resourceId: uuid('resource_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('idempotency_scope_key_uq').on(t.scope, t.key),
    index('idempotency_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Ordered server-side change log. Clients pull from here to refresh their local
 * catalogue and stock levels; the monotonic id doubles as the sync cursor.
 */
export const changeLog = pgTable(
  'change_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    operation: text('operation').notNull(),
    payload: jsonb('payload'),
    createdAt: createdAt(),
  },
  (t) => [
    index('change_log_store_id_idx').on(t.storeId, t.id),
    index('change_log_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Per-batch record of what a device pushed, for support and forensics. */
export const syncBatches = pgTable(
  'sync_batches',
  {
    id: pk(),
    deviceId: uuid('device_id').notNull(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    batchSequence: integer('batch_sequence').notNull(),
    operationCount: integer('operation_count').notNull(),
    appliedCount: integer('applied_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    results: jsonb('results'),
    receivedAt: tsCol('received_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sync_batches_device_seq_uq').on(t.deviceId, t.batchSequence)],
);
