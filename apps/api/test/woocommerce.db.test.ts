import { Writable } from 'node:stream';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createWooClient, openCredentials } from '@noctiv/woocommerce';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startMockWoo, type MockWoo } from '../../../packages/woocommerce/test/mock-woocommerce.ts';
import {
  woocommerceDisconnectHandler,
  woocommerceTestHandler,
} from '../../worker/src/jobs/woocommerce.ts';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
const workerSql = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
const KEY = 'ck_' + 'a1'.repeat(20);
const SECRET = 'cs_' + 'b2'.repeat(20);
const STORE = 'https://shop.example.com';
const keys = generateSealingKeyPair();

let mock: MockWoo;
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let client: ReturnType<typeof createWooClient>;
let A: SeededTenant;
let B: SeededTenant;
const logs: string[] = [];

async function seedBare(label: string, axis: number) {
  const t = await seedTenant(owner, label, { embeddingAxis: axis });
  await owner`delete from public.shopify_connections where tenant_id = ${t.tenantId}`;
  await owner`delete from public.woocommerce_connections where tenant_id = ${t.tenantId}`;
  return t;
}

beforeAll(async () => {
  mock = await startMockWoo({ consumerKey: KEY, consumerSecret: SECRET });
  client = createWooClient({ get: mock.get, rewrite: mock.rewrite });
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
    actionSecret: 'woo-test-action-secret-0123456789abcdef',
    appUrl: 'https://app.example.test',
    publicApiUrl: 'https://api.example.test',
    rateLimits: false,
    woo: client,
  });
  A = await seedBare('woo-a', 250);
  B = await seedBare('woo-b', 251);
});
afterAll(async () => {
  await mock.close();
  await Promise.all([owner.end(), apiSql.end(), workerSql.end()]);
});

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  userId: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined, raw: res.body };
}

