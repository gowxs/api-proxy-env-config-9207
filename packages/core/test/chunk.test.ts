import { describe, expect, it } from 'vitest';
import { chunkText, normalizeKnowledgeText, reciprocalRankFusion } from '../src/index.ts';
import { ZWSP } from './fixtures/chars.ts';

describe('chunkText', () => {
  it('keeps a short document in one chunk', () => {
    expect(chunkText('Candles cost 24 EUR.\n\nShipping takes 5 days.')).toEqual([
      {
        index: 0,
        content: 'Candles cost 24 EUR.\n\nShipping takes 5 days.',
        headings: [],
        tokenEstimate: 11,
      },
    ]);
  });

  it('starts a new chunk per section and repeats the heading path in each chunk', () => {
    const text =
      '# Shop\n\nWelcome.\n\n## Shipping\n\nLatvia: 2-3 days.\n\n## Prices\n\nCandle: 24 EUR.';
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.content)).toEqual([
      'Shop\n\nWelcome.',
      'Shop › Shipping\n\nLatvia: 2-3 days.',
      'Shop › Prices\n\nCandle: 24 EUR.',
    ]);
    expect(chunks[2]!.headings).toEqual(['Shop', 'Prices']);
  });

  it('respects the size limit and overlaps consecutive chunks', () => {
    const paragraph = (n: number) =>
      `Paragraph ${n}. ${'Lorem ipsum dolor sit amet. '.repeat(10)}`.trim();
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n\n');
    const chunks = chunkText(text, { maxChars: 800, overlapChars: 120 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(800 + 120 + 4);
    // The start of each chunk repeats the end of the previous one.
    const prevEnd = chunks[0]!.content.slice(-60);
    expect(chunks[1]!.content).toContain(
      prevEnd.slice(prevEnd.indexOf(' ') + 1, prevEnd.indexOf(' ') + 20),
    );
    // Every paragraph survives somewhere.
    for (let i = 0; i < 12; i++)
      expect(chunks.some((c) => c.content.includes(`Paragraph ${i}.`))).toBe(true);
  });

  it('splits a single oversized paragraph on sentence boundaries', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(long, { maxChars: 300, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => /\.$/.test(c.content))).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText(' \n\n ')).toEqual([]);
  });
});

describe('normalizeKnowledgeText', () => {
  it('removes invisible characters and normalizes whitespace', () => {
    expect(normalizeKnowledgeText(`a${ZWSP}b  \r\n\r\n\r\n\r\nc`)).toBe('ab\n\nc');
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards items found by both searches', () => {
    const vector = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const text = [{ id: 'c' }, { id: 'd' }];
    expect(reciprocalRankFusion([vector, text], 3).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
