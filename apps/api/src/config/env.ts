import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load a .env file before validating, so `npm run dev` works from a checkout
 * without exporting anything by hand. Done here rather than in an entrypoint
 * because this module validates at import time, and several entrypoints
 * (server, migrate, seed) all reach it through different import paths.
 *
 * Real environment variables always win: a .env file never overwrites what the
 * platform already set, so it cannot silently override production config.
 */
function loadDotEnv(): void {
  // Explicit opt-out for containers and CI, where config comes from the platform.
  if (process.env.SKIP_DOTENV === 'true') return;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ENV_FILE,
    resolve(process.cwd(), '.env'),
    // Walk up from this file so it works from dist/ or src/, and from either
    // the app directory or the repo root.
    resolve(here, '../../.env'),
    resolve(here, '../../../.env'),
    resolve(here, '../../../../.env'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      // Node's built-in parser; no dependency, and it does not clobber
      // variables that are already set in the real environment.
      process.loadEnvFile(candidate);
    } catch {
      // A malformed or unreadable file must not stop the process here: the
      // schema validation below reports precisely what is missing instead.
    }
    return;
  }
}

loadDotEnv();

/**
 * Configuration is validated once at boot and the process refuses to start if
 * anything is missing or weak. A POS that boots with a default signing key is a
 * POS that has already been compromised, so there are no fallback secrets here.
 */

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Environment variables are always strings, and `z.coerce.boolean()` is
 * `Boolean(value)` — which makes the string "false" true. Writing
 * `ENABLE_DEV_ROUTES=false` would therefore *enable* dev routes, and
 * `BACKUP_ENABLED=false` could not turn backups off at all.
 *
 * So parse the words operators actually write, and reject anything else rather
 * than guessing: a misspelled flag must fail loudly at boot, not silently pick
 * the dangerous side.
 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off', '']);

