import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPaddleClient,
  parseSubscriptionEvent,
  verifyPaddleSignature,
} from '../src/billing/paddle.ts';

const SECRET = 'pdl_ntfset_test_secret';
const sign = (body: string, ts: number, secret = SECRET) =>
  `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
const NOW = 1_790_000_000;

describe('Paddle-Signature', () => {
  const body = '{"event_type":"subscription.created"}';

  it('accepts a valid signature', () => {
    expect(verifyPaddleSignature(body, sign(body, NOW), SECRET, { nowSec: NOW })).toEqual({
      ok: true,
    });
  });

  it('accepts any of several h1 values (secret rotation)', () => {
    const other = sign(body, NOW, 'old-secret').split(';')[1];
    const header = `${sign(body, NOW)};${other}`;
    expect(verifyPaddleSignature(body, header, SECRET, { nowSec: NOW }).ok).toBe(true);
  });

  it('rejects a changed body, a wrong secret, an old timestamp and junk', () => {
    const h = sign(body, NOW);
    expect(verifyPaddleSignature(body + ' ', h, SECRET, { nowSec: NOW })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyPaddleSignature(body, h, 'other', { nowSec: NOW })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyPaddleSignature(body, h, SECRET, { nowSec: NOW + 301 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyPaddleSignature(body, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(verifyPaddleSignature(body, 'ts=abc;h1=zz', SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('subscription events', () => {
  const event = {
    event_id: 'evt_01',
    event_type: 'subscription.updated',
    occurred_at: '2026-09-25T10:00:00.000Z',
    notification_id: 'ntf_01',
    data: {
      id: 'sub_01',
      status: 'active',
      customer_id: 'ctm_01',
      custom_data: { tenant_id: '8c7d0a8e-3f7e-4a8e-9a55-3a5b8f0c2d11' },
      current_billing_period: {
        starts_at: '2026-09-25T10:00:00Z',
        ends_at: '2026-10-25T10:00:00Z',
      },
      scheduled_change: { action: 'cancel', effective_at: '2026-10-25T10:00:00Z', resume_at: null },
    },
  };

  it('extracts what Noctiv stores', () => {
    expect(parseSubscriptionEvent(event)).toEqual({
      eventId: 'evt_01',
      eventType: 'subscription.updated',
      occurredAt: '2026-09-25T10:00:00.000Z',
      subscriptionId: 'sub_01',
      customerId: 'ctm_01',
      status: 'active',
      tenantHint: '8c7d0a8e-3f7e-4a8e-9a55-3a5b8f0c2d11',
      periodEndsAt: '2026-10-25T10:00:00Z',
      cancelsAt: '2026-10-25T10:00:00Z',
    });
  });

  it('ignores other event types and a tenant hint that is not a uuid', () => {
    expect(parseSubscriptionEvent({ ...event, event_type: 'transaction.completed' })).toBeNull();
    expect(parseSubscriptionEvent(null)).toBeNull();
    const bad = {
      ...event,
      data: { ...event.data, custom_data: { tenant_id: "x' or 1=1" }, scheduled_change: null },
    };
    expect(parseSubscriptionEvent(bad)).toMatchObject({ tenantHint: null, cancelsAt: null });
  });
});

describe('Paddle API client', () => {
  it('creates a portal session in the right environment', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createPaddleClient({
      apiKey: 'pdl_sdbx_apikey_x',
      env: 'sandbox',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(
          JSON.stringify({
            data: { urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1' } } },
          }),
          { status: 201 },
        );
      }) as typeof fetch,
    });
    expect(await client.portalUrl('ctm_01', 'sub_01')).toBe(
      'https://customer-portal.paddle.com/cpl_1',
    );
    expect(seen[0]!.url).toBe('https://sandbox-api.paddle.com/customers/ctm_01/portal-sessions');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ subscription_ids: ['sub_01'] });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer pdl_sdbx_apikey_x',
    );
  });

  it('reports Paddle errors by code only', async () => {
    const client = createPaddleClient({
      apiKey: 'k',
      env: 'production',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 'forbidden', detail: 'x' } }), {
          status: 403,
        })) as unknown as typeof fetch,
    });
    await expect(client.cancelNow('sub_01')).rejects.toThrow('paddle subscriptions: forbidden');
  });
});
