import { createLogger } from '@noctiv/core';
import { createDb } from '@noctiv/db';
import { buildApp } from './app.ts';
import { loadApiConfig } from './config.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });
const db = createDb(config.API_DATABASE_URL, { applicationName: 'noctiv-api' });

const app = buildApp({ logger, checkDatabase: () => db.ping() });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
