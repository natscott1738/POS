import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client.js';
import { jobRuns } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { runBackup } from './backup.js';
import { runQbSyncCycle } from '../modules/quickbooks/worker.js';
import { reconcilePendingPushes } from '../modules/payments/mpesa/service.js';
import { expireStalePdqTransactions } from '../modules/payments/pdq/service.js';
import { purgeExpiredIdempotencyKeys } from '../core/idempotency.js';
import { purgeExpiredRefreshTokens } from '../auth/tokens.js';
import { runHealthChecks, alertingConfigured } from '../core/notify.js';
import { expireLoyaltyPoints } from '../modules/customers/loyalty.js';

const jobs: Cron[] = [];

/**
 * Background schedule. Every job is wrapped so a failure is recorded and logged
 * but never takes the process down: a POS that stops serving tills because a
 * backup failed has made a bad trade.
 */
export function startScheduler(log: FastifyBaseLogger): void {
  if (env.BACKUP_ENABLED) {
    jobs.push(
      new Cron(env.BACKUP_CRON, { name: 'daily-backup', timezone: 'Africa/Nairobi', protect: true }, () =>
        track(log, 'daily-backup', async () => {
          const result = await runBackup('DAILY');
          return { filename: result.filename, sizeBytes: result.sizeBytes };
        }),
      ),
    );
  }

  if (env.QB_ENABLED) {
    jobs.push(
      // `protect: true` skips a tick if the previous run is still going, so a slow
      // QuickBooks never causes overlapping workers to fight over the same jobs.
      new Cron(`*/${Math.max(30, env.QB_SYNC_INTERVAL_SECONDS)} * * * * *`, { name: 'qb-sync', protect: true }, () =>
        track(log, 'qb-sync', () => runQbSyncCycle(log)),
      ),
    );
  }

  if (env.MPESA_ENABLED) {
    jobs.push(
      new Cron('*/60 * * * * *', { name: 'mpesa-reconcile', protect: true }, () =>
        track(log, 'mpesa-reconcile', () => reconcilePendingPushes()),
      ),
    );
  }

  if (env.PDQ_ENABLED) {
    jobs.push(
      new Cron('*/120 * * * * *', { name: 'pdq-expire', protect: true }, () =>
        track(log, 'pdq-expire', async () => ({ expired: await expireStalePdqTransactions() })),
      ),
    );
  }

  jobs.push(
    new Cron('30 3 * * *', { name: 'housekeeping', timezone: 'Africa/Nairobi', protect: true }, () =>
      track(log, 'housekeeping', async () => {
        await purgeExpiredIdempotencyKeys();
        const purged = await purgeExpiredRefreshTokens();
        const loyalty = await expireLoyaltyPoints();
        return { refreshTokensPurged: purged, ...loyalty };
      }),
    ),
  );

  if (alertingConfigured()) {
    jobs.push(
      // Watches the things that fail silently: stale backups and dead jobs.
      new Cron(env.HEALTH_CHECK_CRON, { name: 'health-check', protect: true }, () =>
        track(log, 'health-check', async () => ({ alerts: (await runHealthChecks(log)).length })),
      ),
    );
  }

  log.info({ jobs: jobs.map((j) => j.name) }, 'scheduler started');
}

export function stopScheduler(): void {
  for (const job of jobs) job.stop();
  jobs.length = 0;
}

async function track(
  log: FastifyBaseLogger,
  name: string,
  work: () => Promise<unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const [run] = await db
    .insert(jobRuns)
    .values({ name, status: 'RUNNING' })
    .returning({ id: jobRuns.id })
    .catch(() => [undefined]);

  try {
    const detail = await work();
    if (run) {
      await db
        .update(jobRuns)
        .set({
          status: 'SUCCESS',
          detail: (detail ?? null) as never,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(jobRuns.id, run.id));
    }
  } catch (err) {
    log.error({ err, job: name }, 'scheduled job failed');
    if (run) {
      await db
        .update(jobRuns)
        .set({
          status: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 1000) : 'unknown error',
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(jobRuns.id, run.id))
        .catch(() => {});
    }
  }
}

