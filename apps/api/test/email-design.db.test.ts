import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import sharp from 'sharp';
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
  // These businesses use a logo address; the uploaded logo is tested on its own below.
  await owner`delete from public.tenant_logos where tenant_id in (${A.tenantId}, ${B.tenantId})`;
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(
  method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE',
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

describe('uploaded logo (Your brand)', () => {
  const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#3B2FD0' } })
      .png()
      .toBuffer();

  it('PNG, JPG or SVG up to 500 KB, stored as PNG of at most 400 px; used first; removable', async () => {
    const big = await png(1200, 300);
    const up = await call('PUT', A, '/brand/logo', { data: big.toString('base64') });
    expect(up.status).toBe(200);
    expect(up.json.logo).toMatchObject({ width: 400, height: 100, sourceType: 'png' });
    const [row] = await owner<{ width: number; bytes: number }[]>`
      select width, octet_length(png) as bytes from public.tenant_logos where tenant_id = ${A.tenantId}`;
    expect(row!.width).toBe(400);

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0A7"/></svg>';
    const s = await call('PUT', A, '/brand/logo', { data: Buffer.from(svg).toString('base64') });
    // A vector logo is rendered sharp at 400 px.
    expect(s.json.logo).toMatchObject({ width: 400, height: 200, sourceType: 'svg' });

    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.evil.test/x.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      'GIF89a not a logo',
    ]) {
      const r = await call('PUT', A, '/brand/logo', { data: Buffer.from(bad).toString('base64') });
      expect(r.status).toBe(400);
    }
    const tooBig = Buffer.alloc(501 * 1024, 1);
    tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      (await call('PUT', A, '/brand/logo', { data: tooBig.toString('base64') })).json.error,
    ).toContain('500 KB');

    // The uploaded logo is used before the logo address, inside the e-mail (cid) and in the preview.
    await call('PUT', A, '/brand/logo', { data: big.toString('base64') });
    const prev = await call('POST', A, '/email-design/preview', { emailTemplate: 'logo' });
    expect(prev.json.html).toContain('<img src="data:image/png;base64,');
    expect(prev.json.html).not.toContain('nordlicht.test/logo.png');
    expect((await call('GET', A, '/brand/logo')).json.logo.width).toBe(400);
    // Another business sees nothing of it.
    expect((await call('GET', B, '/brand/logo')).json.logo).toBeNull();

    expect((await call('DELETE', A, '/brand/logo')).status).toBe(200);
    expect((await call('GET', A, '/brand/logo')).json.logo).toBeNull();
    const logs = await owner<{ action: string }[]>`
      select action from public.audit_log where tenant_id = ${A.tenantId} and action like 'brand.logo%'
      order by created_at`;
    expect(logs.at(-1)!.action).toBe('brand.logo_removed');
  });

  it('no logo: the company name in the brand colour, darkened when too light', async () => {
    const dark = await call('POST', A, '/email-design/preview', {
      emailTemplate: 'logo',
      brandLogoUrl: '',
      brandCompanyName: 'Nordlicht',
      brandColor: '#8A1F5C',
    });
    expect(dark.json.html).toContain('font-weight:700;color:#8A1F5C">Nordlicht</p>');
    const light = await call('POST', A, '/email-design/preview', {
      emailTemplate: 'logo',
      brandLogoUrl: '',
      brandCompanyName: 'Nordlicht',
      brandColor: '#FFE066',
    });
    expect(light.json.html).toContain('font-weight:700;color:#2F3A56">Nordlicht</p>');
  });
});
