import { and, eq, lte, sql, inArray, desc } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client.js';
import { qbSyncQueue, qbConnections, qbMappings } from '../../db/schema/index.js';
import { sha256Hex } from '../../core/crypto.js';
import type { QbEntity } from '@pos/shared';
import { env } from '../../config/env.js';

export interface EnqueueInput {
  storeId: string;
  entity: QbEntity;
  localId: string;
  operation?: 'CREATE' | 'UPDATE' | 'VOID' | 'DELETE';
  payloadSnapshot?: unknown;
}

/**
 * Queues a record for QuickBooks. Enqueuing happens inside the business transaction
 * so accounting can never miss a sale that was committed, and the unique index on
 * (store, entity, localId, operation) makes the enqueue itself idempotent.
 */
export async function enqueueQbSync(exec: Executor, input: EnqueueInput): Promise<void> {
  const operation = input.operation ?? 'CREATE';
  // Deterministic key: QuickBooks dedupes a retried POST carrying the same value.
  const requestIdempotencyKey = sha256Hex(`${input.storeId}:${input.entity}:${input.localId}:${operation}`).slice(0, 48);

  await exec
    .insert(qbSyncQueue)
    .values({
      storeId: input.storeId,
      entity: input.entity,
      localId: input.localId,
      operation,
      status: 'PENDING',
      requestIdempotencyKey,
      payloadSnapshot: (input.payloadSnapshot ?? null) as never,
    })
    .onConflictDoUpdate({
      target: [qbSyncQueue.storeId, qbSyncQueue.entity, qbSyncQueue.localId, qbSyncQueue.operation],
      set: {
        // A record edited after a failed push goes back to the front of the queue.
        status: 'PENDING',
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      },
      // Leave successfully synced rows alone unless the caller forces a resync.
      where: sql`${qbSyncQueue.status} IN ('FAILED', 'DEAD_LETTER', 'PENDING')`,
    });
}

/**
 * Claims a batch of due jobs. The UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 * SKIP LOCKED) pattern lets several workers drain the queue concurrently without
 * ever handing the same job to two of them.
 */
export async function claimJobs(workerId: string, limit = 20) {
  const claimed = await db.execute(sql`
    UPDATE ${qbSyncQueue}
    SET status = 'IN_FLIGHT',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1,
        updated_at = now()
    WHERE id IN (
      SELECT id FROM ${qbSyncQueue}
      WHERE status = 'PENDING' AND next_attempt_at <= now()
        AND EXISTS (
          SELECT 1 FROM ${qbConnections}
          WHERE ${qbConnections.storeId} = ${qbSyncQueue.storeId}
            AND ${qbConnections.isActive} = true
            AND ${qbConnections.environment} = ${env.QB_ENVIRONMENT}
        )
        AND EXISTS (
          SELECT 1 FROM ${qbMappings}
          WHERE ${qbMappings.storeId} = ${qbSyncQueue.storeId}
            AND ${qbMappings.autoSyncEnabled} = true
        )
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, store_id AS "storeId", entity, local_id AS "localId", operation,
              attempts, max_attempts AS "maxAttempts",
              request_idempotency_key AS "requestIdempotencyKey", qb_id AS "qbId"
  `);
  return claimed as unknown as Array<{
    id: string;
    storeId: string;
    entity: QbEntity;
    localId: string;
    operation: string;
    attempts: number;
    maxAttempts: number;
    requestIdempotencyKey: string;
    qbId: string | null;
  }>;
}

export async function markSynced(jobId: string, qbId: string | null): Promise<void> {
  await db
    .update(qbSyncQueue)
    .set({
      status: 'SYNCED',
      qbId,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(qbSyncQueue.id, jobId));
}

/**
 * Records a failure and schedules the retry. Backoff is exponential with jitter so
 * a QuickBooks outage does not turn into a synchronised retry storm when it ends.
 */
export async function markFailed(
  jobId: string,
  attempts: number,
  maxAttempts: number,
  error: { message: string; code?: string; permanent?: boolean },
): Promise<void> {
  const exhausted = attempts >= maxAttempts || error.permanent === true;
  const backoffSeconds = Math.min(2 ** attempts * 30, 3600);
  const jitter = Math.floor(Math.random() * Math.min(backoffSeconds, 60));

  await db
    .update(qbSyncQueue)
    .set({
      status: exhausted ? 'DEAD_LETTER' : 'PENDING',
      nextAttemptAt: new Date(Date.now() + (backoffSeconds + jitter) * 1000),
      lastError: error.message.slice(0, 2000),
      lastErrorCode: error.code ?? null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(qbSyncQueue.id, jobId));
}

/** Releases jobs whose worker died mid-flight so they are not stranded. */
export async function reclaimStaleJobs(olderThanMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await db
    .update(qbSyncQueue)
    .set({ status: 'PENDING', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(qbSyncQueue.status, 'IN_FLIGHT'), lte(qbSyncQueue.lockedAt, cutoff)));
  return (result as unknown as { count?: number }).count ?? 0;
}

export async function listQueue(filters: {
  storeIds: string[] | null;
  status?: 'PENDING' | 'IN_FLIGHT' | 'SYNCED' | 'FAILED' | 'DEAD_LETTER';
  limit: number;
}) {
  const conditions = [];
  if (filters.storeIds) conditions.push(inArray(qbSyncQueue.storeId, filters.storeIds));
  if (filters.status) conditions.push(eq(qbSyncQueue.status, filters.status));
  return db
    .select()
    .from(qbSyncQueue)
    .where(conditions.length > 0 ? and(...conditions) : sql`true`)
    .orderBy(desc(qbSyncQueue.updatedAt))
    .limit(filters.limit);
}

/** Puts dead-lettered jobs back in play after an operator fixes the mapping. */
export async function retryDeadLetters(storeId: string): Promise<number> {
  const result = await db
    .update(qbSyncQueue)
    .set({ status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), updatedAt: new Date() })
    .where(and(eq(qbSyncQueue.storeId, storeId), eq(qbSyncQueue.status, 'DEAD_LETTER')));
  return (result as unknown as { count?: number }).count ?? 0;
}

export async function queueDepth(storeId: string): Promise<{ pending: number; failed: number; dead: number }> {
  const rows = await db
    .select({ status: qbSyncQueue.status, count: sql<number>`count(*)::int`.as('count') })
    .from(qbSyncQueue)
    .where(eq(qbSyncQueue.storeId, storeId))
    .groupBy(qbSyncQueue.status);
  const find = (s: string) => rows.find((r) => r.status === s)?.count ?? 0;
  return { pending: find('PENDING'), failed: find('FAILED'), dead: find('DEAD_LETTER') };
}
