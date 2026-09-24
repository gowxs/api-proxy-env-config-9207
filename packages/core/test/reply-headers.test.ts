import { describe, expect, it } from 'vitest';
import { buildReplySubject, buildThreadingHeaders, resolveReplyRecipient } from '../src/index.ts';

describe('resolveReplyRecipient', () => {
  it('replies to From when there is no Reply-To', () => {
    expect(resolveReplyRecipient({ from: 'a@x.test', replyTo: [] })).toEqual({
      to: 'a@x.test',
      replyToMismatch: false,
    });
  });

  it('uses Reply-To within the same organization without flagging it', () => {
    expect(
      resolveReplyRecipient({ from: 'noreply@mail.shop.co.uk', replyTo: ['sales@shop.co.uk'] }),
    ).toEqual({
      to: 'sales@shop.co.uk',
      replyToMismatch: false,
    });
  });

  it('uses but flags a Reply-To at another organization (contact forms, or a redirect attack)', () => {
    expect(resolveReplyRecipient({ from: 'a@x.test', replyTo: ['b@y.test'] })).toEqual({
      to: 'b@y.test',
      replyToMismatch: true,
    });
  });

  it('falls back to From and flags several or malformed Reply-To values', () => {
    expect(resolveReplyRecipient({ from: 'a@x.test', replyTo: ['b@y.test', 'c@z.test'] })).toEqual({
      to: 'a@x.test',
      replyToMismatch: true,
    });
    expect(resolveReplyRecipient({ from: 'a@x.test', replyTo: ['not an address'] })).toEqual({
      to: 'a@x.test',
      replyToMismatch: true,
    });
  });
});

describe('buildReplySubject', () => {
  it.each([
    ['Question', 'Re: Question'],
    ['Re: Question', 'Re: Question'],
    ['RE: Question', 'RE: Question'],
    ['AW: Frage', 'AW: Frage'],
    ['Antw: Vraag', 'Antw: Vraag'],
    ['Atb: Jautājums', 'Atb: Jautājums'],
    ['Re[2]: Question', 'Re[2]: Question'],
    ['Reservation', 'Re: Reservation'],
    ['', 'Re:'],
    ['Line\r\nBcc: evil@x.test', 'Re: Line Bcc: evil@x.test'],
  ])('%j → %j', (input, expected) => {
    expect(buildReplySubject(input)).toBe(expected);
  });
});

describe('buildThreadingHeaders', () => {
  it('sets In-Reply-To and appends to References', () => {
    expect(buildThreadingHeaders({ messageId: '<3@x>', references: ['<1@x>', '<2@x>'] })).toEqual({
      inReplyTo: '<3@x>',
      references: ['<1@x>', '<2@x>', '<3@x>'],
    });
  });

  it('keeps the thread root and the latest ids when References is long', () => {
    const refs = Array.from({ length: 40 }, (_, i) => `<${i}@x>`);
    const out = buildThreadingHeaders({ messageId: '<40@x>', references: refs }).references;
    expect(out).toHaveLength(20);
    expect(out[0]).toBe('<0@x>');
    expect(out.at(-1)).toBe('<40@x>');
  });
});
