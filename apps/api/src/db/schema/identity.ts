import { sql } from 'drizzle-orm';
import { boolean, index, inet, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsCol, updatedAt } from './columns.js';
import { roleEnum } from './enums.js';
import { stores, terminals } from './org.js';

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    role: roleEnum('role').notNull().default('CASHIER'),
    /** Argon2id digest. The algorithm and parameters live inside the encoded string. */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: tsCol('password_changed_at').notNull().defaultNow(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /**
     * The administrator the deployment was bootstrapped with. Only they can change
     * their own account: otherwise any administrator could reset the owner's
     * password, take the temporary one, and lock them out of their own system.
     */
    isOwner: boolean('is_owner').notNull().default(false),

    /** Short till code + PIN, only usable from a registered terminal. */
    staffCode: text('staff_code'),
    pinHash: text('pin_hash'),

    /** AES-256-GCM ciphertext of the TOTP secret; null until enrolment completes. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** Hashed single-use recovery codes. */
    mfaRecoveryCodes: text('mfa_recovery_codes').array(),

    isActive: boolean('is_active').notNull().default(true),
    /** Lockout state after repeated failures; cleared on success. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tsCol('locked_until'),
    lastLoginAt: tsCol('last_login_at'),
    /** Bumped to invalidate every outstanding access token for this user at once. */
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tsCol('deleted_at'),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_staff_code_uq').on(t.staffCode),
    // There is only ever one owner.
    uniqueIndex('users_single_owner_uq').on(t.isOwner).where(sql`${t.isOwner}`),
    index('users_role_idx').on(t.role),
  ],
);

/** Which stores a user may act in. Absence of a row is denial. */
export const userStores = pgTable(
  'user_stores',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('user_stores_pk').on(t.userId, t.storeId)],
);

/**
 * Refresh tokens are stored hashed and rotated on every use. `replacedBy` builds a
 * chain: presenting an already-rotated token means the cookie leaked, so the whole
 * family is revoked immediately.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the raw token; the raw value only ever exists in the cookie. */
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    replacedByHash: text('replaced_by_hash'),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    expiresAt: tsCol('expires_at').notNull(),
    revokedAt: tsCol('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_family_idx').on(t.familyId),
  ],
);

/**
 * Single-use password reset tokens. Stored hashed, short-lived, and consumed on
 * first use: a reset link that stays valid is a permanent backdoor into an account.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    requestedIp: inet('requested_ip'),
    consumedAt: tsCol('consumed_at'),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('password_reset_hash_uq').on(t.tokenHash),
    index('password_reset_user_idx').on(t.userId, t.createdAt),
  ],
);

/** Feeds rate limiting and brute-force lockout; also an audit trail of who tried what. */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: pk(),
    identifier: text('identifier').notNull(),
    ipAddress: inet('ip_address'),
    succeeded: boolean('succeeded').notNull(),
    failureReason: text('failure_reason'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    index('login_attempts_identifier_idx').on(t.identifier, t.createdAt),
    index('login_attempts_ip_idx').on(t.ipAddress, t.createdAt),
  ],
);

/**
 * Append-only audit trail. Every state-changing request writes exactly one row.
 * There is no UPDATE or DELETE path in application code.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role'),
    /** Manager who authorised a privileged action on someone else's session. */
    overrideByUserId: uuid('override_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Redacted diff; secrets are stripped before this is written. */
    changes: text('changes'),
    reason: text('reason'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);
