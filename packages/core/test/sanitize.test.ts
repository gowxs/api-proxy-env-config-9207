import { describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  emptyAllowlist,
  extractAllowlistEntries,
  findLinks,
  sanitizeReply,
  stripCitationMarkers,
  stripSignOff,
} from '../src/index.ts';
import { BOM, RLO, ZWSP } from './fixtures/chars.ts';

const kb =
  'Write to info@shop.test or visit https://shop.test/faq and www.shop.test. Partner: courier.lv/track';
const allow = buildAllowlist(extractAllowlistEntries(kb));

describe('extractAllowlistEntries', () => {
  it('collects urls, domains and emails from knowledge-base text', () => {
    expect([...allow.emails]).toEqual(['info@shop.test']);
    expect([...allow.urls].sort()).toEqual(['courier.lv/track', 'shop.test', 'shop.test/faq']);
    expect([...allow.domains].sort()).toEqual(['courier.lv', 'shop.test']);
  });

  it('never allowlists obfuscated addresses', () => {
    expect(extractAllowlistEntries('mail boss [at] shop [dot] test')).toEqual([]);
  });
});

describe('findLinks', () => {
  it('ignores file names and abbreviations that are not real domains', () => {
    expect(findLinks('See node.js, report.pdf, e.g. this, and v1.2.')).toEqual([]);
  });

  it('treats an email as one match, not an email plus a domain', () => {
    expect(findLinks('Mail a@evil.com now').map((l) => l.kind)).toEqual(['email']);
  });
});

describe('sanitizeReply', () => {
  it('keeps links and addresses that the knowledge base contains', () => {
    const text =
      'Details: https://shop.test/faq, or email info@shop.test. Home: https://www.shop.test/';
    expect(sanitizeReply(text, allow)).toEqual({ text, removed: [] });
  });

  it('removes a path on a known domain that the knowledge base never mentions', () => {
    const r = sanitizeReply('Reset here: https://shop.test/reset-password?u=1', allow);
    expect(r.removed).toEqual([{ kind: 'url', value: 'https://shop.test/reset-password?u=1' }]);
    expect(r.text).toBe('Reset here:');
  });

  it.each([
    ['http://evil.test/x', 'url'],
    ['www.evil.com/login', 'url'],
    ['evil.com', 'domain'],
    ['boss@evil.com', 'email'],
    ['boss [at] evil [dot] com', 'obfuscated_email'],
    ['boss (at) evil (dot) com', 'obfuscated_email'],
    ['boss at evil dot com', 'obfuscated_email'],
  ])('removes %s (%s)', (value, kind) => {
    const r = sanitizeReply(`Contact ${value} today.`, allow);
    expect(r.removed).toEqual([{ kind, value }]);
    expect(r.text).not.toContain(value);
  });

  it('turns a markdown link with a removed target into plain text', () => {
    expect(sanitizeReply('Click [here](https://evil.test/a) please.', allow).text).toBe(
      'Click here please.',
    );
  });

  it('removes invisible and bidi characters', () => {
    const r = sanitizeReply(`Hello${ZWSP} wor${RLO}ld${BOM}`, emptyAllowlist());
    expect(r.text).toBe('Hello world');
    expect(r.removed).toEqual([{ kind: 'invisible_characters', value: '' }]);
  });

  it('leaves text without links untouched', () => {
    expect(sanitizeReply('  Thanks for your message!  ', allow)).toEqual({
      text: 'Thanks for your message!',
      removed: [],
    });
  });
});

describe('citation markers', () => {
  it('are removed from the text a customer reads, and are not a content removal', () => {
    const r = sanitizeReply(
      'Ein Onepager kostet 3.900 € [S1]. Die Umsetzung dauert 3–4 Wochen [S1, S2] .',
      emptyAllowlist(),
    );
    expect(r.text).toBe('Ein Onepager kostet 3.900 €. Die Umsetzung dauert 3–4 Wochen.');
    expect(r.removed).toEqual([]);
    expect(stripCitationMarkers('Plain text [see note].')).toBe('Plain text [see note].');
  });
});

describe('stripSignOff (QA #29)', () => {
  it('drops a closing the model added, with a short name after it', () => {
    expect(
      stripSignOff('Hallo Jana,\n\ndas Angebot folgt.\n\nMit freundlichen Grüßen\nMax Muster'),
    ).toBe('Hallo Jana,\n\ndas Angebot folgt.');
    expect(stripSignOff('Hi Sam,\n\nThanks for asking.\n\nBest regards,')).toBe(
      'Hi Sam,\n\nThanks for asking.',
    );
  });
  it('leaves text without a closing, or with real content after it, alone', () => {
    const plain = 'Hi Sam,\n\nThe candles ship on Monday.';
    expect(stripSignOff(plain)).toBe(plain);
    const long = `Hi,\n\nRegards to your team.\n${'x'.repeat(80)}`;
    expect(stripSignOff(long)).toBe(long);
  });
});
