import { describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  emptyAllowlist,
  extractAllowlistEntries,
  findLinks,
  sanitizeReply,
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
