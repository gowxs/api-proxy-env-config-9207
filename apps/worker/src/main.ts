import { createLogger } from '@noctiv/core';
import { createDb } from '@noctiv/db';
import { createProviders, partitionMailboxes, resolveLlmConfig } from '@noctiv/llm';
import { loadWorkerConfig } from './config.ts';
import { listConnectedMailboxes } from './mailboxes.ts';

// Skeleton: connects, selects the LLM provider, applies the mailbox guard and
// idles. IMAP listeners (step 7) will start only for the `allowed` mailboxes.
const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const llm = createProviders(resolveLlmConfig());
const db = createDb(config.WORKER_DATABASE_URL, { applicationName: 'noctiv-worker' });

if (!(await db.ping())) {
  logger.fatal('database not reachable');
  process.exit(1);
}

logger.info({ llm: llm.description }, 'llm provider selected');
if (llm.description.trainingPolicy === 'may_train_on_data') {
  logger.warn(
    { provider: llm.description.provider },
    'FREE-TIER LLM PROVIDER ACTIVE: submitted data may be used for training. Only mailboxes flagged is_test_mailbox will be processed.',
  );
}

const { allowed, refused } = partitionMailboxes(llm.llm, await listConnectedMailboxes(db.sql));
if (refused.length) {
  logger.warn(
    { refusedConnectionIds: refused.map((m) => m.connectionId) },
    'refusing to process mailboxes that are not flagged is_test_mailbox while a free-tier provider is active',
  );
}
logger.info({ mailboxes: allowed.length, refused: refused.length }, 'worker started');

const keepAlive = setInterval(() => {}, 60_000);
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(keepAlive);
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
