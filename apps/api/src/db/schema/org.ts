import { boolean, integer, jsonb, pgTable, text, uniqueIndex, uuid, index } from 'drizzle-orm/pg-core';
import { cents, createdAt, pk, tsCol, updatedAt } from './columns.js';

export const stores = pgTable(
  'stores',
  {
    id: pk(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    /** KRA PIN printed on VAT invoices. */
    taxPin: text('tax_pin'),
    currency: text('currency').notNull().default('KES'),
    timezone: text('timezone').notNull().default('Africa/Nairobi'),
    /** Shelf prices include VAT (Kenyan retail norm). */
    pricesIncludeTax: boolean('prices_include_tax').notNull().default(true),
    cashRoundingIncrement: integer('cash_rounding_increment').notNull().default(0),
    receiptHeader: text('receipt_header'),
    receiptFooter: text('receipt_footer'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('stores_code_uq').on(t.code)],
);

export const terminals = pgTable(
  'terminals',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Receipt numbers are per-terminal so offline tills never collide. */
    receiptPrefix: text('receipt_prefix').notNull(),
    lastReceiptSequence: integer('last_receipt_sequence').notNull().default(0),
    /**
     * Device-bound secret fingerprint. A terminal must present this to use PIN login,
     * so a stolen staff PIN is useless away from the shop floor.
     */
    deviceFingerprint: text('device_fingerprint'),
    isActive: boolean('is_active').notNull().default(true),
    lastSeenAt: tsCol('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('terminals_store_code_uq').on(t.storeId, t.code),
    uniqueIndex('terminals_receipt_prefix_uq').on(t.receiptPrefix),
  ],
);

/** A physical card machine bound to a till. */
export const pdqTerminals = pgTable(
  'pdq_terminals',
  {
    id: pk(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    terminalId: uuid('terminal_id').references(() => terminals.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    /** 'SIMULATOR' in dev; 'ECR_HTTP' talks to a local bridge next to the card reader. */
    provider: text('provider').notNull().default('SIMULATOR'),
    acquirer: text('acquirer'),
    /** Merchant/terminal identifiers issued by the acquirer. Not secret. */
    merchantId: text('merchant_id'),
    deviceSerial: text('device_serial'),
    /** e.g. http://127.0.0.1:9110 — the ECR bridge on the till's own loopback. */
    endpointUrl: text('endpoint_url'),
    /** AES-256-GCM ciphertext of the bridge shared secret. */
    encryptedSecret: text('encrypted_secret'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('pdq_terminals_store_idx').on(t.storeId)],
);

/** Key/value configuration, scoped globally (storeId null) or per store. */
export const settings = pgTable(
  'settings',
  {
    id: pk(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    /** Marks values that must be encrypted at rest and redacted from API responses. */
    isSecret: boolean('is_secret').notNull().default(false),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('settings_scope_key_uq').on(t.storeId, t.key)],
);
