import { describe, expect, it } from 'vitest';
import {
  acceptExtractedItems,
  clarifyingQuestionText,
  computeTotals,
  decideQuoteSend,
  formatQty,
  formatQuoteNumber,
  formatRate,
  labelItems,
  languageFromAcceptHeader,
  QUOTE_LABELS,
  QUOTE_LANGUAGES,
  quoteLabels,
  quotePdfFileName,
  lineTotalCents,
  parseMoney,
  parsePriceCsv,
  quantitiesInText,
  quoteCoverText,
  renderQuotePdf,
  signQuoteToken,
  validateMapping,
  verifyQuoteToken,
  type PricedItem,
  type QuoteMapping,
} from '../src/index.ts';

const item = (
  id: string,
  name: string,
  cents: number,
  extra: Partial<PricedItem> = {},
): PricedItem => ({
  id,
  name,
  description: null,
  unit: 'pcs',
  unitPriceCents: cents,
  minQty: null,
  maxQty: null,
  vatNote: null,
  ...extra,
});
const candle = item('i1', 'Lavender candle, 200 g', 2400, { maxQty: 200 });
const labels = item('i3', 'Custom label printing', 4500, { unit: 'order', minQty: 1, maxQty: 1 });
const favour = item('i5', 'Wedding favour candle', 650, { minQty: 20, maxQty: 500 });
const hours = item('i7', 'Candle-making workshop', 3500, { unit: 'hour' });
const L = labelItems([candle, labels, favour, hours]); // P1..P4
const map = (lines: QuoteMapping['lines'], unmapped: string[] = []): QuoteMapping => ({
  lines,
  unmapped,
  language: 'en',
});

describe('money', () => {
  it('parses prices as written in different countries', () => {
    expect(parseMoney('24')).toBe(2400);
    expect(parseMoney('24,5')).toBe(2450);
    expect(parseMoney('24.50')).toBe(2450);
    expect(parseMoney('1 234,50')).toBe(123450);
    expect(parseMoney('1.234,50 €')).toBe(123450);
    expect(parseMoney('€1,234.50')).toBe(123450);
    expect(parseMoney('1,234')).toBe(123400);
    expect(parseMoney('EUR 6.5')).toBe(650);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
  });

  it('line totals: quantity × unit price in cents, half-up', () => {
    expect(lineTotalCents(12, 2400)).toBe(28800);
    expect(lineTotalCents(2.5, 3500)).toBe(8750);
    expect(lineTotalCents(0.33, 1001)).toBe(330); // 330.33 → 330
    expect(lineTotalCents(0.5, 1001)).toBe(501); // 500.5 → 501
    expect(() => lineTotalCents(0, 100)).toThrow();
    expect(() => lineTotalCents(1.234, 100)).toThrow();
  });

  it('quote numbers', () => {
    expect(formatQuoteNumber(2026, 7)).toBe('Q-2026-0007');
    expect(formatQuoteNumber(2026, 12345)).toBe('Q-2026-12345');
  });
});

describe('VAT', () => {
  it('exclusive: VAT added on the whole quote, rounded once', () => {
    expect(computeTotals([28800, 4500], { mode: 'exclusive', ratePercent: 21 })).toEqual({
      subtotalCents: 33300,
      vatCents: 6993,
      totalCents: 40293,
    });
    // Rounded on the total, not per line: 3 × 0.05 at 21% = 0.0315 → 0.03.
    expect(computeTotals([5, 5, 5], { mode: 'exclusive', ratePercent: 21 }).vatCents).toBe(3);
    expect(computeTotals([1000], { mode: 'exclusive', ratePercent: 5.5 }).vatCents).toBe(55);
  });

  it('inclusive: the total is the sum; VAT is the part of it that is VAT', () => {
    expect(computeTotals([12100], { mode: 'inclusive', ratePercent: 21 })).toEqual({
      subtotalCents: 12100,
      vatCents: 2100,
      totalCents: 12100,
    });
    expect(computeTotals([1000], { mode: 'inclusive', ratePercent: 21 })).toEqual({
      subtotalCents: 1000,
      vatCents: 174, // 1000 − 826.45 → 826
      totalCents: 1000,
    });
  });

  it('none: no VAT at all', () => {
    expect(computeTotals([28800, 4500], { mode: 'none', ratePercent: 21 })).toEqual({
      subtotalCents: 33300,
      vatCents: 0,
      totalCents: 33300,
    });
  });
});

