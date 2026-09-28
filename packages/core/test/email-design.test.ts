import { describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  EMAIL_TEMPLATES,
  EMPTY_BRAND,
  logoAllowed,
  MAX_HTML_BYTES,
  renderReplyEmail,
  stripSignOff,
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
    // The signature already names the company: the footer has only the address.
    expect(html).toContain('>Brīvības iela 1, Rīga, Latvia</p>');
    expect(html).not.toContain('Nordlicht Candles · Brīvības');
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

// Production case 2026-09-28 (Latvian, tenant Wxs, Card design): "Ar cieņu,\nWxs" from the model,
// then the signature, then the company name again from the contact block.
describe('exactly one sign-off', () => {
  const wxs: EmailBrand = { ...EMPTY_BRAND, companyName: 'Wxs', website: 'https://gowxs.com/en/' };
  const body =
    'Labdien!\n\nNosūtām mūsu pakalpojumu piedāvājumu:\n- Landing page: no 390 EUR\n- Uzņēmuma mājaslapa: no 590 EUR\n\nLabprāt atbildēsim uz jautājumiem vai vienosimies par detaļām!\n\nAr cieņu,\nWxs';
  const signature = 'Gvido Angarskis\nWXS · Web eXpert Solutions';

  it.each(['plain', 'clean', 'logo', 'branded', 'card'] as const)(
    '%s: the text ends with the signature once',
    (template) => {
      const r = renderReplyEmail({
        template,
        body,
        signature,
        brand: wxs,
        allowlist: buildAllowlist([]),
      });
      expect(r.text).not.toContain('Ar cieņu');
      expect(r.text.match(/\bwxs\b/gi)).toHaveLength(1); // only "WXS · Web eXpert Solutions"
      expect(r.text).toContain(
        'vienosimies par detaļām!\n\nGvido Angarskis\nWXS · Web eXpert Solutions',
      );
      if (r.html) {
        expect(r.html).not.toContain('Ar cieņu');
        // The name may head the design (in place of a logo), but nothing after the signature repeats it.
        const afterSignature = r.html.slice(r.html.indexOf('Gvido Angarskis'));
        expect(afterSignature).not.toMatch(/>Wxs</);
      }
    },
  );

  it('without a signature the text keeps its own closing', () => {
    const r = renderReplyEmail({
      template: 'plain',
      body,
      signature: null,
      brand: wxs,
      allowlist: buildAllowlist([]),
    });
    expect(r.text).toContain('Ar cieņu,\nWxs');
  });
});

describe('stripSignOff in six languages', () => {
  it.each([
    ['Hello,\n\nSee you soon.\n\nBest regards,\nAnna', 'Hello,\n\nSee you soon.'],
    ['Hallo,\n\nDanke.\n\nMit freundlichen Grüßen\nMax Muster\nNordlicht GmbH', 'Hallo,\n\nDanke.'],
    ['Labdien!\n\nPaldies.\n\nAr cieņu,\nWxs', 'Labdien!\n\nPaldies.'],
    ['Hallo,\n\nTot snel.\n\nMet vriendelijke groet,\nSanne', 'Hallo,\n\nTot snel.'],
    ['Bonjour,\n\nÀ bientôt.\n\nCordialement,\nMarie', 'Bonjour,\n\nÀ bientôt.'],
    ['Hola,\n\nHasta pronto.\n\nUn saludo,\nLucía', 'Hola,\n\nHasta pronto.'],
    ['Hi,\n\nThanks!', 'Hi,'],
    ['Thanks!', 'Thanks!'],
  ])('%j', (input, out) => expect(stripSignOff(input)).toBe(out));

  it('leaves sentences and text after a closing alone', () => {
    const sentence = 'Hi,\n\nThanks for asking, the candle costs 24 EUR.';
    expect(stripSignOff(sentence)).toBe(sentence);
    const more =
      'Hi,\n\nBest regards,\nAnna\n\nP.S. The shop opens at 10:00 on Saturday, see you there.';
    expect(stripSignOff(more)).toBe(more);
  });
});
