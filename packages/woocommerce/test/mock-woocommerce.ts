/**
 * A mock WooCommerce REST API (v3) for tests: HTTP Basic auth with the consumer key and
 * secret, the orders list and single order, order notes and the two shipment-tracking
 * endpoints. Fixtures mirror the Shopify dev-store orders so both platforms are tested
 * against the same scenarios. Every request is recorded (without the credentials) so tests
 * can prove the client only ever reads.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpGet } from '../src/http.ts';

const DAY = 86_400_000;
/** WooCommerce style: UTC without a zone marker. */
export const gmt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 19);
export const unix = (msAgo: number) => String(Math.floor((Date.now() - msAgo) / 1000));

export interface MockWooOrder {
  id: number;
  number: string;
  status: string;
  date_created_gmt: string;
  date_modified_gmt: string;
  date_completed_gmt: string | null;
  date_paid_gmt: string | null;
  billing: {
    email: string;
    first_name: string;
    last_name: string;
    address_1: string;
    phone: string;
  };
  line_items: { name: string; quantity: number; total: string }[];
  refunds: { id: number; total: string }[];
  meta_data: { id: number; key: string; value: unknown }[];
  /** What the shipment-tracking plugin answers (undefined: the endpoint 404s). */
  trackingEndpoint?: unknown[];
  /** Order notes (customer notes carry customer_note: true). */
  notes?: { id: number; note: string; customer_note: boolean; date_created_gmt: string }[];
}

const trackingMeta = (over: Record<string, unknown> = {}) => [
  {
    id: 1,
    key: '_wc_shipment_tracking_items',
    value: [
      {
        tracking_id: 'abc',
        tracking_provider: 'Latvijas Pasts',
        custom_tracking_provider: '',
        tracking_number: 'LV987654321',
        custom_tracking_link: '',
        formatted_tracking_link: 'https://tracking.example-carrier.test/LV987654321',
        date_shipped: unix(2 * DAY),
        ...over,
      },
    ],
  },
];

export function wooOrder(
  over: Partial<MockWooOrder> & { id: number; email: string },
): MockWooOrder {
  const { email, ...rest } = over;
  return {
    number: String(over.id),
    status: 'completed',
    date_created_gmt: gmt(5 * DAY),
    date_modified_gmt: gmt(2 * DAY),
    date_completed_gmt: gmt(2 * DAY),
    date_paid_gmt: gmt(5 * DAY),
    billing: {
      email,
      first_name: 'Test',
      last_name: 'Customer',
      address_1: 'Private Street 1',
      phone: '+371 20000000',
    },
    line_items: [{ name: 'Lavender candle', quantity: 2, total: '20.00' }],
    refunds: [],
    meta_data: [{ id: 9, key: '_payment_method', value: 'stripe' }, ...trackingMeta()],
    ...rest,
  };
}

const GVIDO = 'gowxs612@gmail.com';

/** The scenarios the owner's dev store has, plus the WooCommerce-specific tracking cases. */
export function devStoreOrders(): MockWooOrder[] {
  const noTracking = { meta_data: [{ id: 9, key: '_payment_method', value: 'stripe' }] };
  return [
    wooOrder({
      id: 1001,
      email: 'russel.winfield@example.com',
      line_items: [{ name: 'Secret gift box', quantity: 1, total: '30.00' }],
      meta_data: trackingMeta({
        tracking_provider: 'DHL',
        tracking_number: 'RW555000111',
        formatted_tracking_link: 'https://tracking.example-carrier.test/RW555000111',
      }),
    }),
    wooOrder({ id: 1002, email: GVIDO }), // completed, tracking in the plugin's meta
    wooOrder({
      id: 1003,
      email: GVIDO,
      status: 'processing',
      date_completed_gmt: null,
      date_created_gmt: gmt(1 * DAY),
      ...noTracking,
    }),
    wooOrder({
      id: 1004,
      email: GVIDO,
      status: 'cancelled',
      date_completed_gmt: null,
      date_modified_gmt: gmt(3 * DAY),
      ...noTracking,
    }),
    wooOrder({ id: 1005, email: GVIDO, ...noTracking }), // completed, no tracking anywhere
    wooOrder({
      id: 1006,
      email: GVIDO,
      ...noTracking,
      notes: [
        {
          id: 1,
          note: 'Internal: packed by Anna',
          customer_note: false,
          date_created_gmt: gmt(3 * DAY),
        },
        {
          id: 2,
          note: 'Your order has been shipped. Tracking number: LV555123456 <a href="https://tracking.example-carrier.test/LV555123456">track</a>',
          customer_note: true,
          date_created_gmt: gmt(2 * DAY),
        },
      ],
    }),
    wooOrder({
      id: 1007,
      email: GVIDO,
      ...noTracking,
      trackingEndpoint: [
        {
          tracking_id: 't1',
          tracking_provider: 'DPD',
          tracking_link: 'https://tracking.example-carrier.test/DPD777000',
          tracking_number: 'DPD777000',
          date_shipped: unix(1 * DAY),
        },
      ],
    }),
    wooOrder({
      id: 1008,
      email: GVIDO,
      status: 'on-hold',
      date_completed_gmt: null,
      ...noTracking,
    }),
    wooOrder({
      id: 1009,
      email: GVIDO,
      date_created_gmt: gmt(40 * DAY),
      date_completed_gmt: gmt(30 * DAY),
      meta_data: trackingMeta({ date_shipped: unix(30 * DAY) }),
    }), // shipped a month ago, no delivery news
    wooOrder({ id: 1010, email: GVIDO, refunds: [{ id: 5, total: '-5.00' }] }),
    wooOrder({ id: 1011, email: GVIDO, status: 'shipped-by-courier', ...noTracking }), // a plugin's own status
    wooOrder({
      id: 1012,
      email: GVIDO,
      status: 'refunded',
      date_completed_gmt: null,
      ...noTracking,
    }),
    wooOrder({ id: 2001, email: 'solo@example.com' }),
  ];
}

