import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { permissionsForRole, type Permission, type Role } from '@pos/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { forbidden, unauthenticated } from '../core/errors.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  storeIds: string[];
  terminalId?: string;
  sessionId: string;
  permissions: Set<Permission>;
  /** Set when a manager has authorised the current privileged action. */
  overrideByUserId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const BEARER = /^Bearer (.+)$/i;

/**
 * Resolves the caller from the Authorization header. Access tokens are short-lived
 * and self-contained, but `tokenVersion` is re-checked against the database so a
 * disabled account or forced logout takes effect immediately rather than after
 * the token expires.
 */
export async function authenticate(request: FastifyRequest): Promise<AuthContext> {
  const header = request.headers.authorization;
  const match = header ? BEARER.exec(header) : null;
  if (!match?.[1]) throw unauthenticated();

  const claims = await verifyAccessToken(match[1]);

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!user || !user.isActive || user.deletedAt) throw unauthenticated('Account is not active');
  if (user.tokenVersion !== claims.tv) throw unauthenticated('Session is no longer valid');

  const context: AuthContext = {
    userId: user.id,
    email: user.email,
    role: user.role as Role,
    storeIds: claims.stores ?? [],
    sessionId: claims.sid,
    permissions: new Set(permissionsForRole(user.role as Role)),
  };
  if (claims.terminalId) context.terminalId = claims.terminalId;

  request.auth = context;
  return context;
}

/** Route guard: authenticate, then require every listed permission. */
export function requirePermissions(...required: Permission[]) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const auth = request.auth ?? (await authenticate(request));
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (missing.length > 0) {
      request.log.warn(
        { userId: auth.userId, role: auth.role, missing },
        'permission denied',
      );
      throw forbidden(`Missing permission: ${missing.join(', ')}`);
    }
  };
}

/** Authentication with no specific permission requirement. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.auth) await authenticate(request);
}

export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Multi-store safety: a manager at Store A must not read or write Store B, even
 * though the role grants the permission. Admins are exempt because they administer
 * the whole tenant.
 */
export function assertStoreAccess(request: FastifyRequest, storeId: string): void {
  const auth = getAuth(request);
  if (auth.role === 'ADMIN') return;
  if (!auth.storeIds.includes(storeId)) {
    request.log.warn({ userId: auth.userId, storeId }, 'cross-store access denied');
    throw forbidden('You do not have access to that store');
  }
}

/** Narrows a query to the stores the caller may see; admins get everything. */
export function visibleStoreIds(request: FastifyRequest): string[] | null {
  const auth = getAuth(request);
  return auth.role === 'ADMIN' ? null : auth.storeIds;
}
