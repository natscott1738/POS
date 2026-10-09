import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { qbConnections, qbEntityLinks, sales, refunds, saleLines, refundLines } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { randomUUID } from '../../core/crypto.js';
import { claimJobs, markFailed, markSynced, reclaimStaleJobs } from './queue.js';
import { activeConnection, qbRequest, QbApiError } from './client.js';
import { buildSalesReceipt, buildRefundReceipt, buildCustomer, buildItem, linkedQbId } from './mapper.js';
import { isAppError } from '../../core/errors.js';
import type { QbEntity } from '@pos/shared';

const WORKER_ID = `qb-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Drains the QuickBooks queue. Runs on an interval rather than reacting to each
 * sale, so a QuickBooks outage never slows down the till: sales commit locally
 * and catch up whenever the integration comes back.
 */
export async function runQbSyncCycle(log: {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}): Promise<{ processed: number; succeeded: number; failed: number }> {
  if (!env.QB_ENABLED) return { processed: 0, succeeded: 0, failed: 0 };

  await reclaimStaleJobs();
  const jobs = await claimJobs(WORKER_ID, 20);

  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const qbId = await processJob(job);
      await markSynced(job.id, qbId);
      succeeded++;
    } catch (err) {
      failed++;
      const permanent =
        err instanceof QbApiError ? err.permanent : isAppError(err) && err.statusCode < 500;
      const message = err instanceof Error ? err.message : 'unknown error';

      await markFailed(job.id, job.attempts, job.maxAttempts, {
        message,
        ...(err instanceof QbApiError && err.code ? { code: err.code } : {}),
        permanent,
      });

      log.warn({ jobId: job.id, entity: job.entity, permanent, message }, 'QuickBooks sync failed');

      await db
        .update(qbConnections)
        .set({ lastSyncError: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(qbConnections.storeId, job.storeId));
    }
  }

  if (jobs.length > 0) {
    await db
      .update(qbConnections)
      .set({ lastSyncAt: new Date() })
      .where(eq(qbConnections.storeId, jobs[0]!.storeId));
    log.info({ processed: jobs.length, succeeded, failed }, 'QuickBooks sync cycle complete');
  }

  return { processed: jobs.length, succeeded, failed };
}

async function processJob(job: {
  id: string;
  storeId: string;
  entity: QbEntity;
  localId: string;
  operation: string;
  requestIdempotencyKey: string;
}): Promise<string | null> {
  const connection = await activeConnection(job.storeId);

  switch (job.entity) {
    case 'SALES_RECEIPT': {
      if (job.operation === 'VOID') return voidSalesReceipt(connection, job);

      const existing = await linkedQbId(job.storeId, 'SALES_RECEIPT', job.localId);
      // Already posted: nothing to do, and re-posting would duplicate revenue.
      if (existing) return existing.qbId;

      // Items must exist before the sale that references them, so create any
      // that are missing now rather than letting QuickBooks reject the sale.
      const soldVariants = await db
        .select({ variantId: saleLines.variantId })
        .from(saleLines)
        .where(eq(saleLines.saleId, job.localId));
      await ensureItems(connection, job.storeId, soldVariants.map((v) => v.variantId));

      const { payload, documentType } = await buildSalesReceipt(job.localId);
      const resource = documentType === 'INVOICE' ? 'invoice' : 'salesreceipt';

      const response = await qbRequest<Record<string, { Id: string; SyncToken: string }>>(
        connection,
        `/${resource}`,
        { method: 'POST', body: payload, requestId: job.requestIdempotencyKey },
      );

      const created = response.SalesReceipt ?? response.Invoice;
      if (!created?.Id) throw new Error('QuickBooks did not return an id');

      await recordLink(job.storeId, documentType === 'INVOICE' ? 'INVOICE' : 'SALES_RECEIPT', job.localId, created);
      await db.update(sales).set({ syncedAt: new Date() }).where(eq(sales.id, job.localId));
      return created.Id;
    }

    case 'REFUND_RECEIPT': {
      const existing = await linkedQbId(job.storeId, 'REFUND_RECEIPT', job.localId);
      if (existing) return existing.qbId;

      const refundedVariants = await db
        .select({ variantId: refundLines.variantId })
        .from(refundLines)
        .where(eq(refundLines.refundId, job.localId));
      await ensureItems(connection, job.storeId, refundedVariants.map((v) => v.variantId));

      const payload = await buildRefundReceipt(job.localId);
      const response = await qbRequest<{ RefundReceipt?: { Id: string; SyncToken: string } }>(
        connection,
        '/refundreceipt',
        { method: 'POST', body: payload, requestId: job.requestIdempotencyKey },
      );

      const created = response.RefundReceipt;
      if (!created?.Id) throw new Error('QuickBooks did not return an id');

      await recordLink(job.storeId, 'REFUND_RECEIPT', job.localId, created);
      return created.Id;
    }

    case 'CUSTOMER': {
      const existing = await linkedQbId(job.storeId, 'CUSTOMER', job.localId);
      if (existing) return existing.qbId;

      const payload = await buildCustomer(job.localId);
      const response = await qbRequest<{ Customer?: { Id: string; SyncToken: string } }>(
        connection,
        '/customer',
        { method: 'POST', body: payload, requestId: job.requestIdempotencyKey },
      );

      const created = response.Customer;
      if (!created?.Id) throw new Error('QuickBooks did not return an id');
      await recordLink(job.storeId, 'CUSTOMER', job.localId, created);
      return created.Id;
    }

    case 'ITEM': {
      const existing = await linkedQbId(job.storeId, 'ITEM', job.localId);
      if (existing) return existing.qbId;
      const [created] = await ensureItems(connection, job.storeId, [job.localId]);
      return created ?? null;
    }

    default:
      // Unsupported entity types are dropped rather than retried forever.
      return null;
  }
}

/**
 * Creates any QuickBooks items that are missing for these variants and records
 * the link. Idempotent: a variant already linked is skipped, and a name clash
 * (the item exists in QuickBooks but not in our link table) is resolved by
 * querying for it rather than failing.
 */
async function ensureItems(
  connection: Awaited<ReturnType<typeof activeConnection>>,
  storeId: string,
  variantIds: string[],
): Promise<string[]> {
  const unique = [...new Set(variantIds)];
  if (unique.length === 0) return [];

  const linked = await db
    .select({ localId: qbEntityLinks.localId, qbId: qbEntityLinks.qbId })
    .from(qbEntityLinks)
    .where(
      and(
        eq(qbEntityLinks.storeId, storeId),
        eq(qbEntityLinks.entity, 'ITEM'),
        inArray(qbEntityLinks.localId, unique),
      ),
    );
  const known = new Map(linked.map((l) => [l.localId, l.qbId]));
  const missing = unique.filter((id) => !known.has(id));

  for (const variantId of missing) {
    const payload = await buildItem(variantId);
    const name = String(payload.Name);

    let qbId: string | null = null;
    try {
      const response = await qbRequest<{ Item?: { Id: string; SyncToken: string } }>(connection, '/item', {
        method: 'POST',
        body: payload,
        requestId: `item-${variantId}`.slice(0, 48),
      });
      qbId = response.Item?.Id ?? null;
      if (response.Item) await recordLink(storeId, 'ITEM', variantId, response.Item);
    } catch (err) {
      // A duplicate name means the item is already in QuickBooks from a previous
      // run or manual entry; adopt it instead of failing the whole sale.
      const duplicate = err instanceof QbApiError && (err.code === '6240' || /duplicate/i.test(err.message));
      if (!duplicate) throw err;

      const query = `SELECT Id, SyncToken FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`;
      const found = await qbRequest<{ QueryResponse?: { Item?: Array<{ Id: string; SyncToken: string }> } }>(
        connection,
        `/query?query=${encodeURIComponent(query)}`,
      );
      const item = found.QueryResponse?.Item?.[0];
      if (!item) throw err;
      qbId = item.Id;
      await recordLink(storeId, 'ITEM', variantId, item);
    }

    if (qbId) known.set(variantId, qbId);
  }

  return unique.map((id) => known.get(id)).filter((id): id is string => Boolean(id));
}

/**
 * Voiding in QuickBooks keeps the document number but zeroes the amounts, which
 * preserves the audit trail on both sides.
 */
async function voidSalesReceipt(
  connection: Awaited<ReturnType<typeof activeConnection>>,
  job: { storeId: string; localId: string; requestIdempotencyKey: string },
): Promise<string | null> {
  const link =
    (await linkedQbId(job.storeId, 'SALES_RECEIPT', job.localId)) ??
    (await linkedQbId(job.storeId, 'INVOICE', job.localId));

  // Never posted, so there is nothing to void.
  if (!link) return null;

  const response = await qbRequest<{ SalesReceipt?: { Id: string; SyncToken: string } }>(
    connection,
    '/salesreceipt?operation=void',
    {
      method: 'POST',
      body: { Id: link.qbId, SyncToken: link.syncToken ?? '0' },
      requestId: job.requestIdempotencyKey,
    },
  );

  const updated = response.SalesReceipt;
  if (updated) {
    await db
      .update(qbEntityLinks)
      .set({ syncToken: updated.SyncToken, lastSyncedAt: new Date() })
      .where(
        and(
          eq(qbEntityLinks.storeId, job.storeId),
          eq(qbEntityLinks.localId, job.localId),
          eq(qbEntityLinks.entity, 'SALES_RECEIPT'),
        ),
      );
  }
  return link.qbId;
}

async function recordLink(
  storeId: string,
  entity: QbEntity,
  localId: string,
  created: { Id: string; SyncToken?: string },
): Promise<void> {
  await db
    .insert(qbEntityLinks)
    .values({
      storeId,
      entity,
      localId,
      qbId: created.Id,
      syncToken: created.SyncToken ?? '0',
    })
    .onConflictDoUpdate({
      target: [qbEntityLinks.storeId, qbEntityLinks.entity, qbEntityLinks.localId],
      set: { qbId: created.Id, syncToken: created.SyncToken ?? '0', lastSyncedAt: new Date() },
    });
}
