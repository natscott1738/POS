import { execSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Integration test harness.
 *
 * These tests run against a real PostgreSQL, because the guarantees that matter
 * most in this system — row locks preventing oversell, unique indexes making
 * sync idempotent, transactions rolling back cleanly — do not exist in a mock.
 * A mocked test here would prove nothing.
 *
 * Each run gets its own database, created and dropped around the suite, so tests
 * never see each other's data and can run in any order.
 */

export interface TestDatabase {
  url: string;
  name: string;
  drop: () => void;
}

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/18/bin';
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://pos@127.0.0.1:5433/postgres';

function psql(url: string, sql: string): string {
  return execSync(`${PG_BIN}/psql "${url}" -v ON_ERROR_STOP=1 -tA -c ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function createTestDatabase(): TestDatabase {
  const name = `pos_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  psql(ADMIN_URL, `CREATE DATABASE ${name}`);
  const url = ADMIN_URL.replace(/\/postgres$/, `/${name}`);
  return {
    url,
    name,
    drop: () => {
      try {
        // Terminate stragglers first; a held connection blocks the drop.
        psql(ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`);
        psql(ADMIN_URL, `DROP DATABASE IF EXISTS ${name}`);
      } catch {
        // A leaked test database is untidy, not a failure.
      }
    },
  };
}

/**
 * Sets the environment a fresh API process needs. Must run before any module
 * that imports config, because configuration is validated at import time.
 */
export function applyTestEnv(databaseUrl: string): void {
  process.env.NODE_ENV = 'test';
  process.env.SKIP_DOTENV = 'true';
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.BACKUP_ENABLED = 'false';
  process.env.LOG_LEVEL = 'fatal';
  process.env.PDQ_ENABLED = 'true';
  process.env.PDQ_PROVIDER = 'SIMULATOR';
  process.env.ENABLE_DEV_ROUTES = 'true';
  process.env.ALERT_WEBHOOK_URL = 'https://example.invalid/hook';
}

export function runMigrations(databaseUrl: string): void {
  execSync('npx tsx src/db/migrate.ts', {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: databaseUrl, SKIP_DOTENV: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
