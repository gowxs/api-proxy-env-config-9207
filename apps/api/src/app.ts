import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';
import { z, ZodError } from 'zod';
import { AuthError, type AuthUser, type VerifyToken } from './auth.ts';
import { registerRateLimits } from './rate-limit.ts';
import { waitlistRoutes } from './routes/waitlist.ts';
import { weeklyReportRoutes } from './routes/weekly-report.ts';
import type { PaddleClient } from './billing/paddle.ts';
import { actionRoutes } from './routes/actions.ts';
import { billingRoutes, type BillingConfig } from './routes/billing.ts';
import { connectionRoutes } from './routes/connections.ts';
import { meRoutes } from './routes/me.ts';
import { quoteLinkRoutes } from './routes/quote-link.ts';
import { quoteRoutes } from './routes/quotes.ts';
import { composeRoutes } from './routes/compose.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { documentRoutes } from './routes/documents.ts';
import { bookingRoutes } from './routes/bookings.ts';
import { bookingPageRoutes } from './routes/booking-page.ts';
import { shopifyRoutes, type ShopifyAppDeps } from './routes/shopify.ts';
import { woocommerceRoutes } from './routes/woocommerce.ts';
import type { WooClient } from '@noctiv/woocommerce';
import type { GoogleCalendarApi } from '@noctiv/bookings';
import { HttpError, webRoutes } from './routes/web.ts';
import { healthRoutes, readWorkerHealth, type WorkerHealth } from './routes/health.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
  }
}

export interface AppDeps {
  logger: Logger;
  /** Returns true when the database answers; used by the readiness probe. */
  checkDatabase: () => Promise<boolean>;
  /** GET /healthz/worker reads this (default: app.worker_health in the database). */
  workerHealth?: () => Promise<WorkerHealth>;
  sql: Sql;
  verifyToken: VerifyToken;
  /** Worker's public sealing key: the API can encrypt mailbox passwords but never decrypt them. */
  credentialsPublicKey: string;
  connectionTestWaitMs: number;
  /** How long a Noctiv Assistant message waits for the answer before the app polls (default 20 s). */
  assistantWaitMs?: number;
  requireMember: (tenantId: string, userId: string) => Promise<void>;
  /** Shared with the worker: verifies Approve / Reject links. Without it those routes are off. */
  actionSecret?: string;
  /** Dashboard base URL, shown on action pages. */
  appUrl?: string;
  /** Public base URL of this API (customer quote links: <url>/q/<token>). */
  publicApiUrl?: string;
  /** Development only: extra routes (the dev login). */
  devRoutes?: (app: FastifyInstance) => void;
  /** Behind Caddy in production: take the client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Paddle Billing settings; without them checkout and the webhook are off. */
  billing?: BillingConfig;
  /** Paddle API client (needs PADDLE_API_KEY). */
  paddle?: PaddleClient;
  /** The public site (waitlist pages link back to it). */
  siteUrl?: string;
  /** Bearer token for GET /admin/waitlist.csv; without it the export is off. */
  waitlistExportToken?: string;
  /** Off only in tests that need many requests. */
  rateLimits?: boolean;
  /** Google Calendar for Bookings (GOOGLE_OAUTH_*, or the fake with CALENDAR_FAKE=1). */
  google?: GoogleCalendarApi;
  /** How long a booking waits for the worker's confirmation (default 8 s). */
  bookingWaitMs?: number;
  /** Noctiv's Shopify app (order lookup). Without it the Shopify routes are off. */
  shopify?: ShopifyAppDeps;
  /** Public, non-secret switches shown by GET /healthz, to tell which build and settings are live. */
  features?: Record<string, boolean>;
  /** WooCommerce REST client (order lookup). Without it the WooCommerce routes are off. */
  woo?: WooClient;
}

/** Membership check within the tenant's own RLS context. */
export function memberCheck(sql: Sql) {
  return async (tenantId: string, userId: string) => {
    const rows = await withTenant(
      sql,
      tenantId,
      (tx) => tx`select 1 from public.tenant_members where user_id = ${userId}`,
    );
    if (rows.length === 0) throw new ForbiddenError();
  };
}

const publicApiUrl = (d: { publicApiUrl?: string; appUrl?: string }) =>
  d.publicApiUrl ?? `${(d.appUrl ?? 'https://app.noctiv.io').replace(/\/+$/, '')}/api`;

