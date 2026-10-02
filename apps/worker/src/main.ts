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
import { composeAssistHandler } from './jobs/compose-assist.ts';
import { assistantTurnHandler } from './jobs/assistant-turn.ts';
import { documentsAutomationHandler } from './jobs/documents-automation.ts';
import { documentsPrefillHandler } from './jobs/documents-prefill.ts';
import { MailboxManager } from './mailbox/manager.ts';
import { alertDeadJob } from './ops/alerts.ts';
import { purgeExpiredContent, tenantDeleteHandler } from './ops/gdpr.ts';
import { sendWaitlistConfirmations } from './ops/waitlist.ts';
import { queuePaymentReminders } from './ops/payment-reminders.ts';
import { healthCheckHandler, scanHealthChecks } from './ops/health.ts';
import { scanQuotaWaits } from './ops/quota.ts';
import { scanWeeklyReports } from './ops/weekly-report.ts';
import { DIGEST_TIME_ZONE, maybeSendDigest, zonedParts } from './ops/digest.ts';
import { EXPORT_HOUR_RIGA, maybeMailExport } from './ops/export.ts';
import { createDbWatch, maybeKeepalive, sqlProbe } from './ops/keepalive.ts';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { deliverNotifications } from './notify/delivery.ts';
import { createSystemTransport, EmailChannel } from './notify/email-channel.ts';
import { QUEUES } from './queues.ts';
import { createShopifyClient } from '@noctiv/shopify';
import { shopifyDisconnectHandler, shopifyTestHandler } from './jobs/shopify.ts';
import { openConnection, shopifyOrders } from './shopify/connection.ts';
import { createFakeGoogleCalendar, createGoogleCalendar, signFormLink } from '@noctiv/bookings';
import {
  bookingCancelHandler,
  bookingConfirmHandler,
  calendarDisconnectHandler,
  calendarSyncHandler,
  scanCalendarSyncs,
} from './jobs/bookings.ts';

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

// Bookings (beta): Google Calendar (or the fake one in development).
const google = config.CALENDAR_FAKE
  ? createFakeGoogleCalendar()
  : config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET
    ? createGoogleCalendar({
        clientId: config.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      })
    : undefined;
const shopify = createShopifyClient();
const shopifyConn = {
  sql: db.sql,
  keys,
  shopify,
  app:
    config.SHOPIFY_APP_CLIENT_ID && config.SHOPIFY_APP_CLIENT_SECRET
      ? { clientId: config.SHOPIFY_APP_CLIENT_ID, clientSecret: config.SHOPIFY_APP_CLIENT_SECRET }
      : null,
};
const bookings = {
  sql: db.sql,
  keys,
  appUrl: config.PUBLIC_APP_URL,
  logger,
  ...(google ? { google } : {}),
  ...(config.ACTION_LINK_SECRET ? { secret: config.ACTION_LINK_SECRET } : {}),
};

