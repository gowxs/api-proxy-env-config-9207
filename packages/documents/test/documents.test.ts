import { describe, expect, it } from 'vitest';
import {
  applyCmrPrefill,
  datesIn,
  DOC_LABELS,
  documentCoverText,
  documentFileName,
  documentProblems,
  documentTotalsOf,
  emptyData,
  ibanValid,
  invoiceTotals,
  numbersIn,
  parseData,
  renderCmrPdf,
  renderDeliveryNotePdf,
  renderInvoicePdf,
  vatNoValid,
  type CmrData,
  type InvoiceData,
  type Seller,
} from '../src/index.ts';

const seller: Seller = {
  legalName: 'SIA Nordlicht',
  legalAddress: 'Brīvības iela 1, Rīga, LV-1010',
  regNo: '40003123456',
  vatNo: 'LV40003123456',
  bankName: 'Swedbank',
  iban: 'LV80 BANK 0000 4351 9500 1',
  bic: 'HABALV22',
  country: 'Latvia',
};
const today = '2026-09-26';
const invoice = (patch: Partial<InvoiceData> = {}): InvoiceData => ({
  ...parseData('invoice', {}),
  buyer: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: 'LV40103987654', email: '' },
  dueDate: '2026-10-10',
  lines: [
    { name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 },
    { name: 'Gift box', unit: 'box', qty: 2.5, unitPriceCents: 650 },
  ],
  ...patch,
});
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe('fields', () => {
  it('fills defaults and rejects unknown fields', () => {
    const d = parseData('invoice', {});
    expect(d).toMatchObject({ reverseCharge: false, lines: [], buyer: { name: '' } });
    expect(() => parseData('invoice', { hacked: true })).toThrow();
    expect(() => parseData('cmr', { goods: [{ packages: 1.5 }] })).toThrow();
    expect((emptyData('cmr') as CmrData).goods).toHaveLength(1);
  });

  it('checks IBAN and VAT numbers', () => {
    expect(ibanValid('LV80BANK0000435195001')).toBe(true);
    expect(ibanValid('LV80 BANK 0000 4351 9500 1')).toBe(true);
    expect(ibanValid('LV81BANK0000435195001')).toBe(false);
    expect(ibanValid('not an iban')).toBe(false);
    expect(vatNoValid('LV40003123456')).toBe(true);
    expect(vatNoValid('DE 123 456 789')).toBe(true);
    expect(vatNoValid('40003123456')).toBe(false);
  });
});

describe('invoice totals', () => {
  it('VAT added once on the whole invoice', () => {
    // 20 × 24.00 + 2.5 × 6.50 = 480 + 16.25 = 496.25; VAT 21 % = 104.21 (half-up); 600.46.
    expect(invoiceTotals(invoice(), { mode: 'exclusive', ratePercent: 21 })).toEqual({
      unitPrices: [2400, 650],
      lineTotals: [48000, 1625],
      subtotalCents: 49625,
      vatCents: 10421,
      totalCents: 60046,
    });
  });
  it('prices including VAT, and reverse charge (no VAT)', () => {
    expect(invoiceTotals(invoice(), { mode: 'inclusive', ratePercent: 21 })).toMatchObject({
      vatCents: 8613,
      totalCents: 49625,
    });
    expect(
      invoiceTotals(invoice({ reverseCharge: true }), { mode: 'exclusive', ratePercent: 21 }),
    ).toMatchObject({ vatCents: 0, totalCents: 49625 });
  });
  it('reverse charge with VAT-inclusive prices: unit prices are recalculated to net', () => {
    // 24.00 incl. 21 % → 19.83 net; 6.50 → 5.37. 20 × 19.83 = 396.60; 2.5 × 5.37 = 13.425 → 13.43.
    expect(
      invoiceTotals(invoice({ reverseCharge: true }), { mode: 'inclusive', ratePercent: 21 }),
    ).toEqual({
      unitPrices: [1983, 537],
      lineTotals: [39660, 1343],
      subtotalCents: 41003,
      vatCents: 0,
      totalCents: 41003,
    });
    // With prices already net nothing is recalculated.
    expect(
      invoiceTotals(invoice({ reverseCharge: true }), { mode: 'exclusive', ratePercent: 21 })
        .unitPrices,
    ).toEqual([2400, 650]);
  });
  it('incomplete lines do not count yet', () => {
    const t = invoiceTotals(
      invoice({ lines: [{ name: 'x', unit: 'pcs', qty: null, unitPriceCents: 100 }] }),
      { mode: 'none', ratePercent: 0 },
    );
    expect(t).toMatchObject({ lineTotals: [null], totalCents: 0 });
  });
});

