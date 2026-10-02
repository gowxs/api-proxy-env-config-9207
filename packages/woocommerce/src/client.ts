import {
  OrderLookupError,
  type OrderProvider,
  type OrderRecord,
  type Payment,
} from '@noctiv/orders';
import { BlockedAddressError, safeGet, type HttpGet } from './http.ts';
import {
  toShipments,
  trackingFromEndpoint,
  trackingFromMeta,
  trackingFromNotes,
  type WooTracking,
} from './tracking.ts';
import type { WooCredentials } from './credentials.ts';

export type WooErrorCode =
  | 'INVALID_URL'
  | 'HTTPS_REQUIRED'
  | 'BLOCKED_ADDRESS'
  | 'UNREACHABLE'
  | 'AUTH_FAILED'
  | 'NO_REST_API'
  | 'REDIRECT'
  | 'BAD_RESPONSE'
  | 'UNAVAILABLE';

export class WooError extends Error {
  readonly code: WooErrorCode;
  constructor(code: WooErrorCode) {
    super(`woocommerce: ${code}`);
    this.name = 'WooError';
    this.code = code;
  }
}

/** Shown to the owner. Never contains the key. */
export const WOO_ERROR_MESSAGES: Record<WooErrorCode, string> = {
  INVALID_URL:
    'That does not look like a store address. Use the address of your shop, like https://myshop.com.',
  HTTPS_REQUIRED:
    'The store address must start with https://. Noctiv does not send keys over plain http.',
  BLOCKED_ADDRESS: 'That address points to a private or local network, which Noctiv cannot reach.',
  UNREACHABLE: 'Noctiv could not reach the store. Check the address and that the site is online.',
  AUTH_FAILED:
    'The store refused the key. Check the key and secret, that the key has Read access, and that your host passes the Authorization header on (some hosts strip it).',
  NO_REST_API:
    'The store has no WooCommerce REST API at that address. Check the address, that WooCommerce is active and that Settings > Permalinks is not "Plain".',
  REDIRECT:
    'The address redirects somewhere else. Enter the final address of your store (for example with or without www).',
  BAD_RESPONSE: 'The store answered with something Noctiv does not understand.',
  UNAVAILABLE: 'The store did not answer in time. Try again in a moment.',
};

export interface ClientOptions {
  /** Tests inject a mock transport; production never sends a key anywhere but a public https host. */
  get?: HttpGet;
  /** Tests point this at a mock server. */
  rewrite?: (url: string) => string;
}

