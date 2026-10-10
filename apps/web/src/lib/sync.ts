import type { SyncOperationResult } from '@pos/shared';
import { api, ApiError } from './api.js';
import { db, getMeta, setMeta, pendingCount, type CachedVariant } from './db.js';
import { useNetwork, useAuth, toast } from './store.js';

/**
 * Background sync loop.
 *
 * Push before pull: work the shop has already done is more valuable than a fresh
 * catalogue, so queued sales go up first. Failures are kept and retried rather
 * than dropped, and a rejection is surfaced to a human instead of being silently
 * discarded.
 */

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

const PUSH_BATCH_SIZE = 100;
const INTERVAL_MS = 20_000;

let warnedUnregistered = false;

/**
 * The server only accepts offline batches from a registered device, and only an
 * administrator may register one, so that a revoked tablet cannot re-enrol itself.
 * The till therefore registers itself whenever an administrator is signed in on
 * it. Until then queued sales wait safely in the queue.
 */
async function ensureRegistered(storeId: string, terminalId: string | null, deviceId: string): Promise<boolean> {
  const key = `${deviceId}:${storeId}:${terminalId ?? ''}`;
  if ((await getMeta<string | null>('registeredDevice', null)) === key) return true;
  if (!useAuth.getState().can('store:write')) return false;

  await api.post('/sync/devices', {
    deviceId,
    storeId,
    ...(terminalId ? { terminalId } : {}),
    label: deviceLabel(),
  });
  await setMeta('registeredDevice', key);
  return true;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'unknown system';
  return `Till app on ${os}`;
}

export function startSync(): void {
  if (timer) return;
  void runSync();
  timer = setInterval(() => void runSync(), INTERVAL_MS);
  window.addEventListener('online', () => void runSync());
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runSync(): Promise<void> {
  if (running) return;
  const { user, storeId, terminalId, deviceId } = useAuth.getState();
  if (!user || !storeId || !deviceId) return;
  if (!navigator.onLine) {
    useNetwork.getState().setServerReachable(false);
    return;
  }

  running = true;
  useNetwork.getState().setSyncing(true);

  try {
    const registered = await ensureRegistered(storeId, terminalId, deviceId);
    if (registered) {
      await pushQueue(storeId, terminalId, deviceId);
    } else if ((await pendingCount()) > 0 && !warnedUnregistered) {
      warnedUnregistered = true;
      toast.warning('Sales made offline are saved on this till. They upload once an administrator signs in on it.');
    }
    await pullCatalogue(storeId, deviceId);
    useNetwork.getState().setServerReachable(true);
    useNetwork.getState().markSynced();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NETWORK') {
      useNetwork.getState().setServerReachable(false);
    } else {
      // The server answered, so it is reachable even though this sync failed.
      useNetwork.getState().setServerReachable(true);
      console.error('sync failed', err);
    }
  } finally {
    useNetwork.getState().setSyncing(false);
    useNetwork.getState().setPending(await pendingCount());
    running = false;
  }
}

async function pushQueue(storeId: string, terminalId: string | null, deviceId: string): Promise<void> {
  const queued = await db.queue
    .where('status')
    .anyOf('PENDING', 'FAILED')
    .limit(PUSH_BATCH_SIZE)
    .toArray();

  if (queued.length === 0) return;
  if (!terminalId) return;

  // Chronological order so a void never arrives before the sale it voids.
  queued.sort((a, b) => a.createdAt - b.createdAt);

  const batchSequence = (await getMeta<number>('batchSequence', 0)) + 1;
  await db.queue.bulkPut(queued.map((op) => ({ ...op, status: 'SENDING' as const })));

  try {
    const response = await api.post<{ results: SyncOperationResult[] }>('/sync/push', {
      deviceId,
      storeId,
      terminalId,
      batchSequence,
      operations: queued.map((op) => ({
        type: op.type,
        opId: op.opId,
        occurredAt: op.occurredAt,
        payload: op.payload,
      })),
    });

    await setMeta('batchSequence', batchSequence);

    for (const result of response.results) {
      if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
        await db.queue.delete(result.opId);
        const local = await db.sales.where('clientSaleId').equals(localSaleIdFor(queued, result.opId)).first();
        if (local) {
          await db.sales.put({
            ...local,
            status: 'SYNCED',
            receiptNumber: result.receiptNumber ?? local.receiptNumber,
          });
        }
      } else if (result.status === 'REJECTED') {
        // Kept locally and flagged: a rejected sale needs a human decision, not
        // an endless retry that will never succeed.
        const op = queued.find((q) => q.opId === result.opId);
        await db.queue.put({
          ...(op as (typeof queued)[number]),
          status: 'FAILED',
          attempts: (op?.attempts ?? 0) + 1,
          lastError: result.error?.message ?? 'rejected by server',
        });
        const clientSaleId = localSaleIdFor(queued, result.opId);
        const local = await db.sales.where('clientSaleId').equals(clientSaleId).first();
        if (local) {
          await db.sales.put({ ...local, status: 'REJECTED', error: result.error?.message });
        }
        toast.error(`A queued sale was rejected: ${result.error?.message ?? 'unknown reason'}`);
      }
    }
  } catch (err) {
    // The server no longer knows this device (never registered, or its records
    // were reset): register it again on the next cycle where that is possible.
    if (err instanceof ApiError && err.status === 404) await setMeta('registeredDevice', null);
    // Put everything back so the batch is retried intact on the next cycle.
    await db.queue.bulkPut(
      queued.map((op) => ({
        ...op,
        status: 'PENDING' as const,
        attempts: op.attempts + 1,
        lastError: err instanceof Error ? err.message : 'push failed',
      })),
    );
    throw err;
  }
}

