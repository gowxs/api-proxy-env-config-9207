import type { OrderRecord } from './types.ts';
import { toFacts, type OrderFacts } from './facts.ts';
import { emailMatches } from './identity.ts';

/** Why an order e-mail goes to the owner instead of getting an answer. Shown in the app, so keep the codes stable. */
export const ORDER_ESCALATIONS = [
  'order_not_found',
  'order_ambiguous',
  'order_identity_mismatch',
  'order_cancelled_or_refunded',
  'order_partially_fulfilled',
  'order_fulfilled_no_tracking',
  'order_shipment_stale',
  'order_change_request',
  'order_chargeback',
  /** Shopify could not be asked (connection broken, store busy): never guess. */
  'order_lookup_unavailable',
] as const;
export type OrderEscalation = (typeof ORDER_ESCALATIONS)[number];

export type OrderDecision =
  | {
      kind: 'reply';
      facts: OrderFacts;
      /** Fully verified and a normal status: the only case that may be sent without approval. */
      simple: boolean;
      /** Why it is not simple (empty when it is). */
      notSimple: string[];
    }
  | {
      kind: 'escalate';
      reason: OrderEscalation;
      /** Present only when the identity was verified (the owner's card may show it). */
      facts?: OrderFacts;
      /** A polite request for the order number and checkout e-mail may be suggested to the owner. */
      suggestVerification: boolean;
    };

export interface DecideInput {
  /** From parseOrderRefs: the distinct order numbers in the e-mail. */
  numbers: string[];
  /** The From address of the e-mail (never Reply-To). */
  sender: string;
  /** Orders found by that single number (only when numbers.length === 1). */
  byNumber: OrderRecord[];
  /** Orders found by the sender's address (only when there is no number). */
  byEmail: OrderRecord[];
  now: Date;
  /** Days without a shipping update before the owner is asked. */
  staleDays: number;
}

const DAY = 86_400_000;
const esc = (
  reason: OrderEscalation,
  suggestVerification = false,
  facts?: OrderFacts,
): OrderDecision => ({
  kind: 'escalate',
  reason,
  suggestVerification,
  ...(facts ? { facts } : {}),
});

/** Deterministic: this function, not the model, decides what happens with an order e-mail. */
export function decideOrder(i: DecideInput): OrderDecision {
  if (i.numbers.length > 1) return esc('order_ambiguous', true);

  let order: OrderRecord;
  if (i.numbers.length === 1) {
    if (i.byNumber.length === 0) return esc('order_not_found', true);
    if (i.byNumber.length > 1) return esc('order_ambiguous', true);
    order = i.byNumber[0]!;
    // The identity check comes before anything about the order is used.
    if (!emailMatches(i.sender, order)) return esc('order_identity_mismatch', true);
  } else {
    const mine = i.byEmail.filter((o) => emailMatches(i.sender, o));
    if (mine.length === 0) return esc('order_not_found', true);
    if (mine.length > 1) return esc('order_ambiguous', true);
    order = mine[0]!;
  }

  const facts = toFacts(order);
  if (facts.cancelled || ['refunded', 'partially_refunded', 'voided'].includes(facts.payment))
    return esc('order_cancelled_or_refunded', false, facts);
  if (facts.fulfillment === 'other') return esc('order_partially_fulfilled', false, facts);

  const stale = (since: number) => i.now.getTime() - since > i.staleDays * DAY;
  if (facts.fulfillment === 'shipped') {
    if (!facts.shipments.length || facts.shipments.some((s) => !s.trackingNumber && !s.trackingUrl))
      return esc('order_fulfilled_no_tracking', false, facts);
    const delivered = facts.shipments.every((s) => s.deliveredOn);
    if (!delivered) {
      const stamps = order.shipments.flatMap((s) =>
        [s.createdAt, s.inTransitAt].map((t) => (t ? Date.parse(t) : NaN)),
      );
      const last = Math.max(...stamps.filter((t) => !Number.isNaN(t)), -Infinity);
      if (last === -Infinity || stale(last)) return esc('order_shipment_stale', false, facts);
    }
  } else {
    const placed = Date.parse(order.createdAt);
    if (!Number.isNaN(placed) && stale(placed)) return esc('order_shipment_stale', false, facts);
  }

  const notSimple: string[] = [];
  if (facts.payment !== 'paid') notSimple.push('order_payment_not_paid');
  return { kind: 'reply', facts, simple: notSimple.length === 0, notSimple };
}
