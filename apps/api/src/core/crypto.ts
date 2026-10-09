import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Authenticated column encryption for secrets at rest: QuickBooks OAuth tokens,
 * TOTP seeds and PDQ bridge credentials. AES-256-GCM so tampering is detected,
 * not just hidden.
 *
 * Format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 * The version prefix is what makes key rotation possible without a flag day.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

const primaryKey = keyFrom(env.ENCRYPTION_KEY);
const previousKey = env.ENCRYPTION_KEY_PREVIOUS ? keyFrom(env.ENCRYPTION_KEY_PREVIOUS) : null;

export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', primaryKey, iv, { authTagLength: TAG_BYTES });
  // Binding the ciphertext to context (e.g. the store id) stops a valid blob from
  // being moved to another row and still decrypting.
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(payload: string, aad?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('malformed ciphertext');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  for (const key of [primaryKey, previousKey]) {
    if (!key) continue;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      // Fall through to the previous key; a genuine failure throws below.
    }
  }
  throw new Error('unable to decrypt: wrong key or tampered ciphertext');
}

/** True when a value was encrypted with the retired key and should be re-wrapped. */
export function needsRewrap(payload: string): boolean {
  if (!previousKey) return false;
  try {
    decryptSecretWithKey(payload, primaryKey);
    return false;
  } catch {
    return true;
  }
}

function decryptSecretWithKey(payload: string, key: Buffer): string {
  const [, ivB64, tagB64, dataB64] = payload.split('.') as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/* ------------------------------- Token helpers ------------------------------ */

/** Cryptographically random, URL-safe opaque token (refresh tokens, CSRF, state). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Refresh tokens are stored hashed so a database leak alone cannot mint sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** Constant-time comparison for secrets; plain === leaks length and content by timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path takes similar time.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export { randomUUID };