describe('what is missing before issuing', () => {
  const o = { vatMode: 'exclusive' as const, today };
  it('a complete invoice is ready', () => {
    expect(documentProblems('invoice', invoice(), seller, o)).toEqual([]);
  });
  it('lists missing seller, buyer and line details in plain words', () => {
    const p = documentProblems(
      'invoice',
      invoice({
        buyer: { name: '', address: '', regNo: '', vatNo: '', email: '' },
        lines: [{ name: '', unit: 'pcs', qty: 1.234, unitPriceCents: null }],
      }),
      { ...seller, iban: 'LV00BANK0000435195001', vatNo: null },
      o,
    );
    expect(p).toEqual([
      'Your VAT number is missing (Documents → Setup)',
      'Your IBAN is not valid (Documents → Setup)',
      'Buyer: name is missing',
      'Buyer: address is missing',
      'Line 1: item is missing',
      'Line 1: quantity must be a number with at most two decimals',
      'Line 1: price is missing',
    ]);
  });
  it('UK sellers can use sort code and account number instead of an IBAN (D2)', () => {
    const uk: Seller = {
      ...seller,
      vatNo: 'GB123456789',
      country: 'United Kingdom',
      iban: null,
      bic: null,
      sortCode: '',
      accountNumber: '',
    };
    expect(documentProblems('invoice', invoice(), uk, o)).toEqual([
      'Your bank details are missing: sort code and account number, or IBAN (Documents → Setup)',
    ]);
    expect(
      documentProblems(
        'invoice',
        invoice(),
        { ...uk, sortCode: '20-00-00', accountNumber: '55779911' },
        o,
      ),
    ).toEqual([]);
    expect(
      documentProblems(
        'invoice',
        invoice(),
        { ...uk, sortCode: '2000', accountNumber: '55779911' },
        o,
      ),
    ).toHaveLength(1);
    // Not for sellers outside the UK, and BIC stays optional for everyone.
    expect(
      documentProblems(
        'invoice',
        invoice(),
        { ...seller, iban: null, bic: null, sortCode: '200000', accountNumber: '55779911' },
        o,
      ),
    ).toEqual(['Your IBAN is missing (Documents → Setup)']);
    expect(documentProblems('invoice', invoice(), { ...seller, bic: null }, o)).toEqual([]);
  });
  it('reverse charge needs the buyer’s VAT number (with any VAT mode)', () => {
    const d = invoice({
      reverseCharge: true,
      buyer: { name: 'B', address: 'A', regNo: '', vatNo: '', email: '' },
    });
    expect(documentProblems('invoice', d, seller, { vatMode: 'inclusive', today })).toEqual([
      'Reverse charge needs the buyer’s VAT number',
    ]);
  });
  it('no VAT number needed when there is no VAT', () => {
    expect(
      documentProblems(
        'invoice',
        invoice(),
        { ...seller, vatNo: null },
        { vatMode: 'none', today },
      ),
    ).toEqual([]);
  });
  it('a due date in the past is refused', () => {
    expect(documentProblems('invoice', invoice({ dueDate: '2026-09-01' }), seller, o)).toEqual([
      'The due date is in the past',
    ]);
  });
  it('CMR: the particulars of CMR art. 6', () => {
    const p = documentProblems('cmr', emptyData('cmr'), seller, o);
    expect(p).toContain('Box 1: sender name is missing');
    expect(p).toContain('Box 4: date of taking over is missing');
    expect(p).toContain('Box 11: gross weight is missing');
    expect(p).toContain('Box 16: carrier address is missing');
    expect(p).toContain('Box 21: date the note is made out is missing');
  });
  it('a delivery note with prices needs a price on every line', () => {
    const d = {
      ...parseData('delivery_note', {}),
      withPrices: true,
      receiver: { name: 'R', address: 'A', regNo: '', vatNo: '' },
      deliveryAddress: 'A',
      lines: [{ name: 'Candle', unit: 'pcs', qty: 2, unitPriceCents: null }],
    };
    expect(documentProblems('delivery_note', d, { ...seller, vatNo: null }, o)).toEqual([
      'Your VAT number is missing (Documents → Setup)',
      'Line 1: price is missing',
    ]);
  });
  it('delivery note', () => {
    expect(documentProblems('delivery_note', emptyData('delivery_note'), seller, o)).toEqual([
      'Receiver: name is missing',
      'Receiver: address is missing',
      'Delivery address is missing',
      'Line 1: item is missing',
    ]);
  });
});

