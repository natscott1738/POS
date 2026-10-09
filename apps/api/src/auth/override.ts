import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { permissionsForRole, type Permission, type Role } from '@pos/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { forbidden } from '../core/errors.js';
import { verifyPin, burnPasswordCycle } from './password.js';
import { writeAuditSafe } from '../core/audit.js';

/**
 * Manager override at the till: a cashier initiates a void, refund or price change
 * and a supervisor authorises it in person with their staff code and PIN. The
 * supervisor is never signed in - their identity is recorded on the record and in
 * the audit trail, which is what makes the control meaningful after the fact.
 */
export async function resolveOverride(
  request: FastifyRequest,
  credentials: { staffCode: string; pin: string; reason: string },
  needed: Permission,
): Promise<{ userId: string; email: string; role: Role }> {
  const [approver] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      pinHash: users.pinHash,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.staffCode, credentials.staffCode.toUpperCase()))
    .limit(1);

  if (!approver?.pinHash) {
    // Equalise timing so a wrong staff code is indistinguishable from a wrong PIN.
    await burnPasswordCycle(credentials.pin);
    throw forbidden('Override was not authorised');
  }

  const locked = approver.lockedUntil && approver.lockedUntil.getTime() > Date.now();
  if (!approver.isActive || approver.deletedAt || locked) {
    await burnPasswordCycle(credentials.pin);
    throw forbidden('Override was not authorised');
  }

  const ok = await verifyPin(approver.pinHash, credentials.pin);
  if (!ok) {
    writeAuditSafe(request, {
      action: 'OVERRIDE_FAILED',
      entityType: 'USER',
      entityId: approver.id,
      reason: credentials.reason,
    });
    throw forbidden('Override was not authorised');
  }

  const approverPermissions = permissionsForRole(approver.role as Role);
  if (!approverPermissions.includes(needed)) {
    throw forbidden('That user cannot authorise this action');
  }

  // Self-approval defeats the purpose of a two-person control.
  if (request.auth && approver.id === request.auth.userId) {
    throw forbidden('You cannot authorise your own override');
  }

  writeAuditSafe(request, {
    action: 'OVERRIDE_GRANTED',
    entityType: 'USER',
    entityId: approver.id,
    reason: credentials.reason,
    changes: { permission: needed },
  });

  return { userId: approver.id, email: approver.email, role: approver.role as Role };
}

/**
 * Returns the approver id when the caller needed an override, or null when they
 * already hold the permission themselves.
 */
export async function requirePermissionOrOverride(
  request: FastifyRequest,
  needed: Permission,
  override: { staffCode: string; pin: string; reason: string } | undefined,
): Promise<string | null> {
  const auth = request.auth;
  if (auth?.permissions.has(needed)) return null;
  if (!override) throw forbidden(`This action needs a manager override (${needed})`);
  const approver = await resolveOverride(request, override, needed);
  if (request.auth) request.auth.overrideByUserId = approver.userId;
  return approver.userId;
}
