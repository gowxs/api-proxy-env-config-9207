import { createLogger, nonEuWarning } from '@noctiv/core';
import { createDb, JobRunner } from '@noctiv/db';
import { createSafeFetcher } from '@noctiv/kb';
import { createProviders, resolveLlmConfig } from '@noctiv/llm';
import { loadSealingKeys, loadWorkerConfig } from './config.ts';
import { scanFollowups } from './followups/followup.ts';
import { connectionTestHandler } from './jobs/connection-test.ts';
import { followupHandler } from './jobs/followup.ts';
import { kbIngestHandler } from './jobs/kb-ingest.ts';
import { mailFetchHandler } from './jobs/mail-fetch.ts';
import { mailProcessHandler } from './jobs/mail-process.ts';
import { mailSendHandler } from './jobs/mail-send.ts';
import { quotesImportHandler } from './jobs/quotes-import.ts';
import { MailboxManager } from './mailbox/manager.ts';
import { alertDeadJob } from './ops/alerts.ts';
import { purgeExpiredContent, tenantDeleteHandler } from './ops/gdpr.ts';
import { healthCheckHandler, scanHealthChecks } from './ops/health.ts';
import { deliverNotifications } from './notify/delivery.ts';
import { createSystemTransport, EmailChannel } from './notify/email-channel.ts';
import { QUEUES } from './queues.ts';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL });
const regionWarning = nonEuWarning(config, 'worker');
if (regionWarning) logger.warn({ region: config.DATA_REGION }, regionWarning);
const keys = loadSealingKeys(config);
const providers = createProviders(resolveLlmConfig());
const db = createDb(config.WORKER_DATABASE_URL, { applicationName: 'noctiv-worker', max: 20 });

if (!(await db.ping())) {
  logger.fatal('database not reachable');
  process.exit(1);
}
logger.info({ llm: providers.description }, 'llm provider selected');
if (providers.description.trainingPolicy === 'may_train_on_data') {
  logger.warn(
    { provider: providers.description.provider },
    'FREE-TIER LLM PROVIDER ACTIVE: submitted data may be used for training. Only mailboxes flagged is_test_mailbox will be processed.',
  );
}

// Quotes (beta) need the link secret for the customer's accept link.
const quotes = config.ACTION_LINK_SECRET
  ? { secret: config.ACTION_LINK_SECRET, publicApiUrl: config.PUBLIC_API_URL }
  : undefined;

const runner = new JobRunner({
  sql: db.sql,
  // A crashed worker's jobs are re-claimed after this. Long enough for a website
  // ingest that waits out free-tier rate limits (a live job must never be re-claimed).
  leaseSeconds: 900,
  handlers: {
    [QUEUES.connectionTest]: connectionTestHandler({
      keys,
      allowInsecure: config.MAIL_ALLOW_INSECURE,
    }),
    [QUEUES.mailFetch]: mailFetchHandler({
      sql: db.sql,
      keys,
      allowInsecure: config.MAIL_ALLOW_INSECURE,
    }),
    [QUEUES.mailProcess]: mailProcessHandler({
      sql: db.sql,
      llm: providers.llm,
      embeddings: providers.embeddings,
      logger,
      ...(quotes ? { quotes } : {}),
    }),
    [QUEUES.quotesImport]: quotesImportHandler({ sql: db.sql, llm: providers.llm }),
    [QUEUES.tenantDelete]: tenantDeleteHandler({ sql: db.sql }),
    [QUEUES.healthCheck]: healthCheckHandler({
      sql: db.sql,
      keys,
      allowInsecure: config.MAIL_ALLOW_INSECURE,
    }),
    [QUEUES.followup]: followupHandler({
      sql: db.sql,
      llm: providers.llm,
      embeddings: providers.embeddings,
      logger,
    }),
    [QUEUES.kbIngest]: kbIngestHandler({
      sql: db.sql,
      embeddings: providers.embeddings,
      fetcher: createSafeFetcher(),
    }),
    [QUEUES.mailSend]: mailSendHandler({
      sql: db.sql,
      keys,
      allowInsecure: config.MAIL_ALLOW_INSECURE,
      logger,
      ...(quotes
        ? {
            quotes: {
              ...quotes,
              fetchLogo: createSafeFetcher({ maxBytes: 1024 * 1024, timeoutMs: 8_000 }),
            },
          }
        : {}),
    }),
  },
  onError: (job, error, outcome) => {
    if (outcome === 'dead') {
      void alertDeadJob(db.sql, job, error).catch((e: unknown) =>
        logger.error({ err: String(e) }, 'dead-job alert failed'),
      );
    }
    logger.warn(
      {
        jobId: job.id,
        tenantId: job.tenantId,
        queue: job.queue,
        outcome,
        err: error instanceof Error ? error.message : 'error',
      },
      'job failed',
    );
  },
});

