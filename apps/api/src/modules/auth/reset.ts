import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../../db/client.js';
import { passwordResetTokens, users } from '../../db/schema/index.js';
import { generateToken, hashToken } from '../../core/crypto.js';
import { hashPassword, isTriviallyWeak } from '../../auth/password.js';
import { revokeAllUserSessions } from '../../auth/tokens.js';
import { badRequest, unauthenticated } from '../../core/errors.js';
import { writeAuditSafe } from '../../core/audit.js';
import { env } from '../../config/env.js';
import { emailConfigured, sendEmail } from '../../core/email.js';

const TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Starts a password reset.
 *
 * Always reports success, whether or not the address exists — otherwise this
 * endpoint becomes a way to enumerate which staff emails are real.
 *
 * The token only ever leaves by email. This endpoint is unauthenticated, so
 * returning the token to the caller would let anyone who knows a staff address
 * reset that account and sign in as them. Without an email transport no token is
 * issued at all, and recovery goes through an administrator instead
 * (`POST /admin/users/:id/reset-password`).
 */
export async function requestPasswordReset(request: FastifyRequest, email: string): Promise<void> {
  if (!emailConfigured()) {
    request.log.warn('password reset requested, but no email transport is configured to deliver it');
    return;
  }

  const [user] = await db
    .select({ id: users.id, isActive: users.isActive, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !user.isActive || user.deletedAt) return;

  // Rate limit per account: a flood of reset mails is its own kind of attack.
  const [recent] = await db
    .select({ count: sql<number>`COUNT(*)::int`.as('count') })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        gte(passwordResetTokens.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.count ?? 0) >= 5) return;

  // Any outstanding token is invalidated: only the newest link should work.
  await db
    .update(passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)));

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: hashToken(token),
    requestedIp: request.ip,
    expiresAt,
  });

  writeAuditSafe(request, {
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'USER',
    entityId: user.id,
  });

  // Delivery depends on an actual email transport, not on operator alerting: a
  // Slack webhook for engineers cannot deliver a reset link to a cashier.
  const link = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
  const result = await sendEmail({
    to: email,
    subject: 'Reset your POS password',
    text: [
      'A password reset was requested for your point-of-sale account.',
      '',
      `Open this link to choose a new password: ${link}`,
      '',
      'The link expires in 30 minutes and can only be used once.',
      'If you did not request this, you can ignore this message — nothing has changed.',
    ].join('\n'),
  });

  if (!result.sent) {
    // The token is not handed back as a fallback: the caller is anonymous. It
    // expires unused, and an administrator can reset the password instead.
    request.log.error({ error: result.error, provider: result.provider }, 'password reset email failed');
  }
}

/** Completes a reset. The token is consumed whether or not the password is accepted. */
export async function completePasswordReset(
  request: FastifyRequest,
  input: { token: string; newPassword: string },
): Promise<void> {
  const tokenHash = hashToken(input.token);

  const userId = await db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1)
      .for('update');

    if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
      throw unauthenticated('That reset link is no longer valid. Request a new one.');
    }

    // Consumed immediately, so a leaked link cannot be used twice even if the
    // password below is rejected.
    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(eq(passwordResetTokens.id, record.id));

    return record.userId;
  });

  const [user] = await db
    .select({ email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user && isTriviallyWeak(input.newPassword, [user.email, user.fullName])) {
    throw badRequest('Choose a less predictable password');
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(input.newPassword),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));

  // Every other session dies: if the account was compromised, this ends it.
  await revokeAllUserSessions(userId, 'PASSWORD_RESET');

  writeAuditSafe(request, {
    action: 'PASSWORD_RESET_COMPLETED',
    entityType: 'USER',
    entityId: userId,
  });
}
