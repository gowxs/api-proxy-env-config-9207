import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { buildOutboundMessage } from '../src/outbound.ts';

const base = {
  from: { address: 'shop@nordlicht.test', name: 'Nordlicht Candles' },
  to: 'anna@example-mail.test',
  subject: 'Re: Candle price',
  text: 'Hi Anna,\n\nThe lavender candle costs 24 EUR.\n\nMāra\n',
  messageId: '<noctiv.1@nordlicht.test>',
};

describe('outbound message', () => {
  it('without a design: a single text/plain part', async () => {
    const raw = (await buildOutboundMessage(base)).toString();
    expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(raw).not.toMatch(/multipart|text\/html/);
  });

  it('with a design: multipart/alternative, the full text first, then the HTML', async () => {
    const html =
      '<!doctype html><html><body><p>The lavender candle costs 24 EUR.</p></body></html>';
    const raw = await buildOutboundMessage({ ...base, html });
    const s = raw.toString();
    expect(s).toMatch(/Content-Type: multipart\/alternative/);
    expect(s.indexOf('text/plain')).toBeLessThan(s.indexOf('text/html'));
    const parsed = await simpleParser(raw);
    expect(parsed.text).toBe(base.text);
    expect(parsed.html).toContain('The lavender candle costs 24 EUR.');
    // Nothing is fetched or embedded: no attachments, no inline images.
    expect(parsed.attachments).toHaveLength(0);
  });
});
