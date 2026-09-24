import * as cheerio from 'cheerio';

export interface ExtractedPage {
  title: string;
  /** Markdown-like text: "# " headings, "- " list items, paragraphs. */
  text: string;
  /** Absolute http(s) links found on the page (fragment removed). */
  links: string[];
}

const DROP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'nav',
  'footer',
  'header',
  'aside',
  '[aria-hidden="true"]',
  '[hidden]',
].join(',');

/**
 * Turns a web page into plain, structured text. Navigation, scripts, forms
 * and anything hidden with inline CSS are dropped — hidden text on a website
 * is a classic place to plant instructions for AI crawlers.
 */
export function extractHtml(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href') ?? '', pageUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.hash = '';
        links.add(u.toString());
      }
    } catch {
      // ignore malformed links
    }
  });

  $(DROP).remove();
  $('[style]').each((_, el) => {
    const style = ($(el).attr('style') ?? '').toLowerCase().replace(/\s+/g, '');
    if (/display:none|visibility:hidden|font-size:0|opacity:0(?![.\d])|max-height:0/.test(style))
      $(el).remove();
  });

  const title = $('title').first().text().trim();
  const root = $('main').length ? $('main').first() : $('body');
  const lines: string[] = [];
  root.find('h1, h2, h3, h4, p, li, td, th, blockquote, pre, dt, dd').each((_, el) => {
    const $el = $(el);
    // Skip containers whose text is emitted by a nested matched element.
    if ($el.find('p, li, h1, h2, h3, h4, td, th').length && !/^h[1-4]$/.test(el.tagName)) return;
    const t = $el.text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^h[1-4]$/.test(el.tagName)) lines.push(`${'#'.repeat(Number(el.tagName[1]))} ${t}`);
    else if (el.tagName === 'li') lines.push(`- ${t}`);
    else lines.push(t);
  });
  if (lines.length === 0) {
    const fallback = root.text().replace(/\s+/g, ' ').trim();
    if (fallback) lines.push(fallback);
  }
  return { title, text: lines.join('\n\n'), links: [...links] };
}
