import { createHmac } from 'node:crypto';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import type { PaddleClient } from '../src/billing/paddle.ts';
import { testAuth } from './helpers.ts';

const SECRET = 'pdl_ntfset_db_test';
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;
const portalCalls: string[] = [];
const cancelled: string[] = [];
const paddle: PaddleClient = {
  portalUrl: async (customerId) => {
    portalCalls.push(customerId);
    return `https://sandbox-customer-portal.paddle.com/${customerId}`;
  },
  cancelNow: async (id) => {
    cancelled.push(id);
  },
};

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: generateSealingKeyPair().publicKey,
    connectionTestWaitMs: 1_000,
    rateLimits: false,
    billing: {
      env: 'sandbox',
      webhookSecret: SECRET,
      clientToken: 'test_client_token',
      priceId: 'pri_01test',
    },
    paddle,
  });
  A = await seedTenant(owner, 'bill-a', { embeddingAxis: 110 });
  B = await seedTenant(owner, 'bill-b', { embeddingAxis: 111 });
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

const get = async (s: SeededTenant, userId = s.userId) => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/tenants/${s.tenantId}/billing`,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
  });
  return { status: res.statusCode, json: res.json() };
};

let seq = 0;
function subEvent(
  tenant: SeededTenant | null,
  patch: { type?: string; status?: string; sub?: string; ctm?: string; at?: string } = {},
) {
  seq++;
  return {
    event_id: `evt_${seq}`,
    event_type: patch.type ?? 'subscription.created',
    occurred_at: patch.at ?? new Date(Date.UTC(2026, 8, 25, 10, seq)).toISOString(),
    notification_id: `ntf_${seq}`,
    data: {
      id: patch.sub ?? 'sub_a1',
      status: patch.status ?? 'active',
      customer_id: patch.ctm ?? 'ctm_a',
      custom_data: tenant ? { tenant_id: tenant.tenantId } : null,
      current_billing_period: {
        starts_at: '2026-09-25T10:00:00Z',
        ends_at: '2026-10-25T10:00:00Z',
      },
      scheduled_change: null,
    },
  };
}

async function deliver(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
  const res = await app.inject({
    method: 'POST',
    url: '/paddle/webhook',
    headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${h1}` },
    payload: raw,
  });
  return { status: res.statusCode, json: res.json() as { result?: string; ignored?: boolean } };
}

const row = async (s: SeededTenant) =>
  (
    await owner<
      {
        billing_status: string;
        paddle_subscription_id: string | null;
        billing_resumed_at: Date | null;
      }[]
    >`
      select billing_status, paddle_subscription_id, billing_resumed_at from public.tenants where id = ${s.tenantId}`
  )[0]!;

describe('billing state', () => {
  it('a new business is in its 14-day in-app trial, with checkout settings for Paddle.js', async () => {
    const r = await get(A);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      status: 'trial',
      entitled: true,
      hasSubscription: false,
      portalAvailable: false,
      checkout: { env: 'sandbox', clientToken: 'test_client_token', priceId: 'pri_01test' },
    });
    expect(r.json.trialDaysLeft).toBeGreaterThanOrEqual(13);
  });

  it('after 14 days without a subscription the tenant is not entitled', async () => {
    await owner`update public.tenants set trial_ends_at = now() - interval '1 hour' where id = ${B.tenantId}`;
    expect((await get(B)).json).toMatchObject({
      status: 'trial',
      entitled: false,
      trialDaysLeft: 0,
    });
  });

  it('members of other businesses cannot read it', async () => {
    expect((await get(A, B.userId)).status).toBe(403);
  });
});

