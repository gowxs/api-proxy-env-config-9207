import { describe, expect, it } from 'vitest';
import {
  bankDomainFor,
  matchPayment,
  normalizeBankDomain,
  readPayment,
  senderVerified,
  type OpenDocument,
} from '../src/index.ts';

describe('bank senders', () => {
  it('normalises what the owner types', () => {
    expect(normalizeBankDomain('https://www.Swedbank.lv/business')).toBe('swedbank.lv');
    expect(normalizeBankDomain('noreply@seb.lv')).toBe('seb.lv');
    expect(normalizeBankDomain('not a domain')).toBeNull();
  });
  it('matches the domain and its subdomains only', () => {
    expect(bankDomainFor('alerts@notify.swedbank.lv', ['swedbank.lv'])).toBe('swedbank.lv');
    expect(bankDomainFor('info@swedbank.lv', ['swedbank.lv'])).toBe('swedbank.lv');
    expect(bankDomainFor('info@fakeswedbank.lv', ['swedbank.lv'])).toBeNull();
    expect(bankDomainFor('info@swedbank.lv.evil.test', ['swedbank.lv'])).toBeNull();
  });
  it('trusts only the receiving provider’s DKIM/DMARC verdict for that domain', () => {
    const gmail =
      'mx.google.com; dkim=pass header.i=@swedbank.lv header.s=s1 header.b=abc; spf=pass smtp.mailfrom=swedbank.lv; dmarc=pass (p=REJECT) header.from=swedbank.lv';
    expect(senderVerified(gmail, 'swedbank.lv')).toBe(true);
    expect(senderVerified('mx; dkim=pass header.d=notify.swedbank.lv', 'swedbank.lv')).toBe(true);
    expect(senderVerified('mx; dmarc=pass header.from=swedbank.lv', 'swedbank.lv')).toBe(true);
    // Signed, but by someone else; or failing; or no verdict at all.
    expect(
      senderVerified(
        'mx; dkim=pass header.d=evil.test; dmarc=fail header.from=swedbank.lv',
        'swedbank.lv',
      ),
    ).toBe(false);
    expect(senderVerified('mx; dkim=fail header.d=swedbank.lv', 'swedbank.lv')).toBe(false);
    expect(senderVerified(undefined, 'swedbank.lv')).toBe(false);
    // Only the topmost header (added by the receiving provider) counts.
    expect(
      senderVerified(['mx; dkim=none', 'forged; dkim=pass header.d=swedbank.lv'], 'swedbank.lv'),
    ).toBe(false);
  });
});

describe('reading a bank notification', () => {
  const email =
    'You have received a payment. Amount: 600,46 EUR. Payer: SIA Ozols Būve. Payment details: Rēķins INV-2026-0012. Date: 26.09.2026.';
  const f = (value: string, source: string) => ({ value, source });

  it('reads amount, currency, payer and reference from the e-mail’s own text', () => {
    expect(
      readPayment(
        {
          credit: true,
          amount: f('600.46', 'Amount: 600,46 EUR'),
          currency: f('EUR', '600,46 EUR'),
          payer_name: f('SIA Ozols Būve', 'Payer: SIA Ozols Būve'),
          reference: f('Rēķins INV-2026-0012', 'Payment details: Rēķins INV-2026-0012'),
        },
        email,
      ),
    ).toEqual({
      amountCents: 60046,
      currency: 'EUR',
      payerName: 'SIA Ozols Būve',
      reference: 'Rēķins INV-2026-0012',
      sources: {
        amount: 'Amount: 600,46 EUR',
        payer_name: 'Payer: SIA Ozols Būve',
        reference: 'Payment details: Rēķins INV-2026-0012',
      },
    });
  });

  it('ignores debits, invented amounts and invented payers', () => {
    const amount = f('600.46', 'Amount: 600,46 EUR');
    expect(
      readPayment(
        { credit: false, amount, currency: null, payer_name: null, reference: null },
        email,
      ),
    ).toBeNull();
    expect(
      readPayment(
        {
          credit: true,
          amount: f('900', 'Amount: 900 EUR'),
          currency: null,
          payer_name: null,
          reference: null,
        },
        email,
      ),
    ).toBeNull();
    const r = readPayment(
      {
        credit: true,
        amount,
        currency: null,
        payer_name: f('Hacker Ltd', 'Payer: Hacker Ltd'),
        reference: null,
      },
      email,
    );
    expect(r).toMatchObject({ amountCents: 60046, currency: 'EUR', payerName: null });
  });
});

describe('matching a payment to open invoices', () => {
  const open: OpenDocument[] = [
    {
      id: 'a',
      number: 'INV-2026-0012',
      totalCents: 60046,
      currency: 'EUR',
      counterpartyName: 'SIA Ozols Būve',
      paymentReference: null,
    },
    {
      id: 'b',
      number: 'INV-2026-0013',
      totalCents: 12100,
      currency: 'EUR',
      counterpartyName: 'Keller Wohnen GmbH',
      paymentReference: null,
    },
    {
      id: 'c',
      number: 'DN-2026-0004',
      totalCents: 12100,
      currency: 'EUR',
      counterpartyName: 'Hotel Rīga',
      paymentReference: null,
    },
  ];
  const pay = (
    p: Partial<{
      amountCents: number;
      currency: string | null;
      payerName: string | null;
      reference: string | null;
    }>,
  ) => ({
    amountCents: 60046,
    currency: 'EUR',
    payerName: null,
    reference: null,
    ...p,
  });

  it('exact: amount and the invoice number in the reference (spacing and dashes ignored)', () => {
    expect(matchPayment(pay({ reference: 'Rēķins inv 2026 0012' }), open)).toEqual({
      kind: 'exact',
      documentId: 'a',
    });
  });
  it('partial: the amount alone, when only one open invoice has it', () => {
    expect(matchPayment(pay({}), open)).toEqual({ kind: 'amount', documentId: 'a' });
    // Two open documents for 121.00: not sure which.
    expect(matchPayment(pay({ amountCents: 12100 }), open)).toEqual({
      kind: null,
      documentId: null,
    });
  });
  it('partial: the payer is the buyer (legal form ignored), even with another amount', () => {
    expect(matchPayment(pay({ amountCents: 5000, payerName: 'Keller Wohnen' }), open)).toEqual({
      kind: 'payer',
      documentId: 'b',
    });
  });
  it('no match: wrong amount, unknown payer, other currency', () => {
    expect(matchPayment(pay({ amountCents: 777 }), open)).toEqual({ kind: null, documentId: null });
    expect(matchPayment(pay({ currency: 'USD', reference: 'INV-2026-0012' }), open)).toEqual({
      kind: null,
      documentId: null,
    });
  });
  it('an amount match is not proposed when the reference names another invoice', () => {
    expect(matchPayment(pay({ reference: 'INV-2026-0013' }), open)).toEqual({
      kind: null,
      documentId: null,
    });
  });
});
