import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { JobRunner, withTenant } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { openMailboxPassword } from '@noctiv/mail';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connectionTestHandler } from '../../worker/src/jobs/connection-test.ts';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { CONNECTION_TEST_QUEUE } from '../src/routes/connections.ts';
import { testAuth } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
const workerSql = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
const keys = generateSealingKeyPair();

let A: SeededTenant;
let B: SeededTenant;
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
const runner = new JobRunner({
  sql: workerSql,
  pollMs: 100,
  handlers: { [CONNECTION_TEST_QUEUE]: connectionTestHandler({ keys, allowInsecure: true }) },
});

beforeAll(async () => {
  A = await seedTenant(owner, 'api-a', { embeddingAxis: 30 });
  B = await seedTenant(owner, 'api-b', { embeddingAxis: 31 });
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: keys.publicKey,
    connectionTestWaitMs: 15_000,
  });
  runner.start();
});
afterAll(async () => {
  await runner.stop();
  await Promise.all([owner.end(), apiSql.end(), workerSql.end()]);
});

const greenmailBody = (address: string, password: string) => ({
  provider: 'generic',
  emailAddress: address,
  password,
  imap: { host: gm.host, port: gm.imapPort, secure: false },
  smtp: { host: gm.host, port: gm.smtpPort, security: 'starttls' },
});

async function post(url: string, userId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    payload: body as object,
  });
}

