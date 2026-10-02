/**
 * A mock Shopify Admin API for tests: the client-credentials token endpoint and
 * the GraphQL endpoint (shop info and orders). Fixtures mirror the owner's
 * development store (#1001 to #1004). It records every request so tests can
 * prove the client only ever reads.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const DAY = 86_400_000;
export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

export interface MockOrder {
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  email: string | null;
  customerEmail: string | null;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  fulfillments: {
    status: string;
    createdAt: string;
    inTransitAt: string | null;
    deliveredAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
    items: { name: string; quantity: number }[];
  }[];
}

const shipment = (over: Partial<MockOrder['fulfillments'][number]> = {}) => ({
  status: 'SUCCESS',
  createdAt: iso(3 * DAY),
  inTransitAt: iso(2 * DAY),
  deliveredAt: null,
  estimatedDeliveryAt: null,
  trackingInfo: [
    {
      company: 'Latvijas Pasts',
      number: 'LV987654321',
      url: 'https://tracking.example-carrier.test/LV987654321',
    },
  ],
  items: [{ name: 'Lavender candle', quantity: 2 }],
  ...over,
});

/** The development store's test orders. Dates are relative to now so they are never "stale". */
export function devStoreOrders(): MockOrder[] {
  return [
    {
      name: '#1001',
      createdAt: iso(6 * DAY),
      cancelledAt: null,
      email: 'russel.winfield@example.com',
      customerEmail: 'russel.winfield@example.com',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [
        shipment({
          trackingInfo: [
            {
              company: 'DHL',
              number: 'RW555000111',
              url: 'https://tracking.example-carrier.test/RW555000111',
            },
          ],
          items: [{ name: 'Secret gift box', quantity: 1 }],
        }),
      ],
    },
    {
      name: '#1002',
      createdAt: iso(5 * DAY),
      cancelledAt: null,
      email: 'gowxs612@gmail.com',
      customerEmail: 'gowxs612@gmail.com',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [shipment()],
    },
    {
      name: '#1003',
      createdAt: iso(1 * DAY),
      cancelledAt: null,
      email: 'gowxs612@gmail.com',
      customerEmail: 'gowxs612@gmail.com',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [],
    },
    {
      name: '#1004',
      createdAt: iso(4 * DAY),
      cancelledAt: iso(3 * DAY),
      email: 'gowxs612@gmail.com',
      customerEmail: 'gowxs612@gmail.com',
      displayFinancialStatus: 'REFUNDED',
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [],
    },
  ];
}