async function runWorkerJobs(queue: string) {
  for (let i = 0; i < 60; i++) {
    const [job] = await owner<
      { id: string; tenant_id: string; payload: Record<string, unknown> }[]
    >`
      select id, tenant_id, payload from public.jobs where queue = ${queue} and status = 'queued' order by created_at limit 1`;
    if (job) {
      const deps = { sql: workerSql, keys, woo: client };
      const handler =
        queue === 'woocommerce.test'
          ? woocommerceTestHandler(deps)
          : woocommerceDisconnectHandler(deps);
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

const connect = (t: SeededTenant, over: Record<string, unknown> = {}) =>
  call('PUT', `/v1/tenants/${t.tenantId}/woocommerce`, t.userId, {
    storeUrl: STORE,
    consumerKey: KEY,
    consumerSecret: SECRET,
    ...over,
  });

describe('connecting a store', () => {
  it('refuses addresses that are not a public https store', async () => {
    for (const storeUrl of [
      'http://shop.example.com',
      'https://127.0.0.1',
      'localhost',
      'https://169.254.169.254',
    ]) {
      const r = await connect(A, { storeUrl });
      expect(r.status, storeUrl).toBe(422);
    }
    expect(
      await owner`select 1 from public.woocommerce_connections where tenant_id = ${A.tenantId}`,
    ).toHaveLength(0);
  });
  it('refuses keys that are not ck_/cs_ keys, and a key the store rejects', async () => {
    expect((await connect(A, { consumerKey: 'nope' })).status).toBe(422);
    const bad = await connect(A, { consumerSecret: 'cs_' + 'c3'.repeat(20) });
    expect(bad.status).toBe(422);
    expect(bad.json.error ?? bad.json.message).toMatch(/refused the key/i);
    expect(
      await owner`select 1 from public.woocommerce_connections where tenant_id = ${A.tenantId}`,
    ).toHaveLength(0);
  });
  it('checks the key, seals it, and never gives it back', async () => {
    const r = await connect(A);
    expect(r.json).toEqual({ status: 'ok', storeName: 'Nordlicht Candles', storeUrl: STORE });
    const [row] = await owner<
      { store_url: string; credentials_ciphertext: Buffer; status: string }[]
    >`
      select store_url, credentials_ciphertext, status from public.woocommerce_connections where tenant_id = ${A.tenantId}`;
    expect(row).toMatchObject({ store_url: STORE, status: 'connected' });
    // Sealed: the plain key is nowhere in the stored bytes, and only the worker's private key opens it.
    expect(row!.credentials_ciphertext.toString('latin1')).not.toContain(KEY);
    expect(openCredentials(row!.credentials_ciphertext, keys, STORE)).toEqual({
      consumerKey: KEY,
      consumerSecret: SECRET,
    });
    expect(() =>
      openCredentials(row!.credentials_ciphertext, keys, 'https://other.example.com'),
    ).toThrow();
    // The API role cannot read it back, and the status route shows no secret.
    await expect(
      apiSql`select credentials_ciphertext from public.woocommerce_connections`,
    ).rejects.toThrow();
    const status = await call('GET', `/v1/tenants/${A.tenantId}/woocommerce`, A.userId);
    expect(status.json).toMatchObject({
      configured: true,
      connection: { storeUrl: STORE, storeName: 'Nordlicht Candles', status: 'connected' },
    });
    expect(status.raw).not.toContain(KEY);
    expect(status.raw).not.toContain(SECRET);
    expect(mock.requests.every((x) => x.method === 'GET')).toBe(true);
  });
  it('only a member of the business can connect, and the other business sees nothing', async () => {
    expect(
      (
        await connect(A, {}).then(() =>
          call('PUT', `/v1/tenants/${A.tenantId}/woocommerce`, B.userId, {
            storeUrl: STORE,
            consumerKey: KEY,
            consumerSecret: SECRET,
          }),
        )
      ).status,
    ).toBe(403);
    const s = await call('GET', `/v1/tenants/${B.tenantId}/woocommerce`, B.userId);
    expect(s.json.connection).toBeNull();
  });
  it('a business with Shopify connected cannot also connect WooCommerce', async () => {
    await owner`insert into public.shopify_connections (tenant_id, shop_domain, credentials_ciphertext, credentials_key_id)
                values (${B.tenantId}, 'woo-conflict.myshopify.com', ${Buffer.from('x')}, 'k')`;
    expect((await connect(B)).status).toBe(409);
    await owner`delete from public.shopify_connections where tenant_id = ${B.tenantId}`;
  });
  it('the key and secret never appear in the logs, on success or failure', async () => {
    await connect(A, { consumerSecret: 'cs_' + 'c3'.repeat(20) });
    await connect(A, { storeUrl: 'http://shop.example.com' });
    await connect(A);
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('c3c3c3c3');
    expect(all).not.toContain(Buffer.from(`${KEY}:${SECRET}`).toString('base64'));
  });
});

describe('test connection and disconnect', () => {
  it('"Test connection" asks the worker, which opens the key and reads the store', async () => {
    const [res] = await Promise.all([
      call('POST', `/v1/tenants/${A.tenantId}/woocommerce/test`, A.userId, {}),
      runWorkerJobs('woocommerce.test'),
    ]);
    expect(res.json).toEqual({ status: 'ok', storeName: 'Nordlicht Candles' });
  });
  it('reports a key the store no longer accepts, in plain words, and marks the connection', async () => {
    const original = mock.get;
    // The merchant deleted the key in WooCommerce.
    const revoked = createWooClient({
      get: async (url, h) =>
        original(url, {
          ...h,
          authorization: 'Basic ' + Buffer.from('ck_x:cs_x').toString('base64'),
        }),
      rewrite: mock.rewrite,
    });
    const deps = { sql: workerSql, keys, woo: revoked };
    const [res] = await Promise.all([
      call('POST', `/v1/tenants/${A.tenantId}/woocommerce/test`, A.userId, {}),
      (async () => {
        for (let i = 0; i < 60; i++) {
          const [job] = await owner<{ id: string; tenant_id: string }[]>`
            select id, tenant_id from public.jobs where queue = 'woocommerce.test' and status = 'queued' limit 1`;
          if (job) {
            const result = await woocommerceTestHandler(deps)({
              id: job.id,
              tenantId: job.tenant_id,
              queue: 'woocommerce.test',
              payload: {},
              attempts: 1,
              maxAttempts: 1,
            });
            await owner`update public.jobs set status = 'done', result = ${owner.json(result as never)} where id = ${job.id}`;
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
    ]);
    expect(res.json).toMatchObject({ status: 'failed', code: 'AUTH_FAILED' });
    expect(res.json.message).toMatch(/refused the key/i);
    const [c] =
      await owner`select status, last_error_code from public.woocommerce_connections where tenant_id = ${A.tenantId}`;
    expect(c).toMatchObject({ status: 'error', last_error_code: 'AUTH_FAILED' });
  });
  it('pasting a new key repairs the connection', async () => {
    expect((await connect(A)).status).toBe(200);
    const [c] =
      await owner`select status, last_error_code from public.woocommerce_connections where tenant_id = ${A.tenantId}`;
    expect(c).toMatchObject({ status: 'connected', last_error_code: null });
  });
  it('"Disconnect and delete keys" deletes the sealed pair and leaves an audit row', async () => {
    const [res] = await Promise.all([
      call('DELETE', `/v1/tenants/${A.tenantId}/woocommerce`, A.userId),
      runWorkerJobs('woocommerce.disconnect'),
    ]);
    expect(res.json).toEqual({ status: 'disconnected' });
    expect(
      await owner`select 1 from public.woocommerce_connections where tenant_id = ${A.tenantId}`,
    ).toHaveLength(0);
    const actions = await owner<
      { action: string }[]
    >`select action from public.audit_log where tenant_id = ${A.tenantId} and action like 'woocommerce.%'`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['woocommerce.connected', 'woocommerce.disconnected']),
    );
  });
  it('disconnect still deletes when the worker is slow', async () => {
    await connect(A);
    const r = await call('DELETE', `/v1/tenants/${A.tenantId}/woocommerce`, A.userId);
    expect(r.json).toEqual({ status: 'disconnected' });
    expect(
      await owner`select 1 from public.woocommerce_connections where tenant_id = ${A.tenantId}`,
    ).toHaveLength(0);
  });
});

describe('without a client the routes are off', () => {
  it('the status route says not configured', async () => {
    const off = buildApp({
      logger: createLogger({ service: 'x', level: 'silent' }),
      sql: apiSql,
      checkDatabase: async () => true,
      verifyToken: createTokenVerifier({ jwks: auth.jwks }),
      credentialsPublicKey: keys.publicKey,
      connectionTestWaitMs: 100,
      rateLimits: false,
    });
    const res = await off.inject({
      method: 'GET',
      url: `/v1/tenants/${A.tenantId}/woocommerce`,
      headers: { authorization: `Bearer ${await auth.token(A.userId)}` },
    });
    expect(res.json()).toMatchObject({ configured: false, connection: null });
  });
});
