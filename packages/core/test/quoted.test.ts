import { describe, expect, it } from 'vitest';
import { stripQuotedText } from '../src/index.ts';

describe('stripQuotedText', () => {
  it.each([
    ['Thanks!\n\nOn Mon, 1 Sep 2026 at 10:00, Shop <info@shop.test> wrote:\n> old text', 'Thanks!'],
    ['Danke.\n\nAm 01.09.2026 um 10:00 schrieb Shop <info@shop.test>:\n> alt', 'Danke.'],
    ['Merci.\n\nLe lun. 1 sept. 2026, Shop a écrit :\n> ancien', 'Merci.'],
    ['Paldies!\n\n2026. gada 1. sept. Shop <info@shop.test> rakstīja:\n> vecais', 'Paldies!'],
    ['Ok\n\n-----Original Message-----\nFrom: x', 'Ok'],
    ['Ok\n\nFrom: Shop <info@shop.test>\nSent: Monday\nSubject: Re', 'Ok'],
    ['Line one\n> quoted\nLine two', 'Line one\nLine two'],
    ['No quotes here.', 'No quotes here.'],
  ])('%j', (input, out) => {
    expect(stripQuotedText(input)).toBe(out);
  });
});
