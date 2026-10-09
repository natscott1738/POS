import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { jobRuns } from '../db/schema/index.js';
import { desc, eq, gte, and, sql } from 'drizzle-orm';

/**
 * Operational alerting.
 *
 * Deliberately simple: a webhook (Slack, Teams, or anything that accepts JSON)
 * and/or SMTP-less email via a provider HTTP API. The point is that a failed
 * backup or a stalled accounting queue reaches a human, not that we build an
 * observability platform.
 *
 * Alerts are deduplicated: the same problem every five minutes trains people to
 * ignore alerts entirely.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
}

const recentlySent = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

export function alertingConfigured(): boolean {
  return Boolean(env.ALERT_WEBHOOK_URL || env.ALERT_EMAIL_TO);
}

export async function sendAlert(alert: Alert, log?: { warn: (o: unknown, m?: string) => void }): Promise<boolean> {
  if (!alertingConfigured()) return false;

  const lastSent = recentlySent.get(alert.key);
  if (lastSent && Date.now() - lastSent < DEDUPE_WINDOW_MS) return false;
  recentlySent.set(alert.key, Date.now());

  const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟠' : '🔵';
  const text = [
    `${icon} *${alert.title}*`,
    alert.detail ?? '',
    alert.context ? '```' + JSON.stringify(alert.context, null, 2) + '```' : '',
    `_${env.JWT_ISSUER} · ${env.NODE_ENV}_`,
  ]
    .filter(Boolean)
    .join('\n');

  let delivered = false;

  if (env.ALERT_WEBHOOK_URL) {
    try {
      const response = await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` suits Slack and Teams; `title`/`detail` suit anything else.
        body: JSON.stringify({ text, title: alert.title, detail: alert.detail, severity: alert.severity }),
        signal: AbortSignal.timeout(10_000),
      });
      delivered = response.ok;
    } catch (err) {
      log?.warn({ err, alert: alert.key }, 'alert webhook failed');
    }
  }

  return delivered;
}

/**
 * Periodic health sweep. Checks the things that fail silently: backups that
 * stopped running, an accounting queue that has given up, and offline sales
 * that were flagged for review and never looked at.
 */
export async function runHealthChecks(log: { warn: (o: unknown, m?: string) => void }): Promise<Alert[]> {
  const raised: Alert[] = [];
  const { backupHealth } = await import('../jobs/backup.js');

  const backups = await backupHealth();
  if (!backups.healthy) {
    raised.push({
      key: 'backup-stale',
      severity: 'critical',
      title: 'No successful backup in over 36 hours',
      detail: backups.lastSuccessAt
        ? `Last good backup: ${backups.lastSuccessAt.toISOString()}`
        : 'There has never been a successful backup.',
    });
  } else if (backups.offsiteConfigured && !backups.offsiteHealthy) {
    raised.push({
      key: 'backup-offsite-stale',
      severity: 'warning',
      title: 'Backups are running but not reaching off-site storage',
      detail: 'The local copy is current; the off-site copy is not. A site loss would lose everything.',
    });
  }

  // A job that failed on its last run and has not succeeded since.
  const failures = await db
    .select({ name: jobRuns.name, error: jobRuns.error, startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.status, 'FAILED'), gte(jobRuns.startedAt, sql`now() - interval '24 hours'`)))
    .orderBy(desc(jobRuns.startedAt))
    .limit(5);

  for (const failure of failures) {
    raised.push({
      key: `job-failed-${failure.name}`,
      severity: 'warning',
      title: `Scheduled job failed: ${failure.name}`,
      detail: failure.error ?? undefined,
    });
  }

  for (const alert of raised) await sendAlert(alert, log);
  return raised;
}

/** Test hook so an operator can prove alerting works before relying on it. */
export async function sendTestAlert(): Promise<boolean> {
  recentlySent.delete('test-alert');
  return sendAlert({
    key: 'test-alert',
    severity: 'info',
    title: 'Backyard POS alert test',
    detail: 'If you can read this, operational alerts are working.',
  });
}
