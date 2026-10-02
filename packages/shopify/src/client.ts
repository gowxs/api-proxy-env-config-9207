/**
 * Read-only Shopify Admin GraphQL client plus the OAuth token calls. Only
 * queries are ever sent (no mutation exists in this file). Tokens are used in
 * memory and never logged or put into an error message: errors carry a code and
 * an HTTP status. Orders come back in the platform-neutral shape of
 * @noctiv/orders, so the lookup logic does not depend on Shopify.
 */
import {
  OrderLookupError,
  type OrderProvider,
  type OrderRecord,
  type OrderShipment,
  type Payment,
} from '@noctiv/orders';

export const SHOPIFY_API_VERSION = '2026-10';
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** "My-Store", "https://my-store.myshopify.com/admin" or "my-store" → "my-store.myshopify.com" (null if not a shop). */
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (/^[a-z0-9][a-z0-9-]{0,60}$/.test(s)) s = `${s}.myshopify.com`;
  return SHOP_RE.test(s) ? s : null;
}

export type ShopifyErrorCode =
  | 'INVALID_SHOP'
  | 'AUTH_FAILED'
  | 'MISSING_SCOPE'
  | 'WRITE_SCOPES'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'BAD_RESPONSE';

export class ShopifyError extends Error {
  readonly code: ShopifyErrorCode;
  readonly status: number | undefined;
  constructor(code: ShopifyErrorCode, status?: number) {
    super(`shopify: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'ShopifyError';
    this.code = code;
    this.status = status;
  }
}

export const SHOPIFY_ERROR_MESSAGES: Record<ShopifyErrorCode, string> = {
  INVALID_SHOP: 'That is not a Shopify store address.',
  AUTH_FAILED:
    'Shopify no longer accepts the connection (the app was removed from the store, or access was withdrawn). Connect the store again.',
  MISSING_SCOPE:
    'Noctiv is not allowed to read orders in this store. Connect the store again and accept the permission.',
  WRITE_SCOPES:
    'The connection has permission to change data in your store. Noctiv only reads orders, so it refuses it.',
  RATE_LIMITED: 'Shopify is busy. Try again in a minute.',
  UNAVAILABLE: 'Shopify could not be reached. Try again in a minute.',
  BAD_RESPONSE: 'Shopify answered in an unexpected way. Try again, or contact us.',
};

/** The result of the code exchange and of every refresh. Expiring offline tokens: 1 hour, refresh token 90 days, both replaced on refresh. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

const ORDER_FIELDS = `
  name createdAt cancelledAt email
  customer { defaultEmailAddress { emailAddress } }
  displayFinancialStatus displayFulfillmentStatus
  fulfillments(first: 10) {
    createdAt inTransitAt deliveredAt estimatedDeliveryAt
    trackingInfo { company number url }
    fulfillmentLineItems(first: 20) { nodes { quantity lineItem { name } } }
  }`;
const ORDERS_QUERY = `query Orders($q: String!) {
  orders(first: 10, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
}`;
const SHOP_QUERY = `{ shop { name } currentAppInstallation { accessScopes { handle } } }`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const PAYMENT: Record<string, Payment> = {
  PAID: 'paid',
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PARTIALLY_PAID: 'partially_paid',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  VOIDED: 'voided',
};

/** Raw GraphQL order → the neutral OrderRecord (tolerant: missing parts become null). */
export function normalizeOrder(raw: unknown): OrderRecord | null {
  const o = obj(raw);
  const name = str(o?.name);
  if (!o || !name) return null;
  const customer = obj(o.customer);
  const shipments: OrderShipment[] = arr(o.fulfillments).flatMap((f) => {
    const fo = obj(f);
    if (!fo) return [];
    const tracking = obj(arr(fo.trackingInfo)[0]);
    const items = arr(obj(fo.fulfillmentLineItems)?.nodes).flatMap((n) => {
      const no = obj(n);
      const itemName = str(obj(no?.lineItem)?.name);
      return itemName ? [{ name: itemName, quantity: Number(no?.quantity) || 1 }] : [];
    });
    return [
      {
        createdAt: str(fo.createdAt),
        carrier: str(tracking?.company),
        trackingNumber: str(tracking?.number),
        trackingUrl: str(tracking?.url),
        estimatedDeliveryAt: str(fo.estimatedDeliveryAt),
        deliveredAt: str(fo.deliveredAt),
        inTransitAt: str(fo.inTransitAt),
        items,
      },
    ];
  });
  const fs = (str(o.displayFulfillmentStatus) ?? 'UNKNOWN').toUpperCase();
  return {
    name,
    createdAt: str(o.createdAt) ?? '',
    cancelledAt: str(o.cancelledAt),
    email: str(o.email),
    customerEmail: str(obj(customer?.defaultEmailAddress)?.emailAddress),
    payment: PAYMENT[(str(o.displayFinancialStatus) ?? '').toUpperCase()] ?? 'other',
    fulfillment: fs === 'FULFILLED' ? 'shipped' : fs === 'UNFULFILLED' ? 'not_shipped' : 'other',
    fulfillmentDetail:
      fs === 'FULFILLED' || fs === 'UNFULFILLED' ? null : fs.toLowerCase().replace(/_/g, ' '),
    shipments,
  };
}

export interface ClientOptions {
  fetch?: typeof fetch;
  /** Tests point this at a mock server; the shop domain is always validated first. */
  baseUrl?: (shop: string) => string;
  apiVersion?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ShopifyClient {
  /** Authorization code → expiring offline tokens (the last step of the install). */
  exchangeCode(shop: string, app: AppCredentials, code: string): Promise<TokenSet>;
  /** Refresh token → a new access token AND a new refresh token (the old one is spent). */
  refresh(shop: string, app: AppCredentials, refreshToken: string): Promise<TokenSet>;
  shopInfo(shop: string, accessToken: string): Promise<{ shopName: string; scopes: string[] }>;
  /** Uninstalls the app from the store, which revokes the token (best effort). */
  revoke(shop: string, accessToken: string): Promise<void>;
  /** The read-only order lookup for this store, in the neutral shape. */
  orders(shop: string, accessToken: string): OrderProvider;
}

/** Maps a Shopify failure to what the neutral lookup knows about. */
export function toLookupError(e: unknown): OrderLookupError {
  if (e instanceof OrderLookupError) return e;
  if (e instanceof ShopifyError)
    return new OrderLookupError(
      e.code === 'AUTH_FAILED'
        ? 'AUTH'
        : e.code === 'MISSING_SCOPE' || e.code === 'WRITE_SCOPES'
          ? 'SCOPE'
          : 'UNAVAILABLE',
    );
  return new OrderLookupError('UNAVAILABLE');
}

export function createShopifyClient(opts: ClientOptions = {}): ShopifyClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? ((shop: string) => `https://${shop}`);
  const version = opts.apiVersion ?? SHOPIFY_API_VERSION;
  const timeout = opts.timeoutMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const shopOk = (shop: string) => {
    if (!SHOP_RE.test(shop)) throw new ShopifyError('INVALID_SHOP');
  };

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      } catch {
        if (attempt === 0) continue;
        throw new ShopifyError('UNAVAILABLE');
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      return res;
    }
  }

  async function tokens(shop: string, form: Record<string, string>): Promise<TokenSet> {
    shopOk(shop);
    const res = await send(`${base(shop)}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status >= 400 && res.status < 500 && res.status !== 429)
      throw new ShopifyError('AUTH_FAILED', res.status);
    if (!res.ok)
      throw new ShopifyError(res.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', res.status);
    const j = obj(await res.json().catch(() => null));
    const accessToken = str(j?.access_token);
    if (!accessToken) throw new ShopifyError('BAD_RESPONSE', res.status);
    const expiresIn = Number(j?.expires_in);
    const refreshIn = Number(j?.refresh_token_expires_in);
    return {
      accessToken,
      refreshToken: str(j?.refresh_token),
      scopes: (str(j?.scope) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      accessExpiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0
          ? new Date(now() + expiresIn * 1000).toISOString()
          : null,
      refreshExpiresAt:
        Number.isFinite(refreshIn) && refreshIn > 0
          ? new Date(now() + refreshIn * 1000).toISOString()
          : null,
    };
  }

  async function graphql(shop: string, token: string, query: string, variables?: Json) {
    shopOk(shop);
    const res = await send(`${base(shop)}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-shopify-access-token': token,
      },
      body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 404)
      throw new ShopifyError('AUTH_FAILED', res.status);
    if (res.status === 429) throw new ShopifyError('RATE_LIMITED', 429);
    if (!res.ok) throw new ShopifyError('UNAVAILABLE', res.status);
    const j = obj(await res.json().catch(() => null));
    if (!j) throw new ShopifyError('BAD_RESPONSE', res.status);
    const errors = arr(j.errors);
    if (errors.length) {
      const text = JSON.stringify(errors).toLowerCase();
      if (text.includes('throttled')) throw new ShopifyError('RATE_LIMITED');
      if (text.includes('access denied') || text.includes('scope') || text.includes('not approved'))
        throw new ShopifyError('MISSING_SCOPE');
      throw new ShopifyError('BAD_RESPONSE');
    }
    const data = obj(j.data);
    if (!data) throw new ShopifyError('BAD_RESPONSE');
    return data;
  }

