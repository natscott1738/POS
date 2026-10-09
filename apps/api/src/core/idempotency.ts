import { and, eq, lt } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';
import { sha256Hex } from './crypto.js';
import { conflict, idempotencyMismatch } from './errors.js';

const TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface IdempotentOutcome<T> {
  result: T;
  /** True when the stored response was replayed instead of re-executing. */
  replayed: boolean;
}

/**
 * Runs `work` at most once per (scope, key). A till that retries after a network
 * timeout gets the original response back rather than creating a second sale.
 *
 * The unique index on (scope, key) is the actual concurrency control: two
 * simultaneous retries race to INSERT and exactly one wins.
 */
export async function withIdempotency<T>(
  params: {
    scope: string;
    key: string;
    request: unknown;
    userId?: string | null;
  },
  work: (tx: Tx) => Promise<{ result: T; resourceId?: string | null }>,
): Promise<IdempotentOutcome<T>> {
  const requestHash = sha256Hex(stableStringify(params.request));

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, params.scope), eq(idempotencyKeys.key, params.key)))
    .limit(1);

  if (existing) {
    // Same key, different body: the client has a bug, or someone is replaying a
    // captured request against different data. Never silently accept either.
    if (existing.requestHash !== requestHash) throw idempotencyMismatch();
    if (existing.status === 'COMPLETED') {
      return { result: existing.responseBody as T, replayed: true };
    }
    if (existing.status === 'IN_PROGRESS') {
      const stale = Date.now() - existing.updatedAt.getTime() > 60_000;
      if (!stale) throw conflict('A matching request is still being processed');
      // A crashed attempt left this row behind; take it over.
    }
  }

  return db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(idempotencyKeys)
        .set({ status: 'IN_PROGRESS', updatedAt: new Date() })
        .where(eq(idempotencyKeys.id, existing.id));
    } else {
      try {
        await tx.insert(idempotencyKeys).values({
          key: params.key,
          scope: params.scope,
          requestHash,
          status: 'IN_PROGRESS',
          userId: params.userId ?? null,
          expiresAt: new Date(Date.now() + TTL_MS),
        });
      } catch (err) {
        // Lost the race to a concurrent identical request.
        if (isUniqueViolation(err)) throw conflict('A matching request is already in flight');
        throw err;
      }
    }

    const { result, resourceId } = await work(tx);

    await tx
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus: 200,
        responseBody: result as never,
        resourceId: resourceId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(idempotencyKeys.scope, params.scope), eq(idempotencyKeys.key, params.key)));

    return { result, replayed: false };
  });
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function uniqueViolationConstraint(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  return (err as { constraint_name?: string }).constraint_name ?? null;
}

/** Key order must not change the hash, or a retry with reordered JSON looks new. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export async function purgeExpiredIdempotencyKeys(): Promise<void> {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date()));
}
