import { bigint, boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsCol } from './columns.js';
import { backupStatusEnum } from './enums.js';
import { users } from './identity.js';

/** Record of every backup run, including verification, so "we have backups" is provable. */
export const backups = pgTable(
  'backups',
  {
    id: pk(),
    kind: text('kind').notNull().default('DAILY'),
    status: backupStatusEnum('status').notNull().default('RUNNING'),
    filename: text('filename').notNull(),
    location: text('location').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** SHA-256 of the dump; re-checked on verify and before any restore. */
    checksum: text('checksum'),
    encrypted: boolean('encrypted').notNull().default(true),
    durationMs: integer('duration_ms'),
    error: text('error'),
    verifiedAt: tsCol('verified_at'),
    /** Where the off-site copy landed, and whether it got there. */
    offsiteKey: text('offsite_key'),
    offsiteUploadedAt: tsCol('offsite_uploaded_at'),
    offsiteError: text('offsite_error'),
    startedAt: tsCol('started_at').notNull().defaultNow(),
    completedAt: tsCol('completed_at'),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('backups_started_idx').on(t.startedAt), index('backups_status_idx').on(t.status)],
);

/** Generic async job runner used by report exports and scheduled maintenance. */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: pk(),
    name: text('name').notNull(),
    status: text('status').notNull().default('RUNNING'),
    detail: jsonb('detail'),
    error: text('error'),
    startedAt: tsCol('started_at').notNull().defaultNow(),
    finishedAt: tsCol('finished_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('job_runs_name_idx').on(t.name, t.startedAt)],
);