const manager = new MailboxManager({
  sql: db.sql,
  logger,
  keys,
  provider: providers.llm,
  listener: { allowInsecure: config.MAIL_ALLOW_INSECURE },
});

runner.start();
await manager.refresh();
const refreshTimer = setInterval(
  () =>
    void manager
      .refresh()
      .catch((e: unknown) => logger.error({ err: String(e) }, 'mailbox refresh failed')),
  60_000,
);
// Hourly: queue/upload housekeeping, budget-state reset on a new UTC day,
// old health checks removed, a health check per connected mailbox, the
// retention purge (idempotent; content past retention_days is removed) and
// trial reminder e-mails (7 days and 1 day before the trial ends).
const hourly = () =>
  Promise.all([
    db.sql`select * from app.housekeeping()`,
    db.sql`select * from app.hourly_maintenance()`,
    scanHealthChecks(db.sql),
    purgeExpiredContent(db.sql),
    db.sql`select app.queue_trial_reminders()`,
    db.sql`select app.expire_quotes()`,
    db.sql`select app.purge_expired_quote_text()`,
  ]).catch((e: unknown) => logger.error({ err: String(e) }, 'hourly jobs failed'));
const housekeepingTimer = setInterval(() => void hourly(), 60 * 60_000);
void hourly();

let notifyTimer: NodeJS.Timeout | undefined;
if (config.SYSTEM_SMTP_HOST) {
  const transport = createSystemTransport({
    host: config.SYSTEM_SMTP_HOST,
    port: config.SYSTEM_SMTP_PORT,
    security: config.SYSTEM_SMTP_SECURITY,
    user: config.SYSTEM_SMTP_USER,
    pass: config.SYSTEM_SMTP_PASS,
    from: config.SYSTEM_MAIL_FROM,
  });
  const email = new EmailChannel({ transport, from: config.SYSTEM_MAIL_FROM });
  if (regionWarning && config.ADMIN_EMAIL) {
    // Every start, so a temporary non-EU deployment is not forgotten.
    void transport
      .sendMail({
        from: config.SYSTEM_MAIL_FROM,
        to: config.ADMIN_EMAIL,
        subject: '[admin] Noctiv worker started outside the EU',
        text: `${regionWarning}\n\nRegion: ${config.DATA_REGION}\nStarted: ${new Date().toISOString()}`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      })
      .catch((e: unknown) => logger.error({ err: String(e) }, 'region warning email failed'));
  }
  let running = false;
  const deliver = async () => {
    if (running) return;
    running = true;
    try {
      await deliverNotifications({
        sql: db.sql,
        routes: {
          email_owner: { channel: email, audience: 'owner' },
          email_admin: { channel: email, audience: 'admin' },
        },
        adminEmail: config.ADMIN_EMAIL,
        links: {
          apiUrl: config.PUBLIC_API_URL,
          appUrl: config.PUBLIC_APP_URL,
          actionSecret: config.ACTION_LINK_SECRET,
        },
        logger,
      });
    } catch (e) {
      logger.error({ err: String(e) }, 'notification delivery failed');
    } finally {
      running = false;
    }
  };
  notifyTimer = setInterval(() => void deliver(), config.NOTIFY_POLL_MS);
  if (!config.ACTION_LINK_SECRET) {
    logger.warn('ACTION_LINK_SECRET not set: draft emails carry no Approve / Reject links');
  }
} else {
  logger.warn(
    'SYSTEM_SMTP_HOST not set: owner and admin notifications stay queued until the system mailer is configured',
  );
}
// PLAN.md §4.7: follow-ups.scan every 15 minutes.
const followupTimer = setInterval(
  () =>
    void scanFollowups(db.sql).catch((e: unknown) =>
      logger.error({ err: String(e) }, 'follow-up scan failed'),
    ),
  15 * 60_000,
);
logger.info({ mailboxes: manager.active.length }, 'worker started');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  clearInterval(refreshTimer);
  clearInterval(housekeepingTimer);
  clearInterval(followupTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  await manager.stopAll();
  await runner.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
