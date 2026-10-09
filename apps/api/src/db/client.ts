import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env, isProduction } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * Single pooled connection for the process. `prepare: false` keeps us compatible
 * with transaction-mode poolers (PgBouncer), which a multi-till deployment will
 * eventually sit behind.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  prepare: false,
  idle_timeout: 30,
  connect_timeout: 10,
  // Never let a runaway query pin a connection through a busy trading hour.
  connection: { statement_timeout: 30_000 },
  onnotice: (notice) => {
    // "already exists, skipping" from CREATE ... IF NOT EXISTS is expected on
    // every migration run and reads alarmingly like a failure. Drop it.
    if (notice.code === '42710' || notice.code === '42P06' || notice.code === '42P07') return;
    if (!isProduction) console.warn(`postgres: ${notice.message}`);
  },
  transform: { undefined: null },
});

export const db: PostgresJsDatabase<typeof schema> = drizzle(sql, {
  schema,
  logger: env.LOG_LEVEL === 'trace',
});

export type Database = typeof db;
/** The handle passed to code that must run inside an existing transaction. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Accepts either the pool or a transaction, so services compose freely. */
export type Executor = Database | Tx;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { schema };
