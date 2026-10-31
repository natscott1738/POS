import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { qbConnectQuery, qbCallbackQuery, qbMappingSchema, qbSyncTriggerSchema, qbQueueQuery, uuid } from '@pos/shared';
import { db } from '../../db/client.js';
import { qbConnections, qbOauthStates, qbMappings, qbEntityLinks, sales, refunds } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { parseBody, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess, visibleStoreIds } from '../../auth/context.js';
import { badRequest, forbidden, integrationUnavailable, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { encryptSecret, generateToken, safeEqual } from '../../core/crypto.js';
import { authorizeUrl, exchangeCode, activeConnection, qbRequest, revokeConnection } from './client.js';
import { enqueueQbSync, listQueue, queueDepth, retryDeadLetters } from './queue.js';
import { runQbSyncCycle } from './worker.js';

export async function quickbooksRoutes(app: FastifyInstance): Promise<void> {
  /** Step 1 of OAuth: mint a single-use state and hand back the consent URL. */
  app.get('/connect', { preHandler: requirePermissions('quickbooks:connect') }, async (request) => {
    if (!env.QB_ENABLED) throw integrationUnavailable('QuickBooks');
    const auth = getAuth(request);
    const query = parseQuery(request, qbConnectQuery);
    assertStoreAccess(request, query.storeId);

    const state = generateToken(32);
    await db.insert(qbOauthStates).values({
      state,
      storeId: query.storeId,
      userId: auth.userId,
      returnTo: query.returnTo ?? null,
      // Short window: a state that lingers is a CSRF opportunity.
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    return { authorizeUrl: authorizeUrl(state) };
  });

  /**
   * Step 2: Intuit redirects here. The state must exist, be unexpired and unused,
   * which is what stops an attacker from binding their own QuickBooks company to
   * someone else's store.
   */
  app.get('/callback', async (request, reply) => {
    const query = parseQuery(request, qbCallbackQuery);

    const [record] = await db
      .select()
      .from(qbOauthStates)
      .where(eq(qbOauthStates.state, query.state))
      .limit(1);

    if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
      throw forbidden('This authorisation link is no longer valid');
    }
    if (!safeEqual(record.state, query.state)) throw forbidden('Invalid authorisation state');

    await db
      .update(qbOauthStates)
      .set({ consumedAt: new Date() })
      .where(eq(qbOauthStates.id, record.id));

    const tokens = await exchangeCode(query.code);

    await db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ realmId: qbConnections.realmId, environment: qbConnections.environment })
        .from(qbConnections)
        .where(eq(qbConnections.storeId, record.storeId))
        .for('update');

      const companyChanged =
        !previous || previous.realmId !== query.realmId || previous.environment !== env.QB_ENVIRONMENT;

      // Account, item, customer and transaction IDs belong to one QBO company.
      // Never reuse sandbox/company links against a different production realm.
      if (companyChanged) {
        await tx.delete(qbEntityLinks).where(eq(qbEntityLinks.storeId, record.storeId));
        await tx
          .update(qbMappings)
          .set({ autoSyncEnabled: false, updatedAt: new Date() })
          .where(eq(qbMappings.storeId, record.storeId));
      }

      await tx
        .insert(qbConnections)
        .values({
          storeId: record.storeId,
          realmId: query.realmId,
          accessTokenEncrypted: encryptSecret(tokens.accessToken, record.storeId),
          refreshTokenEncrypted: encryptSecret(tokens.refreshToken, record.storeId),
          accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
          refreshTokenExpiresAt: new Date(Date.now() + tokens.refreshExpiresIn * 1000),
          environment: env.QB_ENVIRONMENT,
          isActive: true,
          connectedBy: record.userId,
        })
        .onConflictDoUpdate({
          target: qbConnections.storeId,
          set: {
            realmId: query.realmId,
            accessTokenEncrypted: encryptSecret(tokens.accessToken, record.storeId),
            refreshTokenEncrypted: encryptSecret(tokens.refreshToken, record.storeId),
            accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
            refreshTokenExpiresAt: new Date(Date.now() + tokens.refreshExpiresIn * 1000),
            environment: env.QB_ENVIRONMENT,
            isActive: true,
            disconnectedAt: null,
            lastSyncError: null,
            updatedAt: new Date(),
          },
        });
    });

    await writeAudit(db, request, {
      action: 'QUICKBOOKS_CONNECTED',
      entityType: 'QB_CONNECTION',
      entityId: record.storeId,
      storeId: record.storeId,
      changes: { realmId: query.realmId, environment: env.QB_ENVIRONMENT },
    });

    // Redirect back into the SPA rather than rendering HTML from the API.
    const target = record.returnTo && record.returnTo.startsWith('/') ? record.returnTo : '/quickbooks';
    return reply.redirect(`${env.CORS_ORIGINS[0] ?? ''}${target}?connected=1`);
  });

  app.get('/status', { preHandler: requirePermissions('quickbooks:sync') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);

    const [connection] = await db
      .select({
        realmId: qbConnections.realmId,
        companyName: qbConnections.companyName,
        environment: qbConnections.environment,
        isActive: qbConnections.isActive,
        lastSyncAt: qbConnections.lastSyncAt,
        lastSyncError: qbConnections.lastSyncError,
        refreshTokenExpiresAt: qbConnections.refreshTokenExpiresAt,
      })
      .from(qbConnections)
      .where(eq(qbConnections.storeId, query.storeId))
      .limit(1);

    const [mapping] = await db.select().from(qbMappings).where(eq(qbMappings.storeId, query.storeId)).limit(1);

    return {
      connected: Boolean(connection?.isActive && connection.environment === env.QB_ENVIRONMENT),
      connection: connection ?? null,
      mappingConfigured: Boolean(mapping?.autoSyncEnabled),
      // Surfaced early because a lapsed refresh token silently stops accounting.
      reconnectBy: connection?.refreshTokenExpiresAt ?? null,
      queue: await queueDepth(query.storeId),
    };
  });

  app.delete('/connection', { preHandler: requirePermissions('quickbooks:connect') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);
    await revokeConnection(query.storeId);
    await writeAudit(db, request, {
      action: 'QUICKBOOKS_DISCONNECTED',
      entityType: 'QB_CONNECTION',
      entityId: query.storeId,
      storeId: query.storeId,
    });
    return { ok: true };
  });

  /** Chart of accounts, so the mapping screen offers real choices, not free text. */
  app.get('/accounts', { preHandler: requirePermissions('quickbooks:map') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);

    const connection = await activeConnection(query.storeId);
    const response = await qbRequest<{ QueryResponse?: { Account?: Array<Record<string, unknown>> } }>(
      connection,
      `/query?query=${encodeURIComponent("SELECT Id, Name, AccountType, AccountSubType, Classification FROM Account WHERE Active = true MAXRESULTS 500")}`,
    );

    return { accounts: response.QueryResponse?.Account ?? [] };
  });

  app.get('/tax-codes', { preHandler: requirePermissions('quickbooks:map') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);
    const connection = await activeConnection(query.storeId);
    const response = await qbRequest<{ QueryResponse?: { TaxCode?: Array<Record<string, unknown>> } }>(
      connection,
      `/query?query=${encodeURIComponent('SELECT Id, Name, Description, Active FROM TaxCode MAXRESULTS 200')}`,
    );
    return { taxCodes: response.QueryResponse?.TaxCode ?? [] };
  });

  app.get('/mapping', { preHandler: requirePermissions('quickbooks:map') }, async (request) => {
    const query = parseQuery(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, query.storeId);
    const [mapping] = await db.select().from(qbMappings).where(eq(qbMappings.storeId, query.storeId)).limit(1);
    return { mapping: mapping ?? null };
  });

  app.put('/mapping', { preHandler: requirePermissions('quickbooks:map') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, qbMappingSchema);
    assertStoreAccess(request, input.storeId);

    const [mapping] = await db
      .insert(qbMappings)
      .values({
        storeId: input.storeId,
        incomeAccountId: input.incomeAccountId,
        incomeAccountName: input.incomeAccountName,
        undepositedFundsAccountId: input.undepositedFundsAccountId,
        taxCodeIdStandard: input.taxCodeIdStandard ?? null,
        taxCodeIdZeroRated: input.taxCodeIdZeroRated ?? null,
        taxCodeIdExempt: input.taxCodeIdExempt ?? null,
        inventoryAssetAccountId: input.inventoryAssetAccountId ?? null,
        cogsAccountId: input.cogsAccountId ?? null,
        discountAccountId: input.discountAccountId ?? null,
        roundingAccountId: input.roundingAccountId ?? null,
        paymentAccounts: input.paymentAccounts,
        defaultCustomerId: input.defaultCustomerId ?? null,
        postingMode: input.postingMode,
        autoSyncEnabled: input.autoSyncEnabled,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: qbMappings.storeId,
        set: {
          incomeAccountId: input.incomeAccountId,
          incomeAccountName: input.incomeAccountName,
          undepositedFundsAccountId: input.undepositedFundsAccountId,
          taxCodeIdStandard: input.taxCodeIdStandard ?? null,
          taxCodeIdZeroRated: input.taxCodeIdZeroRated ?? null,
          taxCodeIdExempt: input.taxCodeIdExempt ?? null,
          paymentAccounts: input.paymentAccounts,
          defaultCustomerId: input.defaultCustomerId ?? null,
          postingMode: input.postingMode,
          autoSyncEnabled: input.autoSyncEnabled,
          updatedBy: auth.userId,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAudit(db, request, {
      action: 'QUICKBOOKS_MAPPING_UPDATED',
      entityType: 'QB_MAPPING',
      entityId: input.storeId,
      storeId: input.storeId,
      changes: input,
    });

    return { mapping };
  });

  app.get('/queue', { preHandler: requirePermissions('quickbooks:sync') }, async (request) => {
    const query = parseQuery(request, qbQueueQuery);
    if (query.storeId) assertStoreAccess(request, query.storeId);
    return {
      jobs: await listQueue({
        storeIds: query.storeId ? [query.storeId] : visibleStoreIds(request),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
      }),
    };
  });

  /** Backfills a date range; used after connecting QuickBooks to an existing store. */
  app.post('/sync', { preHandler: requirePermissions('quickbooks:sync') }, async (request) => {
    const input = parseBody(request, qbSyncTriggerSchema);
    assertStoreAccess(request, input.storeId);

    let queued = 0;
    if (input.from && input.to) {
      const from = new Date(input.from);
      const to = new Date(input.to);
      if (to.getTime() - from.getTime() > 366 * 24 * 3600 * 1000) {
        throw badRequest('Backfill range may not exceed one year');
      }

      const rows = await db
        .select({ id: sales.id })
        .from(sales)
        .where(
          and(
            eq(sales.storeId, input.storeId),
            gte(sales.soldAt, from),
            lte(sales.soldAt, to),
            sql`${sales.status} <> 'VOIDED'`,
          ),
        )
        .limit(5000);

      for (const row of rows) {
        await enqueueQbSync(db, {
          storeId: input.storeId,
          entity: 'SALES_RECEIPT',
          localId: row.id,
          operation: 'CREATE',
        });
      }
      queued = rows.length;
    }

    const result = await runQbSyncCycle(request.log);

    await writeAudit(db, request, {
      action: 'QUICKBOOKS_SYNC_TRIGGERED',
      entityType: 'QB_CONNECTION',
      entityId: input.storeId,
      storeId: input.storeId,
      changes: { queued, ...result },
    });

    return { queued, ...result };
  });

  app.post('/queue/retry', { preHandler: requirePermissions('quickbooks:sync') }, async (request) => {
    const input = parseBody(request, z.object({ storeId: uuid }));
    assertStoreAccess(request, input.storeId);
    const retried = await retryDeadLetters(input.storeId);
    await writeAudit(db, request, {
      action: 'QUICKBOOKS_QUEUE_RETRIED',
      entityType: 'QB_QUEUE',
      entityId: input.storeId,
      storeId: input.storeId,
      changes: { retried },
    });
    return { retried };
  });
}
