import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;

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
  });
  A = await seedTenant(owner, 'design-a', { embeddingAxis: 130 });
  B = await seedTenant(owner, 'design-b', { embeddingAxis: 131 });
  // A's knowledge base mentions its own site; B's mentions another one.
  await owner`insert into public.kb_allowlist (tenant_id, source_id, kind, value)
              values (${A.tenantId}, ${A.sourceId}, 'domain', 'nordlicht.test')`;
  await owner`insert into public.kb_allowlist (tenant_id, source_id, kind, value)
              values (${B.tenantId}, ${B.sourceId}, 'domain', 'other-shop.test')`;
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(
  method: 'GET' | 'PATCH' | 'POST',
  s: SeededTenant,
  path: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/v1/tenants/${s.tenantId}${path}`,
    headers: { authorization: `Bearer ${await auth.token(s.userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

describe('e-mail design settings', () => {
  it('new businesses send plain text', async () => {
    expect((await call('GET', A, '')).json).toMatchObject({
      email_template: 'plain',
      brand_logo_url: null,
      brand_social_links: [],
    });
  });

  it('saves a design with a logo from the business’s own (allowlisted) site', async () => {
    const r = await call('PATCH', A, '', {
      emailTemplate: 'card',
      brandCompanyName: 'Nordlicht Candles',
      brandLogoUrl: 'https://nordlicht.test/logo.png',
      brandColor: '#b4532a',
      brandWebsite: 'https://nordlicht.test',
      brandPhone: '+371 2000 0000',
      brandAddress: 'Brīvības iela 1, Rīga',
      brandSocialLinks: ['https://instagram.com/nordlicht'],
    });
    expect(r.status).toBe(200);
    expect((await call('GET', A, '')).json).toMatchObject({
      email_template: 'card',
      brand_logo_url: 'https://nordlicht.test/logo.png',
      brand_color: '#B4532A',
      brand_social_links: ['https://instagram.com/nordlicht'],
    });
  });

  it('refuses a logo from a site that is not in the knowledge base', async () => {
    for (const url of ['https://tracker.evil.test/pixel.png', 'https://other-shop.test/logo.png']) {
      const r = await call('PATCH', A, '', { brandLogoUrl: url });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/logo from your own website/);
    }
    // Another tenant's allowlist does not count.
    expect(
      (await call('PATCH', B, '', { brandLogoUrl: 'https://nordlicht.test/logo.png' })).status,
    ).toBe(400);
    expect(
      (await call('PATCH', A, '', { brandLogoUrl: 'http://nordlicht.test/logo.png' })).status,
    ).toBe(400);
    expect((await call('GET', A, '')).json.brand_logo_url).toBe('https://nordlicht.test/logo.png');
  });

  it('validates the other fields', async () => {
    expect((await call('PATCH', A, '', { emailTemplate: 'fancy' })).status).toBe(400);
    expect((await call('PATCH', A, '', { brandColor: 'red' })).status).toBe(400);
    const four = Array.from({ length: 4 }, (_, i) => `https://instagram.com/n${i}`);
    expect((await call('PATCH', A, '', { brandSocialLinks: four })).status).toBe(400);
    expect((await call('PATCH', A, '', { brandWebsite: 'javascript:alert(1)' })).status).toBe(400);
    // Empty strings clear a field.
    expect((await call('PATCH', A, '', { brandPhone: '' })).status).toBe(200);
    expect((await call('GET', A, '')).json.brand_phone).toBeNull();
  });

  it('previews unsaved values over the saved ones, as the worker would send them', async () => {
    const r = await call('POST', A, '/email-design/preview', {
      emailTemplate: 'branded',
      brandColor: '#2A3566',
    });
    expect(r.status).toBe(200);
    expect(r.json.html).toContain('background:#2A3566');
    expect(r.json.html).toContain('<img src="https://nordlicht.test/logo.png"');
    expect(r.json.text).toContain('the lavender candle is in stock');
    expect(r.json.logo).toBe('shown');

    const blocked = await call('POST', A, '/email-design/preview', {
      emailTemplate: 'logo',
      brandLogoUrl: 'https://tracker.evil.test/pixel.png',
    });
    expect(blocked.json.logo).toBe('blocked');
    expect(blocked.json.html).not.toContain('evil.test');
    expect(blocked.json.logoMessage).toMatch(/own website/);

    const plain = await call('POST', A, '/email-design/preview', { emailTemplate: 'plain' });
    expect(plain.json.html).toBeNull();
  });
});