describe('texts', () => {
  it('labels exist in every language', () => {
    const keys = Object.keys(DOC_LABELS.en).sort();
    for (const l of Object.values(DOC_LABELS)) expect(Object.keys(l).sort()).toEqual(keys);
    expect(DOC_LABELS.lv.deliveryNote).toBe('Preču pavadzīme');
  });
  it('the reply that carries a document', () => {
    expect(
      documentCoverText({
        type: 'invoice',
        language: 'lv',
        customerName: 'Māris Ozols',
        number: 'INV-2026-0001',
        total: '600,46 €',
        due: '2026. gada 10. oktobris',
      }),
    ).toBe(
      'Labdien, Māris!\n\nPielikumā ir rēķins INV-2026-0001 par summu 600,46 €, apmaksas termiņš 2026. gada 10. oktobris. Maksājuma rekvizīti ir norādīti rēķinā.',
    );
    expect(
      documentCoverText({
        type: 'cmr',
        language: 'de',
        customerName: null,
        number: 'CMR-2026-0003',
      }),
    ).toBe('Hallo,\n\nanbei erhalten Sie den CMR-Frachtbrief CMR-2026-0003.');
  });
  it('the reply for a delivery note with prices names the total', () => {
    expect(
      documentCoverText({
        type: 'delivery_note',
        priced: true,
        language: 'lv',
        customerName: null,
        number: 'DN-2026-0002',
        total: '600,46 €',
      }),
    ).toBe('Labdien!\n\nPielikumā ir preču pavadzīme-rēķins DN-2026-0002 par summu 600,46 €.');
    expect(
      documentFileName({
        type: 'delivery_note',
        number: 'DN-2026-0002',
        language: 'lv',
        data: { ...parseData('delivery_note', {}), withPrices: true },
      }),
    ).toBe('Precu-pavadzime-rekins-DN-2026-0002.pdf');
  });
  it('file names in the language, ASCII only', () => {
    expect(documentFileName({ type: 'invoice', number: 'INV-2026-0001', language: 'lv' })).toBe(
      'Rekins-INV-2026-0001.pdf',
    );
    expect(
      documentFileName({ type: 'delivery_note', number: 'DN-2026-0002', language: 'lv' }),
    ).toBe('Precu-pavadzime-DN-2026-0002.pdf');
    expect(documentFileName({ type: 'cmr', number: 'CMR-2026-0003', language: 'de' })).toBe(
      'CMR-2026-0003.pdf',
    );
  });
});

describe('CMR pre-fill from an e-mail', () => {
  const email = `Hello, please collect 4 pallets of scented candles (620 kg, 1,250 m3?) on 14.10.2026
from our partner in Rīga and deliver to Keller Wohnen GmbH, Torstraße 140, 10119 Berlin, Germany.
Carrier: Baltic Road Cargo SIA, truck KL-4410. Freight paid by us. Invoice INV-2026-0012 goes with the goods.`;
  const base = emptyData('cmr') as CmrData;
  const f = (field: string, value: string, source: string) => ({ field, value, source });

  it('keeps fields whose source is in the e-mail; numbers and dates come from the source', () => {
    const r = applyCmrPrefill(
      {
        fields: [
          f('consignee.name', 'Keller Wohnen GmbH', 'deliver to Keller Wohnen GmbH'),
          f('consignee.address', 'Torstraße 140, 10119 Berlin', 'Torstraße 140, 10119 Berlin'),
          f('goods.0.packages', '4', '4 pallets'),
          f('goods.0.grossKg', '650', '620 kg'),
          f('goods.0.nature', 'scented candles', 'pallets of scented candles'),
          f('takingOver.date', '2026-10-14', 'on 14.10.2026'),
          f('carriagePayment', 'paid', 'Freight paid by us'),
          f('vehicleTractor', 'KL-4410', 'truck KL-4410'),
        ],
      },
      email,
      base,
    );
    expect(r.dropped).toEqual([]);
    expect(r.data.consignee.name).toBe('Keller Wohnen GmbH');
    expect(r.data.goods[0]).toMatchObject({ packages: 4, grossKg: 620, nature: 'scented candles' });
    expect(r.data.takingOver.date).toBe('2026-10-14');
    expect(r.data.carriagePayment).toBe('paid');
    expect(r.prefill['goods.0.grossKg']).toEqual({ source: '620 kg' });
  });

  it('drops invented text, ambiguous numbers, the sender and unknown fields', () => {
    const r = applyCmrPrefill(
      {
        fields: [
          f('consignee.country', 'France', 'Germany'),
          f('carrier.address', 'Ganību dambis 1, Rīga', 'Ganību dambis 1, Rīga'),
          f('goods.0.volumeM3', '1250', '1,250 m3'),
          f('sender.name', 'SIA Nordlicht', 'our partner in Rīga'),
          f('carriagePayment', 'forward', 'Freight paid by us'),
          f('goods.1.nature', 'candles', 'scented candles'),
        ],
      },
      email,
      base,
    );
    expect(r.dropped.map((d) => [d.field, d.reason])).toEqual([
      ['consignee.country', 'value not in its source'],
      ['carrier.address', 'source not in the e-mail'],
      ['goods.0.volumeM3', 'no single number in its source'],
      ['sender.name', 'not a field the e-mail may fill'],
      ['carriagePayment', 'payment terms not stated in its source'],
    ]);
    expect(r.data.goods).toHaveLength(2);
    expect(r.data.goods[1]!.nature).toBe('candles');
  });

  it('reads numbers and dates the way they are written', () => {
    expect(numbersIn('1.250,5 kg and 1,250.5 kg and 2,5 m3 and 620')).toEqual([
      1250.5, 1250.5, 2.5, 620,
    ]);
    expect(numbersIn('1,250 kg')).toEqual([]);
    expect(
      datesIn('on 14.10.2026 or 2026-10-15, else October 16, 2026 or 17. Oktober 2026'),
    ).toEqual(['2026-10-15', '2026-10-14', '2026-10-17', '2026-10-16']);
    expect(datesIn('31.02.2026')).toEqual([]);
  });
});

