import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paddle Billing (merchant of record). Paddle hosts checkout, tax, invoices
 * and the customer portal; Noctiv only keeps the subscription state per tenant.
 */
export type PaddleEnv = 'sandbox' | 'production';

export const paddleApiBase = (env: PaddleEnv) =>
  env === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

export type SignatureResult =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

/**
 * Verifies a `Paddle-Signature: ts=<unix>;h1=<hex>` header: HMAC-SHA256 of
 * `${ts}:${rawBody}` with the notification destination's secret key. The raw
 * body must be exactly the bytes Paddle sent. Several h1 values can be present
 * while Paddle rotates a secret; any match is accepted.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };
  let ts: number | undefined;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 'ts' && v && /^\d+$/.test(v)) ts = Number(v);
    else if (k === 'h1' && v && /^[0-9a-f]{64}$/i.test(v)) h1.push(v.toLowerCase());
  }
  if (ts === undefined || h1.length === 0) return { ok: false, reason: 'malformed' };
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300)) return { ok: false, reason: 'expired' };
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex'),
  );
  const match = h1.some((h) => timingSafeEqual(Buffer.from(h), expected));
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** The Paddle subscription statuses Noctiv mirrors onto the tenant. */
export const PADDLE_STATUSES = ['trialing', 'active', 'past_due', 'paused', 'canceled'] as const;

export interface SubscriptionEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  subscriptionId: string;
  customerId: string | null;
  status: string;
  tenantHint: string | null;
  periodEndsAt: string | null;
  /** A cancellation scheduled for the end of the period (cancelled in the portal). */
  cancelsAt: string | null;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pulls what Noctiv needs out of a `subscription.*` notification; null for anything else. */
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | null {
  const b = body as {
    event_id?: unknown;
    event_type?: unknown;
    occurred_at?: unknown;
    data?: {
      id?: unknown;
      status?: unknown;
      customer_id?: unknown;
      custom_data?: { tenant_id?: unknown } | null;
      current_billing_period?: { ends_at?: unknown } | null;
      scheduled_change?: { action?: unknown; effective_at?: unknown } | null;
    };
  } | null;
  if (!b || typeof b !== 'object') return null;
  const type = b.event_type;
  if (typeof type !== 'string' || !type.startsWith('subscription.')) return null;
  const d = b.data;
  if (
    typeof b.event_id !== 'string' ||
    typeof b.occurred_at !== 'string' ||
    Number.isNaN(Date.parse(b.occurred_at)) ||
    !d ||
    typeof d.id !== 'string' ||
    typeof d.status !== 'string'
  )
    return null;
  const hint = d.custom_data?.tenant_id;
  const endsAt = d.current_billing_period?.ends_at;
  return {
    eventId: b.event_id,
    eventType: type,
    occurredAt: b.occurred_at,
    subscriptionId: d.id,
    customerId: typeof d.customer_id === 'string' ? d.customer_id : null,
    status: d.status,
    tenantHint: typeof hint === 'string' && UUID.test(hint) ? hint : null,
    periodEndsAt: isDate(endsAt) ? endsAt : null,
    cancelsAt:
      d.scheduled_change?.action === 'cancel' && isDate(d.scheduled_change.effective_at)
        ? d.scheduled_change.effective_at
        : null,
  };
}

export interface PaddleClient {
  /** A one-time, authenticated customer portal link (card changes, invoices, cancellation). */
  portalUrl(customerId: string, subscriptionId: string | null): Promise<string>;
  /** Cancels at once (used when a business deletes its account). */
  cancelNow(subscriptionId: string): Promise<void>;
}

export class PaddleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createPaddleClient(opts: {
  apiKey: string;
  env: PaddleEnv;
  fetchImpl?: typeof fetch;
}): PaddleClient {
  const base = paddleApiBase(opts.env);
  const doFetch = opts.fetchImpl ?? fetch;
  const call = async (path: string, body: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'paddle-version': '1',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? code;
      } catch {
        // not JSON
      }
      throw new PaddleApiError(res.status, `paddle ${path.split('/')[1]}: ${code}`);
    }
    return JSON.parse(text) as unknown;
  };
  return {
    async portalUrl(customerId, subscriptionId) {
      const r = (await call(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
        subscription_ids: subscriptionId ? [subscriptionId] : [],
      })) as { data?: { urls?: { general?: { overview?: string } } } };
      const url = r.data?.urls?.general?.overview;
      if (!url) throw new PaddleApiError(502, 'paddle portal-sessions: no url');
      return url;
    },
    async cancelNow(subscriptionId) {
      await call(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        effective_from: 'immediately',
      });
    },
  };
}