const API = '/wp-json/wc/v3';
const FIELDS = [
  'id',
  'number',
  'status',
  'date_created_gmt',
  'date_modified_gmt',
  'date_completed_gmt',
  'date_paid_gmt',
  'billing.email',
  'line_items.name',
  'line_items.quantity',
  'refunds.total',
  'meta_data',
].join(',');

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** WooCommerce's *_gmt dates are UTC without a zone marker. */
const gmt = (v: unknown): string | null => {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Orders in these states are not orders a customer can ask about. */
const IGNORED = new Set(['trash', 'auto-draft', 'draft', 'checkout-draft', 'new']);

/**
 * WooCommerce order → neutral OrderRecord. `trackings` come from the tracking plugin, if any.
 * WooCommerce has no fulfilment object: "completed" is the shipped state, and the shipment is
 * only as good as the tracking data a plugin or note provides.
 */
export function normalizeOrder(raw: unknown, trackings: WooTracking[]): OrderRecord | null {
  const o = obj(raw);
  const number = str(o?.number) ?? (typeof o?.number === 'number' ? String(o.number) : null);
  const status = (str(o?.status) ?? '').replace(/^wc-/, '').toLowerCase();
  if (!o || !number || !status || IGNORED.has(status)) return null;
  const createdAt = gmt(o.date_created_gmt) ?? '';
  const paid = Boolean(gmt(o.date_paid_gmt));
  const refunded = (Array.isArray(o.refunds) ? o.refunds : []).reduce<number>(
    (sum, r) => sum + Math.abs(Number(obj(r)?.total) || 0),
    0,
  );
  const items = (Array.isArray(o.line_items) ? o.line_items : []).flatMap((li) => {
    const l = obj(li);
    const name = str(l?.name);
    return name ? [{ name, quantity: Number(l?.quantity) || 1 }] : [];
  });
  const modified = gmt(o.date_modified_gmt) ?? createdAt;

  let payment: Payment = 'other';
  let fulfillment: OrderRecord['fulfillment'] = 'other';
  let detail: string | null = null;
  let cancelledAt: string | null = null;
  switch (status) {
    case 'pending':
      payment = 'pending';
      fulfillment = 'not_shipped';
      break;
    case 'on-hold':
      payment = paid ? 'paid' : 'pending';
      detail = 'on hold';
      break;
    case 'processing':
      payment = paid ? 'paid' : 'other';
      fulfillment = trackings.length ? 'other' : 'not_shipped';
      if (trackings.length) detail = 'tracking added but order not marked completed';
      break;
    case 'completed':
      payment = paid ? 'paid' : 'other';
      fulfillment = 'shipped';
      break;
    case 'cancelled':
    case 'failed':
      payment = 'voided';
      fulfillment = 'not_shipped';
      cancelledAt = modified || createdAt;
      break;
    case 'refunded':
      payment = 'refunded';
      fulfillment = 'not_shipped';
      break;
    default:
      // A status added by a plugin ("shipped", "awaiting pickup"): not ours to interpret.
      detail =
        status
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
          .slice(0, 30) || 'unusual status';
  }
  if (refunded > 0 && payment === 'paid') payment = 'partially_refunded';

  const completedAt = gmt(o.date_completed_gmt);
  return {
    name: `#${number}`,
    createdAt,
    cancelledAt,
    email: str(obj(o.billing)?.email),
    customerEmail: null,
    payment,
    fulfillment,
    fulfillmentDetail: fulfillment === 'other' ? detail : null,
    shipments:
      fulfillment === 'shipped' || (fulfillment === 'other' && trackings.length)
        ? toShipments(trackings, items, completedAt)
        : [],
  };
}

export function createWooClient(opts: ClientOptions = {}) {
  const get = opts.get ?? safeGet;
  const rewrite = opts.rewrite ?? ((u) => u);

  async function call(
    store: string,
    creds: WooCredentials,
    path: string,
    query: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const qs = new URLSearchParams(query).toString();
    const url = rewrite(`${store}${path}${qs ? `?${qs}` : ''}`);
    let res;
    try {
      res = await get(url, {
        authorization: `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`,
      });
    } catch (e) {
      if (
        e instanceof BlockedAddressError ||
        (e as { cause?: unknown })?.cause instanceof BlockedAddressError
      )
        throw new WooError('BLOCKED_ADDRESS');
      throw new WooError('UNREACHABLE');
    }
    if (res.status >= 300 && res.status < 400) throw new WooError('REDIRECT');
    if (res.status === 401 || res.status === 403) throw new WooError('AUTH_FAILED');
    if (res.status >= 500 || res.status === 429 || res.status === 408)
      throw new WooError('UNAVAILABLE');
    let json: unknown = null;
    if (res.body) {
      try {
        json = JSON.parse(res.body);
      } catch {
        if (res.status === 404) throw new WooError('NO_REST_API');
        throw new WooError('BAD_RESPONSE');
      }
    }
    return { status: res.status, json };
  }

  /** Tracking for a shipped order: the plugin's order meta, then its REST endpoints, then explicit customer notes. */
  async function trackingFor(store: string, creds: WooCredentials, raw: Record<string, unknown>) {
    const fromMeta = trackingFromMeta(raw.meta_data);
    if (fromMeta.length || str(raw.status)?.replace(/^wc-/, '') !== 'completed') return fromMeta;
    const id = String(raw.id);
    for (const base of ['/wp-json/wc-shipment-tracking/v3', API]) {
      try {
        const r = await call(store, creds, `${base}/orders/${id}/shipment-trackings`);
        const t = r.status === 200 ? trackingFromEndpoint(r.json) : [];
        if (t.length) return t;
      } catch (e) {
        if (e instanceof WooError && e.code === 'AUTH_FAILED') throw e;
        // The plugin is not installed or answers differently: try the next source.
      }
    }
    try {
      const r = await call(store, creds, `${API}/orders/${id}/notes`, {
        type: 'customer',
        per_page: '20',
      });
      return r.status === 200 ? trackingFromNotes(r.json) : [];
    } catch (e) {
      if (e instanceof WooError && e.code === 'AUTH_FAILED') throw e;
      return [];
    }
  }

  const asLookupError = (e: unknown): never => {
    if (e instanceof OrderLookupError) throw e;
    throw new OrderLookupError(
      e instanceof WooError && e.code === 'AUTH_FAILED' ? 'AUTH' : 'UNAVAILABLE',
    );
  };

  return {
    /** Checks that the key works for reading orders (and reads the shop's public name). */
    async ping(store: string, creds: WooCredentials): Promise<{ storeName: string | null }> {
      const r = await call(store, creds, `${API}/orders`, { per_page: '1', _fields: 'id' });
      if (r.status === 404) throw new WooError('NO_REST_API');
      if (r.status !== 200 || !Array.isArray(r.json)) throw new WooError('BAD_RESPONSE');
      let storeName: string | null = null;
      try {
        const idx = await call(store, creds, '/wp-json', { _fields: 'name' });
        storeName = str(obj(idx.json)?.name)?.slice(0, 200) ?? null;
      } catch {
        // The name is cosmetic.
      }
      return { storeName };
    },

    /** The read-only order lookup for this store, in the neutral shape. */
    orders(store: string, creds: WooCredentials): OrderProvider {
      const build = async (raws: unknown[]): Promise<OrderRecord[]> => {
        const out: OrderRecord[] = [];
        for (const raw of raws) {
          const o = obj(raw);
          if (!o) continue;
          const rec = normalizeOrder(o, await trackingFor(store, creds, o));
          if (rec) out.push(rec);
        }
        return out;
      };
      return {
        platform: 'woocommerce',
        async findByNumber(number) {
          try {
            const found = new Map<string, Record<string, unknown>>();
            const keep = (v: unknown) => {
              const o = obj(v);
              if (o && String(o.number) === number) found.set(String(o.id), o);
            };
            if (/^\d{1,12}$/.test(number)) {
              const r = await call(store, creds, `${API}/orders/${number}`, { _fields: FIELDS });
              if (r.status === 200) keep(r.json);
            }
            const s = await call(store, creds, `${API}/orders`, {
              search: number,
              per_page: '20',
              _fields: FIELDS,
            });
            if (s.status === 200 && Array.isArray(s.json)) s.json.forEach(keep);
            return await build([...found.values()]);
          } catch (e) {
            return asLookupError(e);
          }
        },
        async findByEmail(email) {
          try {
            const s = await call(store, creds, `${API}/orders`, {
              search: email,
              per_page: '20',
              orderby: 'date',
              order: 'desc',
              _fields: FIELDS,
            });
            if (s.status !== 200 || !Array.isArray(s.json)) throw new WooError('BAD_RESPONSE');
            const mine = s.json.filter(
              (o) => str(obj(obj(o)?.billing)?.email)?.toLowerCase() === email.trim().toLowerCase(),
            );
            return await build(mine);
          } catch (e) {
            return asLookupError(e);
          }
        },
      };
    },
  };
}
export type WooClient = ReturnType<typeof createWooClient>;
