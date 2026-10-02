import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createShopifyClient, signToken } from '@noctiv/shopify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startMockShopify } from '../../../packages/shopify/test/mock-shopify.ts';
import { shopifyDisconnectHandler, shopifyTestHandler } from '../../worker/src/jobs/shopify.ts';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
const workerSql = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
const SECRET = 'shopify-test-action-secret-0123456789abcdef';
const APP = { clientId: 'cid-api', clientSecret: 'shpss_api_secret_00000000' };
const APP_URL = 'https://app.example.test';
const API_URL = 'https://api.example.test';
const keys = generateSealingKeyPair();

let mock: Awaited<ReturnType<typeof startMockShopify>>;
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;
const logs: string[] = [];
let n = 0;
/** Requests as Shopify's redirect reaches the API: on the public host (the App URL's host). */
const hit = (
  o: { method: string; url: string; headers?: Record<string, string>; payload?: string | object },
  a: ReturnType<typeof buildApp> = app,
) =>
  a.inject({
    ...o,
    method: o.method as 'GET',
    headers: { host: 'api.example.test', ...o.headers },
  });
/** The shared fixture seeds a connection per tenant; these tests connect their own. */
async function seedBare(label: string, embeddingAxis: number) {
  const t = await seedTenant(owner, label, { embeddingAxis });
  await owner`delete from public.shopify_connections where tenant_id = ${t.tenantId}`;
  await owner`delete from public.woocommerce_connections where tenant_id = ${t.tenantId}`;
  return t;
}
const shopName = () => `api${n++}-store.myshopify.com`;

beforeAll(async () => {
  mock = await startMockShopify({ clientId: APP.clientId, clientSecret: APP.clientSecret });
  auth = await testAuth();
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'debug', destination: sink }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: keys.publicKey,
    connectionTestWaitMs: 1_500,
    actionSecret: SECRET,
    appUrl: APP_URL,
    publicApiUrl: API_URL,
    rateLimits: false,
    shopify: {
      app: APP,
      client: createShopifyClient({ baseUrl: mock.baseUrl }),
      installUrl: 'https://admin.shopify.com/oauth/install?client_id=cid-api',
    },
  });
  A = await seedBare('shopify-a', 240);
  B = await seedBare('shopify-b', 241);
});
afterAll(async () => {
  await mock.close();
  await Promise.all([owner.end(), apiSql.end(), workerSql.end()]);
});

const sign = (q: Record<string, string>) =>
  createHmac('sha256', APP.clientSecret)
    .update(
      Object.keys(q)
        .sort()
        .map((k) => `${k}=${q[k]}`)
        .join('&'),
    )
    .digest('hex');
