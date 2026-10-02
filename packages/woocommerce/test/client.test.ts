import { decideOrder, OrderLookupError, parseOrderRefs, toFacts } from '@noctiv/orders';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWooClient, WooError, WOO_ERROR_MESSAGES } from '../src/client.ts';
import { trackingFromMeta, trackingFromNotes } from '../src/tracking.ts';
import { startMockWoo, type MockWoo } from './mock-woocommerce.ts';

const CREDS = { consumerKey: 'ck_' + 'a1'.repeat(20), consumerSecret: 'cs_' + 'b2'.repeat(20) };
const STORE = 'https://shop.test';
const GVIDO = 'gowxs612@gmail.com';
let mock: MockWoo;
let client: ReturnType<typeof createWooClient>;
beforeAll(async () => {
  mock = await startMockWoo(CREDS);
  client = createWooClient({ get: mock.get, rewrite: mock.rewrite });
});
afterAll(() => mock.close());

const provider = () => client.orders(STORE, CREDS);
const decide = async (number: string, sender: string) =>
  decideOrder({
    numbers: [number],
    sender,
    byNumber: await provider().findByNumber(number),
    byEmail: [],
    now: new Date(),
    staleDays: 14,
  });

describe('connection check', () => {
  it('accepts a working key and reads the shop name', async () => {
    expect(await client.ping(STORE, CREDS)).toEqual({ storeName: 'Nordlicht Candles' });
  });
  it('maps failures to codes the owner can act on', async () => {
    const bad = { ...CREDS, consumerSecret: 'cs_' + 'c3'.repeat(20) };
    await expect(client.ping(STORE, bad)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    mock.failNext(500);
    await expect(client.ping(STORE, CREDS)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    mock.failNext(302);
    await expect(client.ping(STORE, CREDS)).rejects.toMatchObject({ code: 'REDIRECT' });
    mock.failNext(404);
    await expect(client.ping(STORE, CREDS)).rejects.toMatchObject({ code: 'NO_REST_API' });
    for (const m of Object.values(WOO_ERROR_MESSAGES)) {
      expect(m).not.toContain(CREDS.consumerSecret);
      expect(m).not.toContain(CREDS.consumerKey);
    }
  });
  it('a store that cannot be reached is UNREACHABLE', async () => {
    const down = createWooClient({
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(down.ping(STORE, CREDS)).rejects.toBeInstanceOf(WooError);
    await expect(down.ping(STORE, CREDS)).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

describe('order lookup', () => {
  it('finds an order by number and translates it, without addresses or phone numbers', async () => {
    const [o] = await provider().findByNumber('1002');
    expect(o).toMatchObject({
      name: '#1002',
      email: GVIDO,
      payment: 'paid',
      fulfillment: 'shipped',
    });
    expect(o!.shipments[0]).toMatchObject({
      carrier: 'Latvijas Pasts',
      trackingNumber: 'LV987654321',
      trackingUrl: 'https://tracking.example-carrier.test/LV987654321',
      items: [{ name: 'Lavender candle', quantity: 2 }],
    });
    expect(JSON.stringify(o)).not.toMatch(/Private Street|20000000|stripe|Customer/);
  });
  it('finds orders by the sender address (billing e-mail, exact)', async () => {
    const found = await provider().findByEmail('solo@example.com');
    expect(found.map((o) => o.name)).toEqual(['#2001']);
    expect(await provider().findByEmail('nobody@example.com')).toEqual([]);
  });
  it('an unknown number is simply not found', async () => {
    expect(await provider().findByNumber('999999')).toEqual([]);
  });
  it('ignores a search hit whose order number differs', async () => {
    mock.orders.push({ ...mock.orders[1]!, id: 5000, number: '77' });
    expect(await provider().findByNumber('5000')).toEqual([]);
    expect((await provider().findByNumber('77')).map((o) => o.name)).toEqual(['#77']);
    mock.orders.pop();
  });
  it('a revoked key is AUTH, a store error is UNAVAILABLE', async () => {
    const bad = client.orders(STORE, { ...CREDS, consumerSecret: 'cs_' + 'c3'.repeat(20) });
    await expect(bad.findByNumber('1002')).rejects.toMatchObject({ code: 'AUTH' });
    mock.failNext(503);
    await expect(provider().findByNumber('1002')).rejects.toBeInstanceOf(OrderLookupError);
    mock.failNext(503);
    await expect(provider().findByNumber('1002')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('only ever reads: every request is a GET, the key travels only in the Authorization header', async () => {
    await provider().findByNumber('1002');
    await provider().findByEmail(GVIDO);
    expect(mock.requests.length).toBeGreaterThan(5);
    expect(mock.requests.every((r) => r.method === 'GET')).toBe(true);
    const all = JSON.stringify(mock.requests);
    expect(all).not.toContain(CREDS.consumerKey);
    expect(all).not.toContain(CREDS.consumerSecret);
    expect(mock.requests.every((r) => !('consumer_key' in r.query))).toBe(true);
  });
});

describe('decisions on WooCommerce orders (same rules as Shopify)', () => {
  it('verified, shipped with tracking: a reply, and it is simple', async () => {
    const d = await decide('1002', GVIDO);
    expect(d).toMatchObject({ kind: 'reply', simple: true });
  });
  it('identity mismatch reveals nothing about the order', async () => {
    const d = await decide('1001', GVIDO);
    expect(d).toMatchObject({ kind: 'escalate', reason: 'order_identity_mismatch' });
    expect(JSON.stringify(d)).not.toMatch(/Secret gift box|RW555000111|russel|DHL/i);
    expect('facts' in d).toBe(false);
  });
  it('processing, no tracking: not shipped yet', async () => {
    const d = await decide('1003', GVIDO);
    expect(d).toMatchObject({ kind: 'reply' });
    if (d.kind === 'reply') expect(d.facts.fulfillment).toBe('not_shipped');
  });
  it.each([
    ['1004', 'order_cancelled_or_refunded'],
    ['1012', 'order_cancelled_or_refunded'],
    ['1010', 'order_cancelled_or_refunded'], // partially refunded
    ['1005', 'order_fulfilled_no_tracking'], // completed, no tracking anywhere: say so, escalate
    ['1008', 'order_partially_fulfilled'], // on hold
    ['1011', 'order_partially_fulfilled'], // a status Noctiv does not know
    ['1009', 'order_shipment_stale'],
    ['424242', 'order_not_found'],
  ])('#%s is escalated: %s', async (n, reason) => {
    expect(await decide(n, GVIDO)).toMatchObject({ kind: 'escalate', reason });
  });
  it('a stale-days setting applies to unshipped orders too', async () => {
    const d = decideOrder({
      numbers: ['1003'],
      sender: GVIDO,
      byNumber: await provider().findByNumber('1003'),
      byEmail: [],
      now: new Date(Date.now() + 20 * 86_400_000),
      staleDays: 14,
    });
    expect(d).toMatchObject({ kind: 'escalate', reason: 'order_shipment_stale' });
  });
  it('finds the order from the sender address alone', async () => {
    const d = decideOrder({
      numbers: parseOrderRefs('Where is my parcel?').numbers,
      sender: 'solo@example.com',
      byNumber: [],
      byEmail: await provider().findByEmail('solo@example.com'),
      now: new Date(),
      staleDays: 14,
    });
    expect(d).toMatchObject({ kind: 'reply' });
  });
});

describe('where tracking comes from', () => {
  it('the plugin meta (1002), its REST endpoint (1007) and an explicit customer note (1006)', async () => {
    const t = async (n: string) => toFacts((await provider().findByNumber(n))[0]!).shipments[0]!;
    expect(await t('1002')).toMatchObject({ trackingNumber: 'LV987654321' });
    expect(await t('1007')).toMatchObject({ carrier: 'DPD', trackingNumber: 'DPD777000' });
    expect(await t('1006')).toMatchObject({
      trackingNumber: 'LV555123456',
      trackingUrl: 'https://tracking.example-carrier.test/LV555123456',
    });
  });
  it('customer notes are only read for completed orders without plugin data, and only customer notes', async () => {
    mock.requests.length = 0;
    await provider().findByNumber('1002');
    expect(mock.requests.some((r) => r.path.endsWith('/notes'))).toBe(false);
    mock.requests.length = 0;
    await provider().findByNumber('1006');
    const notes = mock.requests.filter((r) => r.path.endsWith('/notes'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.query.type).toBe('customer');
  });
  it('vague notes are not tracking: nothing is guessed', () => {
    const n = (note: string) => [
      { note, customer_note: true, date_created_gmt: '2026-10-01T10:00:00' },
    ];
    expect(trackingFromNotes(n('Your order has been shipped. Thanks!'))).toEqual([]);
    expect(trackingFromNotes(n('We will send the tracking number soon'))).toEqual([]);
    expect(trackingFromNotes(n('Tracking number: ABCDEFGH'))).toEqual([]); // no digit
    expect(
      trackingFromNotes([{ note: 'Tracking number: LV1234567', customer_note: false }]),
    ).toEqual([]);
    expect(trackingFromNotes(n('Tracking number: LV1234567'))[0]).toMatchObject({
      number: 'LV1234567',
    });
  });
  it('plugin meta is read tolerantly and unsafe links are dropped', () => {
    const meta = (item: Record<string, unknown>) => [
      { key: '_wc_shipment_tracking_items', value: [item] },
    ];
    expect(
      trackingFromMeta(
        meta({ tracking_number: 'AB12 345 678', custom_tracking_link: 'http://x.test/1' }),
      )[0],
    ).toMatchObject({ number: 'AB12 345 678', url: null });
    expect(trackingFromMeta(meta({ tracking_number: '<script>' }))).toEqual([]);
    expect(trackingFromMeta('nope')).toEqual([]);
    expect(
      trackingFromMeta(
        meta({
          custom_tracking_provider: 'Local courier',
          tracking_number: 'LC-998877',
          date_shipped: '1790000000',
        }),
      )[0],
    ).toMatchObject({ provider: 'Local courier', shippedAt: expect.stringMatching(/^2026-/) });
  });
});
