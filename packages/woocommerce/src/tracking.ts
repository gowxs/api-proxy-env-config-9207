import type { OrderShipment } from '@noctiv/orders';

/** One shipment as a tracking plugin recorded it. Every field is optional: plugins differ. */
export interface WooTracking {
  provider: string | null;
  number: string | null;
  url: string | null;
  shippedAt: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null;

const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{3,38}[A-Za-z0-9]$/;
const cleanNumber = (v: unknown): string | null => {
  const s = text(typeof v === 'number' ? String(v) : v, 40);
  return s && NUMBER_RE.test(s) ? s : null;
};
const cleanUrl = (v: unknown): string | null => {
  const s = text(v, 500);
  if (!s) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};
/** The Shipment Tracking plugin stores "date_shipped" as Unix seconds; others use ISO dates. */
const shipped = (v: unknown): string | null => {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,11}$/.test(v))) {
    const d = new Date(Number(v) * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};

function fromItem(v: unknown): WooTracking | null {
  const o = obj(v);
  if (!o) return null;
  const t: WooTracking = {
    provider: text(o.custom_tracking_provider, 80) ?? text(o.tracking_provider, 80),
    number: cleanNumber(o.tracking_number),
    url:
      cleanUrl(o.formatted_tracking_link) ??
      cleanUrl(o.tracking_link) ??
      cleanUrl(o.custom_tracking_link),
    shippedAt: shipped(o.date_shipped),
  };
  return t.number || t.url ? t : null;
}

/** The common Shipment Tracking plugin keeps its entries in the order meta `_wc_shipment_tracking_items`. */
export function trackingFromMeta(meta: unknown): WooTracking[] {
  if (!Array.isArray(meta)) return [];
  for (const m of meta) {
    const o = obj(m);
    if (o?.key === '_wc_shipment_tracking_items' && Array.isArray(o.value))
      return o.value.flatMap((x) => fromItem(x) ?? []);
  }
  return [];
}

/** The plugin's own REST answer (a list of shipments). */
export function trackingFromEndpoint(body: unknown): WooTracking[] {
  return Array.isArray(body) ? body.flatMap((x) => fromItem(x) ?? []) : [];
}

const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Customer notes ("Your order was shipped. Tracking number: LV123456789") are free text. Only an
 * explicit "tracking/parcel number: X" statement counts, X must contain a digit, and a link is
 * taken only if the note has one. Anything vaguer is not tracking: the owner is asked instead.
 */
const NOTE_NUMBER =
  /\b(?:tracking|parcel|consignment)\s*(?:number|no\.?|code|id)\s*(?:is\s*)?[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,38})/i;
export function trackingFromNotes(notes: unknown): WooTracking[] {
  if (!Array.isArray(notes)) return [];
  const out: WooTracking[] = [];
  for (const n of notes) {
    const o = obj(n);
    if (!o || o.customer_note === false || typeof o.note !== 'string') continue;
    const note = stripHtml(o.note);
    const num = NOTE_NUMBER.exec(note)?.[1];
    if (!num || !/\d/.test(num)) continue;
    const rawNote = o.note;
    const link =
      /href=["'](https:\/\/[^"'\s]+)["']/i.exec(rawNote)?.[1] ??
      /https:\/\/[^\s<>"']+/.exec(note)?.[0]?.replace(/[.,;)]+$/, '') ??
      null;
    out.push({
      provider: null,
      number: num,
      url: cleanUrl(link),
      shippedAt: shipped(
        o.date_created_gmt ? `${String(o.date_created_gmt).replace(/Z?$/, 'Z')}` : null,
      ),
    });
  }
  return out.slice(0, 3);
}

export const toShipments = (
  trackings: WooTracking[],
  items: { name: string; quantity: number }[],
  fallbackShippedAt: string | null,
): OrderShipment[] =>
  trackings.map((t, i) => ({
    createdAt: t.shippedAt ?? fallbackShippedAt,
    carrier: t.provider,
    trackingNumber: t.number,
    trackingUrl: t.url,
    estimatedDeliveryAt: null,
    deliveredAt: null,
    inTransitAt: null,
    items: i === 0 ? items : [],
  }));
