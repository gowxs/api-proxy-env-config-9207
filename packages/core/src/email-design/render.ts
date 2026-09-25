import type { Allowlist } from '../safety/allowlist.ts';
import { findLinks, hostOfUrl, normalizeUrl } from '../safety/links.ts';

/**
 * E-mail design: the visual frame around an outgoing reply (founder decision
 * 2026-09-26). The reply text is never changed; only how it is wrapped.
 *
 * Rules for every HTML template: inline CSS only (no <style>, no scripts),
 * no remote assets except the tenant's logo (https, host in the knowledge-base
 * allowlist), no tracking, HTML under 40 KB, colours that survive a mail app's
 * dark-mode inversion (no pure black, text on colour picked for contrast).
 * Every HTML message also carries a full text/plain part.
 */
export const EMAIL_TEMPLATES = ['plain', 'clean', 'logo', 'branded', 'card'] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailBrand {
  companyName: string | null;
  logoUrl: string | null;
  /** #RRGGBB */
  color: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  /** Up to three profile URLs. */
  socialLinks: string[];
}

export const EMPTY_BRAND: EmailBrand = {
  companyName: null,
  logoUrl: null,
  color: null,
  website: null,
  phone: null,
  address: null,
  socialLinks: [],
};

export interface RenderInput {
  template: EmailTemplate;
  /** The reply as written (AI draft or owner edit); never modified. */
  body: string;
  /** The tenant's text signature. */
  signature: string | null;
  brand: EmailBrand;
  /** The tenant's knowledge-base allowlist; the logo is shown only if its host is on it. */
  allowlist: Allowlist;
}

export interface RenderedReply {
  text: string;
  /** null: send text/plain only (template "plain", or the HTML would be too large). */
  html: string | null;
  logo: 'shown' | 'none' | 'blocked';
  /** Why there is no HTML although the template has one. */
  fallback?: 'too_large';
}

/** HTML larger than this is not sent; the message goes out as text only. */
export const MAX_HTML_BYTES = 40 * 1024;

// ------------------------------------------------------------------ helpers
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Not pure black: inverts to a soft white in dark mode. */
const INK = '#1F2430';
const MUTED = '#5B6275';
const RULE = '#E3E6EE';
const DEFAULT_COLOR = '#2F3A56';
const WHITE = '#FFFFFF';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const isHex = (c: string | null): c is string => !!c && /^#[0-9A-Fa-f]{6}$/.test(c);

/** Brand colour usable for links on white (falls back when too light). */
function linkColor(brand: string): string {
  return contrast(brand, WHITE) >= 3 ? brand : DEFAULT_COLOR;
}
/** Readable text on the brand colour: white or ink, whichever contrasts more. */
function onColor(brand: string): string {
  return contrast(WHITE, brand) >= contrast(INK, brand) ? WHITE : INK;
}

