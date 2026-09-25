import { withTenant } from '@noctiv/db';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  parseSubscriptionEvent,
  verifyPaddleSignature,
  type PaddleClient,
  type PaddleEnv,
} from '../billing/paddle.ts';
import { HttpError } from './web.ts';

export interface BillingConfig {
  env: PaddleEnv;
  /** Server-side API key: customer portal links, cancellation on account deletion. */
  apiKey?: string;
  /** The notification destination's secret key: verifies webhooks. */
  webhookSecret?: string;
  /** Public, for Paddle.js in the browser. */
  clientToken?: string;
  /** The one price: Noctiv, $79/month, tax-exclusive. */
  priceId?: string;
}

export interface BillingDeps {
  sql: Sql;
  billing: BillingConfig;
  paddle?: PaddleClient;
  requireMember: (tenantId: string, userId: string) => Promise<void>;
}

interface BillingRow {
  billing_status: string;
  trial_ends_at: Date;
  billing_period_ends_at: Date | null;
  billing_cancels_at: Date | null;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  entitled: boolean;
  timezone: string;
}

const tenantParams = z.object({ tenantId: z.uuid() });
const DAY = 86_400_000;

/**
 * Subscriptions (Paddle Billing, merchant of record). The in-app trial needs
 * no card; afterwards Paddle Checkout (overlay, in the dashboard) starts the
 * subscription and Paddle's webhooks keep tenants.billing_status in step.
 */
export function billingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  const { billing } = deps;

  const load = async (tenantId: string, userId: string) => {
    await deps.requireMember(tenantId, userId);
    const [row] = await withTenant(
      deps.sql,
      tenantId,
      (tx) => tx<BillingRow[]>`
        select billing_status, trial_ends_at, billing_period_ends_at, billing_cancels_at, paddle_customer_id,
               paddle_subscription_id, app.billing_entitled(billing_status, trial_ends_at) as entitled,
               timezone
        from public.tenants`,
    );
    if (!row) throw new HttpError(404, 'not found');
    return row;
  };

  app.get('/v1/tenants/:tenantId/billing', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    const r = await load(tenantId, req.user!.userId);
    const checkoutReady = Boolean(billing.clientToken && billing.priceId);
    return {
      status: r.billing_status,
      entitled: r.entitled,
      trialEndsAt: r.trial_ends_at,
      /** The business's time zone, for showing the exact end. */
      timezone: r.timezone,
      trialDaysLeft:
        r.billing_status === 'trial'
          ? Math.max(0, Math.ceil((r.trial_ends_at.getTime() - Date.now()) / DAY))
          : null,
      periodEndsAt: r.billing_period_ends_at,
      cancelsAt: r.billing_cancels_at,
      hasSubscription: r.paddle_subscription_id !== null,
      portalAvailable: Boolean(deps.paddle && r.paddle_customer_id),
      checkout: checkoutReady
        ? {
            env: billing.env,
            clientToken: billing.clientToken,
            priceId: billing.priceId,
            email: req.user!.email ?? null,
          }
        : null,
    };
  });

  app.post('/v1/tenants/:tenantId/billing/portal', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    const r = await load(tenantId, req.user!.userId);
    if (!deps.paddle) throw new HttpError(503, 'Billing is not configured.');
    if (!r.paddle_customer_id) throw new HttpError(409, 'There is no subscription yet.');
    try {
      return { url: await deps.paddle.portalUrl(r.paddle_customer_id, r.paddle_subscription_id) };
    } catch (err) {
      req.log.warn({ err: { message: (err as Error).message } }, 'paddle portal session failed');
      throw new HttpError(502, 'The billing portal could not be opened. Try again in a minute.');
    }
  });

  // --------------------------------------------------------------- webhook
  // Outside /v1 (no user token): Paddle signs every notification instead.
  if (!billing.webhookSecret) return;
  const secret = billing.webhookSecret;
  void app.register(async (scope) => {
    // The signature covers the exact bytes Paddle sent: keep the body raw.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 512 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post('/paddle/webhook', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const sig = verifyPaddleSignature(raw, req.headers['paddle-signature'] as string, secret);
      if (!sig.ok) {
        req.log.warn({ reason: sig.reason }, 'paddle webhook rejected');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'invalid json' });
      }
      const ev = parseSubscriptionEvent(body);
      if (!ev) {
        // Other event types (transactions, customers…) are not needed: 200 so Paddle stops retrying.
        return reply.code(200).send({ ok: true, ignored: true });
      }
      const [r] = await deps.sql<{ result: string }[]>`
        select app.paddle_apply_subscription(
          ${ev.eventId}, ${ev.eventType}, ${ev.occurredAt}, ${ev.subscriptionId},
          ${ev.customerId}, ${ev.status}, ${ev.tenantHint}, ${ev.periodEndsAt}, ${ev.cancelsAt}
        ) as result`;
      req.log.info(
        { eventType: ev.eventType, status: ev.status, result: r?.result },
        'paddle subscription event',
      );
      return reply.code(200).send({ ok: true, result: r?.result });
    });
  });
}
