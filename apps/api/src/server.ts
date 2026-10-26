import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env, isProduction } from './config/env.js';
import { registerSecurity } from './plugins/security.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { authRoutes } from './modules/auth/routes.js';
import { salesRoutes, shiftRoutes } from './modules/sales/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { customerRoutes } from './modules/customers/routes.js';
import { paymentRoutes, webhookRoutes } from './modules/payments/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { quickbooksRoutes } from './modules/quickbooks/routes.js';
import { syncRoutes } from './modules/sync/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { creditRoutes } from './modules/credit/routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Trusting the proxy is what makes request.ip correct behind a load balancer,
    // and request.ip is what rate limiting and the webhook allowlist depend on.
    trustProxy: isProduction,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // 1 MB is generous for a POS payload and small enough to blunt body-flood attacks.
    bodyLimit: 1024 * 1024,
    /**
     * Close idle keep-alive sockets on shutdown instead of waiting for them.
     * Without this, `close()` waits out every browser's keep-alive timeout, so
     * stopping the server takes tens of seconds for no benefit — in-flight
     * requests still finish, because those sockets are not idle.
     */
    forceCloseConnections: true,
    // A till polls frequently; a short keep-alive costs little and shortens shutdown.
    keepAliveTimeout: 5_000,
    logger: {
      level: env.LOG_LEVEL,
      ...(isProduction
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
      redact: {
        // Secrets must never reach the log, even at trace level.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.pin',
          'req.body.totp',
          'req.body.secret',
          'req.body.override.pin',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          id: request.id,
          ip: request.ip,
        }),
      },
    },
  });

  await registerSecurity(app);
  registerErrorHandler(app);

  // Echo the request id so a till can quote it when reporting a problem.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('X-Request-Id', request.id);
  });

  await app.register(healthRoutes);

  // Webhooks sit outside the authenticated API surface on purpose: they are
  // public endpoints with their own token + source checks.
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(catalogRoutes, { prefix: '/catalog' });
      await api.register(inventoryRoutes, { prefix: '/inventory' });
      await api.register(customerRoutes, { prefix: '/customers' });
      await api.register(creditRoutes, { prefix: '/credit' });
      await api.register(salesRoutes, { prefix: '/sales' });
      await api.register(shiftRoutes, { prefix: '/shifts' });
      await api.register(paymentRoutes, { prefix: '/payments' });
      await api.register(reportRoutes, { prefix: '/reports' });
      await api.register(quickbooksRoutes, { prefix: '/quickbooks' });
      await api.register(syncRoutes, { prefix: '/sync' });
      await api.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