describe('mapping to the price list', () => {
  const email =
    'Hi, could you send a price for 12 lavender candles with our logo on them? Thanks, Anna';

  it('keeps lines whose label, quantity and limits check out', () => {
    const v = validateMapping(
      map([
        { item: 'P1', qty: 12, customer_text: '12 lavender candles' },
        { item: 'p2', qty: 1, customer_text: 'with our logo on them' },
      ]),
      L,
      email,
    );
    expect(v.unmapped).toEqual([]);
    expect(v.lines.map((l) => [l.item.id, l.qty, l.qtyAssumed])).toEqual([
      ['i1', 12, false],
      ['i3', 1, true],
    ]);
  });

  it('an unknown label is never quoted', () => {
    const v = validateMapping(
      map([{ item: 'P9', qty: 12, customer_text: 'scented diffuser' }]),
      L,
      email,
    );
    expect(v.lines).toEqual([]);
    expect(v.unmapped).toEqual([{ customerText: 'scented diffuser', reason: 'unknown_item' }]);
  });

  it('a quantity the customer did not write is rejected (1 may be assumed)', () => {
    const v = validateMapping(
      map([{ item: 'P1', qty: 20, customer_text: 'lavender candles' }]),
      L,
      email,
    );
    expect(v.unmapped[0]!.reason).toBe('quantity_not_in_email');
    const one = validateMapping(
      map([{ item: 'P1', qty: 1, customer_text: 'a lavender candle' }]),
      L,
      'Price for a lavender candle?',
    );
    expect(one.lines[0]).toMatchObject({ qty: 1, qtyAssumed: true });
  });

  it('written-out quantities and decimal hours count', () => {
    expect(quantitiesInText('zwölf Kerzen, 2,5 Stunden, twelve')).toEqual(new Set([12, 2.5]));
    const v = validateMapping(
      map([{ item: 'P4', qty: 2.5, customer_text: 'workshop' }]),
      L,
      'A workshop for 2,5 hours please',
    );
    expect(v.lines[0]!.qty).toBe(2.5);
  });

  it('min and max quantities are enforced', () => {
    const below = validateMapping(
      map([{ item: 'P3', qty: 10, customer_text: '10 favour candles' }]),
      L,
      '10 favour candles',
    );
    expect(below.unmapped[0]).toMatchObject({ reason: 'below_minimum', item: favour });
    const above = validateMapping(
      map([{ item: 'P1', qty: 250, customer_text: '250 candles' }]),
      L,
      '250 candles',
    );
    expect(above.unmapped[0]!.reason).toBe('above_maximum');
  });

  it('invalid quantities and duplicate items are unmapped; the model’s unmapped list is kept', () => {
    const v = validateMapping(
      map(
        [
          { item: 'P1', qty: -2, customer_text: 'candles' },
          { item: 'P4', qty: 2, customer_text: 'workshop' },
          { item: 'P4', qty: 2, customer_text: 'workshop again' },
        ],
        ['a scented diffuser'],
      ),
      L,
      'candles, a 2 hour workshop, a scented diffuser',
    );
    expect(v.lines.map((l) => l.item.id)).toEqual(['i7']);
    expect(v.unmapped.map((u) => u.reason)).toEqual([
      'not_on_price_list',
      'invalid_quantity',
      'duplicate',
    ]);
  });
});

describe('auto-send limit', () => {
  const ok = {
    lines: [{ item: candle, qty: 12, customerText: '', qtyAssumed: false }],
    unmapped: [],
  };

  it('modes 2 and 3 auto-send a fully mapped quote at or under the limit', () => {
    expect(
      decideQuoteSend({ mode: 'auto_send', mapping: ok, totalCents: 50000, limitCents: 50000 }),
    ).toEqual({
      action: 'auto_send',
      reasons: [],
    });
    expect(
      decideQuoteSend({ mode: 'full_auto', mapping: ok, totalCents: 1, limitCents: 50000 }).action,
    ).toBe('auto_send');
  });

  it('holds a quote over the limit, with anything unmapped, or in mode 1', () => {
    expect(
      decideQuoteSend({ mode: 'auto_send', mapping: ok, totalCents: 50001, limitCents: 50000 }),
    ).toEqual({
      action: 'draft',
      reasons: ['quote_over_limit'],
    });
    expect(
      decideQuoteSend({
        mode: 'auto_send',
        mapping: { ...ok, unmapped: [{ customerText: 'diffuser', reason: 'not_on_price_list' }] },
        totalCents: 100,
        limitCents: 50000,
      }).reasons,
    ).toEqual(['quote_unmapped']);
    expect(
      decideQuoteSend({ mode: 'draft_only', mapping: ok, totalCents: 100, limitCents: 50000 })
        .reasons,
    ).toEqual(['tenant_draft_only']);
    expect(
      decideQuoteSend({
        mode: 'auto_send',
        mapping: ok,
        totalCents: 100,
        limitCents: 50000,
        guardReasons: ['sender_cap_reached'],
      }).action,
    ).toBe('draft');
  });
});

