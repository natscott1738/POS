import Dexie, { type Table } from 'dexie';
import type { CreateSaleInput, SyncOperation } from '@pos/shared';

/**
 * The till's local database. Everything the checkout screen needs is here, so the
 * shop keeps trading through an internet outage: the catalogue is cached, sales
 * are queued, and nothing depends on a round trip at the moment of sale.
 *
 * Nothing sensitive is stored: no tokens, no card data, no passwords.
 */

export interface CachedVariant {
  variantId: string;
  productId: string;
  name: string;
  sku: string;
  barcode: string | null;
  attributes: Record<string, string>;
  variantLabel: string | null;
  unitPrice: number;
  taxRateBasisPoints: number;
  taxCode: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  unitOfMeasure: string;
  trackInventory: boolean;
  categoryId: string | null;
  /** Last known on-hand; advisory only, the server is authoritative. */
  quantityOnHand: number;
}

export interface QueuedOperation {
  opId: string;
  type: SyncOperation['type'];
  occurredAt: string;
  payload: unknown;
  /** PENDING -> SENDING -> (removed) | FAILED */
  status: 'PENDING' | 'SENDING' | 'FAILED';
  attempts: number;
  lastError?: string;
  createdAt: number;
}

export interface LocalSale {
  clientSaleId: string;
  receiptNumber: string | null;
  total: number;
  status: 'QUEUED' | 'SYNCED' | 'REJECTED';
  soldAt: string;
  payload: CreateSaleInput;
  error?: string;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * A basket set aside so the till can serve someone else.
 *
 * Essential on a real shop floor: a customer goes back for a forgotten item, or
 * realises they left their wallet in the car, and the queue behind them cannot
 * wait. Parked baskets live only on the till — nothing is sent to the server
 * until the sale is actually paid for.
 */
export interface ParkedSale {
  parkedId: string;
  label: string;
  /** Rehydrated straight back into the cart, so nothing is recomputed. */
  lines: Array<{
    clientLineId: string;
    variantId: string;
    quantity: number;
    unitPrice: number;
    discount: unknown;
    note: string | null;
    /** Snapshotted so a parked basket survives a catalogue refresh. */
    variant: CachedVariant;
  }>;
  orderDiscount: unknown;
  customerId: string | null;
  customerName: string | null;
  note: string;
  total: number;
  parkedAt: number;
}

class PosDatabase extends Dexie {
  variants!: Table<CachedVariant, string>;
  queue!: Table<QueuedOperation, string>;
  sales!: Table<LocalSale, string>;
  meta!: Table<MetaRow, string>;
  parked!: Table<ParkedSale, string>;

  constructor() {
    super('pos-till');
    this.version(1).stores({
      // Barcode and sku are indexed because they are the two scan paths.
      variants: 'variantId, barcode, sku, name, categoryId',
      queue: 'opId, status, createdAt',
      sales: 'clientSaleId, status, soldAt',
      meta: 'key',
    });
    // Parked baskets added without touching the existing stores, so an installed
    // till upgrades in place and keeps anything already queued.
    this.version(2).stores({
      parked: 'parkedId, parkedAt',
    });
  }
}

export const db = new PosDatabase();

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Barcode lookup is the hot path at the till; it must not scan the table. */
export async function findByBarcode(barcode: string): Promise<CachedVariant | undefined> {
  return db.variants.where('barcode').equals(barcode).first();
}

export async function searchLocal(term: string, limit = 25): Promise<CachedVariant[]> {
  const needle = term.trim().toLowerCase();
  if (!needle) return db.variants.limit(limit).toArray();

  const exact = await db.variants.where('barcode').equals(term.trim()).toArray();
  if (exact.length > 0) return exact;

  const results: CachedVariant[] = [];
  await db.variants.each((v) => {
    if (results.length >= limit) return;
    if (v.name.toLowerCase().includes(needle) || v.sku.toLowerCase().includes(needle)) {
      results.push(v);
    }
  });
  return results;
}

export async function enqueue(operation: Omit<QueuedOperation, 'status' | 'attempts' | 'createdAt'>): Promise<void> {
  await db.queue.put({ ...operation, status: 'PENDING', attempts: 0, createdAt: Date.now() });
}

export async function pendingCount(): Promise<number> {
  return db.queue.where('status').anyOf('PENDING', 'FAILED').count();
}

/**
 * What belongs to the device rather than to whoever is signed in: its identity,
 * its till binding, its offline batch counter and its settings. Losing these on
 * sign-out turned the till into a new, unregistered device whose offline sales
 * the server would not accept.
 */
const DEVICE_META_KEYS = new Set([
  'deviceId', 'batchSequence', 'registeredDevice', 'storeId', 'terminalId', 'printerConfig', 'quickKeys',
]);

/**
 * Wipes cached data on sign-out so a shared till does not leak between staff.
 * The queue and parked baskets are deliberately kept: unsynced sales and a
 * customer's held basket must survive a shift change. So is the device's own
 * identity, above.
 */
export async function clearLocalData(): Promise<void> {
  const keys = (await db.meta.toCollection().primaryKeys()) as string[];
  await Promise.all([
    db.variants.clear(),
    db.meta.bulkDelete(keys.filter((key) => !DEVICE_META_KEYS.has(key))),
  ]);
}

export async function listParked(): Promise<ParkedSale[]> {
  return db.parked.orderBy('parkedAt').reverse().toArray();
}

export async function parkedCount(): Promise<number> {
  return db.parked.count();
}
