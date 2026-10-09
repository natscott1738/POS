import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Config is validated at import time, so the environment must exist first.
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/test';
  process.env.JWT_SECRET ??= 'a-test-secret-that-is-at-least-32-characters';
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
});

describe('boolean config flags', () => {
  // Regression: z.coerce.boolean() is Boolean(value), so the string "false" was
  // true - ENABLE_DEV_ROUTES=false enabled dev routes and BACKUP_ENABLED=false
  // could not disable backups.
  it('reads the string "false" as false', async () => {
    const { boolish } = await import('../src/config/env.js');
    expect(boolish(true).parse('false')).toBe(false);
    expect(boolish(true).parse('FALSE')).toBe(false);
    expect(boolish(true).parse(' false ')).toBe(false);
  });

  it('accepts the usual spellings of both values', async () => {
    const { boolish } = await import('../src/config/env.js');
    for (const word of ['true', '1', 'yes', 'y', 'on', 'TRUE']) {
      expect(boolish(false).parse(word)).toBe(true);
    }
    for (const word of ['false', '0', 'no', 'n', 'off', '']) {
      expect(boolish(true).parse(word)).toBe(false);
    }
  });

  it('falls back to the default only when the variable is unset', async () => {
    const { boolish } = await import('../src/config/env.js');
    expect(boolish(true).parse(undefined)).toBe(true);
    expect(boolish(false).parse(undefined)).toBe(false);
  });

  it('rejects anything it cannot read rather than guessing', async () => {
    const { boolish } = await import('../src/config/env.js');
    expect(boolish(false).safeParse('ture').success).toBe(false);
    expect(boolish(false).safeParse('enabled').success).toBe(false);
  });
});
