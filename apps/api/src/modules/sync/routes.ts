import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { syncPushSchema, syncPullQuery, uuid, safeText } from '@pos/shared';
import { db } from '../../db/client.js';
import { syncDevices, terminals } from '../../db/schema/index.js';
import { parseBody, parseQuery, parseParams } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess } from '../../auth/context.js';
import { notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { applySyncBatch, pullChanges, bootstrapSnapshot } from './service.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /** Registers a till so it may push offline work. Admin-gated on purpose. */
  app.post('/devices', { preHandler: requirePermissions('store:write') }, async (request, reply) => {
    const auth = getAuth(request);
    const input = parseBody(
      request,
      z.object({
        deviceId: uuid,
        storeId: uuid,
        terminalId: uuid.optional(),
        label: safeText(80).optional(),
      }),
    );
    assertStoreAccess(request, input.storeId);

    if (input.terminalId) {
      const [terminal] = await db.select().from(terminals).where(eq(terminals.id, input.terminalId)).limit(1);
      if (!terminal || terminal.storeId !== input.storeId) throw notFound('Terminal');
    }

    const [device] = await db
      .insert(syncDevices)
      .values({
        deviceId: input.deviceId,
        storeId: input.storeId,
        terminalId: input.terminalId ?? null,
        label: input.label ?? null,
        registeredBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: syncDevices.deviceId,
        // Registering again re-enables the device and moves it to the till it is now bound to.
        set: {
          storeId: input.storeId,
          terminalId: input.terminalId ?? null,
          revokedAt: null,
          updatedAt: new Date(),
          label: input.label ?? null,
        },
      })
      .returning();

    await writeAudit(db, request, {
      action: 'SYNC_DEVICE_REGISTERED',
      entityType: 'SYNC_DEVICE',
      entityId: device?.id ?? null,
      storeId: input.storeId,
      changes: { deviceId: input.deviceId, label: input.label },
    });

    return reply.status(201).send({ device });
  });

  app.delete('/devices/:deviceId', { preHandler: requirePermissions('store:write') }, async (request) => {
    const { deviceId } = parseParams(request, z.object({ deviceId: uuid }));
    const [device] = await db.select().from(syncDevices).where(eq(syncDevices.deviceId, deviceId)).limit(1);
    if (!device) throw notFound('Device');
    assertStoreAccess(request, device.storeId);

    await db
      .update(syncDevices)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(syncDevices.deviceId, deviceId));

    await writeAudit(db, request, {
      action: 'SYNC_DEVICE_REVOKED',
      entityType: 'SYNC_DEVICE',
      entityId: device.id,
      storeId: device.storeId,
    });

    return { ok: true };
  });

  /**
   * Uploads work done offline. A larger body cap than other routes because a till
   * that has been off for a full day can legitimately carry hundreds of sales.
   */
  app.post(
    '/push',
    {
      preHandler: requirePermissions('sale:create'),
      bodyLimit: 8 * 1024 * 1024,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const auth = getAuth(request);
      const input = parseBody(request, syncPushSchema);
      assertStoreAccess(request, input.storeId);
      return applySyncBatch(request, input, auth);
    },
  );

  app.get('/pull', { preHandler: requirePermissions('product:read') }, async (request) => {
    const query = parseQuery(request, syncPullQuery);
    assertStoreAccess(request, query.storeId);
    return pullChanges({
      deviceId: query.deviceId,
      storeId: query.storeId,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
  });

  app.get('/bootstrap', { preHandler: requirePermissions('product:read') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);
    return bootstrapSnapshot(query.storeId);
  });

  /** Lets a till detect clock drift, which would otherwise corrupt soldAt values. */
  app.get('/time', async () => ({ serverTime: new Date().toISOString() }));

  app.get('/devices', { preHandler: requirePermissions('store:read') }, async (request) => {
    const auth = getAuth(request);
    const rows =
      auth.role === 'ADMIN'
        ? await db.select().from(syncDevices)
        : await db
            .select()
            .from(syncDevices)
            .where(
              auth.storeIds.length > 0
                ? eq(syncDevices.storeId, auth.storeIds[0] as string)
                : and(eq(syncDevices.storeId, '00000000-0000-0000-0000-000000000000')),
            );
    return { devices: rows };
  });
}