export interface MockShopify {
  /** Pass to createShopifyClient({ baseUrl }). */
  baseUrl: (shop: string) => string;
  /** Every request received: path, method, header values that matter, and the raw body. */
  requests: { path: string; method: string; token: string | null; body: string }[];
  orders: MockOrder[];
  /** Access scopes the "app" has (default: read_orders only). */
  scopes: string[];
  /** How the client credentials grant answers: 'ok' (default), or the errors Shopify gives. */
  clientCredentials: 'ok' | 'not_permitted' | 'not_installed';
  /** Token values the server accepts as an Admin API access token. */
  validTokens: Set<string>;
  /** The app's own credentials (what the token endpoint checks). */
  app: { clientId: string; clientSecret: string };
  /** Authorization codes the token endpoint accepts (single use). */
  codes: Set<string>;
  /** Refresh tokens still valid (each is spent when used and replaced). */
  refreshTokens: Set<string>;
  /** Issue an install: returns the code Shopify would send to the callback. */
  newCode(): string;
  /** Make every access token invalid (as an hour passing, or an uninstall). */
  revokeAll(): void;
  /** Make the next N requests fail with this HTTP status. */
  failNext(status: number, times?: number): void;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

const toNode = (o: MockOrder) => ({
  name: o.name,
  createdAt: o.createdAt,
  cancelledAt: o.cancelledAt,
  email: o.email,
  customer: o.customerEmail ? { defaultEmailAddress: { emailAddress: o.customerEmail } } : null,
  displayFinancialStatus: o.displayFinancialStatus,
  displayFulfillmentStatus: o.displayFulfillmentStatus,
  fulfillments: o.fulfillments.map((f) => ({
    status: f.status,
    createdAt: f.createdAt,
    inTransitAt: f.inTransitAt,
    deliveredAt: f.deliveredAt,
    estimatedDeliveryAt: f.estimatedDeliveryAt,
    trackingInfo: f.trackingInfo,
    fulfillmentLineItems: {
      nodes: f.items.map((i) => ({ quantity: i.quantity, lineItem: { name: i.name } })),
    },
  })),
});

export async function startMockShopify(
  opts: { token?: string; clientId?: string; clientSecret?: string } = {},
): Promise<MockShopify & { url: string }> {
  const token = opts.token ?? 'shpat_test_0123456789abcdef0123456789abcdef';
  const m: MockShopify & { url: string } = {
    url: '',
    baseUrl: () => m.url,
    requests: [],
    orders: devStoreOrders(),
    scopes: ['read_orders'],
    clientCredentials: 'ok',
    validTokens: new Set([token]),
    app: {
      clientId: opts.clientId ?? 'client-id-1',
      clientSecret: opts.clientSecret ?? 'shpss_test_secret_0123456789',
    },
    codes: new Set(),
    refreshTokens: new Set(),
    newCode() {
      const c = `code_${Math.random().toString(36).slice(2)}`;
      m.codes.add(c);
      return c;
    },
    revokeAll() {
      m.validTokens.clear();
    },
    failNext(status, times = 1) {
      failures.push(...Array<number>(times).fill(status));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const failures: number[] = [];
  const json = (res: ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  const server: Server = createServer((req, res) => {
    void body(req).then((raw) => {
      const path = req.url ?? '';
      m.requests.push({
        path,
        method: req.method ?? '',
        token: (req.headers['x-shopify-access-token'] as string | undefined) ?? null,
        body: raw,
      });
      const fail = failures.shift();
      if (fail) return json(res, fail, { errors: 'mock failure' });
      if (path === '/admin/oauth/access_token' && req.method === 'POST') {
        const p = new URLSearchParams(raw);
        const appOk =
          p.get('client_id') === m.app.clientId && p.get('client_secret') === m.app.clientSecret;
        const code = p.get('code');
        const rt = p.get('refresh_token');
        if (appOk && p.get('grant_type') === 'client_credentials') {
          if (m.clientCredentials === 'not_permitted')
            return json(res, 400, {
              error: 'shop_not_permitted',
              error_description: 'Client credentials cannot be performed on this shop.',
            });
          if (m.clientCredentials === 'not_installed')
            return json(res, 400, { error: 'app_not_installed' });
          const at = `shpat_cc_${m.requests.length}`;
          m.validTokens.add(at);
          return json(res, 200, { access_token: at, scope: m.scopes.join(','), expires_in: 86399 });
        }
        const granted =
          appOk &&
          ((code && m.codes.delete(code)) ||
            (p.get('grant_type') === 'refresh_token' && rt && m.refreshTokens.delete(rt)));
        if (!granted) return json(res, 400, { error: 'invalid_request' });
        const n = m.requests.length;
        const at = `shpat_minted_${n}`;
        const nrt = `shprt_minted_${n}`;
        m.validTokens.add(at);
        m.refreshTokens.add(nrt);
        // Expiring offline tokens, as the docs describe (1 hour, refresh token 90 days).
        return json(res, 200, {
          access_token: at,
          scope: m.scopes.join(','),
          expires_in: 3600,
          refresh_token: nrt,
          refresh_token_expires_in: 7776000,
        });
      }
      if (path === '/admin/api_permissions/current.json' && req.method === 'DELETE') {
        const t = (req.headers['x-shopify-access-token'] as string | undefined) ?? '';
        if (!m.validTokens.delete(t)) return json(res, 401, { errors: 'invalid token' });
        return json(res, 200, {});
      }
      if (/^\/admin\/api\/[\d-]+\/graphql\.json$/.test(path) && req.method === 'POST') {
        const t = (req.headers['x-shopify-access-token'] as string | undefined) ?? '';
        if (!m.validTokens.has(t))
          return json(res, 401, { errors: '[API] Invalid API key or access token' });
        const { query, variables } = JSON.parse(raw) as {
          query: string;
          variables?: { q?: string };
        };
        if (/\bmutation\b/.test(query))
          return json(res, 200, { errors: [{ message: 'mock: mutations are not supported' }] });
        if (query.includes('currentAppInstallation'))
          return json(res, 200, {
            data: {
              shop: { name: 'Noctiv Dev Store' },
              currentAppInstallation: { accessScopes: m.scopes.map((handle) => ({ handle })) },
            },
          });
        if (!m.scopes.includes('read_orders'))
          return json(res, 200, {
            errors: [
              {
                message:
                  'Access denied for orders field. Required access: read_orders access scope.',
              },
            ],
          });
        const q = variables?.q ?? '';
        const nameQ = /^name:#?(\S+)$/.exec(q)?.[1];
        const emailQ = /^email:(\S+)$/.exec(q)?.[1];
        const hit = m.orders.filter((o) =>
          nameQ
            ? o.name.replace('#', '') === nameQ
            : emailQ
              ? (o.email ?? '').toLowerCase() === emailQ.toLowerCase()
              : false,
        );
        return json(res, 200, { data: { orders: { nodes: hit.map(toNode) } } });
      }
      return json(res, 404, { errors: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return m;
}
