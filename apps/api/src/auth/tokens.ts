import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db, type Executor } from '../db/client.js';
import { refreshTokens, users } from '../db/schema/index.js';
import { generateToken, hashToken, randomUUID } from '../core/crypto.js';
import { unauthenticated } from '../core/errors.js';
import type { Role } from '@pos/shared';

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email: string;
  role: Role;
  /** Stores the session may act in; checked on every store-scoped request. */
  stores: string[];
  terminalId?: string;
  /** Must match users.tokenVersion, so a forced logout is immediate. */
  tv: number;
  /** Session family, used to tie an access token to its refresh chain. */
  sid: string;
}

export async function signAccessToken(claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(secretKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    return payload as AccessTokenClaims;
  } catch {
    throw unauthenticated('Session expired or invalid');
  }
}

export interface IssuedRefresh {
  token: string;
  familyId: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  exec: Executor,
  input: {
    userId: string;
    familyId?: string;
    terminalId?: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<IssuedRefresh> {
  const token = generateToken(48);
  const familyId = input.familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  await exec.insert(refreshTokens).values({
    userId: input.userId,
    tokenHash: hashToken(token),
    familyId,
    terminalId: input.terminalId ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    ipAddress: input.ipAddress ?? null,
    expiresAt,
  });

  return { token, familyId, expiresAt };
}

export interface RotationResult {
  userId: string;
  familyId: string;
  terminalId: string | null;
  token: string;
  expiresAt: Date;
}

/**
 * Rotates a refresh token. If the presented token was already rotated, the cookie
 * has been replayed - almost certainly stolen - so the entire family is revoked
 * and the user must sign in again. This is the standard OAuth 2.1 reuse-detection
 * pattern and it is the main defence for long-lived till sessions.
 */
/**
 * Rotates a refresh token. If the presented token was already rotated, the cookie
 * has been replayed - almost certainly stolen - so the entire family is revoked
 * and the user must sign in again. This is the standard OAuth 2.1 reuse-detection
 * pattern and it is the main defence for long-lived till sessions.
 */
type RotationOutcome =
  | { kind: 'OK'; result: RotationResult }
  | { kind: 'UNKNOWN' }
  | { kind: 'EXPIRED' }
  | { kind: 'INACTIVE' }
  | { kind: 'REUSE'; familyId: string };

export async function rotateRefreshToken(rawToken: string): Promise<RotationResult> {
  const presentedHash = hashToken(rawToken);

  const outcome: RotationOutcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, presentedHash))
      .limit(1)
      .for('update');

    if (!existing) return { kind: 'UNKNOWN' };

    // Reuse is reported, not handled, here: revoking inside this transaction and
    // then throwing would roll the revocation straight back, leaving the stolen
    // family alive. The caller commits the revocation separately.
    if (existing.replacedByHash !== null || existing.revokedAt !== null) {
      return { kind: 'REUSE', familyId: existing.familyId };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: 'EXPIRED' })
        .where(eq(refreshTokens.id, existing.id));
      return { kind: 'EXPIRED' };
    }

    const [user] = await tx.select().from(users).where(eq(users.id, existing.userId)).limit(1);
    if (!user || !user.isActive || user.deletedAt) return { kind: 'INACTIVE' };

    const next = await issueRefreshToken(tx, {
      userId: existing.userId,
      familyId: existing.familyId,
      terminalId: existing.terminalId,
      userAgent: existing.userAgent,
      ipAddress: existing.ipAddress,
    });

    await tx
      .update(refreshTokens)
      .set({ replacedByHash: hashToken(next.token), revokedAt: new Date(), revokedReason: 'ROTATED' })
      .where(eq(refreshTokens.id, existing.id));

    return {
      kind: 'OK',
      result: {
        userId: existing.userId,
        familyId: existing.familyId,
        terminalId: existing.terminalId,
        token: next.token,
        expiresAt: next.expiresAt,
      },
    };
  });

  switch (outcome.kind) {
    case 'OK':
      return outcome.result;
    case 'REUSE':
      await revokeFamily(outcome.familyId, 'REUSE_DETECTED');
      throw unauthenticated('Session was revoked for security reasons. Please sign in again.');
    case 'EXPIRED':
      throw unauthenticated('Session expired');
    case 'INACTIVE':
      throw unauthenticated('Account is not active');
    default:
      throw unauthenticated('Session expired or invalid');
  }
}

/** Kills every live token descended from one sign-in. Commits on its own. */
export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

export async function revokeRefreshToken(rawToken: string, reason = 'LOGOUT'): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.tokenHash, hashToken(rawToken)), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllUserSessions(userId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    // Bumping tokenVersion kills outstanding access tokens too, not just refreshes.
    await tx
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));
  });
}


/** Housekeeping: drop refresh rows that are long past use. */
export async function purgeExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, cutoff));
  return (result as unknown as { count?: number }).count ?? 0;
}
