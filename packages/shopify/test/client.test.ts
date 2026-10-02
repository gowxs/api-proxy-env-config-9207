import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsForModel, toFacts, OrderLookupError } from '@noctiv/orders';
import {
  accessNeedsRefresh,
  authorizeUrl,
  checkScopes,
  createShopifyClient,
  normalizeShopDomain,
  ShopifyError,
  signToken,
  verifyQueryHmac,
  verifyToken,
  verifyWebhookHmac,
} from '../src/index.ts';
import { createHmac } from 'node:crypto';
import { startMockShopify } from './mock-shopify.ts';

let mock: Awaited<ReturnType<typeof startMockShopify>>;
beforeAll(async () => {
  mock = await startMockShopify({ clientId: 'cid-1', clientSecret: 'shpss_unit_secret_9999' });
});
afterAll(() => mock.close());

const TOKEN = 'shpat_test_0123456789abcdef0123456789abcdef';
const APP = { clientId: 'cid-1', clientSecret: 'shpss_unit_secret_9999' };
const SHOP = 'noctiv-nvojutjr.myshopify.com';
const client = (extra = {}) => createShopifyClient({ baseUrl: mock.baseUrl, ...extra });
const orders = () => client().orders(SHOP, TOKEN);

describe('shop domain', () => {
  it.each([
    ['noctiv-nvojutjr', SHOP],
    ['Noctiv-NVOJUTJR.myshopify.com', SHOP],
    ['https://noctiv-nvojutjr.myshopify.com/admin', SHOP],
  ])('%s', (input, out) => expect(normalizeShopDomain(input)).toBe(out));
  it.each([
    'evil.example.com',
    'shop.myshopify.com.evil.test',
    '127.0.0.1:3000',
    'a b.myshopify.com',
    '',
  ])('rejects %j (never a request to another host)', (input) =>
    expect(normalizeShopDomain(input)).toBeNull(),
  );
  it('a lookup for another host is refused before any request', () => {
    const before = mock.requests.length;
    expect(() => client().orders('evil.example.com', TOKEN)).toThrow(ShopifyError);
    expect(mock.requests.length).toBe(before);
  });
});

describe('reading orders (neutral shape)', () => {
  it('finds an order by number with the facts the reply needs', async () => {
    const [o] = await orders().findByNumber('1002');
    expect(o).toMatchObject({
      name: '#1002',
      email: 'gowxs612@gmail.com',
      payment: 'paid',
      fulfillment: 'shipped',
    });
    expect(o!.shipments[0]).toMatchObject({
      carrier: 'Latvijas Pasts',
      trackingNumber: 'LV987654321',
    });
  });
  it('maps the other development-store orders', async () => {
    const [o3] = await orders().findByNumber('1003');
    expect(o3).toMatchObject({ payment: 'paid', fulfillment: 'not_shipped', shipments: [] });
    const [o4] = await orders().findByNumber('1004');
    expect(o4!.cancelledAt).not.toBeNull();
    expect(o4!.payment).toBe('refunded');
  });
  it('finds orders by e-mail address', async () => {
    const found = await orders().findByEmail('gowxs612@gmail.com');
    expect(found.map((o) => o.name).sort()).toEqual(['#1002', '#1003', '#1004']);
  });
  it('returns nothing for an unknown number and refuses odd input without a request', async () => {
    const before = mock.requests.length;
    const p = orders();
    expect(await p.findByNumber('9999')).toEqual([]);
    expect(await p.findByNumber('1002 OR name:*')).toEqual([]);
    expect(await p.findByEmail('a@b.c" OR email:*')).toEqual([]);
    expect(mock.requests.length - before).toBe(2);
  });
  it('the facts for the model hold no address, e-mail or amount', async () => {
    const [o] = await orders().findByNumber('1002');
    const text = factsForModel(toFacts(o!));
    expect(text).toContain('Order #1002');
    expect(text).toContain('tracking number: LV987654321');
    expect(text).toContain('Lavender candle x2');
    for (const s of ['gowxs612', '@', 'EUR', '€']) expect(text).not.toContain(s);
  });
  it('a non-https tracking link is dropped', () => {
    const f = toFacts({
      name: '#1',
      createdAt: '2026-10-01T00:00:00Z',
      cancelledAt: null,
      email: null,
      customerEmail: null,
      payment: 'paid',
      fulfillment: 'shipped',
      fulfillmentDetail: null,
      shipments: [
        {
          createdAt: null,
          carrier: null,
          trackingNumber: 'X1',
          trackingUrl: 'javascript:alert(1)',
          estimatedDeliveryAt: null,
          deliveredAt: null,
          inTransitAt: null,
          items: [],
        },
      ],
    });
    expect(f.shipments[0]!.trackingUrl).toBeNull();
  });
});