describe('Paddle webhook', () => {
  it('rejects unsigned or wrongly signed notifications', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/paddle/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(subEvent(B)),
    });
    expect(res.statusCode).toBe(401);
    expect((await deliver(subEvent(B), 'wrong-secret')).status).toBe(401);
    expect((await row(B)).billing_status).toBe('trial');
  });

  it('subscription.created reactivates a lapsed tenant (found by custom data)', async () => {
    const r = await deliver(subEvent(B, { sub: 'sub_b1', ctm: 'ctm_b' }));
    expect(r).toMatchObject({ status: 200, json: { result: 'applied' } });
    const t = await row(B);
    expect(t).toMatchObject({ billing_status: 'active', paddle_subscription_id: 'sub_b1' });
    expect(t.billing_resumed_at).not.toBeNull();
    expect((await get(B)).json).toMatchObject({
      entitled: true,
      hasSubscription: true,
      portalAvailable: true,
    });

    const audit = await owner<{ action: string; metadata: { result: string } }[]>`
      select action, metadata from public.audit_log where tenant_id = ${B.tenantId} and action like 'billing.%'`;
    expect(audit.map((a) => [a.action, a.metadata.result])).toContainEqual([
      'billing.subscription.created',
      'applied',
    ]);
  });

  it('past_due keeps service; canceled stops it; events are applied in time order', async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, m)).toISOString();
    expect(
      (
        await deliver(
          subEvent(null, {
            type: 'subscription.past_due',
            status: 'past_due',
            sub: 'sub_b1',
            at: at(10),
          }),
        )
      ).json.result,
    ).toBe('applied');
    expect((await get(B)).json).toMatchObject({ status: 'past_due', entitled: true });

    // A late, older "active" must not undo a newer state.
    expect(
      (
        await deliver(
          subEvent(null, {
            type: 'subscription.updated',
            status: 'active',
            sub: 'sub_b1',
            at: at(5),
          }),
        )
      ).json.result,
    ).toBe('stale');

    expect(
      (
        await deliver(
          subEvent(null, {
            type: 'subscription.canceled',
            status: 'canceled',
            sub: 'sub_b1',
            at: at(20),
          }),
        )
      ).json.result,
    ).toBe('applied');
    expect((await get(B)).json).toMatchObject({ status: 'canceled', entitled: false });
  });

  it('a late cancel of an old subscription does not stop the new one', async () => {
    await deliver(
      subEvent(B, {
        sub: 'sub_b2',
        ctm: 'ctm_b',
        at: new Date(Date.UTC(2026, 9, 2)).toISOString(),
      }),
    );
    expect((await row(B)).paddle_subscription_id).toBe('sub_b2');
    const late = await deliver(
      subEvent(null, {
        type: 'subscription.canceled',
        status: 'canceled',
        sub: 'sub_b1',
        ctm: 'ctm_b',
        at: new Date(Date.UTC(2026, 9, 3)).toISOString(),
      }),
    );
    expect(late.json.result).toBe('ignored_other_subscription');
    expect((await get(B)).json).toMatchObject({ status: 'active', entitled: true });
  });

  it('unknown subscriptions and other event types are acknowledged without changes', async () => {
    expect(
      (await deliver(subEvent(null, { sub: 'sub_nobody', ctm: 'ctm_nobody' }))).json.result,
    ).toBe('unknown_tenant');
    expect(
      (await deliver({ ...subEvent(A), event_type: 'transaction.completed' })).json,
    ).toMatchObject({ ignored: true });
    expect((await row(A)).billing_status).toBe('trial');
  });

  it('the API role cannot set billing columns directly', async () => {
    await expect(
      apiSql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.tenantId}, true)`;
        await tx`update public.tenants set billing_status = 'comped'`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('customer portal', () => {
  it('opens a Paddle portal session for the subscribed tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${B.tenantId}/billing/portal`,
      headers: { authorization: `Bearer ${await auth.token(B.userId)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://sandbox-customer-portal.paddle.com/ctm_b' });
  });

  it('is refused before there is a subscription', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${A.tenantId}/billing/portal`,
      headers: { authorization: `Bearer ${await auth.token(A.userId)}` },
    });
    expect(res.statusCode).toBe(409);
  });
});