describe('PDFs', () => {
  const ctx = {
    number: 'INV-2026-0001',
    issueDate: new Date('2026-09-26T00:00:00Z'),
    seller,
    brand: { companyName: 'Nordlicht', color: '#B4532A', website: null, phone: null, logo: null },
  };
  it('an invoice in every language', async () => {
    for (const language of ['en', 'de', 'lv', 'nl', 'fr', 'es']) {
      const data = invoice({ reverseCharge: language === 'de', notes: 'Thank you!' });
      const pdf = await renderInvoicePdf({
        ...ctx,
        language,
        data,
        currency: 'EUR',
        vatMode: 'exclusive',
        vatRatePercent: 21,
        totals: invoiceTotals(data, { mode: 'exclusive', ratePercent: 21 }),
        dueDate: '2026-10-10',
      });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pages(pdf)).toBe(1);
    }
  });
  it('an invoice with UK sort code and account number', async () => {
    const data = invoice();
    const pdf = await renderInvoicePdf({
      ...ctx,
      seller: { ...seller, iban: null, bic: null, sortCode: '200000', accountNumber: '55779911' },
      language: 'en',
      data,
      currency: 'GBP',
      vatMode: 'exclusive',
      vatRatePercent: 20,
      totals: invoiceTotals(data, { mode: 'exclusive', ratePercent: 20 }),
      dueDate: '2026-10-10',
    });
    expect(pages(pdf)).toBe(1);
  });
  it('a delivery note with signature boxes', async () => {
    const pdf = await renderDeliveryNotePdf({
      ...ctx,
      number: 'DN-2026-0001',
      language: 'lv',
      data: {
        ...parseData('delivery_note', {}),
        receiver: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '' },
        deliveryAddress: 'Rīga',
        lines: [{ name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: null }],
        vehicle: 'KL-4410',
      },
    });
    expect(pages(pdf)).toBe(1);
  });
  it('a delivery note with prices (pavadzīme-rēķins)', async () => {
    const data = {
      ...parseData('delivery_note', {}),
      withPrices: true,
      receiver: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '' },
      deliveryAddress: 'Rīga',
      lines: [
        { name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 },
        { name: 'Gift box', unit: 'box', qty: 2.5, unitPriceCents: 650 },
      ],
    };
    const totals = documentTotalsOf('delivery_note', data, 'exclusive', 21);
    expect(totals).toMatchObject({ subtotalCents: 49625, vatCents: 10421, totalCents: 60046 });
    const pdf = await renderDeliveryNotePdf({
      ...ctx,
      number: 'DN-2026-0002',
      language: 'lv',
      data,
      priced: {
        currency: 'EUR',
        vatMode: 'exclusive',
        vatRatePercent: 21,
        totals,
        dueDate: '2026-10-10',
      },
    });
    expect(pages(pdf)).toBe(1);
    // Without the option a delivery note has no totals.
    expect(
      documentTotalsOf('delivery_note', { ...data, withPrices: false }, 'exclusive', 21).totalCents,
    ).toBe(0);
  });
  it('a CMR has four copies', async () => {
    const data: CmrData = {
      ...(emptyData('cmr') as CmrData),
      sender: { name: 'SIA Nordlicht', address: 'Rīga', country: 'Latvia' },
      goods: [
        {
          marks: 'NL-1',
          packages: 4,
          packing: 'pallets',
          nature: 'candles',
          statNo: '',
          grossKg: 620,
          volumeM3: 2.5,
        },
      ],
    };
    const pdf = await renderCmrPdf({
      number: 'CMR-2026-0001',
      issueDate: ctx.issueDate,
      data,
      author: 'SIA Nordlicht',
    });
    expect(pages(pdf)).toBe(4);
  });
});
