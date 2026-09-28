import { describe, expect, it } from 'vitest';
import {
  asksForPrice,
  findSourceConflicts,
  pricesInExcerpts,
} from '../src/claims/source-checks.ts';
import type { ExcerptSource } from '../src/prompt/build.ts';

// Production case 2026-09-28 (test tenant): the owner's note and the website disagree.
const NOTE_SOURCE: ExcerptSource = {
  type: 'note',
  title: 'Services, prices and policies',
  url: null,
  updatedAt: new Date('2026-09-24T20:10:48Z'),
};
const web = (url: string): ExcerptSource => ({
  type: 'website',
  title: 'example.com',
  url,
  updatedAt: new Date('2026-09-25T07:11:03Z'),
});
const NOTE = [
  'Company facts',
  'Services and prices (EUR, excl. VAT):',
  '- Landing page (one page): €290',
  '- Business website (up to 6 pages): €490',
  '- Shopify online store: €690',
  'Delivery times:',
  '- Landing page: 5 business days',
  '- Business website: 10 business days',
  '- Shopify store: 14 business days',
  'Times start after we receive the content (texts, photos, logo).',
].join('\n');
const FAQ =
  'A website that works for your business. › Frequently asked questions A landing page — 3–5 business days, ' +
  'a business website — 3–7 business days, a wedding site — 5–7 days after we receive the content. ' +
  'The timeline depends mostly on how quickly we get texts and images.';
const PACKAGE =
  'Pricing › Business website A complete site for a small business. - 3–8 pages - Custom design - ' +
  'Contact form and WhatsApp - SEO basics and Google Maps - LV/EN version - Ready in 3–7 business days';
const EXCERPTS = [
  { label: 'S1', chunk: { chunkId: 'note', content: NOTE, source: NOTE_SOURCE } },
  { label: 'S2', chunk: { chunkId: 'faq', content: FAQ, source: web('https://example.com/en/') } },
  {
    label: 'S3',
    chunk: { chunkId: 'pkg', content: PACKAGE, source: web('https://example.com/en/pricing/') },
  },
];
const QUESTION =
  'Business website\nHi, how much does a business website cost and how long does it take?';

const conflicts = (reply: string, excerpts = EXCERPTS) =>
  findSourceConflicts({ reply, inboundText: QUESTION, excerpts });

describe('asksForPrice', () => {
  it.each([
    'Hi, how much does a business website cost?',
    'What are your prices?',
    'Wie viel kostet eine Webseite?',
    'Wat is de prijs van een website?',
    'Combien coûte un site ?',
    '¿Cuánto cuesta una página web?',
    'Cik maksā mājaslapa?',
    // Production case 2026-09-28: "send … an offer" in Latvian.
    'Nosūti uz klients@example.test piedāvājumu: 1 biznesa mājaslapa un 1 landing page',
  ])('%s', (text) => expect(asksForPrice(text)).toBe(true));

  it('not for other questions, unless classified as a quote request', () => {
    expect(asksForPrice('When are you open on Saturday?')).toBe(false);
    expect(asksForPrice('I need 20 candles', 'quote_request')).toBe(true);
  });
});

describe('pricesInExcerpts', () => {
  it('finds the amounts the model was shown', () => {
    expect(pricesInExcerpts([NOTE, FAQ])).toEqual(['€290', '€490', '€690']);
    expect(pricesInExcerpts([FAQ, PACKAGE])).toEqual([]);
  });
});