/** https:// + host only, for display. */
const displayHost = (url: string) => hostOfUrl(url) ?? url;
const SOCIAL: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, 'Facebook'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)pinterest\.com$/, 'Pinterest'],
];
export function socialLabel(url: string): string {
  const host = displayHost(url);
  return SOCIAL.find(([re]) => re.test(host))?.[1] ?? host;
}
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
const safeHttp = (url: string | null): url is string =>
  !!url && /^https?:\/\/[^\s"'<>]+$/i.test(url);

/** The logo is used only over https and only from a host the knowledge base mentions. */
export function logoAllowed(url: string | null, allowlist: Allowlist): boolean {
  if (!url || !/^https:\/\/[^\s"'<>]+$/i.test(url)) return false;
  const host = hostOfUrl(url);
  if (!host) return false;
  const normalized = normalizeUrl(url);
  return (
    allowlist.domains.has(host) ||
    [...allowlist.domains].some((d) => host.endsWith(`.${d}`)) ||
    (normalized !== null && allowlist.urls.has(normalized))
  );
}

/** Plain text → HTML: escaped, links clickable, blank lines make paragraphs. */
function textToHtml(text: string, anchorStyle: string, pStyle: string): string {
  const linkify = (line: string) => {
    let out = '';
    let at = 0;
    for (const l of findLinks(line)) {
      if (l.kind === 'obfuscated_email') continue;
      out += esc(line.slice(at, l.start));
      const shown = line.slice(l.start, l.end);
      const href =
        l.kind === 'email'
          ? `mailto:${l.value}`
          : /^https?:\/\//i.test(l.value)
            ? l.value
            : `https://${l.value}`;
      out += `<a href="${esc(href)}" style="${anchorStyle}">${esc(shown)}</a>`;
      at = l.end;
    }
    return out + esc(line.slice(at));
  };
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p style="${pStyle}">${para.split('\n').map(linkify).join('<br>')}</p>`)
    .join('');
}

interface ContactLink {
  label: string;
  href: string;
}
function contactLinks(b: EmailBrand): ContactLink[] {
  const out: ContactLink[] = [];
  if (safeHttp(b.website)) out.push({ label: displayHost(b.website), href: b.website });
  if (b.phone?.trim()) out.push({ label: b.phone.trim(), href: telHref(b.phone) });
  for (const s of b.socialLinks.slice(0, 3)) {
    if (safeHttp(s)) out.push({ label: socialLabel(s), href: s });
  }
  return out;
}

/** The text/plain version of templates 2–5: the reply, the signature, then the contact lines. */
function fullText(body: string, signature: string | null, b: EmailBrand): string {
  const lines: string[] = [];
  if (b.companyName?.trim() && !signature?.includes(b.companyName.trim()))
    lines.push(b.companyName.trim());
  if (safeHttp(b.website)) lines.push(b.website);
  if (b.phone?.trim()) lines.push(b.phone.trim());
  for (const s of b.socialLinks.slice(0, 3)) if (safeHttp(s)) lines.push(`${socialLabel(s)}: ${s}`);
  if (b.address?.trim()) lines.push(b.address.trim());
  return [
    body.trimEnd(),
    ...(signature?.trim() ? ['', signature.trim()] : []),
    ...(lines.length ? ['', ...lines] : []),
  ]
    .join('\n')
    .concat('\n');
}

// ---------------------------------------------------------------- templates
export function renderReplyEmail(i: RenderInput): RenderedReply {
  const signature = i.signature?.trim() || null;
  // 1. Plain: exactly what Noctiv has always sent.
  if (i.template === 'plain') {
    return {
      text: `${i.body.trimEnd()}${signature ? `\n\n${signature}` : ''}\n`,
      html: null,
      logo: 'none',
    };
  }

  const b = i.brand;
  const brand = isHex(b.color) ? b.color.toUpperCase() : DEFAULT_COLOR;
  const link = linkColor(brand);
  const text = fullText(i.body, signature, b);
  const wantsLogo = i.template !== 'clean';
  const logoOk = wantsLogo && logoAllowed(b.logoUrl, i.allowlist);
  const logoState: RenderedReply['logo'] =
    !wantsLogo || !b.logoUrl ? 'none' : logoOk ? 'shown' : 'blocked';
  const company = b.companyName?.trim() || '';

  const p = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK}`;
  const small = `margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}`;
  const anchor = `color:${link};text-decoration:underline`;
  const bodyHtml = textToHtml(i.body, anchor, p);
  const sigHtml = signature
    ? textToHtml(signature, anchor, p.replace('margin:0 0 14px', 'margin:0 0 6px'))
    : '';

  const logo = (align: 'left' | 'center' = 'left') =>
    logoOk
      ? `<img src="${esc(b.logoUrl!)}" alt="${esc(company || 'Logo')}" style="display:block;max-width:160px;max-height:64px;height:auto;width:auto;border:0;outline:none;text-decoration:none${align === 'center' ? ';margin:0 auto' : ''}">`
      : company
        ? `<p style="margin:0;font-family:${FONT};font-size:18px;font-weight:700;color:${INK}">${esc(company)}</p>`
        : '';

  const contacts = contactLinks(b);
  const contactInline = contacts.length
    ? `<p style="${small};margin-top:8px">${contacts
        .map(
          (c) =>
            `<a href="${esc(c.href)}" style="color:${link};text-decoration:none">${esc(c.label)}</a>`,
        )
        .join(' &nbsp;·&nbsp; ')}</p>`
    : '';
  const address = b.address?.trim()
    ? `<p style="${small};margin-top:6px">${esc(b.address.trim())}</p>`
    : '';
  const divider = `<div style="height:1px;line-height:1px;font-size:1px;background:${RULE};margin:18px 0">&nbsp;</div>`;

  const page = (bg: string, inner: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg}"><tr><td align="center" style="padding:${bg === WHITE ? '8px' : '24px 12px'}">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">${inner}</table>` +
    `</td></tr></table></body></html>`;

  let html: string;
  switch (i.template) {
    case 'clean':
      html = page(
        WHITE,
        `<tr><td style="padding:8px 4px">${bodyHtml}${divider}${sigHtml}${contactInline}${address}</td></tr>`,
      );
      break;
    case 'logo': {
      const top = logo();
      html = page(
        WHITE,
        `${top ? `<tr><td style="padding:8px 4px 18px">${top}</td></tr>` : ''}` +
          `<tr><td style="padding:0 4px 8px">${bodyHtml}${divider}${sigHtml}${contactInline}${address}</td></tr>`,
      );
      break;
    }
    case 'branded': {
      const top = logo();
      const sigBlock =
        sigHtml || contacts.length
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px"><tr>` +
            `<td style="width:3px;background:${brand};font-size:1px;line-height:1px">&nbsp;</td>` +
            `<td style="padding:2px 0 2px 12px">${sigHtml}${contactInline}</td></tr></table>`
          : '';
      html = page(
        WHITE,
        `<tr><td style="height:4px;line-height:4px;font-size:4px;background:${brand}">&nbsp;</td></tr>` +
          `${top ? `<tr><td style="padding:20px 4px 4px">${top}</td></tr>` : ''}` +
          `<tr><td style="padding:18px 4px 8px">${bodyHtml}${sigBlock}</td></tr>` +
          (b.address?.trim() || company
            ? `<tr><td style="padding:14px 4px 8px;border-top:1px solid ${RULE}"><p style="${small}">${esc(
                [company, b.address?.trim()].filter(Boolean).join(' · '),
              )}</p></td></tr>`
            : ''),
      );
      break;
    }
    case 'card': {
      const top = logo();
      const buttonStyle = `display:inline-block;margin:2px 6px 6px 0;padding:7px 14px;border-radius:999px;background:${brand};color:${onColor(brand)};font-family:${FONT};font-size:13px;font-weight:600;text-decoration:none`;
      const button = (c: ContactLink) =>
        `<a href="${esc(c.href)}" style="${buttonStyle}">${esc(c.label)}</a>`;
      // Every link in the signature is a brand-colour button, in place.
      const sigText = signature
        ? textToHtml(signature, buttonStyle, p.replace('margin:0 0 14px', 'margin:0 0 6px'))
        : '';
      const buttons = contacts;
      html = page(
        '#F4F5F7',
        `<tr><td style="background:${WHITE};border:1px solid ${RULE};border-radius:12px;padding:28px 28px 22px">` +
          `${top ? `<div style="margin:0 0 20px">${top}</div>` : ''}` +
          `${bodyHtml}${divider}${sigText}` +
          `${buttons.length ? `<div style="margin-top:10px">${buttons.map(button).join('')}</div>` : ''}` +
          `${address}</td></tr>`,
      );
      break;
    }
  }

  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return { text, html: null, logo: 'none', fallback: 'too_large' };
  }
  return { text, html, logo: logoState };
}