function localSaleIdFor(queued: Array<{ opId: string; payload: unknown }>, opId: string): string {
  const op = queued.find((q) => q.opId === opId);
  return (op?.payload as { clientSaleId?: string })?.clientSaleId ?? '';
}

async function pullCatalogue(storeId: string, deviceId: string): Promise<void> {
  const cursor = await getMeta<string | null>('syncCursor', null);

  // No cursor means this till has never synced: take a full snapshot.
  if (!cursor) {
    const snapshot = await api.get<{
      catalogue: CachedVariant[];
      stock: Array<{ variantId: string; quantityOnHand: number }>;
      cursor: string;
    }>(`/sync/bootstrap?storeId=${storeId}`);

    const stock = new Map(snapshot.stock.map((s) => [s.variantId, s.quantityOnHand]));
    await db.variants.bulkPut(
      snapshot.catalogue.map((item) => ({
        ...item,
        variantLabel: labelFor(item.attributes),
        quantityOnHand: stock.get(item.variantId) ?? 0,
      })),
    );
    await setMeta('syncCursor', snapshot.cursor);
    return;
  }

  const delta = await api.get<{
    cursor: string;
    hasMore: boolean;
    products: Array<Record<string, unknown>>;
    stock: Array<{ variantId: string; quantityOnHand: number }>;
  }>(`/sync/pull?deviceId=${deviceId}&storeId=${storeId}&cursor=${encodeURIComponent(cursor)}&limit=500`);

  for (const row of delta.products) {
    const variantId = row.variantId as string;
    if (!variantId) continue;
    const existing = await db.variants.get(variantId);
    const inactive = row.deletedAt || row.isActive === false || row.variantActive === false;
    if (inactive) {
      await db.variants.delete(variantId);
      continue;
    }
    await db.variants.put({
      variantId,
      productId: row.id as string,
      name: row.name as string,
      sku: row.sku as string,
      barcode: (row.barcode as string) ?? null,
      attributes: (row.attributes as Record<string, string>) ?? {},
      variantLabel: labelFor(row.attributes),
      unitPrice: row.unitPrice as number,
      taxRateBasisPoints: row.taxRateBasisPoints as number,
      taxCode: row.taxCode as CachedVariant['taxCode'],
      unitOfMeasure: row.unitOfMeasure as string,
      trackInventory: row.trackInventory as boolean,
      categoryId: (row.categoryId as string) ?? null,
      quantityOnHand: existing?.quantityOnHand ?? 0,
    });
  }

  for (const level of delta.stock) {
    const existing = await db.variants.get(level.variantId);
    if (existing) {
      await db.variants.put({ ...existing, quantityOnHand: level.quantityOnHand });
    }
  }

  await setMeta('syncCursor', delta.cursor);

  // Keep draining while the server says there is more, rather than waiting a
  // full interval per page.
  if (delta.hasMore) await pullCatalogue(storeId, deviceId);
}

function labelFor(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object') return null;
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' / ');
}

/** Forces a full catalogue refresh; used by the "re-sync" button in settings. */
export async function resetCatalogue(): Promise<void> {
  await db.variants.clear();
  await setMeta('syncCursor', null);
  await runSync();
}