  const findOrders = async (shop: string, token: string, q: string) => {
    const data = await graphql(shop, token, ORDERS_QUERY, { q });
    return arr(obj(data.orders)?.nodes).flatMap((n) => {
      const o = normalizeOrder(n);
      return o ? [o] : [];
    });
  };

  return {
    exchangeCode: (shop, app, code) =>
      tokens(shop, {
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        expiring: '1',
      }),
    refresh: (shop, app, refreshToken) =>
      tokens(shop, {
        grant_type: 'refresh_token',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: refreshToken,
      }),
    async shopInfo(shop, accessToken) {
      const data = await graphql(shop, accessToken, SHOP_QUERY);
      const scopes = arr(obj(data.currentAppInstallation)?.accessScopes).flatMap((s) => {
        const h = str(obj(s)?.handle);
        return h ? [h] : [];
      });
      return { shopName: str(obj(data.shop)?.name) ?? shop, scopes };
    },
    async revoke(shop, accessToken) {
      shopOk(shop);
      const res = await send(`${base(shop)}/admin/api_permissions/current.json`, {
        method: 'DELETE',
        headers: { 'x-shopify-access-token': accessToken, accept: 'application/json' },
      });
      // 401/403: already revoked or uninstalled, which is the goal.
      if (!res.ok && res.status !== 401 && res.status !== 403 && res.status !== 404)
        throw new ShopifyError('UNAVAILABLE', res.status);
    },
    orders(shop, accessToken): OrderProvider {
      shopOk(shop);
      const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (e) {
          throw toLookupError(e);
        }
      };
      return {
        platform: 'shopify',
        findByNumber: (number) =>
          wrap(async () => {
            if (!/^\d{1,9}$/.test(number)) return [];
            // Stores differ in how "name:" matches the "#" and any prefix: ask both ways.
            const first = await findOrders(shop, accessToken, `name:${number}`);
            const all = first.length
              ? first
              : await findOrders(shop, accessToken, `name:#${number}`);
            const want = number.replace(/^0+/, '');
            return all.filter((o) => o.name.replace(/\D/g, '').replace(/^0+/, '') === want);
          }),
        findByEmail: (email) =>
          wrap(async () => {
            if (!/^[^\s"'\\:()]+@[^\s"'\\:()]+$/.test(email)) return [];
            return findOrders(shop, accessToken, `email:${email}`);
          }),
      };
    },
  };
}

/** Throws when the app can read nothing useful or can change things. Used when installing and in "Test connection". */
export function checkScopes(scopes: string[]): void {
  if (scopes.some((s) => s.startsWith('write_'))) throw new ShopifyError('WRITE_SCOPES');
  if (!scopes.includes('read_orders')) throw new ShopifyError('MISSING_SCOPE');
}