export function buildApp(
  deps: Omit<AppDeps, 'requireMember'> & Partial<Pick<AppDeps, 'requireMember'>>,
) {
  const full: AppDeps = { ...deps, requireMember: deps.requireMember ?? memberCheck(deps.sql) };
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    // Signed action tokens are ~250 characters.
    routerOptions: { maxParamLength: 512 },
    trustProxy: deps.trustProxy ?? false,
    // Fastify's own lines carry no URL on completion; both lines are written below instead.
    disableRequestLogging: true,
  });
  app.addHook('onRequest', async (req) => {
    req.log.info({ req }, 'incoming request');
  });
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      { req, res: { statusCode: reply.statusCode }, responseTime: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  if (deps.rateLimits !== false) registerRateLimits(app);

  // HTML forms (action pages, the site's waitlist form): fields as lists of values.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_req, body, done) => {
      const out: Record<string, string[]> = {};
      for (const [k, v] of new URLSearchParams(body as string)) (out[k] ??= []).push(v);
      done(null, out);
    },
  );

  app.get('/healthz', async () => ({
    status: 'ok',
    ...(deps.features ? { features: deps.features } : {}),
  }));
  healthRoutes(app, deps.workerHealth ?? (() => readWorkerHealth(deps.sql)));

  app.get('/readyz', async (_req, reply) => {
    const dbOk = await deps.checkDatabase().catch(() => false);
    return reply.code(dbOk ? 200 : 503).send({ status: dbOk ? 'ready' : 'unavailable' });
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AuthError();
    req.user = await deps.verifyToken(token);
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AuthError) return reply.code(401).send({ error: 'unauthorized' });
    if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: 'invalid request', issues: error.issues.map((i) => i.path.join('.')) });
    reply.log.error(
      { err: { name: (error as Error).name, message: (error as Error).message } },
      'request failed',
    );
    return reply.code(500).send({ error: 'internal error' });
  });

  connectionRoutes(app, full);
  meRoutes(app, full);
  webRoutes(app, full);
  quoteRoutes(app, { ...full, publicApiUrl: publicApiUrl(deps) });
  documentRoutes(app, full);
  composeRoutes(app, full);
  assistantRoutes(app, full);
  bookingRoutes(app, {
    ...full,
    appUrl: deps.appUrl ?? 'https://app.noctiv.io',
    publicApiUrl: publicApiUrl(deps),
  });
  billingRoutes(app, {
    sql: deps.sql,
    billing: deps.billing ?? { env: 'sandbox' },
    ...(deps.paddle ? { paddle: deps.paddle } : {}),
    requireMember: full.requireMember,
  });
  if (!deps.shopify || !deps.actionSecret)
    app.get('/v1/tenants/:tenantId/shopify', async (req) => {
      const { tenantId } = z.object({ tenantId: z.uuid() }).parse(req.params);
      await full.requireMember(tenantId, req.user!.userId);
      return {
        configured: false,
        installUrl: null,
        devConnectShop: null,
        staleDays: 14,
        connection: null,
      };
    });
  if (!deps.shopify || !deps.actionSecret)
    for (const path of ['/shopify/app', '/shopify/callback', '/shopify/webhooks'])
      app.all(path, async (req, reply) => {
        req.log.warn(
          {
            shopify: {
              route: path,
              status: 503,
              reason: 'routes_disabled',
              hasClient: Boolean(deps.shopify),
              hasActionSecret: Boolean(deps.actionSecret),
            },
          },
          'shopify routes are off: SHOPIFY_APP_CLIENT_ID/SECRET or ACTION_LINK_SECRET missing',
        );
        return reply.code(503).send({ error: 'not configured' });
      });
  if (deps.woo) woocommerceRoutes(app, { ...full, woo: deps.woo });
  else
    app.get('/v1/tenants/:tenantId/woocommerce', async (req) => {
      const { tenantId } = z.object({ tenantId: z.uuid() }).parse(req.params);
      await full.requireMember(tenantId, req.user!.userId);
      return { configured: false, staleDays: 14, shopifyConnected: false, connection: null };
    });
  deps.devRoutes?.(app);
  if (deps.actionSecret) {
    actionRoutes(app, {
      sql: deps.sql,
      actionSecret: deps.actionSecret,
      appUrl: deps.appUrl ?? 'https://app.noctiv.io',
    });
    waitlistRoutes(app, {
      sql: deps.sql,
      secret: deps.actionSecret,
      siteUrl: deps.siteUrl ?? 'https://noctiv.io',
      ...(deps.waitlistExportToken ? { exportToken: deps.waitlistExportToken } : {}),
    });
    quoteLinkRoutes(app, {
      sql: deps.sql,
      secret: deps.actionSecret,
      publicApiUrl: publicApiUrl(deps),
    });
    bookingPageRoutes(app, {
      sql: deps.sql,
      secret: deps.actionSecret,
      appUrl: deps.appUrl ?? 'https://app.noctiv.io',
      publicApiUrl: publicApiUrl(deps),
      credentialsPublicKey: deps.credentialsPublicKey,
      ...(deps.google ? { google: deps.google } : {}),
      ...(deps.bookingWaitMs !== undefined ? { waitMs: deps.bookingWaitMs } : {}),
    });
    if (deps.shopify)
      shopifyRoutes(app, {
        ...full,
        appUrl: deps.appUrl ?? 'https://app.noctiv.io',
        publicApiUrl: publicApiUrl(deps),
        secret: deps.actionSecret,
        shopify: deps.shopify,
      });
    weeklyReportRoutes(app, {
      sql: deps.sql,
      secret: deps.actionSecret,
      appUrl: deps.appUrl ?? 'https://app.noctiv.io',
    });
  }
  return app;
}