describe('findSourceConflicts', () => {
  it('the production reply: website duration while the note says 10 days', () => {
    const [c, ...rest] = conflicts(
      'Hello,\n\nA business website takes 3–7 business days to complete after we receive the content.',
    );
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      kind: 'duration',
      about: 'business website',
      replyValue: '3–7 business days',
      preferred: { label: 'S1', text: '10 business days' },
      replyUsesPreferred: false,
    });
    expect(c!.statements.map((s) => `${s.label}:${s.text}`)).toEqual([
      'S1:10 business days',
      'S2:3–7 business days',
    ]);
  });

  it('a reply that follows the note still reports the disagreement', () => {
    const found = conflicts(
      'A business website (up to 6 pages) costs €490 (excl. VAT). ' +
        'Delivery takes 10 business days once we receive your content.',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ replyValue: '10 business days', replyUsesPreferred: true });
  });

  it('a reply stating both figures is caught on the website one', () => {
    const found = conflicts(
      'A business website costs €490. The delivery time is 10 business days after we receive your content. ' +
        'In our standard packages, business websites are typically ready in 3–7 business days.',
    );
    expect(found.map((c) => [c.replyValue, c.replyUsesPreferred])).toEqual([
      ['10 business days', true],
      ['3–7 business days', false],
    ]);
  });

  it('matches the thing the sentence is about, not every figure in the question', () => {
    const found = conflicts('A landing page costs €290 and takes 5 business days.');
    // Only the landing page's own figures: €290 has no rival, 5 vs 3–5 days does.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'duration',
      about: 'landing page',
      replyValue: '5 business days',
      replyUsesPreferred: true,
    });
  });

  it('no conflict when the sources agree or only one states a figure', () => {
    expect(conflicts('A business website costs €490.')).toEqual([]);
    expect(conflicts('A business website takes 10 business days.', [EXCERPTS[0]!])).toEqual([]);
  });

  it('prefers the most recently updated note', () => {
    const newer = {
      label: 'S4',
      chunk: {
        chunkId: 'new',
        content: 'Business website: 12 business days',
        source: { ...NOTE_SOURCE, updatedAt: new Date('2026-09-27T09:00:00Z') },
      },
    };
    const [c] = conflicts('A business website takes 10 business days.', [...EXCERPTS, newer]);
    expect(c).toMatchObject({ preferred: { label: 'S4' }, replyUsesPreferred: false });
  });

  it('without a note there is no preferred figure', () => {
    const other = {
      label: 'S4',
      chunk: {
        chunkId: 'x',
        content: 'Business website: ready in 14 business days',
        source: web('https://example.com/en/old/'),
      },
    };
    const [c] = conflicts('A business website takes 3–7 business days.', [EXCERPTS[1]!, other]);
    expect(c).toMatchObject({ replyUsesPreferred: false });
    expect(c!.preferred).toBeUndefined();
  });
});

describe('findSourceConflicts: not conflicts', () => {
  it('one excerpt listing figures for different things', () => {
    const shop = {
      label: 'S1',
      chunk: {
        chunkId: 'c1',
        content:
          'Nordlicht soy candles cost 24 EUR each. A gift set of three candles costs 65 EUR. ' +
          'Shipping within Latvia takes 2-3 business days; shipping within the EU takes 5 business days.',
      },
    };
    const german = {
      label: 'S2',
      chunk: {
        chunkId: 'c2',
        content: 'Versand innerhalb der EU dauert 5 Werktage. Eine Kerze kostet 24 EUR.',
      },
    };
    expect(
      findSourceConflicts({
        reply: 'Hello, one candle costs 24 EUR and shipping within Latvia takes 2-3 business days.',
        inboundText: 'How much is a candle and how long is shipping to Riga?',
        excerpts: [shop, german],
      }),
    ).toEqual([]);
  });
});

describe('GenerationSchema.conflicts', () => {
  it('is optional, and a malformed list is dropped rather than failing the reply', async () => {
    const { GenerationSchema, responseSchemaFor } = await import('../src/index.ts');
    const base = {
      intent: 'q',
      language: 'en',
      reply: 'Hi',
      sources: [],
      confidence: 0.9,
      action: 'draft',
      escalate_reason: null,
    };
    expect(GenerationSchema.parse(base).conflicts).toEqual([]);
    expect(GenerationSchema.parse({ ...base, conflicts: 'yes' }).conflicts).toEqual([]);
    expect(
      GenerationSchema.parse({ ...base, conflicts: [{ fact: 'time', used: 'S1', other: ['S2'] }] })
        .conflicts,
    ).toEqual([{ fact: 'time', used: 'S1', other: ['S2'] }]);
    const json = JSON.stringify(responseSchemaFor(GenerationSchema));
    expect(json).toContain('"conflicts"');
  });
});
