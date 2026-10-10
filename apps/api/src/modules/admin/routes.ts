import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createUserSchema, updateUserSchema, uuid, safeText, ROLES, permissionsForRole } from '@pos/shared';
import { db } from '../../db/client.js';
import { users, userStores, stores, terminals, pdqTerminals, settings } from '../../db/schema/index.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess } from '../../auth/context.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { writeAudit, queryAuditLogs } from '../../core/audit.js';
import { hashPassword, hashPin, isTriviallyWeak } from '../../auth/password.js';
import { revokeAllUserSessions } from '../../auth/tokens.js';
import { encryptSecret, generateToken } from '../../core/crypto.js';
import { isUniqueViolation } from '../../core/idempotency.js';
import { runBackup, listBackups, verifyBackup, backupHealth } from '../../jobs/backup.js';

const idParam = z.object({ id: uuid });

/**
 * Loads a user that an administrator is about to change. The owner's account is
 * refused to everyone but the owner: any administrator could otherwise reset the
 * owner's password, read the temporary one, and take over the system.
 */
async function loadManagedUser(request: FastifyRequest, id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) throw notFound('User');
  if (user.isOwner && user.id !== getAuth(request).userId) {
    throw forbidden('Only the account owner can change this account');
  }
  return user;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------------- Users --------------------------------- */

  app.get('/users', { preHandler: requirePermissions('user:read') }, async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: users.role,
        staffCode: users.staffCode,
        isActive: users.isActive,
        isOwner: users.isOwner,
        mfaEnabled: users.mfaEnabled,
        lockedUntil: users.lockedUntil,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(users.fullName);

    const assignments = await db.select().from(userStores);
    return {
      users: rows.map((u) => ({
        ...u,
        storeIds: assignments.filter((a) => a.userId === u.id).map((a) => a.storeId),
        permissions: permissionsForRole(u.role),
      })),
    };
  });

  app.post('/users', { preHandler: requirePermissions('user:write') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(request, createUserSchema);

    // Only an admin may mint another admin; otherwise a manager could escalate.
    if (input.role === 'ADMIN' && auth.role !== 'ADMIN') {
      throw forbidden('Only an administrator can create administrator accounts');
    }
    if (isTriviallyWeak(input.password, [input.email, input.fullName])) {
      throw badRequest('Choose a less predictable password');
    }
    if (input.staffCode && !input.pin) throw badRequest('A staff code needs a PIN');

    for (const storeId of input.storeIds) assertStoreAccess(request, storeId);

    try {
      const created = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email: input.email,
            fullName: input.fullName,
            role: input.role,
            passwordHash: await hashPassword(input.password),
            staffCode: input.staffCode?.toUpperCase() ?? null,
            pinHash: input.pin ? await hashPin(input.pin) : null,
            // Force a change so the creating admin's chosen password is temporary.
            mustChangePassword: true,
          })
          .returning({ id: users.id, email: users.email, role: users.role });

        if (!user) throw conflict('Could not create user');

        for (const storeId of input.storeIds) {
          await tx.insert(userStores).values({ userId: user.id, storeId }).onConflictDoNothing();
        }

        await writeAudit(tx, request, {
          action: 'USER_CREATED',
          entityType: 'USER',
          entityId: user.id,
          changes: { email: input.email, role: input.role, storeIds: input.storeIds },
        });

        return user;
      });

      return reply.status(201).send({ user: created });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That email address or staff code is already in use');
      throw err;
    }
  });

  app.patch('/users/:id', { preHandler: requirePermissions('user:write') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    const input = parseBody(request, updateUserSchema);
    const existing = await loadManagedUser(request, id);

    if (input.role && input.role !== existing.role && auth.role !== 'ADMIN') {
      throw forbidden('Only an administrator can change roles');
    }
    // Guard against an admin disabling or demoting themselves out of access.
    if (id === auth.userId && (input.isActive === false || (input.role && input.role !== existing.role))) {
      throw badRequest('You cannot change your own role or disable your own account');
    }

    const updated = await db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.staffCode !== undefined ? { staffCode: input.staffCode?.toUpperCase() ?? null } : {}),
          ...(input.pin !== undefined && input.pin ? { pinHash: await hashPin(input.pin) } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning({ id: users.id, email: users.email, role: users.role, isActive: users.isActive });

      if (input.storeIds) {
        await tx.delete(userStores).where(eq(userStores.userId, id));
        for (const storeId of input.storeIds) {
          await tx.insert(userStores).values({ userId: id, storeId }).onConflictDoNothing();
        }
      }

      await writeAudit(tx, request, {
        action: 'USER_UPDATED',
        entityType: 'USER',
        entityId: id,
        changes: { before: { role: existing.role, isActive: existing.isActive }, after: input },
      });

      return user;
    });

    // Any privilege change must invalidate sessions immediately, not on expiry.
    if (input.role !== undefined || input.isActive === false || input.storeIds) {
      await revokeAllUserSessions(id, 'PRIVILEGES_CHANGED');
    }

    return { user: updated };
  });

  app.post('/users/:id/reset-password', { preHandler: requirePermissions('user:write') }, async (request) => {
    const { id } = parseParams(request, idParam);
    await loadManagedUser(request, id);

    // A random temporary password, shown once and never stored in the clear.
    const temporary = generateToken(12);
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(temporary),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      })
      .where(eq(users.id, id));

    await revokeAllUserSessions(id, 'PASSWORD_RESET');
    await writeAudit(db, request, { action: 'PASSWORD_RESET', entityType: 'USER', entityId: id });

    return { temporaryPassword: temporary };
  });

  app.post('/users/:id/unlock', { preHandler: requirePermissions('user:write') }, async (request) => {
    const { id } = parseParams(request, idParam);
    await loadManagedUser(request, id);
    await db.update(users).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(users.id, id));
    await writeAudit(db, request, { action: 'USER_UNLOCKED', entityType: 'USER', entityId: id });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: requirePermissions('user:delete') }, async (request) => {
    const auth = getAuth(request);
    const { id } = parseParams(request, idParam);
    if (id === auth.userId) throw badRequest('You cannot delete your own account');
    await loadManagedUser(request, id);

    // Soft delete: sales reference the cashier and that link must survive.
    await db
      .update(users)
      .set({ deletedAt: new Date(), isActive: false, staffCode: null, pinHash: null })
      .where(eq(users.id, id));
    await revokeAllUserSessions(id, 'USER_DELETED');
    await writeAudit(db, request, { action: 'USER_DELETED', entityType: 'USER', entityId: id });

    return { ok: true };
  });

  /* --------------------------------- Stores --------------------------------- */

  app.get('/stores', { preHandler: requirePermissions('store:read') }, async (request) => {
    const auth = getAuth(request);
    const rows =
      auth.role === 'ADMIN'
        ? await db.select().from(stores).orderBy(stores.name)
        : await db
            .select()
            .from(stores)
            .where(sql`${stores.id} IN ${auth.storeIds.length ? auth.storeIds : ['00000000-0000-0000-0000-000000000000']}`)
            .orderBy(stores.name);
    return { stores: rows };
  });

  app.post('/stores', { preHandler: requirePermissions('store:write') }, async (request, reply) => {
    const input = parseBody(
      request,
      z.object({
        code: z.string().trim().regex(/^[A-Z0-9-]{2,12}$/),
        name: safeText(120),
        address: safeText(300).optional(),
        phone: safeText(20).optional(),
        taxPin: z.string().trim().regex(/^[A-Z]\d{9}[A-Z]$/i).optional(),
        currency: z.string().length(3).default('KES'),
        pricesIncludeTax: z.boolean().default(true),
        cashRoundingIncrement: z.number().int().min(0).max(500).default(0),
        receiptHeader: safeText(300).optional(),
        receiptFooter: safeText(300).optional(),
      }),
    );

    const [store] = await db
      .insert(stores)
      .values({
        code: input.code,
        name: input.name,
        address: input.address ?? null,
        phone: input.phone ?? null,
        taxPin: input.taxPin?.toUpperCase() ?? null,
        currency: input.currency,
        pricesIncludeTax: input.pricesIncludeTax,
        cashRoundingIncrement: input.cashRoundingIncrement,
        receiptHeader: input.receiptHeader ?? null,
        receiptFooter: input.receiptFooter ?? null,
      })
      .returning();

    await writeAudit(db, request, {
      action: 'STORE_CREATED',
      entityType: 'STORE',
      entityId: store?.id ?? null,
      changes: { code: input.code, name: input.name },
    });

    return reply.status(201).send({ store });
  });

  /* -------------------------------- Terminals ------------------------------- */

  app.get('/terminals', { preHandler: requirePermissions('store:read') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid.optional() }));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    const rows = query.storeId
      ? await db.select().from(terminals).where(eq(terminals.storeId, query.storeId))
      : await db.select().from(terminals);
    return { terminals: rows };
  });

  app.post('/terminals', { preHandler: requirePermissions('store:write') }, async (request, reply) => {
    const input = parseBody(
      request,
      z.object({
        storeId: uuid,
        code: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/),
        name: safeText(60),
        receiptPrefix: z.string().trim().regex(/^[A-Z0-9]{2,8}$/),
      }),
    );
    assertStoreAccess(request, input.storeId);

    try {
      const [terminal] = await db.insert(terminals).values(input).returning();
      await writeAudit(db, request, {
        action: 'TERMINAL_CREATED',
        entityType: 'TERMINAL',
        entityId: terminal?.id ?? null,
        storeId: input.storeId,
        changes: input,
      });
      return reply.status(201).send({ terminal });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That terminal code or receipt prefix is already in use');
      throw err;
    }
  });

  /** Registers a card terminal. The bridge secret is encrypted before it is stored. */
  app.post('/pdq-terminals', { preHandler: requirePermissions('store:write') }, async (request, reply) => {
    const input = parseBody(
      request,
      z.object({
        storeId: uuid,
        terminalId: uuid.optional(),
        label: safeText(60),
        provider: z.enum(['SIMULATOR', 'ECR_HTTP']).default('SIMULATOR'),
        acquirer: safeText(60).optional(),
        merchantId: safeText(40).optional(),
        deviceSerial: safeText(60).optional(),
        endpointUrl: z.string().url().optional(),
        secret: z.string().min(8).max(200).optional(),
      }),
    );
    assertStoreAccess(request, input.storeId);

    const [created] = await db
      .insert(pdqTerminals)
      .values({
        storeId: input.storeId,
        terminalId: input.terminalId ?? null,
        label: input.label,
        provider: input.provider,
        acquirer: input.acquirer ?? null,
        merchantId: input.merchantId ?? null,
        deviceSerial: input.deviceSerial ?? null,
        endpointUrl: input.endpointUrl ?? null,
        encryptedSecret: null,
      })
      .returning({ id: pdqTerminals.id });

    if (created && input.secret) {
      // The row id is the AAD, so a stolen blob cannot be moved to another terminal.
      await db
        .update(pdqTerminals)
        .set({ encryptedSecret: encryptSecret(input.secret, created.id) })
        .where(eq(pdqTerminals.id, created.id));
    }

    await writeAudit(db, request, {
      action: 'PDQ_TERMINAL_CREATED',
      entityType: 'PDQ_TERMINAL',
      entityId: created?.id ?? null,
      storeId: input.storeId,
      changes: { label: input.label, provider: input.provider },
    });

    return reply.status(201).send({ id: created?.id });
  });

  app.get('/pdq-terminals', { preHandler: requirePermissions('store:read') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);
    const rows = await db
      .select({
        id: pdqTerminals.id,
        label: pdqTerminals.label,
        provider: pdqTerminals.provider,
        acquirer: pdqTerminals.acquirer,
        merchantId: pdqTerminals.merchantId,
        deviceSerial: pdqTerminals.deviceSerial,
        endpointUrl: pdqTerminals.endpointUrl,
        isActive: pdqTerminals.isActive,
        // The encrypted secret is deliberately never selected.
        hasSecret: sql<boolean>`${pdqTerminals.encryptedSecret} IS NOT NULL`.as('hasSecret'),
      })
      .from(pdqTerminals)
      .where(eq(pdqTerminals.storeId, query.storeId));
    return { terminals: rows };
  });

  /* ---------------------------------- Audit --------------------------------- */

  app.get('/audit', { preHandler: requirePermissions('audit:read') }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        entityType: z.string().max(40).optional(),
        entityId: z.string().max(64).optional(),
        actorId: uuid.optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    );

    return {
      logs: await queryAuditLogs({
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        limit: query.limit,
      }),
    };
  });

  /* --------------------------------- Backups -------------------------------- */

  app.get('/backups', { preHandler: requirePermissions('backup:read') }, async () => {
    return { backups: await listBackups(), health: await backupHealth() };
  });

  app.post('/backups/run', { preHandler: requirePermissions('backup:run') }, async (request) => {
    const auth = getAuth(request);
    const result = await runBackup('MANUAL', auth.userId);
    await writeAudit(db, request, {
      action: 'BACKUP_RUN',
      entityType: 'BACKUP',
      entityId: result.id,
      changes: { filename: result.filename, sizeBytes: result.sizeBytes },
    });
    return result;
  });

  app.post('/backups/:id/verify', { preHandler: requirePermissions('backup:read') }, async (request) => {
    const { id } = parseParams(request, idParam);
    return verifyBackup(id);
  });

  /* --------------------------------- Settings ------------------------------- */

  app.get('/settings', { preHandler: requirePermissions('settings:read') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid.optional() }));
    if (query.storeId) assertStoreAccess(request, query.storeId);
    const rows = await db
      .select()
      .from(settings)
      .where(query.storeId ? eq(settings.storeId, query.storeId) : isNull(settings.storeId));
    // Secret values are never returned; only their presence is reported.
    return {
      settings: rows.map((r) => ({ ...r, value: r.isSecret ? '[hidden]' : r.value })),
    };
  });

  app.put('/settings', { preHandler: requirePermissions('settings:write') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(
      request,
      z.object({
        storeId: uuid.nullable().optional(),
        key: z.string().trim().regex(/^[a-z0-9_.]{2,60}$/),
        value: z.unknown(),
        isSecret: z.boolean().default(false),
      }),
    );
    if (input.storeId) assertStoreAccess(request, input.storeId);

    const stored = input.isSecret ? encryptSecret(JSON.stringify(input.value), input.key) : input.value;

    await db
      .insert(settings)
      .values({
        storeId: input.storeId ?? null,
        key: input.key,
        value: stored as never,
        isSecret: input.isSecret,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [settings.storeId, settings.key],
        set: { value: stored as never, isSecret: input.isSecret, updatedBy: auth.userId, updatedAt: new Date() },
      });

    await writeAudit(db, request, {
      action: 'SETTING_UPDATED',
      entityType: 'SETTING',
      entityId: input.key,
      storeId: input.storeId ?? null,
      changes: { key: input.key, isSecret: input.isSecret },
    });

    return { ok: true };
  });

  app.get('/roles', { preHandler: requirePermissions('user:read') }, async () => {
    return { roles: ROLES.map((role) => ({ role, permissions: permissionsForRole(role) })) };
  });
}