export interface MockWoo {
  /** http://127.0.0.1:port */
  base: string;
  /** Pass as createWooClient({ get, rewrite }). */
  get: HttpGet;
  rewrite: (url: string) => string;
  requests: { method: string; path: string; query: Record<string, string>; authOk: boolean }[];
  orders: MockWooOrder[];
  failNext(status: number, times?: number): void;
  close(): Promise<void>;
}

export async function startMockWoo(creds: {
  consumerKey: string;
  consumerSecret: string;
}): Promise<MockWoo> {
  const orders = devStoreOrders();
  const failures: number[] = [];
  const requests: MockWoo['requests'] = [];
  const send = (res: ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  const pick = (o: MockWooOrder) => {
    const { trackingEndpoint: _t, notes: _n, ...rest } = o;
    return rest;
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const query = Object.fromEntries(url.searchParams);
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
    const [k, s] = m ? Buffer.from(m[1]!, 'base64').toString().split(':') : [];
    const authOk = k === creds.consumerKey && s === creds.consumerSecret;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, query, authOk });
    if (req.method !== 'GET') return send(res, 405, { code: 'rest_no_route' });
    const fail = failures.shift();
    if (fail) return send(res, fail, { code: 'mock_failure' });
    const p = url.pathname;
    if (p === '/wp-json')
      return send(res, 200, { name: 'Nordlicht Candles', url: 'https://shop.test' });
    if (!authOk)
      return send(res, 401, {
        code: 'woocommerce_rest_cannot_view',
        message: 'Sorry, you cannot list resources.',
      });
    if (p === '/wp-json/wc/v3/orders') {
      const q = (query.search ?? '').toLowerCase();
      const hits = orders.filter(
        (o) =>
          !q ||
          String(o.id) === q ||
          o.number.toLowerCase() === q ||
          o.billing.email.toLowerCase().includes(q),
      );
      return send(res, 200, hits.slice(0, Number(query.per_page) || 10).map(pick));
    }
    let r = /^\/wp-json\/wc\/v3\/orders\/(\d+)$/.exec(p);
    if (r) {
      const o = orders.find((x) => String(x.id) === r![1]);
      return o
        ? send(res, 200, pick(o))
        : send(res, 404, { code: 'woocommerce_rest_shop_order_invalid_id' });
    }
    r = /^\/wp-json\/wc\/v3\/orders\/(\d+)\/notes$/.exec(p);
    if (r) {
      const o = orders.find((x) => String(x.id) === r![1]);
      const notes = (o?.notes ?? []).filter((n) => query.type !== 'customer' || n.customer_note);
      return o
        ? send(res, 200, notes)
        : send(res, 404, { code: 'woocommerce_rest_order_invalid_id' });
    }
    r = /^\/wp-json\/wc-shipment-tracking\/v3\/orders\/(\d+)\/shipment-trackings$/.exec(p);
    if (r) {
      const o = orders.find((x) => String(x.id) === r![1]);
      return o?.trackingEndpoint
        ? send(res, 200, o.trackingEndpoint)
        : send(res, 404, { code: 'rest_no_route' });
    }
    return send(res, 404, { code: 'rest_no_route' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rewrite = (u: string) => u.replace(/^https:\/\/[^/]+(?:\/[^/?]+)?(?=\/wp-json)/, base);
  return {
    base,
    rewrite,
    get: async (url, headers) => {
      const res = await fetch(url, { headers, redirect: 'manual' });
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: await res.text(),
      };
    },
    requests,
    orders,
    failNext(status, times = 1) {
      failures.push(...Array<number>(times).fill(status));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
