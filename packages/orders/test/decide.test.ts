import { describe, expect, it } from 'vitest';
import { decideOrder, ORDER_ESCALATIONS, type OrderRecord } from '../src/index.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const shipment = (
  over: Partial<OrderRecord['shipments'][number]> = {},
): OrderRecord['shipments'][number] => ({
  createdAt: ago(3),
  carrier: 'Latvijas Pasts',
  trackingNumber: 'LV987654321',
  trackingUrl: 'https://tracking.example-carrier.test/LV987654321',
  estimatedDeliveryAt: null,
  deliveredAt: null,
  inTransitAt: ago(2),
  items: [{ name: 'Lavender candle', quantity: 2 }],
  ...over,
});
const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  name: '#1002',
  createdAt: ago(5),
  cancelledAt: null,
  email: 'anna@example.com',
  customerEmail: 'anna@example.com',
  payment: 'paid',
  fulfillment: 'shipped',
  fulfillmentDetail: null,
  shipments: [shipment()],
  ...over,
});
const base = { sender: 'anna@example.com', now: NOW, staleDays: 14 };
const byNumber = (o: OrderRecord[], extra = {}) =>
  decideOrder({ ...base, numbers: ['1002'], byNumber: o, byEmail: [], ...extra });
const byEmail = (o: OrderRecord[]) =>
  decideOrder({ ...base, numbers: [], byNumber: [], byEmail: o });

const reason = (d: ReturnType<typeof decideOrder>) =>
  d.kind === 'escalate' ? d.reason : `reply:${d.simple ? 'simple' : d.notSimple.join()}`;

describe('what happens with an order e-mail', () => {
  it('a verified, shipped order with tracking is a simple reply', () => {
    const d = byNumber([order()]);
    expect(d.kind).toBe('reply');
    if (d.kind === 'reply') {
      expect(d.simple).toBe(true);
      expect(d.facts).toMatchObject({
        orderName: '#1002',
        payment: 'paid',
        fulfillment: 'shipped',
      });
      expect(d.facts.shipments[0]).toMatchObject({
        trackingNumber: 'LV987654321',
        carrier: 'Latvijas Pasts',
      });
    }
  });
  it('a delivered order is a simple reply even when old', () => {
    const d = byNumber([
      order({
        shipments: [shipment({ createdAt: ago(40), inTransitAt: ago(38), deliveredAt: ago(35) })],
      }),
    ]);
    expect(reason(d)).toBe('reply:simple');
  });
  it('a paid order not shipped yet is a simple reply', () =>
    expect(
      reason(byNumber([order({ fulfillment: 'not_shipped', shipments: [], createdAt: ago(1) })])),
    ).toBe('reply:simple'));
  it('an order with payment still pending may be answered but is not simple (never auto)', () =>
    expect(reason(byNumber([order({ payment: 'pending' })]))).toBe('reply:order_payment_not_paid'));
  it("the sender's only order is used when no number is given", () =>
    expect(reason(byEmail([order()]))).toBe('reply:simple'));

  describe('hand to the owner', () => {
    it.each([
      ['not found by number', () => byNumber([]), 'order_not_found'],
      ['no order for the address and no number', () => byEmail([]), 'order_not_found'],
      [
        'several numbers in the e-mail',
        () => decideOrder({ ...base, numbers: ['1002', '1003'], byNumber: [], byEmail: [] }),
        'order_ambiguous',
      ],
      [
        'two orders with that number',
        () => byNumber([order(), order({ name: 'EN1002' })]),
        'order_ambiguous',
      ],
      [
        'several orders for the address',
        () => byEmail([order(), order({ name: '#1003' })]),
        'order_ambiguous',
      ],
      [
        "another person's order",
        () => byNumber([order({ email: 'someone@else.example', customerEmail: null })]),
        'order_identity_mismatch',
      ],
      [
        'cancelled',
        () => byNumber([order({ cancelledAt: ago(1) })]),
        'order_cancelled_or_refunded',
      ],
      ['refunded', () => byNumber([order({ payment: 'refunded' })]), 'order_cancelled_or_refunded'],
      [
        'partially refunded',
        () => byNumber([order({ payment: 'partially_refunded' })]),
        'order_cancelled_or_refunded',
      ],
      [
        'partially fulfilled',
        () => byNumber([order({ fulfillment: 'other', fulfillmentDetail: 'partially fulfilled' })]),
        'order_partially_fulfilled',
      ],
      [
        'on hold',
        () => byNumber([order({ fulfillment: 'other', fulfillmentDetail: 'on hold' })]),
        'order_partially_fulfilled',
      ],
      [
        'fulfilled without tracking',
        () =>
          byNumber([order({ shipments: [shipment({ trackingNumber: null, trackingUrl: null })] })]),
        'order_fulfilled_no_tracking',
      ],
      [
        'fulfilled with no shipment record',
        () => byNumber([order({ shipments: [] })]),
        'order_fulfilled_no_tracking',
      ],
      [
        'shipped long ago, no update',
        () =>
          byNumber([order({ shipments: [shipment({ createdAt: ago(20), inTransitAt: null })] })]),
        'order_shipment_stale',
      ],
      [
        'not shipped for too long',
        () => byNumber([order({ fulfillment: 'not_shipped', shipments: [], createdAt: ago(20) })]),
        'order_shipment_stale',
      ],
    ])('%s', (_n, run, expected) => expect(reason(run())).toBe(expected));

    it('the stale limit is a setting', () => {
      const o = order({ shipments: [shipment({ createdAt: ago(10), inTransitAt: ago(9) })] });
      expect(reason(byNumber([o]))).toBe('reply:simple');
      expect(reason(byNumber([o], { staleDays: 7 }))).toBe('order_shipment_stale');
    });
  });

  describe('a wrong identity reveals nothing', () => {
    it('the decision carries no order data at all', () => {
      const secret = order({
        name: '#1001',
        email: 'russell@example.com',
        customerEmail: 'russell@example.com',
        shipments: [
          shipment({
            trackingNumber: 'SECRET123',
            items: [{ name: 'Secret gift box', quantity: 1 }],
          }),
        ],
      });
      const d = decideOrder({
        ...base,
        sender: 'anna@example.com',
        numbers: ['1001'],
        byNumber: [secret],
        byEmail: [],
      });
      expect(d).toEqual({
        kind: 'escalate',
        reason: 'order_identity_mismatch',
        suggestVerification: true,
      });
      const text = JSON.stringify(d);
      for (const s of ['russell', 'SECRET123', 'Secret gift box', '#1001'])
        expect(text).not.toContain(s);
    });
    it('a similar address is a mismatch too (no +tag or dot folding)', () => {
      expect(reason(byNumber([order({ email: 'anna+x@example.com', customerEmail: null })]))).toBe(
        'order_identity_mismatch',
      );
    });
    it('orders found by address that do not match are ignored (search is fuzzy)', () => {
      expect(reason(byEmail([order({ email: 'other@example.com', customerEmail: null })]))).toBe(
        'order_not_found',
      );
    });
  });

  it('every escalation code is listed for the app', () => {
    expect(ORDER_ESCALATIONS).toContain('order_identity_mismatch');
    expect(new Set(ORDER_ESCALATIONS).size).toBe(ORDER_ESCALATIONS.length);
  });
});
