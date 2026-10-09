import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { permissionsForRole, type Role } from '@pos/shared';
import { db } from '../../db/client.js';
import { users, userStores, loginAttempts, terminals } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { forbidden, mfaRequired, unauthenticated } from '../../core/errors.js';
import { burnPasswordCycle, verifyPassword, verifyPin } from '../../auth/password.js';
import { decryptSecret } from '../../core/crypto.js';
import { verifyTotp } from '../../auth/totp.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  storeIds: string[];
  tokenVersion: number;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

async function recordAttempt(
  request: FastifyRequest,
  identifier: string,
  succeeded: boolean,
  failureReason?: string,
): Promise<void> {
  await db.insert(loginAttempts).values({
    identifier: identifier.slice(0, 254),
    ipAddress: request.ip,
    succeeded,
    failureReason: failureReason ?? null,
    userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
  });
}

/**
 * Per-identifier throttle layered on top of the global per-IP rate limit. It
 * blunts credential stuffing spread across many source addresses, which the IP
 * limiter alone would not catch.
 */
async function tooManyRecentFailures(identifier: string): Promise<boolean> {
  const window = new Date(Date.now() - env.AUTH_LOCKOUT_MINUTES * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.succeeded, false),
        gte(loginAttempts.createdAt, window),
      ),
    );
  return (row?.count ?? 0) >= env.AUTH_MAX_FAILED_ATTEMPTS * 3;
}

async function loadStoreIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ storeId: userStores.storeId })
    .from(userStores)
    .where(eq(userStores.userId, userId));
  return rows.map((r) => r.storeId);
}

/**
 * Email + password sign-in. Every failure path returns the same message and does
 * comparable work, so an attacker learns nothing about which accounts exist.
 */
export async function login(
  request: FastifyRequest,
  input: { email: string; password: string; totp?: string },
): Promise<AuthenticatedUser> {
  const generic = unauthenticated('Invalid email or password');

  if (await tooManyRecentFailures(input.email)) {
    await recordAttempt(request, input.email, false, 'THROTTLED');
    throw unauthenticated('Too many failed attempts. Try again shortly.');
  }

  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (!user) {
    await burnPasswordCycle(input.password);
    await recordAttempt(request, input.email, false, 'NO_SUCH_USER');
    throw generic;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await recordAttempt(request, input.email, false, 'LOCKED');
    throw unauthenticated('This account is temporarily locked. Try again later.');
  }

  if (!user.isActive || user.deletedAt) {
    await burnPasswordCycle(input.password);
    await recordAttempt(request, input.email, false, 'INACTIVE');
    throw generic;
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) {
    const failures = user.failedLoginCount + 1;
    const shouldLock = failures >= env.AUTH_MAX_FAILED_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        lockedUntil: shouldLock ? new Date(Date.now() + env.AUTH_LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await recordAttempt(request, input.email, false, 'BAD_PASSWORD');
    throw generic;
  }

  if (user.mfaEnabled) {
    if (!input.totp) {
      await recordAttempt(request, input.email, false, 'MFA_REQUIRED');
      throw mfaRequired();
    }
    if (!user.mfaSecretEncrypted) throw unauthenticated('MFA is misconfigured for this account');
    const secret = decryptSecret(user.mfaSecretEncrypted, user.id);
    if (!verifyTotp(secret, input.totp).valid) {
      await recordAttempt(request, input.email, false, 'BAD_TOTP');
      throw unauthenticated('Invalid authentication code');
    }
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await recordAttempt(request, input.email, true);

  return {
    id: user.id,
    email: user.email,
    role: user.role as Role,
    storeIds: await loadStoreIds(user.id),
    tokenVersion: user.tokenVersion,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };
}

/**
 * Till sign-in: staff code + PIN, but only from a terminal that has already been
 * registered and is still active. A PIN on its own is not a credential -- it is
 * only meaningful in combination with physical access to a known till.
 */
export async function pinLogin(
  request: FastifyRequest,
  input: { terminalId: string; staffCode: string; pin: string },
): Promise<AuthenticatedUser & { terminalId: string }> {
  const generic = unauthenticated('Invalid staff code or PIN');
  const identifier = `pin:${input.terminalId}:${input.staffCode}`;

  if (await tooManyRecentFailures(identifier)) {
    await recordAttempt(request, identifier, false, 'THROTTLED');
    throw unauthenticated('Too many failed attempts. Ask a manager to unlock this till.');
  }

  const [terminal] = await db.select().from(terminals).where(eq(terminals.id, input.terminalId)).limit(1);
  if (!terminal || !terminal.isActive) {
    await burnPasswordCycle(input.pin);
    await recordAttempt(request, identifier, false, 'UNKNOWN_TERMINAL');
    throw generic;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.staffCode, input.staffCode.toUpperCase()))
    .limit(1);

  if (!user?.pinHash || !user.isActive || user.deletedAt) {
    await burnPasswordCycle(input.pin);
    await recordAttempt(request, identifier, false, 'NO_SUCH_STAFF');
    throw generic;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await recordAttempt(request, identifier, false, 'LOCKED');
    throw unauthenticated('This account is temporarily locked.');
  }

  if (!(await verifyPin(user.pinHash, input.pin))) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        lockedUntil:
          failures >= env.AUTH_MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + env.AUTH_LOCKOUT_MINUTES * 60_000)
            : null,
      })
      .where(eq(users.id, user.id));
    await recordAttempt(request, identifier, false, 'BAD_PIN');
    throw generic;
  }

  const storeIds = await loadStoreIds(user.id);
  // The till belongs to a store this person is not assigned to.
  if (user.role !== 'ADMIN' && !storeIds.includes(terminal.storeId)) {
    await recordAttempt(request, identifier, false, 'WRONG_STORE');
    throw forbidden('You are not assigned to this store');
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await db.update(terminals).set({ lastSeenAt: new Date() }).where(eq(terminals.id, terminal.id));
  await recordAttempt(request, identifier, true);

  return {
    id: user.id,
    email: user.email,
    role: user.role as Role,
    storeIds,
    tokenVersion: user.tokenVersion,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    terminalId: terminal.id,
  };
}

export async function loadUserForSession(userId: string): Promise<AuthenticatedUser> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.isActive || user.deletedAt) throw unauthenticated('Account is not active');
  return {
    id: user.id,
    email: user.email,
    role: user.role as Role,
    storeIds: await loadStoreIds(user.id),
    tokenVersion: user.tokenVersion,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };
}

export function sessionProfile(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    storeIds: user.storeIds,
    permissions: permissionsForRole(user.role),
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };
}

export async function recentLoginActivity(userId: string, limit = 20) {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return [];
  return db
    .select({
      succeeded: loginAttempts.succeeded,
      failureReason: loginAttempts.failureReason,
      ipAddress: loginAttempts.ipAddress,
      createdAt: loginAttempts.createdAt,
    })
    .from(loginAttempts)
    .where(eq(loginAttempts.identifier, user.email))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(limit);
}
