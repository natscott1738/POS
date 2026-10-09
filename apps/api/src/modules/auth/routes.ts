import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  loginSchema,
  pinLoginSchema,
  changePasswordSchema,
  enrollMfaSchema,
  passwordSchema,
} from '@pos/shared';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users, stores, terminals } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { parseBody } from '../../core/validation.js';
import { badRequest, forbidden, unauthenticated } from '../../core/errors.js';
import { writeAuditSafe } from '../../core/audit.js';
import { generateToken, encryptSecret, decryptSecret, hashToken } from '../../core/crypto.js';
import { hashPassword, verifyPassword, isTriviallyWeak } from '../../auth/password.js';
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from '../../auth/totp.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserSessions,
  signAccessToken,
} from '../../auth/tokens.js';
import { requireAuth, getAuth } from '../../auth/context.js';
import {
  REFRESH_COOKIE,
  CSRF_COOKIE,
  clearAuthCookies,
  setAuthCookies,
  verifyCsrf,
} from '../../plugins/security.js';
import { login, pinLogin, loadUserForSession, sessionProfile, recentLoginActivity } from './service.js';
import { requestPasswordReset, completePasswordReset } from './reset.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Sign-in endpoints get a far tighter limit than the global one: this is the
  // single most attacked surface in the system.
  const loginLimit = {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  };

  app.post('/login', loginLimit, async (request, reply) => {
    const input = parseBody(request, loginSchema);
    const user = await login(request, input);

    const { token, expiresAt } = await issueRefreshToken(db, {
      userId: user.id,
      terminalId: input.terminalId ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });
    const csrfToken = generateToken(24);
    setAuthCookies(reply, token, csrfToken, expiresAt);

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      stores: user.storeIds,
      tv: user.tokenVersion,
      sid: hashToken(token).slice(0, 32),
      ...(input.terminalId ? { terminalId: input.terminalId } : {}),
    });

    writeAuditSafe(request, { action: 'LOGIN', entityType: 'USER', entityId: user.id });

    return reply.send({
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      csrfToken,
      user: sessionProfile(user),
    });
  });

  app.post('/pin-login', loginLimit, async (request, reply) => {
    const input = parseBody(request, pinLoginSchema);
    const user = await pinLogin(request, input);

    const { token, expiresAt } = await issueRefreshToken(db, {
      userId: user.id,
      terminalId: user.terminalId,
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });
    const csrfToken = generateToken(24);
    setAuthCookies(reply, token, csrfToken, expiresAt);

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      stores: user.storeIds,
      terminalId: user.terminalId,
      tv: user.tokenVersion,
      sid: hashToken(token).slice(0, 32),
    });

    writeAuditSafe(request, {
      action: 'PIN_LOGIN',
      entityType: 'USER',
      entityId: user.id,
      terminalId: user.terminalId,
    });

    return reply.send({
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      csrfToken,
      user: sessionProfile(user),
    });
  });

  /**
   * Exchanges the refresh cookie for a new access token. Protected by a CSRF
   * double-submit check because it authenticates from a cookie rather than a
   * bearer header.
   */
  app.post('/refresh', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (request, reply) => {
    verifyCsrf(request);

    const presented = request.cookies[REFRESH_COOKIE];
    if (!presented) throw unauthenticated('No session');

    let rotated;
    try {
      rotated = await rotateRefreshToken(presented);
    } catch (err) {
      clearAuthCookies(reply);
      throw err;
    }

    const user = await loadUserForSession(rotated.userId);
    const csrfToken = generateToken(24);
    setAuthCookies(reply, rotated.token, csrfToken, rotated.expiresAt);

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      stores: user.storeIds,
      tv: user.tokenVersion,
      sid: hashToken(rotated.token).slice(0, 32),
      ...(rotated.terminalId ? { terminalId: rotated.terminalId } : {}),
    });

    return reply.send({
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      csrfToken,
      user: sessionProfile(user),
    });
  });

  app.post('/logout', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented, 'LOGOUT');
    clearAuthCookies(reply);
    writeAuditSafe(request, { action: 'LOGOUT', entityType: 'SESSION' });
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    const user = await loadUserForSession(auth.userId);
    return {
      user: sessionProfile(user),
      ...(auth.terminalId ? { terminalId: auth.terminalId } : {}),
    };
  });

  /**
   * Everything the till needs to configure itself: the stores this user may act
   * in, and the terminals inside them. Deliberately available to any signed-in
   * user - a cashier has no `store:read`, but must still be able to pick the till
   * they are standing at - and scoped so it can only ever return their own stores.
   */
  app.get('/context', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);

    const storeRows =
      auth.role === 'ADMIN'
        ? await db.select().from(stores).where(eq(stores.isActive, true)).orderBy(stores.name)
        : auth.storeIds.length === 0
          ? []
          : await db
              .select()
              .from(stores)
              .where(and(eq(stores.isActive, true), inArray(stores.id, auth.storeIds)))
              .orderBy(stores.name);

    const storeIds = storeRows.map((s) => s.id);
    const terminalRows = storeIds.length
      ? await db
          .select({
            id: terminals.id,
            storeId: terminals.storeId,
            code: terminals.code,
            name: terminals.name,
            receiptPrefix: terminals.receiptPrefix,
            lastSeenAt: terminals.lastSeenAt,
          })
          .from(terminals)
          .where(and(eq(terminals.isActive, true), inArray(terminals.storeId, storeIds)))
          .orderBy(terminals.code)
      : [];

    return {
      stores: storeRows.map((store) => ({
        id: store.id,
        code: store.code,
        name: store.name,
        currency: store.currency,
        pricesIncludeTax: store.pricesIncludeTax,
        cashRoundingIncrement: store.cashRoundingIncrement,
        receiptHeader: store.receiptHeader,
        receiptFooter: store.receiptFooter,
      })),
      terminals: terminalRows,
    };
  });

  app.get('/me/activity', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    return { attempts: await recentLoginActivity(auth.userId) };
  });

  app.post('/change-password', { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, changePasswordSchema);

    const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    if (!user) throw unauthenticated();

    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      writeAuditSafe(request, {
        action: 'PASSWORD_CHANGE_FAILED',
        entityType: 'USER',
        entityId: auth.userId,
      });
      throw badRequest('Current password is incorrect');
    }
    if (isTriviallyWeak(input.newPassword, [user.email, user.fullName])) {
      throw badRequest('Choose a less predictable password');
    }
    if (await verifyPassword(user.passwordHash, input.newPassword)) {
      throw badRequest('The new password must be different from the current one');
    }

    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(input.newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
      })
      .where(eq(users.id, auth.userId));

    // Changing a password ends every other session; that is the point of doing it.
    await revokeAllUserSessions(auth.userId, 'PASSWORD_CHANGED');
    clearAuthCookies(reply);

    writeAuditSafe(request, { action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: auth.userId });
    return reply.send({ ok: true, message: 'Password changed. Please sign in again.' });
  });

  /* ----------------------------- Password reset ---------------------------- */

  app.post(
    '/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseBody(request, z.object({ email: z.string().trim().toLowerCase().email().max(254) }));
      const result = await requestPasswordReset(request, input.email);
      // Identical response either way, so this cannot be used to discover which
      // email addresses belong to real staff.
      return reply.send({
        ok: true,
        message: 'If that address belongs to an active account, a reset has been issued.',
        ...(result.token ? { token: result.token, expiresAt: result.expiresAt } : {}),
      });
    },
  );

  app.post(
    '/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = parseBody(
        request,
        z.object({ token: z.string().min(16).max(512), newPassword: passwordSchema }),
      );
      await completePasswordReset(request, input);
      return reply.send({ ok: true, message: 'Password updated. Please sign in.' });
    },
  );

  /* ---------------------------------- MFA ---------------------------------- */

  app.post('/mfa/setup', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    if (!user) throw unauthenticated();
    if (user.mfaEnabled) throw badRequest('Multi-factor authentication is already enabled');

    const secret = generateTotpSecret();
    // Stored encrypted but not yet enabled: enrolment only completes once the
    // user proves they can generate a valid code.
    await db
      .update(users)
      .set({ mfaSecretEncrypted: encryptSecret(secret, user.id) })
      .where(eq(users.id, user.id));

    return {
      secret,
      otpauthUrl: totpUri(secret, user.email, env.JWT_ISSUER),
    };
  });

  app.post('/mfa/enable', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, enrollMfaSchema);

    const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    if (!user?.mfaSecretEncrypted) throw badRequest('Start MFA setup first');

    const secret = decryptSecret(user.mfaSecretEncrypted, user.id);
    if (!verifyTotp(secret, input.totp).valid) throw badRequest('That code is not valid');

    const recoveryCodes = generateRecoveryCodes();
    await db
      .update(users)
      .set({
        mfaEnabled: true,
        // Recovery codes are stored hashed: they are password-equivalent.
        mfaRecoveryCodes: recoveryCodes.map((c) => hashToken(c)),
      })
      .where(eq(users.id, user.id));

    writeAuditSafe(request, { action: 'MFA_ENABLED', entityType: 'USER', entityId: user.id });
    return { ok: true, recoveryCodes };
  });

  app.post('/mfa/disable', { preHandler: requireAuth }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, z.object({ password: passwordSchema, totp: z.string().regex(/^\d{6}$/) }));

    const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
    if (!user?.mfaSecretEncrypted) throw badRequest('MFA is not enabled');
    if (!(await verifyPassword(user.passwordHash, input.password))) throw forbidden('Password is incorrect');

    const secret = decryptSecret(user.mfaSecretEncrypted, user.id);
    if (!verifyTotp(secret, input.totp).valid) throw badRequest('That code is not valid');

    await db
      .update(users)
      .set({ mfaEnabled: false, mfaSecretEncrypted: null, mfaRecoveryCodes: null })
      .where(eq(users.id, user.id));

    writeAuditSafe(request, { action: 'MFA_DISABLED', entityType: 'USER', entityId: user.id });
    return { ok: true };
  });
}
