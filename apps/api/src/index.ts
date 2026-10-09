import { buildServer } from './server.js';
import { env } from './config/env.js';
import { closeDb, pingDb } from './db/client.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  const app = await buildServer();

  if (!(await pingDb())) {
    app.log.fatal('cannot reach the database; refusing to start');
    process.exit(1);
  }

  startScheduler(app.log);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      integrations: { mpesa: env.MPESA_ENABLED, pdq: env.PDQ_ENABLED, quickbooks: env.QB_ENABLED },
    },
    'POS API ready',
  );

  /**
   * Graceful shutdown: stop accepting new work, let in-flight sales finish, then
   * close the pool. A hard kill mid-transaction is how tills end up with a sale
   * the server never recorded.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    // In-flight sales finish; idle sockets are dropped. Five seconds is ample
    // for a transaction to commit, and waiting longer just delays a restart.
    const timer = setTimeout(() => {
      app.log.warn('shutdown timed out; forcing exit');
      process.exit(0);
    }, 5_000);
    timer.unref();

    try {
      stopScheduler();
      await app.close();
      await closeDb();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Ctrl+C a second time means "I meant it".
  process.once('SIGINT', () => {
    process.once('SIGINT', () => process.exit(0));
  });

  // An unhandled rejection has left the process in an unknown state; exiting and
  // letting the supervisor restart is safer than continuing to take payments.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to start', err);
  process.exit(1);
});
