import { describe, expect, it } from 'vitest';
import { asksForChange, mentionsChargeback, parseOrderRefs } from '../src/index.ts';

describe('order numbers in an e-mail', () => {
  it.each([
    ['Where is my order #1234?', ['1234'], true],
    ['Hi, status of order 1234 please', ['1234'], true],
    ['Order no. 1002 has not arrived', ['1002'], true],
    ['Bestellung Nr. 4567: wo ist das Paket?', ['4567'], true],
    ['Ma commande n°8901 est où ?', ['8901'], true],
    ['¿Dónde está mi pedido 2345?', ['2345'], true],
    ['Kur ir mans pasūtījums 5566?', ['5566'], true],
    ['Waar is bestelling #7788', ['7788'], true],
    ['order:  # 1002', ['1002'], true],
    ['Where is #1002 and #1003?', ['1002', '1003'], true],
    ['#1002 and again #1002', ['1002'], true],
    ['order 01002', ['1002'], true],
    // a bare number counts only when it is the one candidate
    ['Hi, where is 1234?', ['1234'], false],
    ['Hi, where are 1234 and 5678?', [], false],
    // not order numbers
    ['I ordered on 12.10.2026 for €1234 and 3 candles', [], false],
    ['I paid 1234,50 EUR at 10:30 on 2026-10-01', [], false],
    ['I ordered in 2026 and nothing came', [], false],
    ['Call me on +371 2000 1234', [], false],
    ['Where is my parcel?', [], false],
    ['order #12', [], false],
  ])('%s', (text, numbers, explicit) => {
    expect(parseOrderRefs(text)).toEqual({ numbers, explicit });
  });

  it('does not take a tracking number or e-mail address for an order number', () => {
    expect(parseOrderRefs('Tracking LV987654321, mail anna1234@example.com').numbers).toEqual([]);
  });
});

describe('requests an order lookup must not answer', () => {
  it.each([
    'I want a refund for my order',
    'Can I send it back? I want to return the candles',
    'Please cancel my order #1002',
    'Please change the delivery address to Brivibas 1',
    'Bitte die Lieferadresse ändern',
    'Quiero cambiar la dirección de envío',
    'Vēlos atcelt pasūtījumu',
  ])('%s', (t) => expect(asksForChange(t)).toBe(true));

  it.each(['Where is my order #1002?', 'Has it shipped yet? Thanks', 'Order 1234 status'])(
    'a plain status question is not a change request: %s',
    (t) => expect(asksForChange(t)).toBe(false),
  );

  it.each([
    'I will start a chargeback with my bank',
    'I will dispute the charge with PayPal',
    'Ich leite eine Rückbuchung ein',
  ])('chargeback: %s', (t) => expect(mentionsChargeback(t)).toBe(true));
  it('no chargeback in a normal question', () =>
    expect(mentionsChargeback('Where is my order?')).toBe(false));
});
