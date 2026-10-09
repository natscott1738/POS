import { hash, verify } from '@node-rs/argon2';
import { createHash } from 'node:crypto';

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 * Cost lives inside the encoded hash, so raising these later re-hashes users on
 * their next successful sign-in rather than locking anyone out.
 */
// `Algorithm` from @node-rs/argon2 is an ambient const enum, which isolatedModules
// cannot read at runtime; 2 is its Argon2id member.
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed digest must read as "wrong password", never as a server error.
    return false;
  }
}

/**
 * Constant-ish work for accounts that do not exist, so response timing does not
 * reveal which email addresses are registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Yk9pqPFvNcnBqhWY1kEdeVYQPYW1aZOCxKfSN7Bx6Xk';

export async function burnPasswordCycle(plain: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plain);
}

/** PINs are low-entropy, so they get the same Argon2 treatment as passwords. */
export const hashPin = hashPassword;
export const verifyPin = verifyPassword;

/**
 * Screens a password against the local breach corpus using a k-anonymity prefix,
 * the same scheme as Have I Been Pwned, so no full hash ever leaves the process.
 */
export function passwordPrefixHash(plain: string): { prefix: string; suffix: string } {
  const digest = createHash('sha1').update(plain).digest('hex').toUpperCase();
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

/**
 * Cheap structural screen applied before the expensive hash. An exact-match
 * blocklist is useless in practice ("password1234" would pass one), so this
 * looks for weak *shapes*: a common base word, a keyboard or digit run, or the
 * user's own identifiers.
 */
const WEAK_BASES = [
  'password', 'passw0rd', 'qwerty', 'asdfgh', 'zxcvbn', 'letmein', 'welcome',
  'monkey', 'dragon', 'admin', 'administrator', 'changeme', 'default',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'trustno1', 'starwars', 'whatever', 'freedom', 'shadow', 'master',
  'pos', 'till', 'cashier', 'manager', 'kenya', 'nairobi', 'safaricom', 'mpesa',
];

const DIGIT_RUNS = ['0123456789', '9876543210'];
const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx'];

export function isTriviallyWeak(plain: string, context: string[] = []): boolean {
  const lowered = plain.toLowerCase();

  // A common base word with digits or punctuation bolted on is still that word.
  const stripped = lowered.replace(/[^a-z]/g, '');
  for (const base of WEAK_BASES) {
    if (stripped === base) return true;
    // "password1234" / "admin!!!" -> the alphabetic core is the whole password.
    if (stripped.length > 0 && base.includes(stripped) && stripped.length >= 4) return true;
    if (lowered.startsWith(base) && lowered.length - base.length <= 4) return true;
  }

  // Passwords built from the user's own identifiers are guessable by anyone who
  // knows them, which for a staff till is everyone in the shop.
  for (const item of context) {
    const token = item.toLowerCase().split('@')[0];
    if (!token) continue;
    for (const part of token.split(/[^a-z0-9]+/)) {
      if (part.length >= 4 && lowered.includes(part)) return true;
    }
  }

  // A single repeated character, or a straight run off the keyboard or number row.
  if (/^(.)\1+$/.test(plain)) return true;
  for (const run of [...DIGIT_RUNS, ...KEYBOARD_RUNS]) {
    for (let i = 0; i + 6 <= run.length; i++) {
      if (lowered.includes(run.slice(i, i + 6))) return true;
    }
  }

  // Too few distinct characters to be worth the length it claims.
  if (new Set(lowered).size <= 3) return true;

  return false;
}