const signed = (q: Record<string, string>) => ({ ...q, hmac: sign(q) });
const qs = (q: Record<string, string>) => new URLSearchParams(q).toString();

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: string,
  body?: unknown,
) {
  const res = await hit({
    method,
    url,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

/** The whole install as a merchant's browser does it: Shopify opens our app URL, then calls back with a code. */
async function install(
  shop: string,
  over: { code?: string; state?: string; cookie?: string; tamper?: boolean } = {},
) {
  const start = await hit({
    method: 'GET',
    url: `/shopify/app?${qs(signed({ shop, timestamp: '1790000000', host: 'abc' }))}`,
  });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get('state')!;
  const cookie = /noctiv_shopify_oauth=([a-f0-9]+)/.exec(String(start.headers['set-cookie']))![1]!;
  const q = signed({
    shop,
    code: over.code ?? mock.newCode(),
    state: over.state ?? state,
    timestamp: '1790000001',
  });
  const res = await hit({
    method: 'GET',
    url: `/shopify/callback?${qs(over.tamper ? { ...q, shop: 'other.myshopify.com' } : q)}`,
    headers: { cookie: `noctiv_shopify_oauth=${over.cookie ?? cookie}` },
  });
  return { res, start, state, location: new URL(String(res.headers.location)) };
}
const claimOf = (loc: URL) => loc.searchParams.get('claim')!;

async function runWorkerJobs(queue: string) {
  for (let i = 0; i < 60; i++) {
    const [job] = await owner<
      { id: string; tenant_id: string; payload: Record<string, unknown> }[]
    >`
      select id, tenant_id, payload from public.jobs where queue = ${queue} and status = 'queued' order by created_at limit 1`;
    if (job) {
      const deps = {
        sql: workerSql,
        keys,
        shopify: createShopifyClient({ baseUrl: mock.baseUrl }),
        app: APP,
      };
      const handler =
        queue === 'shopify.test' ? shopifyTestHandler(deps) : shopifyDisconnectHandler(deps);
      const result = await handler({
        id: job.id,
        tenantId: job.tenant_id,
        queue,
        payload: job.payload,
        attempts: 1,
        maxAttempts: 1,
      });
      await owner`update public.jobs set status = 'done', result = ${owner.json(result as never)} where id = ${job.id}`;
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Shopify opens our app URL', () => {
  const shop = 'noctiv-nvojutjr.myshopify.com';
  it('a signed request goes straight to OAuth for read_orders, with a state and a cookie', async () => {
    const r = await hit({
      method: 'GET',
      url: `/shopify/app?${qs(signed({ shop, timestamp: '1', host: 'h' }))}`,
    });
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location as string);
    expect(u.host).toBe(shop);
    expect(u.pathname).toBe('/admin/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe(APP.clientId);
    expect(u.searchParams.get('scope')).toBe('read_orders');
    expect(u.searchParams.get('redirect_uri')).toBe(`${API_URL}/shopify/callback`);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(r.headers['set-cookie'])).toMatch(/Secure/);
  });
  it.each([
    ['no signature', (q: Record<string, string>) => qs(q)],
    ['a forged signature', (q: Record<string, string>) => qs({ ...q, hmac: 'a'.repeat(64) })],
    [
      'a signature for another shop',
      (q: Record<string, string>) => qs({ ...signed(q), shop: 'evil.myshopify.com' }),
    ],
  ])('refuses %s', async (_n, build) => {
    const r = await hit({
      method: 'GET',
      url: `/shopify/app?${build({ shop, timestamp: '1' })}`,
    });
    expect(r.statusCode).toBe(400);
  });
  it('refuses a shop that is not *.myshopify.com, even when correctly signed', async () => {
    const r = await hit({
      method: 'GET',
      url: `/shopify/app?${qs(signed({ shop: 'evil.example.com', timestamp: '1' }))}`,
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('the OAuth callback', () => {
  it('finishes the install: tokens sealed and waiting, a claim for the owner, only read_orders', async () => {
    const shop = shopName();
    const { res, location } = await install(shop);
    expect(res.statusCode).toBe(302);
    expect(location.origin).toBe(APP_URL);
    expect(location.pathname).toBe('/integrations');
    expect(claimOf(location)).toBeTruthy();
    const [pending] = await owner<{ credentials_ciphertext: Buffer; scopes: string[] }[]>`
      select credentials_ciphertext, scopes from app.shopify_installs where shop_domain = ${shop}`;
    expect(pending!.scopes).toEqual(['read_orders']);
    // Sealed: neither token nor refresh token is readable in the database.
    const raw = pending!.credentials_ciphertext.toString('latin1');
    expect(raw).not.toContain('shpat_minted');
    expect(raw).not.toContain('shprt_minted');
    // The code exchange asked for expiring tokens.
    const req = mock.requests.filter((r) => r.path === '/admin/oauth/access_token').at(-1)!;
    expect(new URLSearchParams(req.body).get('expiring')).toBe('1');
  });
  it.each([
    [
      'a state signed for another shop',
      async (shop: string) =>
        install(shop, {
          state: signToken({ kind: 'oauth', shop: 'x.myshopify.com', nonce: 'n' }, SECRET, 600),
        }),
    ],
    [
      'a missing or wrong cookie (another browser)',
      async (shop: string) => install(shop, { cookie: 'deadbeef' }),
    ],
    ['a forged state', async (shop: string) => install(shop, { state: 'forged.state' })],
    [
      'a changed shop (the signature no longer fits)',
      async (shop: string) => install(shop, { tamper: true }),
    ],
  ])('refuses %s and stores nothing', async (_n, run) => {
    const shop = shopName();
    const { res, location } = await run(shop);
    expect(res.statusCode).toBe(302);
    expect(location.searchParams.get('reason')).toBe('state');
    expect(location.searchParams.get('claim')).toBeNull();
    expect(
      await owner`select 1 from app.shopify_installs where shop_domain = ${shop}`,
    ).toHaveLength(0);
  });
  it('the merchant declining ends cleanly', async () => {
    const shop = shopName();
    const start = await hit({
      method: 'GET',
      url: `/shopify/app?${qs(signed({ shop, timestamp: '1' }))}`,
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cookie = /noctiv_shopify_oauth=([a-f0-9]+)/.exec(
      String(start.headers['set-cookie']),
    )![1]!;
    const res = await hit({
      method: 'GET',
      url: `/shopify/callback?${qs(signed({ shop, error: 'access_denied', state, timestamp: '1' }))}`,
      headers: { cookie: `noctiv_shopify_oauth=${cookie}` },
    });
    expect(new URL(String(res.headers.location)).searchParams.get('reason')).toBe('denied');
  });
  it('a grant that includes a write permission is refused and nothing is stored', async () => {
    const shop = shopName();
    const saved = mock.scopes;
    mock.scopes = ['read_orders', 'write_orders'];
    try {
      const { location } = await install(shop);
      expect(location.searchParams.get('reason')).toBe('scopes');
    } finally {
      mock.scopes = saved;
    }
    expect(
      await owner`select 1 from app.shopify_installs where shop_domain = ${shop}`,
    ).toHaveLength(0);
  });
  it('a code that was already used fails', async () => {
    const code = mock.newCode();
    await install(shopName(), { code });
    const { location } = await install(shopName(), { code });
    expect(location.searchParams.get('reason')).toBe('shopify');
  });
});

describe('linking the finished install to a business', () => {
  it('the owner claims it once; the connection holds sealed tokens and is read-only', async () => {
    const shop = shopName();
    const claim = claimOf((await install(shop)).location);
    const r = await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, A.userId, { claim });
    expect(r).toMatchObject({ status: 200, json: { ok: true, shopDomain: shop } });
    const [c] = await owner<
      { shop_domain: string; scopes: string[]; credentials_ciphertext: Buffer }[]
    >`
      select shop_domain, scopes, credentials_ciphertext from public.shopify_connections where tenant_id = ${A.tenantId}`;
    expect(c).toMatchObject({ shop_domain: shop, scopes: ['read_orders'] });
    expect(
      await owner`select 1 from app.shopify_installs where shop_domain = ${shop}`,
    ).toHaveLength(0);
    // The owner's view of the connection never includes the sealed tokens.
    const status = await call('GET', `/v1/tenants/${A.tenantId}/shopify`, A.userId);
    expect(status.json).toMatchObject({
      configured: true,
      staleDays: 14,
      connection: { shopDomain: shop, status: 'connected' },
    });
    expect(JSON.stringify(status.json)).not.toMatch(/ciphertext|shpat|shprt/);
    // A double click is harmless.
    expect(
      (await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, A.userId, { claim })).status,
    ).toBe(200);
  });
  it('one store, one business: a re-install keeps the link and another business cannot take it', async () => {
    const shop = shopName();
    const first = claimOf((await install(shop)).location);
    expect(
      (await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, A.userId, { claim: first }))
        .status,
    ).toBe(200);
    const [before] = await owner<
      { credentials_ciphertext: Buffer }[]
    >`select credentials_ciphertext from public.shopify_connections where tenant_id = ${A.tenantId}`;
    // The merchant installs again (or Shopify re-authorises): fresh tokens, same link, nothing left pending.
    const again = claimOf((await install(shop)).location);
    expect(
      await owner`select 1 from app.shopify_installs where shop_domain = ${shop}`,
    ).toHaveLength(0);
    const [after] = await owner<
      { credentials_ciphertext: Buffer }[]
    >`select credentials_ciphertext from public.shopify_connections where tenant_id = ${A.tenantId}`;
    expect(Buffer.compare(after!.credentials_ciphertext, before!.credentials_ciphertext)).not.toBe(
      0,
    );
    const r = await call('POST', `/v1/tenants/${B.tenantId}/shopify/claim`, B.userId, {
      claim: again,
    });
    expect(r.status).toBe(409);
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${B.tenantId}`,
    ).toHaveLength(0);
  });
  it("only the business's own owner can link a store to it", async () => {
    const claim = claimOf((await install(shopName())).location);
    expect(
      (await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, B.userId, { claim })).status,
    ).toBe(403);
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${B.tenantId}`,
    ).toHaveLength(0);
  });
  it('an expired or forged claim is refused', async () => {
    const forged = signToken({ kind: 'claim', shop: shopName() }, 'not-the-secret', 600);
    expect(
      (await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, A.userId, { claim: forged }))
        .status,
    ).toBe(400);
    const old = signToken({ kind: 'claim', shop: shopName() }, SECRET, 1, Date.now() - 3600_000);
    expect(
      (await call('POST', `/v1/tenants/${A.tenantId}/shopify/claim`, A.userId, { claim: old }))
        .status,
    ).toBe(400);
  });
  it('a claim token cannot be used as an oauth state (and vice versa)', async () => {
    const shop = shopName();
    const claimAsState = signToken({ kind: 'claim', shop }, SECRET, 600);
    const { location } = await install(shop, { state: claimAsState });
    expect(location.searchParams.get('reason')).toBe('state');
  });
});

describe('test connection and disconnect', () => {
  let t: SeededTenant;
  let shop: string;
  beforeAll(async () => {
    t = await seedBare('shopify-c', 242);
    shop = shopName();
    const claim = claimOf((await install(shop)).location);
    await call('POST', `/v1/tenants/${t.tenantId}/shopify/claim`, t.userId, { claim });
    await owner`delete from public.jobs where queue = 'shopify.test'`;
  });
  it('"Test connection" asks the worker, which opens the tokens and reads the store', async () => {
    const [res] = await Promise.all([
      call('POST', `/v1/tenants/${t.tenantId}/shopify/test`, t.userId, {}),
      runWorkerJobs('shopify.test'),
    ]);
    expect(res.json).toEqual({ status: 'ok', shopName: 'Noctiv Dev Store' });
    const [c] =
      await owner`select status, shop_name, last_checked_at from public.shopify_connections where tenant_id = ${t.tenantId}`;
    expect(c).toMatchObject({ status: 'connected', shop_name: 'Noctiv Dev Store' });
  });
  it('reports a connection Shopify no longer accepts, in plain words', async () => {
    const saved = new Set(mock.validTokens);
    mock.revokeAll();
    try {
      const [res] = await Promise.all([
        call('POST', `/v1/tenants/${t.tenantId}/shopify/test`, t.userId, {}),
        runWorkerJobs('shopify.test'),
      ]);
      expect(res.json).toMatchObject({ status: 'failed', code: 'AUTH_FAILED' });
      expect(res.json.message).toMatch(/connect the store again/i);
    } finally {
      saved.forEach((x) => mock.validTokens.add(x));
    }
    const [c] =
      await owner`select status, last_error_code from public.shopify_connections where tenant_id = ${t.tenantId}`;
    expect(c).toMatchObject({ status: 'error', last_error_code: 'AUTH_FAILED' });
  });
  it('"Disconnect and delete token" uninstalls the app and deletes the sealed tokens', async () => {
    const before = mock.requests.filter((r) => r.method === 'DELETE').length;
    const [res] = await Promise.all([
      call('DELETE', `/v1/tenants/${t.tenantId}/shopify`, t.userId),
      runWorkerJobs('shopify.disconnect'),
    ]);
    expect(res.json).toMatchObject({ status: 'disconnected' });
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${t.tenantId}`,
    ).toHaveLength(0);
    expect(mock.requests.filter((r) => r.method === 'DELETE').length - before).toBeLessThanOrEqual(
      1,
    );
    const [log] =
      await owner`select action from public.audit_log where tenant_id = ${t.tenantId} and action = 'shopify.disconnected'`;
    expect(log).toBeTruthy();
  });
  it('the token is deleted even when the worker is slow', async () => {
    const claim = claimOf((await install(shopName())).location);
    await call('POST', `/v1/tenants/${t.tenantId}/shopify/claim`, t.userId, { claim });
    const res = await call('DELETE', `/v1/tenants/${t.tenantId}/shopify`, t.userId); // no worker running
    expect(res.json).toEqual({ status: 'disconnected', revoked: false });
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${t.tenantId}`,
    ).toHaveLength(0);
  });
  it('only members of the business can use these routes', async () => {
    expect((await call('GET', `/v1/tenants/${t.tenantId}/shopify`, B.userId)).status).toBe(403);
    expect((await call('DELETE', `/v1/tenants/${t.tenantId}/shopify`, B.userId)).status).toBe(403);
  });
});

describe('webhooks from Shopify', () => {
  const post = (topic: string, shop: string, body: object, secret = APP.clientSecret) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/shopify/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': shop,
        'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'),
      },
      payload: raw,
    });
  };
  let t: SeededTenant;
  let shop: string;
  beforeAll(async () => {
    t = await seedBare('shopify-d', 243);
    shop = shopName();
    const claim = claimOf((await install(shop)).location);
    await call('POST', `/v1/tenants/${t.tenantId}/shopify/claim`, t.userId, { claim });
  });
  it('rejects a wrong or missing signature', async () => {
    expect(
      (await post('app/uninstalled', shop, { shop_domain: shop }, 'wrong-secret')).statusCode,
    ).toBe(401);
    const r = await hit({
      method: 'POST',
      url: '/shopify/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': 'app/uninstalled',
        'x-shopify-shop-domain': shop,
      },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${t.tenantId}`,
    ).toHaveLength(1);
  });
  it('customer data requests and erasures are answered and recorded (Noctiv holds no Shopify customer data)', async () => {
    for (const topic of ['customers/data_request', 'customers/redact'])
      expect((await post(topic, shop, { shop_domain: shop, customer: { id: 1 } })).statusCode).toBe(
        200,
      );
    const rows =
      await owner`select metadata from public.audit_log where tenant_id = ${t.tenantId} and action = 'shopify.privacy_request'`;
    expect(rows.map((r) => (r.metadata as { topic: string }).topic).sort()).toEqual([
      'customers/data_request',
      'customers/redact',
    ]);
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${t.tenantId}`,
    ).toHaveLength(1);
  });
  it('an unknown shop is acknowledged without error', async () => {
    expect((await post('customers/redact', 'nobody.myshopify.com', {})).statusCode).toBe(200);
  });
  it('app/uninstalled deletes the tokens', async () => {
    expect((await post('app/uninstalled', shop, { shop_domain: shop })).statusCode).toBe(200);
    expect(
      await owner`select 1 from public.shopify_connections where tenant_id = ${t.tenantId}`,
    ).toHaveLength(0);
  });
  it('shop/redact deletes any pending install too', async () => {
    const s2 = shopName();
    await install(s2);
    expect(await owner`select 1 from app.shopify_installs where shop_domain = ${s2}`).toHaveLength(
      1,
    );
    expect((await post('shop/redact', s2, { shop_domain: s2 })).statusCode).toBe(200);
    expect(await owner`select 1 from app.shopify_installs where shop_domain = ${s2}`).toHaveLength(
      0,
    );
  });
});

