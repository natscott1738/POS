import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Config is validated at import time, so the environment must exist first.
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/test';
  process.env.JWT_SECRET ??= 'a-test-secret-that-is-at-least-32-characters';
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
});

describe('column encryption', () => {
  it('round-trips and produces different ciphertext each time', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/core/crypto.js');
    const plaintext = 'qb-refresh-token-abc123';

    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);

    expect(a).not.toBe(b); // random IV per encryption
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
    expect(a).not.toContain(plaintext);
  });

  it('detects tampering via the GCM auth tag', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/core/crypto.js');
    const payload = encryptSecret('sensitive');
    const parts = payload.split('.');
    // Flip a byte in the ciphertext.
    const corrupted = Buffer.from(parts[3] as string, 'base64');
    corrupted[0] ^= 0xff;
    parts[3] = corrupted.toString('base64');

    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('refuses to decrypt when the associated data does not match', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/core/crypto.js');
    // Binding to a store id stops a valid blob being moved to another row.
    const payload = encryptSecret('secret', 'store-a');
    expect(decryptSecret(payload, 'store-a')).toBe('secret');
    expect(() => decryptSecret(payload, 'store-b')).toThrow();
  });

  it('rejects malformed ciphertext rather than returning garbage', async () => {
    const { decryptSecret } = await import('../src/core/crypto.js');
    expect(() => decryptSecret('not-encrypted')).toThrow();
    expect(() => decryptSecret('v2.a.b.c')).toThrow();
  });
});

describe('constant-time comparison', () => {
  it('matches equal strings and rejects others regardless of length', async () => {
    const { safeEqual } = await import('../src/core/crypto.js');
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'tokes')).toBe(false);
    expect(safeEqual('token', 'tok')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('TOTP', () => {
  it('accepts the current code and rejects a wrong one', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await import('../src/auth/totp.js');
    const secret = generateTotpSecret();
    const code = generateTotp(secret);

    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code).valid).toBe(true);
    expect(verifyTotp(secret, '000000').valid).toBe(false);
    expect(verifyTotp(secret, 'abcdef').valid).toBe(false);
  });

  it('tolerates one step of clock drift but not more', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await import('../src/auth/totp.js');
    const secret = generateTotpSecret();
    const now = Date.now();

    const previous = generateTotp(secret, now - 30_000);
    expect(verifyTotp(secret, previous, now).valid).toBe(true);

    const longAgo = generateTotp(secret, now - 5 * 60_000);
    expect(verifyTotp(secret, longAgo, now).valid).toBe(false);
  });

  it('does not accept another secret’s code', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await import('../src/auth/totp.js');
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(verifyTotp(a, generateTotp(b)).valid).toBe(false);
  });
});

describe('CSV export', () => {
  it('escapes separators, quotes and newlines', async () => {
    const { toCsv } = await import('../src/modules/reports/export.js');
    const csv = toCsv([{ name: 'Tea, Green', note: 'He said "hi"', extra: 'line1\nline2' }]);

    expect(csv).toContain('"Tea, Green"');
    expect(csv).toContain('"He said ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', async () => {
    const { toCsv } = await import('../src/modules/reports/export.js');
    // A product name beginning with = would execute when opened in Excel.
    const csv = toCsv([{ name: '=cmd|/c calc!A1' }, { name: '+1+1' }, { name: '@SUM(A1)' }, { name: '-2+3' }]);

    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+1+1");
    expect(csv).toContain("'@SUM");
    expect(csv).toContain("'-2+3");
  });
});

describe('audit redaction', () => {
  it('strips credentials from anything written to the audit trail', async () => {
    const { redact } = await import('../src/core/audit.js');
    const result = redact({
      email: 'user@example.com',
      password: 'hunter2',
      pin: '1234',
      nested: { refreshToken: 'rt_secret', clientSecret: 'cs_secret', keep: 'visible' },
      list: [{ totp: '123456' }],
    }) as Record<string, unknown>;

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('rt_secret');
    expect(serialised).not.toContain('cs_secret');
    expect(serialised).not.toContain('123456');
    expect(serialised).toContain('user@example.com');
    expect(serialised).toContain('visible');
  });
});

describe('idempotency hashing', () => {
  it('is insensitive to key order but sensitive to values', async () => {
    const { stableStringify } = await import('../src/core/idempotency.js');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
  });
});

describe('PAN masking', () => {
  it('never retains a full card number', async () => {
    const { maskPan } = await import('../src/modules/payments/pdq/provider.js');
    const masked = maskPan('4000123412341234');
    expect(masked).not.toContain('1234123412');
    expect(masked?.startsWith('400012')).toBe(true);
    expect(masked?.endsWith('1234')).toBe(true);
  });
});

describe('password policy', () => {
  it('rejects predictable and identity-derived passwords', async () => {
    const { isTriviallyWeak } = await import('../src/auth/password.js');
    expect(isTriviallyWeak('password1234')).toBe(true);
    expect(isTriviallyWeak('aaaaaaaaaaaa')).toBe(true);
    expect(isTriviallyWeak('jane.doe-2024', ['jane.doe@shop.com'])).toBe(true);
    expect(isTriviallyWeak('correct horse battery staple')).toBe(false);
  });

  it('verifies an argon2id digest and rejects a wrong password', async () => {
    const { hashPassword, verifyPassword } = await import('../src/auth/password.js');
    const digest = await hashPassword('a-strong-enough-password');
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(digest, 'a-strong-enough-password')).toBe(true);
    expect(await verifyPassword(digest, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
