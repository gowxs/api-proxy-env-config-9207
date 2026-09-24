import { buildAllowlist, extractAllowlistEntries, type LabelledChunk } from '../../src/index.ts';

/** Knowledge base of a fictional tenant, "Nordlicht Candles" (Riga). */
export const KB_CHUNKS = [
  {
    id: '00000000-0000-4000-8000-00000000c001',
    content:
      'Nordlicht soy candles cost 24 EUR each. A gift set of three candles costs 65 EUR. ' +
      'Shipping within Latvia takes 2-3 business days; shipping within the EU takes 5 business days.',
  },
  {
    id: '00000000-0000-4000-8000-00000000c002',
    content:
      'Contact us at info@nordlicht-candles.test or order online at https://nordlicht-candles.test/shop. ' +
      'Our Riga studio is open Monday to Friday, 10:00-18:00.',
  },
  {
    id: '00000000-0000-4000-8000-00000000c003',
    content: 'Versand innerhalb der EU dauert 5 Werktage. Eine Kerze kostet 24 EUR.',
  },
];

export const KB_LABELS = new Map<string, LabelledChunk>(
  KB_CHUNKS.map((c, i) => [`S${i + 1}`, { chunkId: c.id, content: c.content }]),
);

export const KB_ALLOWLIST = buildAllowlist(
  KB_CHUNKS.flatMap((c) => extractAllowlistEntries(c.content)),
);

export const TENANT_ADDRESS = 'info@nordlicht-candles.test';
