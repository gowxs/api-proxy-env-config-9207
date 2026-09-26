import { describe, expect, it } from 'vitest';
import {
  derivedAmounts,
  detectClaims,
  isSupportedLanguage,
  numberReadings,
  quantitiesIn,
  verifyClaims,
} from '../src/index.ts';
import { NBSP } from './fixtures/chars.ts';

const kinds = (text: string) => detectClaims(text).map((c) => c.kind);

describe('numberReadings', () => {
  it.each([
    ['24', ['24']],
    ['24.00', ['24']],
    ['19,99', ['19.99']],
    ['1 200,50', ['1200.5']],
    [`1${NBSP}200`, ['1200']],
    ['1.200,50', ['1200.5']],
    ['1,200.50', ['1200.5']],
    ['1.200', ['1200', '1.2']],
    ['1,200', ['1200', '1.2']],
  ])('%s → %o', (raw, readings) => {
    expect(numberReadings(raw).sort()).toEqual([...readings].sort());
  });
});

describe('detectClaims', () => {
  it.each([
    // en
    ['The set costs 65 EUR.', ['money']],
    ['Only €9.50 today.', ['money', 'relative_time']],
    ['Get 10% off with a coupon.', ['percentage', 'discount', 'discount']],
    ['Delivery takes 2-3 business days.', ['duration']],
    ['We are open Monday to Friday, 9:00-17:00.', ['weekday', 'weekday', 'time', 'time']],
    ['It is back in stock and ships free of charge.', ['availability', 'free']],
    ['We guarantee delivery by 12 March.', ['guarantee', 'date']],
    ['Your parcel arrives on 2026-10-05.', ['date']],
    // de
    ['Der Preis beträgt 1.200,50 € und der Versand ist kostenlos.', ['money', 'free']],
    ['Wir liefern morgen, 20% Rabatt.', ['relative_time', 'percentage', 'discount']],
    ['Lieferzeit 5 Werktage, sofort lieferbar.', ['duration', 'availability']],
    // nl
    [
      'Morgen geleverd, 15% korting en gratis verzending.',
      ['relative_time', 'percentage', 'discount', 'free'],
    ],
    ['Het product is op voorraad.', ['availability']],
    // fr
    ['Livraison gratuite sous 48 heures, en stock.', ['free', 'duration', 'availability']],
    ['Remboursement garanti le 3 avril.', ['guarantee', 'guarantee', 'date']],
    // es
    [
      'Envío gratis mañana, 15 % de descuento.',
      ['free', 'relative_time', 'percentage', 'discount'],
    ],
    ['Disponible en stock por 30 euros.', ['availability', 'availability', 'money']],
    // lv
    ['Piegāde rīt bez maksas, cena 19,99 eiro.', ['relative_time', 'free', 'money']],
    [
      'Atlaide 10% un garantija 2 gadi, 3 darba dienās.',
      ['discount', 'percentage', 'guarantee', 'number', 'duration'],
    ],
  ])('%s', (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  it.each([
    'Thank you for contacting us today!',
    'Guten Morgen und vielen Dank für Ihre Nachricht.',
    'Goedemorgen, bedankt voor uw bericht.',
    'Te escribimos por la mañana.',
    'Feel free to reach out if you have questions.',
    '1. Choose a scent\n2. Add it to your cart',
    'Best regards and have a lovely weekend.',
  ])('does not flag harmless phrasing: %s', (text) => {
    expect(kinds(text)).toEqual([]);
  });
});

describe('verifyClaims', () => {
  const kb = [
    'Candles cost 24 EUR each; the gift set is 1.200,00 EUR for businesses. Shipping takes 2-3 business days.',
    'Open Monday to Friday 10:00-18:00. 10% discount for newsletter subscribers. Items marked "in stock" ship next day.',
  ];
  const check = (reply: string, inboundText = '') =>
    verifyClaims(reply, { citedSources: kb, inboundText }).unsupported.map(
      (c) => `${c.kind}:${c.text}`,
    );

  it('accepts claims backed by the cited sources, in any number format', () => {
    expect(
      check('A candle is €24.00 and the business set 1,200 EUR; shipping 2 to 3 days.'),
    ).toEqual([]);
    expect(
      check('We are open on Friday until 18:00 and newsletter subscribers get a 10% discount.'),
    ).toEqual([]);
    expect(check('This item is in stock and ships next day.')).toEqual([]);
  });

  it('rejects numbers, dates and commitments the sources do not state', () => {
    expect(check('A candle is 22 EUR.')).toEqual(['money:22 eur']);
    expect(check('You get 15% off.')).toEqual(['percentage:15%']);
    expect(check('It ships within 24 hours.')).toEqual(['duration:24 hours']);
    expect(check('We are open on Saturday.')).toEqual(['weekday:saturday']);
    expect(check('Delivery on 12.11.2026.')).toEqual(['date:12.11.2026']);
    expect(check('Shipping is free and guaranteed.')).toEqual([
      'free:free',
      'guarantee:guaranteed',
    ]);
  });

  it('lets bare numbers echo the customer email but never prices from it', () => {
    expect(
      check('Your order 55123 for 3 candles is noted.', 'Order 55123, 3 candles please'),
    ).toEqual([]);
    expect(check('Yes, 3 candles for 30 EUR.', 'Can I get 3 candles for 30 EUR?')).toEqual([
      'money:30 eur',
    ]);
  });
});

describe('verifyClaims: totals worked out from knowledge-base prices (D1)', () => {
  const kb = ['Classic candle £18. Gift box £3.95. Large candle £29.'];
  const check = (reply: string, inboundText: string) =>
    verifyClaims(reply, { citedSources: kb, inboundText }).unsupported.map(
      (c) => `${c.kind}:${c.text}`,
    );

  it('accepts quantity × price with the quantity from the customer e-mail', () => {
    expect(check('Two classic candles come to £36.', 'Can I have two classic candles?')).toEqual(
      [],
    );
    expect(check('3 candles are £54 in total.', 'I need 3 candles')).toEqual([]);
    expect(check('Zwei Kerzen kosten 36 £.', 'Ich möchte zwei Kerzen')).toEqual([]);
  });

  it('accepts sums of different items and of quantity totals', () => {
    expect(check('With the gift box it is £39.95.', 'two classic candles and a gift box')).toEqual(
      [],
    );
    expect(check('A classic and a large candle: £47.', 'one classic, one large')).toEqual([]);
    expect(check('Total £68.95.', 'two classic candles, a large one and a gift box')).toEqual([]);
  });

  it('still blocks amounts the code cannot reproduce', () => {
    expect(check('Two classic candles come to £37.', 'two classic candles')).toEqual(['money:£37']);
    // No quantity in the e-mail: a price is never doubled on its own.
    expect(check('That is £36.', 'a classic candle please')).toEqual(['money:£36']);
    // A discount the knowledge base does not state.
    expect(check('Both for £32.40.', 'two classic candles')).toEqual(['money:£32.40']);
    expect(check('Delivery on 12.11.', '')).toEqual(['date:12.11.']);
  });

  it('reads quantities in digits and words', () => {
    expect(quantitiesIn('two candles and 4 boxes, a pair of mugs').sort()).toEqual([2, 4]);
    const d = derivedAmounts(['18', '3.95'], [2]);
    for (const a of ['18', '3.95', '36', '7.9', '21.95', '39.95']) expect(d.has(a)).toBe(true);
    expect(d.has('37')).toBe(false);
    expect([...derivedAmounts(['18'], [])]).toEqual(['18']);
  });
});

describe('supported languages (Q14)', () => {
  it('covers exactly EN, DE, NL, FR, ES, LV', () => {
    expect(['en', 'de', 'nl', 'fr', 'es', 'lv'].every(isSupportedLanguage)).toBe(true);
    expect(isSupportedLanguage('ru')).toBe(false);
    expect(isSupportedLanguage('und')).toBe(false);
  });
});
