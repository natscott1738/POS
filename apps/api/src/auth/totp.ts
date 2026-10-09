import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, implemented directly rather than pulled in as a dependency:
 * it is ~50 lines of well-specified HMAC and keeps the supply chain smaller for
 * a component that guards administrative access.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function totpUri(secret: string, account: string, issuer: string): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}

export function generateTotp(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secret), counter);
}

/**
 * Verifies with a +/- 1 step window to tolerate clock drift on cheap till hardware.
 * Returns the matched step so the caller can reject a replay of the same code.
 */
export function verifyTotp(
  secret: string,
  token: string,
  at: number = Date.now(),
  window = 1,
): { valid: boolean; step?: number } {
  if (!/^\d{6}$/.test(token)) return { valid: false };
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset++) {
    const step = counter + offset;
    const candidate = hotp(key, step);
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) return { valid: true, step };
  }
  return { valid: false };
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Single-use recovery codes for when the authenticator device is lost. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
