import { randomUUID } from 'node:crypto';
import { createLogger, generateSealingKeyPair, waitlistToken } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
const SECRET = 'waitlist-test-secret-0123456789abcdef';
const EXPORT = 'export-token-0123456789abcdef-0123456789';
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: generateSealingKeyPair().publicKey,
    connectionTestWaitMs: 1_000,
    actionSecret: SECRET,
    waitlistExportToken: EXPORT,
    rateLimits: false,
  });
  A = await seedTenant(owner, 'waitlist-a', { embeddingAxis: 180 });
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

const form = (fields: [string, string][]) =>
  app.inject({
    method: 'POST',
    url: '/waitlist',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
const row = async (email: string) =>
  (
    await owner<
      {
        id: string;
        integrations: string[];
        status: string;
        source: string;
        ip_hash: string | null;
        confirmation_due: boolean;
      }[]
    >`select id, integrations, status, source, ip_hash, confirmation_due
      from marketing.waitlist where email = ${email}`
  )[0];

describe('public sign-up form', () => {
  it('signs up with consent, stores a hashed IP and queues one confirmation', async () => {
    const email = `wl-${randomUUID()}@example.test`;
    const r = await form([
      ['email', email.toUpperCase()],
      ['integration', 'xero'],
      ['integration', 'shopify'],
      ['source', 'integrations-xero'],
      ['consent', 'yes'],
      ['website', ''],
    ]);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Check your inbox');
    expect(r.body).toContain('https://noctiv.io/integrations/');
    const w = await row(email);
    expect(w).toMatchObject({
      integrations: ['xero', 'shopify'],
      status: 'pending',
      source: 'integrations-xero',
      confirmation_due: true,
    });
    expect(w!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w!.ip_hash).not.toContain('127.0.0.1');

    // Signing up again adds the choice; no second e-mail within a day once one went out.
    await owner`update marketing.waitlist set confirmation_due = false, confirmation_sent_at = now()
                where id = ${w!.id}`;
    await form([
      ['email', email],
      ['integration', 'quickbooks'],
      ['consent', 'yes'],
    ]);
    expect(await row(email)).toMatchObject({
      integrations: ['quickbooks', 'shopify', 'xero'],
      confirmation_due: false,
    });
  });

  it('refuses a missing consent, a bad address, an unknown integration', async () => {
    const email = `wl-${randomUUID()}@example.test`;
    const noConsent = await form([
      ['email', email],
      ['integration', 'xero'],
    ]);
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.body).toContain('Notify me when this is ready');
    expect(
      (
        await form([
          ['email', 'not-an-address'],
          ['integration', 'xero'],
          ['consent', 'yes'],
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await form([
          ['email', email],
          ['integration', 'sage'],
          ['consent', 'yes'],
        ])
      ).statusCode,
    ).toBe(400);
    expect(await row(email)).toBeUndefined();
  });

  it('ignores bots that fill the hidden field', async () => {
    const email = `wl-${randomUUID()}@example.test`;
    const r = await form([
      ['email', email],
      ['integration', 'xero'],
      ['consent', 'yes'],
      ['website', 'http://spam.test'],
    ]);
    expect(r.statusCode).toBe(200);
    expect(await row(email)).toBeUndefined();
  });
});

describe('confirm and unsubscribe links', () => {
  it('a link only shows a button; the button confirms; unsubscribe works after', async () => {
    const email = `wl-${randomUUID()}@example.test`;
    await form([
      ['email', email],
      ['integration', 'woocommerce'],
      ['consent', 'yes'],
    ]);
    const { id } = (await row(email))!;
    const confirm = `/waitlist/confirm/${id}/${waitlistToken(id, 'confirm', SECRET)}`;
    const get = await app.inject({ method: 'GET', url: confirm });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('<form method="post"');
    expect((await row(email))!.status).toBe('pending');

    // A token for the other action or another id is refused.
    const wrong = `/waitlist/confirm/${id}/${waitlistToken(id, 'unsubscribe', SECRET)}`;
    expect((await app.inject({ method: 'POST', url: wrong })).statusCode).toBe(404);
    const other = `/waitlist/confirm/${randomUUID()}/${waitlistToken(id, 'confirm', SECRET)}`;
    expect((await app.inject({ method: 'POST', url: other })).statusCode).toBe(404);

    const post = await app.inject({ method: 'POST', url: confirm });
    expect(post.body).toContain('Confirmed');
    expect((await row(email))!.status).toBe('confirmed');

    // One-click unsubscribe (RFC 8058 posts the form body).
    const unsub = await app.inject({
      method: 'POST',
      url: `/waitlist/unsubscribe/${id}/${waitlistToken(id, 'unsubscribe', SECRET)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(unsub.body).toContain('Unsubscribed');
    expect((await row(email))!.status).toBe('unsubscribed');
    // An old confirm link cannot re-subscribe.
    await app.inject({ method: 'POST', url: confirm });
    expect((await row(email))!.status).toBe('unsubscribed');
  });
});

describe('settings and export', () => {
  it('per-tenant notify me, and the CSV export behind the token', async () => {
    const token = await auth.token(A.userId);
    const patch = (body: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${A.tenantId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: body as object,
      });
    expect((await patch({ integrationsNotify: ['sage'] })).statusCode).toBe(400);
    expect((await patch({ integrationsNotify: ['shopify', 'xero', 'xero'] })).statusCode).toBe(200);
    const t = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${A.tenantId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(t.json().integrations_notify).toEqual(['xero', 'shopify']);

    const confirmed = `wl-${randomUUID()}@example.test`;
    const pending = `wl-${randomUUID()}@example.test`;
    for (const e of [confirmed, pending])
      await form([
        ['email', e],
        ['integration', 'zoho_books'],
        ['consent', 'yes'],
      ]);
    const { id } = (await row(confirmed))!;
    await app.inject({
      method: 'POST',
      url: `/waitlist/confirm/${id}/${waitlistToken(id, 'confirm', SECRET)}`,
    });

    expect((await app.inject({ method: 'GET', url: '/admin/waitlist.csv' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/waitlist.csv',
          headers: { authorization: `Bearer ${EXPORT.slice(0, -1)}x` },
        })
      ).statusCode,
    ).toBe(401);
    const csv = await app.inject({
      method: 'GET',
      url: '/admin/waitlist.csv',
      headers: { authorization: `Bearer ${EXPORT}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe(
      'email,integrations,source,status,created_at,confirmed_at',
    );
    expect(csv.body).toContain(`${confirmed},zoho_books,integrations,confirmed,`);
    expect(csv.body).not.toContain(pending);
    const [u] = await owner<
      { email: string }[]
    >`select email from auth.users where id = ${A.userId}`;
    expect(csv.body).toContain(`${u!.email},xero shopify,app,confirmed,`);
  });
});
