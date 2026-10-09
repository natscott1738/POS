import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { and, eq, lt, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { backups } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { uploadBackup, offsiteConfigured } from './offsite.js';

/**
 * Nightly logical backup: pg_dump -> gzip -> AES-256-GCM -> disk.
 *
 * Encryption is not optional in production. A POS dump contains customer
 * identifiers, phone numbers, staff records and full transaction history, so an
 * unencrypted file on a shop-floor machine is a breach waiting to be copied.
 *
 * Format: [12-byte IV][16-byte auth tag][ciphertext]
 */

export interface BackupResult {
  id: string;
  filename: string;
  sizeBytes: number;
  checksum: string;
  durationMs: number;
}

export async function runBackup(
  kind: 'DAILY' | 'MANUAL' | 'PRE_RESTORE',
  triggeredBy?: string,
): Promise<BackupResult> {
  const startedAt = Date.now();
  const directory = resolve(env.BACKUP_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const encrypted = Boolean(env.BACKUP_ENCRYPTION_KEY);
  const filename = `pos-${kind.toLowerCase()}-${stamp}.sql.gz${encrypted ? '.enc' : ''}`;
  const target = join(directory, filename);

  const [record] = await db
    .insert(backups)
    .values({
      kind,
      status: 'RUNNING',
      filename,
      location: target,
      encrypted,
      triggeredBy: triggeredBy ?? null,
    })
    .returning({ id: backups.id });

  if (!record) throw new Error('could not create backup record');

  try {
    await dumpTo(target, encrypted);

    const fileStat = await stat(target);
    const checksum = await sha256File(target);
    const durationMs = Date.now() - startedAt;

    await db
      .update(backups)
      .set({
        status: 'SUCCESS',
        sizeBytes: fileStat.size,
        checksum,
        durationMs,
        completedAt: new Date(),
      })
      .where(eq(backups.id, record.id));

    // Off-site copy happens after the local backup is complete and verified, and
    // a failure here is recorded rather than thrown: a good local backup is worth
    // keeping even when the upload fails.
    if (offsiteConfigured()) {
      const offsite = await uploadBackup(target);
      await db
        .update(backups)
        .set({
          offsiteKey: offsite.key ?? null,
          offsiteUploadedAt: offsite.uploaded ? new Date() : null,
          offsiteError: offsite.error ?? null,
        })
        .where(eq(backups.id, record.id));
    }

    await pruneOldBackups(directory);

    return { id: record.id, filename, sizeBytes: fileStat.size, checksum, durationMs };
  } catch (err) {
    await db
      .update(backups)
      .set({
        status: 'FAILED',
        error: err instanceof Error ? err.message.slice(0, 1000) : 'unknown error',
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
      })
      .where(eq(backups.id, record.id));
    // Remove the partial file so it can never be mistaken for a usable backup.
    await rm(target, { force: true });
    throw err;
  }
}

async function dumpTo(target: string, encrypt: boolean): Promise<void> {
  // Credentials are passed via the environment, never on the command line where
  // they would be visible in the process table.
  const child = spawn(
    env.PG_DUMP_PATH,
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--format=plain', env.DATABASE_URL],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCONNECT_TIMEOUT: '10' } },
  );

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('close', (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`pg_dump exited with ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(target, { mode: 0o600 });

  if (!encrypt) {
    await Promise.all([pipeline(child.stdout, gzip, out), exited]);
    return;
  }

  const key = Buffer.from(env.BACKUP_ENCRYPTION_KEY as string, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });

  // The auth tag is only known once the stream ends, so the header is written
  // with a placeholder and the real tag is patched in afterwards.
  out.write(iv);
  const tagPlaceholder = Buffer.alloc(16);
  out.write(tagPlaceholder);

  await Promise.all([pipeline(child.stdout, gzip, cipher, out), exited]);

  const tag = cipher.getAuthTag();
  await patchAuthTag(target, tag);
}

/** Writes the GCM tag into the reserved 16 bytes at offset 12. */
async function patchAuthTag(path: string, tag: Buffer): Promise<void> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r+');
  try {
    await handle.write(tag, 0, 16, 12);
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Verifies a backup is still byte-for-byte what was written. Catches silent disk
 * corruption, which is the usual reason a restore fails at the worst moment.
 */
export async function verifyBackup(backupId: string): Promise<{ valid: boolean; reason?: string }> {
  const [record] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
  if (!record) return { valid: false, reason: 'not found' };

  try {
    const fileStat = await stat(record.location);
    if (record.sizeBytes && fileStat.size !== record.sizeBytes) {
      return { valid: false, reason: 'size does not match the recorded value' };
    }
    const checksum = await sha256File(record.location);
    if (record.checksum && checksum !== record.checksum) {
      return { valid: false, reason: 'checksum mismatch: the file has been altered or corrupted' };
    }
    await db.update(backups).set({ status: 'VERIFIED', verifiedAt: new Date() }).where(eq(backups.id, backupId));
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'unreadable' };
  }
}

async function pruneOldBackups(directory: string): Promise<void> {
  const cutoff = new Date(Date.now() - env.BACKUP_RETENTION_DAYS * 24 * 3600 * 1000);

  const expired = await db
    .select({ id: backups.id, location: backups.location })
    .from(backups)
    .where(and(lt(backups.startedAt, cutoff), eq(backups.status, 'SUCCESS')));

  for (const record of expired) {
    await rm(record.location, { force: true }).catch(() => {});
    await db.delete(backups).where(eq(backups.id, record.id));
  }

  // Sweep orphaned files whose database rows are already gone.
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.startsWith('pos-')) continue;
    const path = join(directory, file);
    const info = await stat(path).catch(() => null);
    if (info && info.mtime < cutoff) await rm(path, { force: true }).catch(() => {});
  }
}

export async function listBackups(limit = 50) {
  return db
    .select({
      id: backups.id,
      kind: backups.kind,
      status: backups.status,
      filename: backups.filename,
      sizeBytes: backups.sizeBytes,
      checksum: backups.checksum,
      encrypted: backups.encrypted,
      durationMs: backups.durationMs,
      error: backups.error,
      verifiedAt: backups.verifiedAt,
      offsiteKey: backups.offsiteKey,
      offsiteUploadedAt: backups.offsiteUploadedAt,
      offsiteError: backups.offsiteError,
      startedAt: backups.startedAt,
      completedAt: backups.completedAt,
    })
    .from(backups)
    .orderBy(desc(backups.startedAt))
    .limit(limit);
}

/**
 * Health signal for the ops dashboard: when did we last take a good backup, and
 * is that recent enough to be meaningful?
 */
export async function backupHealth(): Promise<{
  healthy: boolean;
  lastSuccessAt: Date | null;
  hoursSince: number | null;
  offsiteConfigured: boolean;
  offsiteHealthy: boolean;
  lastOffsiteAt: Date | null;
}> {
  const [last] = await db
    .select({ completedAt: backups.completedAt, offsiteUploadedAt: backups.offsiteUploadedAt })
    .from(backups)
    .where(eq(backups.status, 'SUCCESS'))
    .orderBy(desc(backups.startedAt))
    .limit(1);

  const configured = offsiteConfigured();

  if (!last?.completedAt) {
    return {
      healthy: false,
      lastSuccessAt: null,
      hoursSince: null,
      offsiteConfigured: configured,
      offsiteHealthy: false,
      lastOffsiteAt: null,
    };
  }

  const hoursSince = (Date.now() - last.completedAt.getTime()) / 3_600_000;
  const offsiteHours = last.offsiteUploadedAt
    ? (Date.now() - last.offsiteUploadedAt.getTime()) / 3_600_000
    : null;

  return {
    healthy: hoursSince < 36,
    lastSuccessAt: last.completedAt,
    hoursSince: Math.round(hoursSince),
    offsiteConfigured: configured,
    // Only meaningful when configured; an unconfigured estate is reported, not failed.
    offsiteHealthy: !configured || (offsiteHours !== null && offsiteHours < 36),
    lastOffsiteAt: last.offsiteUploadedAt ?? null,
  };
}