export const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const normalised = value.trim().toLowerCase();
      if (TRUE_WORDS.has(normalised)) return true;
      if (FALSE_WORDS.has(normalised)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a boolean (true/false, 1/0, yes/no, on/off), got "${value}"`,
      });
      return z.NEVER;
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: boolish(false),

  /** Signs access tokens. Rotating this invalidates every session instantly. */
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('backyard-pos'),
  JWT_AUDIENCE: z.string().default('backyard-pos.api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 14),

  /** AES-256-GCM master key for column encryption (QB tokens, TOTP secrets, PDQ secrets). */
  ENCRYPTION_KEY: hex32,
  /** Previous key, kept during rotation so existing ciphertext still decrypts. */
  ENCRYPTION_KEY_PREVIOUS: hex32.optional(),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolish(isProd),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  /** Public base URL; M-PESA and QuickBooks call back here, so it must be exact. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),

  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /* -------------------------------- M-PESA -------------------------------- */
  MPESA_ENABLED: boolish(false),
  MPESA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  /** STK recipient; may differ from the go-live BusinessShortCode for a Till. */
  MPESA_PARTY_B: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  /** Distinguishes till (CustomerBuyGoodsOnline) from paybill (CustomerPayBillOnline). */
  MPESA_TRANSACTION_TYPE: z
    .enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'])
    .default('CustomerPayBillOnline'),
  /** Unguessable path segment on the public callback URL; a cheap shared secret. */
  MPESA_CALLBACK_TOKEN: z.string().min(24).optional(),
  /** Safaricom egress ranges. Empty disables the check (dev only). */
  MPESA_ALLOWED_IPS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  MPESA_STK_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(600).default(120),

  /* ---------------------------------- PDQ --------------------------------- */
  PDQ_ENABLED: boolish(false),
  PDQ_PROVIDER: z.enum(['SIMULATOR', 'ECR_HTTP']).default('SIMULATOR'),
  PDQ_TIMEOUT_SECONDS: z.coerce.number().int().min(15).max(600).default(120),
  PDQ_CALLBACK_TOKEN: z.string().min(24).optional(),

  /* ------------------------------ QuickBooks ------------------------------ */
  QB_ENABLED: boolish(false),
  QB_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  QB_CLIENT_ID: z.string().optional(),
  QB_CLIENT_SECRET: z.string().optional(),
  QB_REDIRECT_URI: z.string().url().optional(),
  QB_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),

  /* -------------------------------- Backups ------------------------------- */
  BACKUP_ENABLED: boolish(true),
  BACKUP_DIR: z.string().default('./backups'),
  /** Cron expression, store-local time. Default 02:15 nightly. */
  BACKUP_CRON: z.string().default('15 2 * * *'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Backups are encrypted with this key; without it a stolen dump is plaintext PII. */
  BACKUP_ENCRYPTION_KEY: hex32.optional(),
  PG_DUMP_PATH: z.string().default('pg_dump'),

  /** Off-site copy. Without this, a fire destroys the data and its backups together. */
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_REGION: z.string().default('us-east-1'),
  /** Set for any non-AWS provider (Backblaze, Wasabi, MinIO, DigitalOcean Spaces). */
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_PREFIX: z.string().default('pos-backups/'),

  /* ---------------------------------- Email -------------------------------- */
  /**
   * Transactional email for password resets and customer receipts. Distinct from
   * ALERT_*, which reaches operators: a Slack webhook cannot deliver a reset link
   * to a cashier.
   */
  EMAIL_PROVIDER: z.enum(['resend', 'sendgrid', 'mailgun', 'webhook']).optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_MAILGUN_DOMAIN: z.string().optional(),
  EMAIL_WEBHOOK_URL: z.string().url().optional(),

  /* -------------------------------- Alerting ------------------------------- */
  /** Slack/Teams/any JSON webhook. Without it, silent failures stay silent. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_EMAIL_TO: z.string().email().optional(),
  /** How often the health sweep runs. */
  HEALTH_CHECK_CRON: z.string().default('*/15 * * * *'),

  /** Enables the seed endpoint and the PDQ simulator. Must never be true in prod. */
  ENABLE_DEV_ROUTES: boolish(false),
});

export type Env = z.infer<typeof schema>;

function fail(messages: string[]): never {
  // eslint-disable-next-line no-console
  console.error(`\nInvalid configuration:\n${messages.map((m) => `  - ${m}`).join('\n')}\n`);
  process.exit(1);
}

function load(): Env {
  // An empty value in a .env file ("ALERT_WEBHOOK_URL=") means "not configured",
  // not "configured as an empty string". Without this, commenting a setting out
  // by blanking it produces a confusing validation failure instead.
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && value.trim() !== '') source[key] = value;
  }

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = parsed.data;
  const problems: string[] = [];

  // Cross-field rules: a feature that is switched on must be fully configured,
  // so a half-set-up integration fails at boot rather than mid-transaction.
  if (env.MPESA_ENABLED) {
    for (const key of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_TOKEN'] as const) {
      if (!env[key]) problems.push(`${key} is required when MPESA_ENABLED=true`);
    }
  }
  if (env.QB_ENABLED) {
    for (const key of ['QB_CLIENT_ID', 'QB_CLIENT_SECRET', 'QB_REDIRECT_URI'] as const) {
      if (!env[key]) problems.push(`${key} is required when QB_ENABLED=true`);
    }
  }
  if (env.PDQ_ENABLED && env.PDQ_PROVIDER === 'ECR_HTTP' && !env.PDQ_CALLBACK_TOKEN) {
    problems.push('PDQ_CALLBACK_TOKEN is required when PDQ_PROVIDER=ECR_HTTP');
  }
  if (env.EMAIL_PROVIDER) {
    if (!env.EMAIL_API_KEY) problems.push('EMAIL_API_KEY is required when EMAIL_PROVIDER is set');
    if (!env.EMAIL_FROM) problems.push('EMAIL_FROM is required when EMAIL_PROVIDER is set');
  }

  if (env.NODE_ENV === 'production') {
    if (env.ENABLE_DEV_ROUTES) problems.push('ENABLE_DEV_ROUTES must be false in production');
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (env.PUBLIC_BASE_URL.startsWith('http://')) problems.push('PUBLIC_BASE_URL must use https in production');
    if (env.CORS_ORIGINS.some((o) => o.startsWith('http://') && !o.includes('localhost'))) {
      problems.push('CORS_ORIGINS must use https in production');
    }
    if (env.MPESA_ENABLED && env.MPESA_ALLOWED_IPS.length === 0) {
      problems.push('MPESA_ALLOWED_IPS must be set in production so callbacks are source-restricted');
    }
    if (env.BACKUP_ENABLED && !env.BACKUP_ENCRYPTION_KEY) {
      problems.push('BACKUP_ENCRYPTION_KEY is required in production');
    }
    // A backup sitting on the same disk as the database is not a backup.
    if (env.BACKUP_ENABLED && !env.BACKUP_S3_BUCKET) {
      problems.push('BACKUP_S3_BUCKET is required in production so backups leave the building');
    }
    if (env.BACKUP_S3_BUCKET && (!env.BACKUP_S3_ACCESS_KEY_ID || !env.BACKUP_S3_SECRET_ACCESS_KEY)) {
      problems.push('BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY are required with a bucket');
    }
    // Backups nobody is told about are backups nobody notices failing.
    if (!env.ALERT_WEBHOOK_URL && !env.ALERT_EMAIL_TO) {
      problems.push('Set ALERT_WEBHOOK_URL or ALERT_EMAIL_TO so failures reach a human');
    }
    if (env.ENCRYPTION_KEY === env.JWT_SECRET) problems.push('ENCRYPTION_KEY and JWT_SECRET must differ');
  }

  if (problems.length > 0) fail(problems);
  return env;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
