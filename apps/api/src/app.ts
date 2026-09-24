import Fastify from 'fastify';
import type { Logger } from '@noctiv/core';

export interface AppDeps {
  logger: Logger;
  /** Returns true when the database answers; used by the readiness probe. */
  checkDatabase: () => Promise<boolean>;
}

export function buildApp({ logger, checkDatabase }: AppDeps) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const dbOk = await checkDatabase().catch(() => false);
    return reply.code(dbOk ? 200 : 503).send({ status: dbOk ? 'ready' : 'unavailable' });
  });

  return app;
}
