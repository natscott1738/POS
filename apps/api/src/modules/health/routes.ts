import type { FastifyInstance } from 'fastify';
import { pingDb } from '../../db/client.js';
import { env } from '../../config/env.js';
import { backupHealth } from '../../jobs/backup.js';
import { requirePermissions } from '../../auth/context.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: is the process up? Deliberately reveals nothing else. */
  app.get('/health', async () => ({ status: 'ok' }));

  /** Readiness: can we actually serve traffic? Used by the load balancer. */
  app.get('/health/ready', async (_request, reply) => {
    const database = await pingDb();
    if (!database) return reply.status(503).send({ status: 'degraded', database: false });
    return { status: 'ok', database: true };
  });

  /** Operational detail, gated: uptime and integration state are useful to an attacker. */
  app.get('/health/detail', { preHandler: requirePermissions('settings:read') }, async () => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      environment: env.NODE_ENV,
      database: await pingDb(),
      integrations: {
        mpesa: env.MPESA_ENABLED,
        pdq: env.PDQ_ENABLED ? env.PDQ_PROVIDER : false,
        quickbooks: env.QB_ENABLED ? env.QB_ENVIRONMENT : false,
      },
      backups: env.BACKUP_ENABLED ? await backupHealth() : { healthy: false, lastSuccessAt: null, hoursSince: null },
      memory: {
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
  });
}
