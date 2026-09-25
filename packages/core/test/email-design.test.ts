import { describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  EMAIL_TEMPLATES,
  EMPTY_BRAND,
  logoAllowed,
  MAX_HTML_BYTES,
  renderReplyEmail,
  type EmailBrand,
  type EmailTemplate,
} from '../src/index.ts';

const allowlist = buildAllowlist([
  { kind: 'domain', value: 'nordlicht.test' },
  { kind: 'url', value: 'nordlicht.test/shipping' },
]);
const brand: EmailBrand = {
  companyName: 'Nordlicht Candles',
  logoUrl: 'https://nordlicht.test/assets/logo.png',
  color: '#B4532A',
  website: 'https://nordlicht.test',
  phone: '+371 2000 0000',
  address: 'Brīvības iela 1, Rīga, Latvia',
  socialLinks: ['https://instagram.com/nordlicht', 'https://www.facebook.com/nordlicht'],
};
const body =
  'Hi Anna,\n\nYes, the lavender candle is in stock and costs 24 EUR. Shipping details: https://nordlicht.test/shipping\n\nWould you like me to reserve one?';
const signature = 'Best regards,\nMāra\nNordlicht Candles';
const render = (template: EmailTemplate, patch: Partial<EmailBrand> = {}, text = body) =>
  renderReplyEmail({ template, body: text, signature, brand: { ...brand, ...patch }, allowlist });

describe('plain template (default)', () => {
  it('is exactly the reply and the signature, with no HTML part', () => {
    const r = render('plain');
    expect(r.html).toBeNull();
    expect(r.text).toBe(`${body}\n\n${signature}\n`);
  });

  it('without a signature, is the reply alone', () => {
    const r = renderReplyEmail({
      template: 'plain',
      body,
      signature: null,
      brand: EMPTY_BRAND,
      allowlist,
    });
    expect(r.text).toBe(`${body}\n`);
  });
});

describe('HTML templates: the plain-text fallback', () => {
  for (const t of EMAIL_TEMPLATES.filter((t) => t !== 'plain')) {
    it(`${t}: the text part holds the whole reply, the signature and the contact details`, () => {
      const r = render(t);
      expect(r.html).not.toBeNull();
      expect(r.text.startsWith(body)).toBe(true);
      expect(r.text).toContain(signature);
      for (const line of [
        'https://nordlicht.test',
        '+371 2000 0000',
        'Instagram: https://instagram.com/nordlicht',
        'Facebook: https://www.facebook.com/nordlicht',
        'Brīvības iela 1, Rīga, Latvia',
      ])
        expect(r.text).toContain(line);
      // Nothing of the HTML leaks into the text part.
      expect(r.text).not.toMatch(/<[a-z]/i);
    });

    it(`${t}: follows the HTML rules`, () => {
      const html = render(t).html!;
      expect(html).not.toMatch(/<style|<script|<link|<iframe|<form/i);
      expect(html).not.toMatch(/url\(/i);
      // The only remote asset is the logo.
      const srcs = [...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1]);
      expect(srcs.every((s) => s === brand.logoUrl)).toBe(true);
      expect(Buffer.byteLength(html)).toBeLessThan(MAX_HTML_BYTES);
      // Dark-mode safe: no pure black anywhere.
      expect(html).not.toMatch(/#000(000)?\b|(?<![-\w])black\b|rgb\(0,\s*0,\s*0\)/i);
      // The reply text is all there, escaped, with its link clickable.
      expect(html).toContain('Yes, the lavender candle is in stock and costs 24 EUR.');
      expect(html).toContain('href="https://nordlicht.test/shipping"');
    });
  }

  it('escapes whatever the reply contains', () => {
    const r = render('clean', {}, 'Price <b>24</b> & "more" <script>alert(1)</script>');
    expect(r.html).toContain('Price &lt;b&gt;24&lt;/b&gt; &amp; &quot;more&quot; &lt;script&gt;');
    expect(r.html).not.toContain('<script>');
  });

  it('a reply too large for 40 KB of HTML goes out as text only', () => {
    const long = Array.from(
      { length: 900 },
      (_, i) => `Line ${i}: the lavender candle ships in 2-3 days.`,
    ).join('\n');
    const r = render('card', {}, long);
    expect(r.html).toBeNull();
    expect(r.fallback).toBe('too_large');
    expect(r.text.startsWith(long)).toBe(true);
  });
});

describe('the logo and the knowledge-base allowlist', () => {
  it('is shown only when its host is on the allowlist', () => {
    expect(logoAllowed('https://nordlicht.test/assets/logo.png', allowlist)).toBe(true);
    expect(logoAllowed('https://cdn.nordlicht.test/logo.png', allowlist)).toBe(true);
    expect(logoAllowed('https://www.nordlicht.test/logo.png', allowlist)).toBe(true);
    expect(logoAllowed('https://evil.test/logo.png', allowlist)).toBe(false);
    expect(logoAllowed('https://nordlicht.test.evil.test/logo.png', allowlist)).toBe(false);
    expect(logoAllowed('http://nordlicht.test/logo.png', allowlist)).toBe(false);
    expect(logoAllowed('https://nordlicht.test/logo.png" onerror="x', allowlist)).toBe(false);
    expect(logoAllowed(null, allowlist)).toBe(false);
  });

  it('a logo from elsewhere is dropped: no image, the company name instead', () => {
    for (const t of ['logo', 'branded', 'card'] as const) {
      const r = render(t, { logoUrl: 'https://tracker.evil.test/pixel.png' });
      expect(r.logo).toBe('blocked');
      expect(r.html).not.toContain('evil.test');
      expect(r.html).not.toMatch(/<img/);
      expect(r.html).toContain('Nordlicht Candles');
    }
  });

  it('templates with a logo show it; Clean never has images', () => {
    expect(render('logo').logo).toBe('shown');
    expect(render('logo').html).toContain('<img src="https://nordlicht.test/assets/logo.png"');
    expect(render('clean').html).not.toMatch(/<img/);
    expect(render('clean').logo).toBe('none');
  });
});

describe('brand colour', () => {
  it('text on the brand colour stays readable (white or ink, never black)', () => {
    const light = render('card', { color: '#F6C89A' }).html!;
    expect(light).toMatch(/background:#F6C89A;color:#1F2430/);
    const dark = render('card', { color: '#2A3566' }).html!;
    expect(dark).toMatch(/background:#2A3566;color:#FFFFFF/);
  });

  it('Branded has a thin top bar in the brand colour and the address in the footer', () => {
    const html = render('branded').html!;
    expect(html).toContain('height:4px;line-height:4px;font-size:4px;background:#B4532A');
    expect(html).toContain('Nordlicht Candles · Brīvības iela 1, Rīga, Latvia');
  });

  it('Card turns every link in the signature into a button', () => {
    const r = renderReplyEmail({
      template: 'card',
      body,
      signature: 'Māra\nhttps://nordlicht.test/contact',
      brand,
      allowlist,
    });
    expect(r.html).toMatch(
      /<a href="https:\/\/nordlicht.test\/contact" style="display:inline-block[^"]*border-radius:999px;background:#B4532A/,
    );
  });
});
