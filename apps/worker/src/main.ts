import { createLogger } from '@noctiv/core';
import { createDb } from '@noctiv/db';
import { loadWorkerConfig } from './config.ts';

// Step 1 skeleton: connects, verifies the database and idles until stopped.
// IMAP listeners and job consumers are added in later build steps.
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const db = createDb(config.WORKER_DATABASE_URL, { applicationName: 'noctiv-worker' });

if (!(await db.ping())) {
  logger.fatal('database not reachable');
  process.exit(1);
}
logger.info('worker started');

const keepAlive = setInterval(() => {}, 60_000);
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(keepAlive);
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