describe('price list CSV', () => {
  it('reads comma and semicolon files, decimal commas, and reports bad rows', () => {
    const r = parsePriceCsv(
      'Name;Description;Unit;Unit price;Min qty;Max qty;VAT note\n' +
        'Lavender candle;Soy wax;pcs;24,00;;200;\n' +
        '"Gift box; 3 candles";"Lavender, amber";box;65;;;\n' +
        ';no name;pcs;5;;;\n' +
        'Tealights;;pack;abc;;;\n' +
        'Favour candle;;pcs;6,50;20;10;\n',
    );
    expect(r.headerError).toBeUndefined();
    expect(r.rows[0]).toMatchObject({
      line: 2,
      item: { name: 'Lavender candle', unitPriceCents: 2400, maxQty: 200, minQty: null },
    });
    expect(r.rows[1]).toMatchObject({
      item: { name: 'Gift box; 3 candles', description: 'Lavender, amber', unitPriceCents: 6500 },
    });
    expect(r.rows.slice(2).map((x) => x.error)).toEqual([
      'name is empty',
      '“abc” is not a price',
      'min_qty is larger than max_qty',
    ]);
  });

  it('needs a header with name and price', () => {
    expect(parsePriceCsv('Lavender candle,24').headerError).toMatch(/name and unit_price/);
    expect(parsePriceCsv('name,price\nCandle,24').rows[0]!.item!.unit).toBe('pcs');
  });
});

describe('reading a price list document', () => {
  it('keeps only items whose price is written in the document', () => {
    const text =
      'PRICE LIST 2026\nWedding favour candle 50 g ....... 6,50 €\nDelivery in Latvia 4.90\n';
    const r = acceptExtractedItems(
      {
        items: [
          {
            name: 'Wedding favour candle 50 g',
            description: null,
            unit: 'pcs',
            price: '6,50',
            min_qty: 20,
            max_qty: null,
          },
          {
            name: 'Delivery in Latvia',
            description: null,
            unit: null,
            price: '4.90',
            min_qty: null,
            max_qty: null,
          },
          {
            name: 'Invented item',
            description: null,
            unit: null,
            price: '99.00',
            min_qty: null,
            max_qty: null,
          },
        ],
      },
      text,
    );
    expect(r.items.map((i) => [i.name, i.unitPriceCents, i.unit])).toEqual([
      ['Wedding favour candle 50 g', 650, 'pcs'],
      ['Delivery in Latvia', 490, 'pcs'],
    ]);
    expect(r.dropped).toEqual([
      { name: 'Invented item', reason: 'price not found in the document' },
    ]);
  });
});