// The health check, also run on request by the assistant's mailbox_check tool.
const mailboxHealth = healthCheckHandler({
  sql: db.sql,
  keys,
  allowInsecure: config.MAIL_ALLOW_INSECURE,
});
const runner = new JobRunner({
  sql: db.sql,
  // A crashed worker's jobs are re-claimed after this. Long enough for a website
  // ingest that waits out free-tier rate limits (a live job must never be re-claimed).
  leaseSeconds: 900,
  // Jobs run side by side; slow ones are capped so mail keeps flowing.
  batchSize: 8,
  queueLimits: {
    [QUEUES.kbIngest]: 2,
    [QUEUES.quotesImport]: 1,
    [QUEUES.tenantDelete]: 1,
  },
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
      bookings,
      orders: shopifyOrders(shopifyConn),
    }),
    [QUEUES.shopifyTest]: shopifyTestHandler(shopifyConn),
    [QUEUES.shopifyDisconnect]: shopifyDisconnectHandler(shopifyConn),
    [QUEUES.quotesImport]: quotesImportHandler({ sql: db.sql, llm: providers.llm }),
    [QUEUES.documentsPrefill]: documentsPrefillHandler({ sql: db.sql, llm: providers.llm }),
    [QUEUES.documentsAutomation]: documentsAutomationHandler({ sql: db.sql }),
    [QUEUES.composeAssist]: composeAssistHandler({
      sql: db.sql,
      llm: providers.llm,
      embeddings: providers.embeddings,
    }),
    [QUEUES.assistantTurn]: assistantTurnHandler({
      sql: db.sql,
      logger,
      llm: providers.llm,
      embeddings: providers.embeddings,
      appUrl: config.PUBLIC_APP_URL,
      ...(config.ACTION_LINK_SECRET
        ? {
            formLink: (tenantId: string, formId: string, leadId: string | null) =>
              `${config.PUBLIC_APP_URL.replace(/\/+$/, '')}/f/${signFormLink({ tenantId, formId, leadId }, config.ACTION_LINK_SECRET!)}`,
          }
        : {}),
      checkMailbox: async (tenantId, connectionId) => {
        const r = (await mailboxHealth({
          id: randomUUID(),
          tenantId,
          queue: QUEUES.healthCheck,
          payload: { connectionId },
          attempts: 1,
          maxAttempts: 1,
        })) as { ok?: boolean; code?: string | null };
        return { ok: Boolean(r?.ok), code: r?.code ?? null };
      },
    }),
    [QUEUES.tenantDelete]: tenantDeleteHandler({ sql: db.sql }),
    [QUEUES.calendarSync]: calendarSyncHandler(bookings),
    [QUEUES.calendarDisconnect]: calendarDisconnectHandler(bookings),
    [QUEUES.bookingsConfirm]: bookingConfirmHandler(bookings),
    [QUEUES.bookingsCancel]: bookingCancelHandler(bookings),
    [QUEUES.healthCheck]: mailboxHealth,
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
      fetchLogo: createSafeFetcher({ maxBytes: 1024 * 1024, timeoutMs: 8_000 }),
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
// Monitoring (PLAN.md §25): a heartbeat every minute, read by the API's
// GET /healthz/worker (down after 3 minutes without one).
const startedAt = new Date();
const workerName = `${hostname()}:${process.pid}`.slice(0, 100);
const beat = () =>
  db.sql`select app.worker_beat(${workerName}, ${startedAt})`.catch((e: unknown) =>
    logger.error({ err: String(e) }, 'heartbeat failed'),
  );
void beat();
const heartbeatTimer = setInterval(() => void beat(), 60_000);
// Free-tier safety: a trivial write + read every 2 days (checked hourly, once across workers).
const keepalive = () =>
  maybeKeepalive({ sql: db.sql, logger }).catch((e: unknown) =>
    logger.error({ err: String(e) }, 'keepalive failed'),
  );
void keepalive();
const keepaliveTimer = setInterval(() => void keepalive(), 60 * 60_000);
// Mailbox health checks every 30 minutes: /healthz/worker reports a
// connected mailbox not checked for 60 minutes.
const healthScan = () =>
  scanHealthChecks(db.sql).catch((e: unknown) =>
    logger.error({ err: String(e) }, 'health check scan failed'),
  );
void healthScan();
const healthTimer = setInterval(() => void healthScan(), 30 * 60_000);
// Bookings: calendars not refreshed in 10 minutes get a free/busy sync.
const calendarScan = () =>
  scanCalendarSyncs(db.sql).catch((e: unknown) =>
    logger.error({ err: String(e) }, 'calendar sync scan failed'),
  );
const calendarTimer = setInterval(() => void calendarScan(), 2 * 60_000);
// Expiring Shopify tokens: a store not used for a week is renewed so its 90-day refresh token stays alive.
const renewShopifyTokens = async () => {
  const due = await db.sql<
    { tenant_id: string }[]
  >`select tenant_id from app.shopify_due_renewal(50)`;
  for (const d of due) await openConnection(shopifyConn, d.tenant_id).catch(() => undefined);
};
// Hourly: queue/upload housekeeping, budget-state reset on a new UTC day,
// old health checks removed, the
// retention purge (idempotent; content past retention_days is removed) and
// trial reminder e-mails (7 days and 1 day before the trial ends).
const hourly = () =>
  Promise.all([
    db.sql`select * from app.housekeeping()`,
    db.sql`select * from app.hourly_maintenance()`,
    purgeExpiredContent(db.sql),
    db.sql`select app.queue_trial_reminders()`,
    db.sql`select app.expire_quotes()`,
    db.sql`select app.purge_expired_quote_text()`,
    db.sql`select app.purge_expired_document_prefill()`,
    queuePaymentReminders(db.sql, logger),
    renewShopifyTokens(),
  ]).catch((e: unknown) => logger.error({ err: String(e) }, 'hourly jobs failed'));