describe('it only ever reads', () => {
  it('every GraphQL request is a query; no mutation is ever sent', async () => {
    const c = client();
    await c.shopInfo(SHOP, TOKEN);
    await c.orders(SHOP, TOKEN).findByNumber('1003');
    await c.orders(SHOP, TOKEN).findByEmail('gowxs612@gmail.com');
    const gql = mock.requests.filter((r) => r.path.includes('graphql'));
    expect(gql.length).toBeGreaterThan(3);
    for (const r of gql) {
      expect(JSON.parse(r.body).query.trimStart()).toMatch(/^(query\b|\{)/);
      expect(r.body).not.toMatch(/mutation/i);
    }
  });
  it('write scopes are refused, read_orders is required', () => {
    expect(() => checkScopes(['read_orders'])).not.toThrow();
    expect(() => checkScopes(['read_orders', 'read_all_orders', 'read_customers'])).not.toThrow();
    expect(() => checkScopes(['read_orders', 'write_orders'])).toThrowError(
      expect.objectContaining({ code: 'WRITE_SCOPES' }),
    );
    expect(() => checkScopes(['read_products'])).toThrowError(
      expect.objectContaining({ code: 'MISSING_SCOPE' }),
    );
  });
});

describe('OAuth: code exchange and refresh (expiring offline tokens)', () => {
  it('exchanges an authorization code for an expiring token pair, once', async () => {
    const code = mock.newCode();
    const t = await client().exchangeCode(SHOP, APP, code);
    expect(t.accessToken).toMatch(/^shpat_minted_/);
    expect(t.refreshToken).toMatch(/^shprt_minted_/);
    expect(t.scopes).toEqual(['read_orders']);
    expect(Date.parse(t.accessExpiresAt!) - Date.now()).toBeGreaterThan(3500_000);
    expect(Date.parse(t.refreshExpiresAt!) - Date.now()).toBeGreaterThan(80 * 86400_000);
    // The exchange asks for expiring tokens, as new public apps must.
    const req = mock.requests.filter((r) => r.path === '/admin/oauth/access_token').at(-1)!;
    expect(new URLSearchParams(req.body).get('expiring')).toBe('1');
    await expect(client().exchangeCode(SHOP, APP, code)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
  it('refreshing returns a new access token AND a new refresh token; the old refresh token is spent', async () => {
    const first = await client().exchangeCode(SHOP, APP, mock.newCode());
    const next = await client().refresh(SHOP, APP, first.refreshToken!);
    expect(next.accessToken).not.toBe(first.accessToken);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    await expect(client().refresh(SHOP, APP, first.refreshToken!)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    const [o] = await client().orders(SHOP, next.accessToken).findByNumber('1002');
    expect(o?.name).toBe('#1002');
  });
  it('wrong app secret fails with a code and the secret is not in the error', async () => {
    const err = await client()
      .exchangeCode(
        SHOP,
        { clientId: 'cid-1', clientSecret: 'shpss_wrong_secret_000' },
        mock.newCode(),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyError);
    const shown = [String(err), JSON.stringify(err), (err as Error).stack ?? ''].join('\n');
    expect(shown).not.toContain('wrong_secret');
  });
  it('uninstalling revokes the token', async () => {
    const t = await client().exchangeCode(SHOP, APP, mock.newCode());
    await client().revoke(SHOP, t.accessToken);
    await expect(client().orders(SHOP, t.accessToken).findByNumber('1002')).rejects.toMatchObject({
      code: 'AUTH',
    });
  });
  it('knows when a token needs refreshing', () => {
    const t = (accessExpiresAt: string | null, refreshToken: string | null = 'r') => ({
      accessToken: 'a',
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt: null,
    });
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(accessNeedsRefresh(t('2026-10-02T13:00:00Z'), now)).toBe(false);
    expect(accessNeedsRefresh(t('2026-10-02T12:03:00Z'), now)).toBe(true);
    expect(accessNeedsRefresh(t(null), now)).toBe(true);
    expect(accessNeedsRefresh(t(null, null), now)).toBe(false);
  });
});

describe('signatures', () => {
  const SECRET = 'shpss_unit_secret_9999';
  const sign = (q: Record<string, string>) => {
    const msg = Object.keys(q)
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join('&');
    return createHmac('sha256', SECRET).update(msg).digest('hex');
  };
  it("accepts Shopify's query signature and rejects tampering", () => {
    const q = { shop: SHOP, timestamp: '1790000000', code: 'abc', state: 's1' };
    expect(verifyQueryHmac({ ...q, hmac: sign(q) }, SECRET)).toBe(true);
    expect(verifyQueryHmac({ ...q, shop: 'evil.myshopify.com', hmac: sign(q) }, SECRET)).toBe(
      false,
    );
    expect(verifyQueryHmac({ ...q }, SECRET)).toBe(false);
    expect(verifyQueryHmac({ ...q, hmac: sign(q) }, 'other')).toBe(false);
  });
  it('accepts a webhook signature over the raw body only', () => {
    const body = JSON.stringify({ shop_domain: SHOP });
    const h = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyWebhookHmac(Buffer.from(body), h, SECRET)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from(body + ' '), h, SECRET)).toBe(false);
    expect(verifyWebhookHmac(Buffer.from(body), undefined, SECRET)).toBe(false);
  });
  it('state and claim tokens expire and cannot be forged', () => {
    const t = signToken({ shop: SHOP, nonce: 'n' }, 'secret', 60, 1_000_000);
    expect(verifyToken(t, 'secret', 1_000_000 + 30_000)).toMatchObject({ shop: SHOP, nonce: 'n' });
    expect(verifyToken(t, 'secret', 1_000_000 + 61_000)).toBeNull();
    expect(verifyToken(t, 'other', 1_000_000)).toBeNull();
    const [b, m] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ shop: 'evil.myshopify.com', exp: 9e9 })).toString(
      'base64url',
    );
    expect(verifyToken(`${forged}.${m}`, 'secret', 1_000_000)).toBeNull();
    expect(b).toBeTruthy();
  });
  it('the authorize URL asks for read_orders only', () => {
    const u = new URL(
      authorizeUrl({
        shop: SHOP,
        clientId: 'cid',
        redirectUri: 'https://api.example.test/shopify/callback',
        state: 's',
      }),
    );
    expect(u.host).toBe(SHOP);
    expect(u.searchParams.get('scope')).toBe('read_orders');
    expect(u.searchParams.get('scope')).not.toMatch(/write_/);
  });
});

describe('failures', () => {
  it('retries once on a server error', async () => {
    mock.failNext(503, 1);
    const [o] = await orders().findByNumber('1002');
    expect(o?.name).toBe('#1002');
  });
  it('gives up with an UNAVAILABLE lookup error after two failures', async () => {
    mock.failNext(500, 2);
    await expect(orders().findByNumber('1002')).rejects.toBeInstanceOf(OrderLookupError);
    mock.failNext(500, 2);
    await expect(orders().findByNumber('1002')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('a token Shopify no longer accepts is an AUTH lookup error', async () => {
    await expect(
      client().orders(SHOP, 'shpat_wrong_token_value_000').findByNumber('1002'),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });
  it('an app without read_orders is a SCOPE lookup error', async () => {
    const saved = mock.scopes;
    mock.scopes = ['read_products'];
    try {
      await expect(orders().findByNumber('1002')).rejects.toMatchObject({ code: 'SCOPE' });
    } finally {
      mock.scopes = saved;
    }
  });
});