describe('connection wizard API (GreenMail)', () => {
  let testId: string;

  it('tests a mailbox live through the worker and returns a test id', async () => {
    const res = await post(
      `/v1/tenants/${A.tenantId}/connections/test`,
      A.userId,
      greenmailBody(GREENMAIL_USERS.shopA.address, GREENMAIL_USERS.shopA.password),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', sentAppendMode: 'none' });
    testId = res.json().testId;
  });

  it('never puts the password in the job queue in plain text', async () => {
    const [job] = await owner<
      { payload: unknown; result: unknown }[]
    >`select payload, result from public.jobs where id = ${testId}`;
    expect(JSON.stringify(job)).not.toContain(GREENMAIL_USERS.shopA.password);
  });

  it('saves the tested mailbox with sealed credentials the worker (only) can open', async () => {
    const res = await post(`/v1/tenants/${A.tenantId}/connections`, A.userId, { testId });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const [row] = await owner<
      { credentials_ciphertext: Buffer; status: string; inbox_last_uid: string }[]
    >`
      select credentials_ciphertext, status, inbox_last_uid from public.email_connections where id = ${id}`;
    expect(row?.status).toBe('connected');
    expect(row?.credentials_ciphertext.includes(Buffer.from(GREENMAIL_USERS.shopA.password))).toBe(
      false,
    );
    expect(openMailboxPassword(row!.credentials_ciphertext, keys, A.tenantId, id)).toBe(
      GREENMAIL_USERS.shopA.password,
    );
    // Bound to its tenant: the same ciphertext is useless for tenant B.
    expect(() => openMailboxPassword(row!.credentials_ciphertext, keys, B.tenantId, id)).toThrow();
  });

  it('does not save the same test twice', async () => {
    expect(
      (await post(`/v1/tenants/${A.tenantId}/connections`, A.userId, { testId })).statusCode,
    ).toBe(409);
  });

  it('lists connections without credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${A.tenantId}/connections`,
      headers: { authorization: `Bearer ${await auth.token(A.userId)}` },
    });
    const list = res.json() as Record<string, unknown>[];
    expect(list.some((c) => c.email_address === GREENMAIL_USERS.shopA.address)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/ciphertext|credentials/);
  });

  it('explains a wrong password and refuses to save that test', async () => {
    const res = await post(
      `/v1/tenants/${A.tenantId}/connections/test`,
      A.userId,
      greenmailBody(GREENMAIL_USERS.shopB.address, 'wrong'),
    );
    expect(res.json()).toMatchObject({ status: 'failed', code: 'AUTH_FAILED', stage: 'imap' });
    const [failed] = await owner<{ id: string }[]>`
      select id from public.jobs where tenant_id = ${A.tenantId} and queue = ${CONNECTION_TEST_QUEUE} order by created_at desc limit 1`;
    expect(
      (await post(`/v1/tenants/${A.tenantId}/connections`, A.userId, { testId: failed!.id }))
        .statusCode,
    ).toBe(409);
  });

  it('answers Outlook addresses without contacting any server', async () => {
    const res = await post(`/v1/tenants/${A.tenantId}/connections/test`, A.userId, {
      ...greenmailBody('a@hotmail.com', 'x'),
      provider: 'outlook',
    });
    expect(res.json()).toMatchObject({ status: 'failed', code: 'PROVIDER_UNSUPPORTED' });
  });

  it("refuses users who are not members of the tenant, and tokens it didn't issue", async () => {
    expect(
      (
        await post(
          `/v1/tenants/${A.tenantId}/connections/test`,
          B.userId,
          greenmailBody('x@y.test', 'p'),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(`/v1/tenants/${B.tenantId}/connections`, A.userId, { testId })).statusCode,
    ).toBe(403);
    const other = await testAuth();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${A.tenantId}/connections`,
      headers: { authorization: `Bearer ${await other.token(A.userId)}` },
      payload: { testId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("tenant B cannot save tenant A's test", async () => {
    const res = await post(`/v1/tenants/${B.tenantId}/connections`, B.userId, { testId });
    expect(res.statusCode).toBe(404);
  });

  it('validates input', async () => {
    const res = await post(`/v1/tenants/${A.tenantId}/connections/test`, A.userId, {
      provider: 'generic',
      emailAddress: 'nope',
    });
    expect(res.statusCode).toBe(400);
    const cnt = await withTenant(
      apiSql,
      A.tenantId,
      (tx) => tx`select 1 from public.tenant_members where user_id = ${A.userId}`,
    );
    expect(cnt).toHaveLength(1);
  });
});

describe('reconnecting a disconnected mailbox', () => {
  it('keeps the connection (and its history), with new sealed credentials', async () => {
    const [c] = await owner<{ id: string }[]>`
      select id from public.email_connections where tenant_id = ${A.tenantId} and email_address = ${GREENMAIL_USERS.shopA.address}`;
    await owner`update public.email_connections set status = 'disconnected', last_error_code = 'AUTH_FAILED' where id = ${c!.id}`;
    const test = await post(`/v1/tenants/${A.tenantId}/connections/test`, A.userId, {
      ...greenmailBody(GREENMAIL_USERS.shopA.address, GREENMAIL_USERS.shopA.password),
      reconnectId: c!.id,
    });
    expect(test.json()).toMatchObject({ status: 'ok' });
    const saved = await post(`/v1/tenants/${A.tenantId}/connections`, A.userId, {
      testId: test.json().testId,
    });
    expect(saved.json()).toEqual({ id: c!.id, status: 'connected' });
    const [row] = await owner<
      { status: string; last_error_code: string | null; credentials_ciphertext: Buffer }[]
    >`
      select status, last_error_code, credentials_ciphertext from public.email_connections where id = ${c!.id}`;
    expect(row).toMatchObject({ status: 'connected', last_error_code: null });
    expect(openMailboxPassword(row!.credentials_ciphertext, keys, A.tenantId, c!.id)).toBe(
      GREENMAIL_USERS.shopA.password,
    );
  });

  it("cannot reconnect another tenant's mailbox or a different address", async () => {
    const [bConn] = await owner<
      { id: string }[]
    >`select id from public.email_connections where tenant_id = ${B.tenantId} limit 1`;
    const res = await post(`/v1/tenants/${A.tenantId}/connections/test`, A.userId, {
      ...greenmailBody(GREENMAIL_USERS.shopA.address, GREENMAIL_USERS.shopA.password),
      reconnectId: bConn!.id,
    });
    expect(res.statusCode).toBe(404);
  });
});
