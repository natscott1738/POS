import type { FastifyRequest } from 'fastify';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

/** Field names whose values must never appear in an audit diff. */
const REDACTED_KEYS = new Set([
  'password', 'newpassword', 'currentpassword', 'pin', 'pinhash', 'passwordhash',
  'totp', 'secret', 'mfasecret', 'mfasecretencrypted', 'accesstoken', 'refreshtoken',
  'accesstokenencrypted', 'refreshtokenencrypted', 'authorization', 'cookie',
  'consumersecret', 'passkey', 'clientsecret', 'encryptedsecret', 'csrftoken',
  'overridetoken', 'cardnumber', 'pan', 'cvv', 'track2',
]);

/**
 * Strips secrets before anything is written to the audit trail. The audit log is
 * queryable by auditors, so it must never become a second home for credentials.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}...[truncated]`;
  return value;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: unknown;
  reason?: string | null;
  storeId?: string | null;
  terminalId?: string | null;
  overrideByUserId?: string | null;
}

/**
 * Writes one append-only audit row. Pass a transaction handle so the audit record
 * commits or rolls back with the change it describes - an audit trail that can
 * disagree with the data is worse than none.
 */
export async function writeAudit(
  exec: Executor,
  request: FastifyRequest | null,
  entry: AuditEntry,
): Promise<void> {
  const actor = request?.auth;
  await exec.insert(auditLogs).values({
    actorId: actor?.userId ?? null,
    actorEmail: actor?.email ?? null,
    actorRole: actor?.role ?? null,
    overrideByUserId: entry.overrideByUserId ?? null,
    storeId: entry.storeId ?? null,
    terminalId: entry.terminalId ?? actor?.terminalId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    changes: entry.changes === undefined ? null : JSON.stringify(redact(entry.changes)),
    reason: entry.reason ?? null,
    ipAddress: request?.ip ?? null,
    userAgent: request?.headers['user-agent']?.slice(0, 300) ?? null,
    requestId: request?.id ?? null,
  });
}

/** Fire-and-forget variant for events that must not fail the request they describe. */
export function writeAuditSafe(request: FastifyRequest | null, entry: AuditEntry): void {
  void writeAudit(db, request, entry).catch((err) => {
    request?.log.error({ err, entry: entry.action }, 'failed to write audit log');
  });
}

export async function queryAuditLogs(filters: {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit: number;
}) {
  const conditions = [];
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
  if (filters.from) conditions.push(gte(auditLogs.createdAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogs.createdAt, filters.to));

  return db
    .select()
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : sql`true`)
    .orderBy(desc(auditLogs.createdAt))
    .limit(filters.limit);
}
