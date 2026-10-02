import type { OrderRecord } from './types.ts';

/**
 * The minimum a reply about an order needs. Nothing about payment methods,
 * amounts, addresses or the customer: number, dates, statuses, shipments and
 * the names of the items that shipped.
 */
export interface OrderFacts {
  /** "#1002" */
  orderName: string;
  /** YYYY-MM-DD */
  createdOn: string | null;
  payment:
    | 'paid'
    | 'pending'
    | 'authorized'
    | 'partially_paid'
    | 'refunded'
    | 'partially_refunded'
    | 'voided'
    | 'other';
  fulfillment: 'not_shipped' | 'shipped' | 'other';
  /** Shopify's own status when it is neither of the two above (partly shipped, on hold, …). */
  fulfillmentDetail: string | null;
  cancelled: boolean;
  shipments: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedOn: string | null;
    deliveredOn: string | null;
    expectedOn: string | null;
    items: { name: string; quantity: number }[];
  }[];
}

const day = (iso: string | null): string | null =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;

/** Only https links, only what the carrier gave Shopify. */
const safeUrl = (u: string | null): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export function toFacts(o: OrderRecord): OrderFacts {
  return {
    orderName: o.name,
    createdOn: day(o.createdAt),
    payment: o.payment,
    fulfillment: o.fulfillment,
    fulfillmentDetail: o.fulfillmentDetail,
    cancelled: Boolean(o.cancelledAt),
    shipments: o.shipments.map((s) => ({
      carrier: s.carrier,
      trackingNumber: s.trackingNumber,
      trackingUrl: safeUrl(s.trackingUrl),
      shippedOn: day(s.createdAt),
      deliveredOn: day(s.deliveredAt),
      expectedOn: day(s.estimatedDeliveryAt),
      items: s.items.slice(0, 10),
    })),
  };
}

const PAYMENT_TEXT: Record<OrderFacts['payment'], string> = {
  paid: 'paid',
  pending: 'payment pending',
  authorized: 'payment authorised, not yet captured',
  partially_paid: 'partially paid',
  refunded: 'refunded',
  partially_refunded: 'partially refunded',
  voided: 'payment voided',
  other: 'payment status unknown',
};

/**
 * The only excerpt the model sees for an order. English key: value lines; the
 * model writes them in the customer's language. Every fact the reply may state
 * is in here, and the claim check holds the reply to it.
 */
export function factsForModel(f: OrderFacts): string {
  const lines = [
    `Order ${f.orderName}${f.createdOn ? `, placed on ${f.createdOn}` : ''}`,
    `Payment: ${PAYMENT_TEXT[f.payment]}`,
    `Shipping: ${f.fulfillment === 'shipped' ? 'shipped' : f.fulfillment === 'not_shipped' ? 'not shipped yet' : (f.fulfillmentDetail ?? 'unknown')}`,
  ];
  f.shipments.forEach((s, i) => {
    const parts = [
      s.carrier && `carrier: ${s.carrier}`,
      s.trackingNumber && `tracking number: ${s.trackingNumber}`,
      s.trackingUrl && `tracking link: ${s.trackingUrl}`,
      s.shippedOn && `shipped on ${s.shippedOn}`,
      s.deliveredOn && `delivered on ${s.deliveredOn}`,
      s.expectedOn && !s.deliveredOn && `expected delivery: ${s.expectedOn}`,
      s.items.length &&
        `items: ${s.items.map((x) => (x.quantity > 1 ? `${x.name} x${x.quantity}` : x.name)).join(', ')}`,
    ].filter(Boolean);
    lines.push(`Shipment ${i + 1}: ${parts.join('; ') || 'no details'}`);
  });
  return lines.join('\n');
}

/** What the conversation's "Order found in Shopify" card shows (stored with the message). */
export interface OrderLookupSummary {
  /** Which shop platform the order came from (the card says "Order found in Shopify"). */
  platform?: 'shopify' | 'woocommerce';
  result: 'found' | 'escalated';
  /** Reason code when escalated (order_not_found, order_identity_mismatch, …). */
  reason?: string;
  /** From a found order: its number and status. For not-found / mismatch this is only what the customer wrote. */
  orderName?: string;
  payment?: OrderFacts['payment'];
  fulfillment?: string;
  cancelled?: boolean;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedOn?: string | null;
  deliveredOn?: string | null;
  checkedAt: string;
}

export function summaryOf(
  f: OrderFacts,
  checkedAt: Date,
  extra: {
    result: OrderLookupSummary['result'];
    reason?: string;
    platform?: OrderLookupSummary['platform'];
  } = { result: 'found' },
): OrderLookupSummary {
  const s = f.shipments.find((x) => x.trackingNumber || x.trackingUrl) ?? f.shipments[0];
  return {
    ...(extra.platform ? { platform: extra.platform } : {}),
    result: extra.result,
    ...(extra.reason ? { reason: extra.reason } : {}),
    orderName: f.orderName,
    payment: f.payment,
    fulfillment: f.fulfillment === 'other' ? (f.fulfillmentDetail ?? 'other') : f.fulfillment,
    cancelled: f.cancelled,
    carrier: s?.carrier ?? null,
    trackingNumber: s?.trackingNumber ?? null,
    trackingUrl: s?.trackingUrl ?? null,
    shippedOn: s?.shippedOn ?? null,
    deliveredOn: s?.deliveredOn ?? null,
    checkedAt: checkedAt.toISOString(),
  };
}