const housekeepingTimer = setInterval(() => void hourly(), 60 * 60_000);
void hourly();

let notifyTimer: NodeJS.Timeout | undefined;
let digestTimer: NodeJS.Timeout | undefined;
let dbWatchTimer: NodeJS.Timeout | undefined;
let exportTimer: NodeJS.Timeout | undefined;
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
  const waitlistMail = config.ACTION_LINK_SECRET
    ? {
        sql: db.sql,
        transport,
        from: config.SYSTEM_MAIL_FROM,
        apiUrl: config.PUBLIC_API_URL,
        secret: config.ACTION_LINK_SECRET,
        logger,
      }
    : null;
  notifyTimer = setInterval(() => {
    void deliver();
    if (waitlistMail)
      void sendWaitlistConfirmations(waitlistMail).catch((e: unknown) =>
        logger.error({ err: String(e) }, 'waitlist confirmations failed'),
      );
  }, config.NOTIFY_POLL_MS);
  if (!config.ACTION_LINK_SECRET) {
    logger.warn('ACTION_LINK_SECRET not set: draft emails carry no Approve / Reject links');
  }
  // Admin daily digest at 08:00 Riga (PLAN.md §25).
  const adminEmail = config.ADMIN_EMAIL;
  if (adminEmail) {
    const digest = () =>
      void maybeSendDigest({
        sql: db.sql,
        transport,
        from: config.SYSTEM_MAIL_FROM,
        to: adminEmail,
        logger,
        dbLimitMb: config.DB_SIZE_LIMIT_MB,
      }).catch((e: unknown) => logger.error({ err: String(e) }, 'admin digest failed'));
    digest();
    digestTimer = setInterval(digest, 60_000);

    // Free-tier safety: alert when the database stops answering (e.g. a paused project).
    const watch = createDbWatch({
      probe: sqlProbe(db.sql),
      alert: (subject, text) =>
        transport
          .sendMail({
            from: config.SYSTEM_MAIL_FROM,
            to: adminEmail,
            subject,
            text,
            headers: { 'Auto-Submitted': 'auto-generated' },
          })
          .then(() => undefined),
      logger,
    });
    void watch();
    dbWatchTimer = setInterval(() => void watch(), 5 * 60_000);

    // Weekly encrypted export of the business tables to the admin e-mail (only with an age key).
    const recipient = config.BACKUP_AGE_RECIPIENT;
    if (recipient) {
      const exportMail = () =>
        maybeMailExport({
          sql: db.sql,
          transport,
          from: config.SYSTEM_MAIL_FROM,
          to: adminEmail,
          recipient,
          logger,
        }).catch((e: unknown) => logger.error({ err: String(e) }, 'weekly export failed'));
      // At 04:00 Riga or later; app.ops_claim keeps it to one send per week.
      const hourlyExport = () => {
        if (zonedParts(new Date(), DIGEST_TIME_ZONE).hour >= EXPORT_HOUR_RIGA) void exportMail();
      };
      hourlyExport();
      exportTimer = setInterval(hourlyExport, 60 * 60_000);
    } else {
      logger.warn('BACKUP_AGE_RECIPIENT not set: no weekly encrypted export by e-mail');
    }
  }
} else {
  logger.warn(
    'SYSTEM_SMTP_HOST not set: owner and admin notifications stay queued until the system mailer is configured',
  );
}
// The Monday summary for owners, from 08:00 local time (PLAN.md §26).
const weeklyTimer = setInterval(
  () =>
    void scanWeeklyReports(db.sql).catch((e: unknown) =>
      logger.error({ err: String(e) }, 'weekly report scan failed'),
    ),
  10 * 60_000,
);
// D5: e-mails waiting on the AI quota — admin alert after 30 min, owner after 4 h.
const quotaTimer = setInterval(
  () =>
    void scanQuotaWaits(db.sql).catch((e: unknown) =>
      logger.error({ err: String(e) }, 'quota wait scan failed'),
    ),
  5 * 60_000,
);
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
  clearInterval(heartbeatTimer);
  clearInterval(keepaliveTimer);
  clearInterval(healthTimer);
  clearInterval(calendarTimer);
  if (digestTimer) clearInterval(digestTimer);
  if (dbWatchTimer) clearInterval(dbWatchTimer);
  if (exportTimer) clearInterval(exportTimer);
  clearInterval(quotaTimer);
  clearInterval(weeklyTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  await manager.stopAll();
  await runner.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