describe('texts and links', () => {
  it('the cover reply is filled in by code, in the customer’s language', () => {
    const t = quoteCoverText({
      language: 'lv',
      customerName: 'Anna',
      number: 'Q-2026-0007',
      lines: [{ qty: 12, name: 'Lavender candle' }],
      totalCents: 40293,
      currency: 'EUR',
      vatMode: 'exclusive',
      validUntil: new Date('2026-10-10T00:00:00Z'),
      acceptUrl: 'https://app.noctiv.io/api/q/x',
    });
    expect(t).toContain('Labdien, Anna!');
    expect(t).toContain('Q-2026-0007');
    expect(t).toContain('12 × Lavender candle');
    expect(t).toMatch(/402,93\s€ ar PVN/);
    expect(t).toContain('https://app.noctiv.io/api/q/x');
  });

  it('the clarifying question names what was not matched and the limits', () => {
    const t = clarifyingQuestionText({
      language: 'en',
      customerName: null,
      unmapped: [
        { customerText: 'a scented diffuser', reason: 'not_on_price_list' },
        { customerText: '10 favour candles', reason: 'below_minimum', item: favour },
      ],
    });
    expect(t).toContain('“a scented diffuser” / “10 favour candles”');
    expect(t).toContain('For Wedding favour candle we can quote 20–500 pcs.');
    expect(t.split('?').length).toBe(2); // one question
  });

  it('accept links are signed and expire after the validity plus 30 days', () => {
    const secret = 'x'.repeat(40);
    const c = {
      tenantId: '8c7d0a8e-3f7e-4a8e-9a55-3a5b8f0c2d11',
      quoteId: '1c7d0a8e-3f7e-4a8e-9a55-3a5b8f0c2d12',
    };
    const tok = signQuoteToken({ ...c, validUntil: new Date('2026-10-10T00:00:00Z') }, secret);
    expect(verifyQuoteToken(tok, secret, new Date('2026-10-20T00:00:00Z'))).toMatchObject({
      ok: true,
      claims: c,
    });
    expect(verifyQuoteToken(tok, secret, new Date('2026-11-10T00:00:01Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyQuoteToken(tok, 'y'.repeat(40))).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyQuoteToken(`${tok}x`, secret)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('PDF', () => {
  it('renders a quote with Latvian characters and the euro sign', async () => {
    const pdf = await renderQuotePdf({
      number: 'Q-2026-0007',
      language: 'lv',
      createdAt: new Date('2026-09-26T08:05:00Z'),
      validUntil: new Date('2026-10-10T00:00:00Z'),
      customer: { name: 'Anna Bērziņa', email: 'anna@example.test' },
      currency: 'EUR',
      vatMode: 'exclusive',
      vatRatePercent: 21,
      lines: [
        {
          name: 'Lavender candle, 200 g',
          unit: 'pcs',
          qty: 12,
          unitPriceCents: 2400,
          lineTotalCents: 28800,
          vatNote: null,
        },
        {
          name: 'Custom label printing',
          unit: 'order',
          qty: 1,
          unitPriceCents: 4500,
          lineTotalCents: 4500,
          vatNote: 'reduced rate',
        },
      ],
      subtotalCents: 33300,
      vatCents: 6993,
      totalCents: 40293,
      notes: 'Ražots Rīgā.',
      acceptUrl: 'https://app.noctiv.io/api/q/token',
      brand: {
        companyName: 'Nordlicht Candles',
        color: '#B4532A',
        website: 'https://nordlicht.test',
        phone: null,
        address: 'Brīvības iela 1, Rīga',
        logo: null,
      },
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
    expect(pdf.length).toBeLessThan(200_000);
    // The accept link is a real link annotation.
    expect(pdf.toString('latin1')).toContain('https://app.noctiv.io/api/q/token');
  });
});

describe('translations (PDF and accept page)', () => {
  it('every language has every label, and none is left in English by mistake', () => {
    const keys = Object.keys(QUOTE_LABELS.en).sort();
    for (const l of QUOTE_LANGUAGES) {
      expect(Object.keys(QUOTE_LABELS[l]).sort()).toEqual(keys);
      if (l !== 'en') {
        expect(QUOTE_LABELS[l].acceptButton).not.toBe(QUOTE_LABELS.en.acceptButton);
        expect(QUOTE_LABELS[l].vat('21')).toContain('21');
      }
    }
  });

  it("follows the quote's language, English otherwise", () => {
    expect(quoteLabels('lv').acceptButton).toBe('Apstiprināt piedāvājumu');
    expect(quoteLabels('de').quote).toBe('Angebot');
    expect(quoteLabels('ja').quote).toBe('Quote');
    expect(quoteLabels(null).quote).toBe('Quote');
  });

  it('writes quantities and rates the local way', () => {
    expect(formatQty(2.5, 'lv-LV')).toBe('2,5');
    expect(formatQty(2.5, 'en-GB')).toBe('2.5');
    expect(formatQty(1200, 'de-DE')).toBe('1200');
    expect(formatRate(5.5, 'de')).toBe('5,5');
    expect(formatRate(21, 'fr')).toBe('21');
  });

  it('names the attachment in the language, ASCII only', () => {
    expect(quotePdfFileName('Q-2026-0001', 'lv')).toBe('Piedavajums-Q-2026-0001.pdf');
    expect(quotePdfFileName('Q-2026-0001', 'de')).toBe('Angebot-Q-2026-0001.pdf');
    expect(quotePdfFileName('Q-2026-0001', null)).toBe('Quote-Q-2026-0001.pdf');
  });

  it('pages without a quote use the browser language', () => {
    expect(languageFromAcceptHeader('lv-LV,lv;q=0.9,en;q=0.8')).toBe('lv');
    expect(languageFromAcceptHeader('ja,de;q=0.5')).toBe('de');
    expect(languageFromAcceptHeader(undefined)).toBe('en');
  });

  it('renders a PDF in every language', async () => {
    for (const language of QUOTE_LANGUAGES) {
      const pdf = await renderQuotePdf({
        number: 'Q-2026-0001',
        language,
        createdAt: new Date('2026-09-26T00:00:00Z'),
        validUntil: new Date('2026-10-10T00:00:00Z'),
        customer: { name: 'Anna', email: 'anna@example.com' },
        currency: 'EUR',
        vatMode: 'inclusive',
        vatRatePercent: 5.5,
        lines: [
          {
            name: 'Candle',
            unit: 'pcs',
            qty: 2.5,
            unitPriceCents: 1000,
            lineTotalCents: 2500,
            vatNote: null,
          },
        ],
        subtotalCents: 2500,
        vatCents: 130,
        totalCents: 2500,
        notes: null,
        acceptUrl: 'https://app.noctiv.io/api/q/x',
        brand: {
          companyName: 'N',
          color: null,
          website: null,
          phone: null,
          address: null,
          logo: null,
        },
      });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });
});