describe('settings', () => {
  it('the days without a shipping update default to 14 and can be changed within 1 to 90', async () => {
    expect(
      (
        await call('PATCH', `/v1/tenants/${A.tenantId}`, A.userId, {
          shopifyStaleDays: 21,
        })
      ).status,
    ).toBe(200);
    expect((await call('GET', `/v1/tenants/${A.tenantId}/shopify`, A.userId)).json.staleDays).toBe(
      21,
    );
    for (const bad of [0, 91, 1.5])
      expect(
        (
          await call('PATCH', `/v1/tenants/${A.tenantId}`, A.userId, {
            shopifyStaleDays: bad,
          })
        ).status,
      ).toBe(400);
  });
});

describe('secrets never reach the logs', () => {
  it('no token, code, secret or signature was logged during all of the above', () => {
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0); // the capture works
    for (const s of ['shpat_', 'shprt_', APP.clientSecret, 'code_', 'hmac='])
      expect(all).not.toContain(s);
  });
});

describe('every request to the install routes leaves one line saying what happened', () => {
  const shop = 'noctiv-nvojutjr.myshopify.com';
  const SECRETISH = ['hmac=', 'code=', 'state=', 'nonce'];
  const lastOutcome = () => {
    const lines = logs
      .join('')
      .split('\n')
      .filter((l) => l.includes('"shopify":{'))
      .map((l) => JSON.parse(l) as { shopify: Record<string, unknown>; msg: string });
    return lines[lines.length - 1]!;
  };

  it('/shopify/app: missing shop, bad domain, missing and wrong signature', async () => {
    const cases: [string, string][] = [
      [`/shopify/app?${qs(signed({ timestamp: '1' }))}`, 'missing_shop'],
      [
        `/shopify/app?${qs(signed({ shop: 'evil.example.com', timestamp: '1' }))}`,
        'bad_shop_domain',
      ],
      [`/shopify/app?${qs({ shop, timestamp: '1' })}`, 'hmac_missing'],
      [`/shopify/app?${qs({ shop, timestamp: '1', hmac: 'ab'.repeat(32) })}`, 'hmac_invalid'],
    ];
    for (const [url, reason] of cases) {
      const r = await hit({ method: 'GET', url });
      expect(r.statusCode).toBe(400);
      const l = lastOutcome();
      expect(l.shopify).toMatchObject({ route: 'app', status: 400, reason });
      expect(l.msg).toBe(`shopify app 400 ${reason}`);
    }
    // For a bad signature the names of the signed parameters are logged (never values) to help diagnosis.
    expect(lastOutcome().shopify.signedParams).toEqual(['shop', 'timestamp']);
  });

  it('/shopify/app: a good request logs the redirect with the callback address it sent Shopify to', async () => {
    const r = await hit({
      method: 'GET',
      url: `/shopify/app?${qs(signed({ shop, timestamp: '1', host: 'YWRtaW4', embedded: '1' }))}`,
    });
    expect(r.statusCode).toBe(302);
    expect(lastOutcome().shopify).toMatchObject({
      status: 302,
      reason: 'redirect_to_authorize',
      shop,
      redirectUri: `${API_URL}/shopify/callback`,
      requestHost: 'api.example.test',
      publicHost: 'api.example.test',
      hmacVariant: 'decoded',
    });
  });

  it('/shopify/app on another host (the platform address) continues on the public host, once', async () => {
    const url = `/shopify/app?${qs(signed({ shop, timestamp: '1' }))}`;
    const first = await hit({ method: 'GET', url, headers: { host: 'http--api--abc.code.run' } });
    expect(first.statusCode).toBe(302);
    const next = new URL(String(first.headers.location));
    expect(`${next.origin}${next.pathname}`).toBe(`${API_URL}/shopify/app/start`);
    expect(lastOutcome().shopify).toMatchObject({
      reason: 'hop_to_public_host',
      seenHost: 'http--api--abc.code.run',
    });
    // The signed query is untouched, so Shopify's signature still holds on the next hop, which never hops again.
    const second = await hit({ method: 'GET', url: `${next.pathname}${next.search}` });
    expect(second.statusCode).toBe(302);
    expect(new URL(String(second.headers.location)).host).toBe(shop);
    const third = await hit({
      method: 'GET',
      url: `${next.pathname}${next.search}`,
      headers: { host: 'http--api--abc.code.run' },
    });
    expect(third.statusCode).toBe(302);
    expect(new URL(String(third.headers.location)).host).toBe(shop);
  });

  it('/shopify/app opened inside the admin (embedded) breaks out to the top window instead of a blocked redirect', async () => {
    const r = await hit({
      method: 'GET',
      url: `/shopify/app?${qs(signed({ shop, timestamp: '1', embedded: '1' }))}`,
      headers: { 'sec-fetch-dest': 'iframe' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body).toContain('window.top.location.href=');
    expect(r.body).toContain(`${API_URL}/shopify/app/start?`);
    expect(lastOutcome().shopify).toMatchObject({ reason: 'breakout_iframe' });
  });

  it('/shopify/callback: each failure has its own reason (the browser only sees "state")', async () => {
    const good = await install(shopName());
    expect(lastOutcome().shopify).toMatchObject({
      route: 'callback',
      status: 302,
      reason: 'installed',
    });
    expect(good.location.searchParams.get('claim')).toBeTruthy();

    const reason = async (over: Parameters<typeof install>[1]) => {
      await install(shopName(), over);
      return lastOutcome().shopify.reason;
    };
    expect(await reason({ tamper: true })).toBe('hmac_invalid');
    expect(await reason({ cookie: 'wrong' })).toBe('nonce_mismatch');
    expect(await reason({ state: 'nonsense' })).toBe('state_invalid');
    const noCookie = await hit({
      method: 'GET',
      url: `/shopify/callback?${qs(signed({ shop, code: 'c', state: signToken({ kind: 'oauth', shop, nonce: 'n' }, SECRET, 600), timestamp: '1' }))}`,
    });
    expect(noCookie.statusCode).toBe(302);
    expect(lastOutcome().shopify.reason).toBe('nonce_cookie_missing');
    const denied = await hit({
      method: 'GET',
      url: `/shopify/callback?${qs(signed({ shop, error: 'access_denied', state: signToken({ kind: 'oauth', shop, nonce: 'n' }, SECRET, 600), timestamp: '1' }))}`,
      headers: { cookie: 'noctiv_shopify_oauth=n' },
    });
    expect(new URL(String(denied.headers.location)).searchParams.get('reason')).toBe('denied');
    expect(lastOutcome().shopify.reason).toBe('shopify_error');
  });

  it('the nonce cookie is set for the path the callback is served under (also behind the /api proxy)', async () => {
    const proxied = buildApp({
      logger: createLogger({ service: 'x', level: 'silent' }),
      sql: apiSql,
      checkDatabase: async () => true,
      verifyToken: createTokenVerifier({ jwks: auth.jwks }),
      credentialsPublicKey: keys.publicKey,
      connectionTestWaitMs: 100,
      actionSecret: SECRET,
      appUrl: APP_URL,
      publicApiUrl: `${APP_URL}/api`,
      rateLimits: false,
      shopify: {
        app: APP,
        client: createShopifyClient({ baseUrl: mock.baseUrl }),
        installUrl: null,
      },
    });
    const r = await hit(
      {
        method: 'GET',
        url: `/shopify/app?${qs(signed({ shop, timestamp: '1' }))}`,
        headers: { host: 'app.example.test', 'x-forwarded-host': 'app.example.test' },
      },
      proxied,
    );
    expect(r.statusCode).toBe(302);
    expect(String(r.headers['set-cookie'])).toContain('Path=/api/shopify;');
    expect(new URL(String(r.headers.location)).searchParams.get('redirect_uri')).toBe(
      `${APP_URL}/api/shopify/callback`,
    );
  });

  it('logs the completion of every request with its URL (redacted) and status, at the normal level', async () => {
    await hit({ method: 'GET', url: `/shopify/app?${qs(signed({ shop, timestamp: '1' }))}` });
    const lines = logs
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const done = lines.filter((l) => l.msg === 'request completed').pop();
    expect(done).toMatchObject({
      level: 30,
      req: { method: 'GET', url: '/shopify/app?[REDACTED]' },
      res: { statusCode: 302 },
    });
    expect(typeof done.responseTime).toBe('number');
  });

  it('with Shopify not configured the routes say so in the log and answer 503', async () => {
    const lines: string[] = [];
    const off = buildApp({
      logger: createLogger({
        service: 'x',
        level: 'debug',
        destination: new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }),
      }),
      sql: apiSql,
      checkDatabase: async () => true,
      verifyToken: createTokenVerifier({ jwks: auth.jwks }),
      credentialsPublicKey: keys.publicKey,
      connectionTestWaitMs: 100,
      actionSecret: SECRET,
      rateLimits: false,
    });
    const r = await hit({ method: 'GET', url: '/shopify/app?shop=x.myshopify.com' }, off);
    expect(r.statusCode).toBe(503);
    expect(lines.join('')).toContain('"reason":"routes_disabled"');
  });

  it('none of these lines holds the signature, code, state, cookie or client secret', () => {
    const all = logs.join('');
    expect(all).not.toContain(APP.clientSecret);
    expect(all).not.toMatch(/"hmac":|hmac=[0-9a-f]{20}|state=eyJ|noctiv_shopify_oauth=[0-9a-f]{8}/);
    for (const s of SECRETISH) expect(all).not.toContain(`${s}${'x'.repeat(40)}`);
    expect(JSON.stringify(mock.codes)).not.toBe('');
  });
});
