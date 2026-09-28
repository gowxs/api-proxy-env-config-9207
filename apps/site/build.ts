/**
 * Static build for noctiv.io. No framework: pages are HTML with a JSON header,
 * assembled with partials, CSS inlined (one small request per page), output to dist/.
 *
 *   node build.ts          build once
 *   node build.ts --serve  build, then serve dist/ on :4321, rebuilding on every page request
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const ORIGIN = 'https://noctiv.io';
/** The web app ("Sign in"). */
const APP_URL = process.env.SITE_APP_URL ?? 'https://app.noctiv.io/';

interface PageMeta {
  title: string;
  description: string;
  /** Header link to mark as current: how | pricing | integrations | contact. */
  nav?: string;
  /** Excluded from the sitemap and search engines. */
  noindex?: boolean;
  /** Inline scripts from src/scripts, e.g. ["demo.js"]. */
  scripts?: string[];
  /** Short name in breadcrumbs (default: the title up to " · "). */
  crumb?: string;
  /** Adds the SoftwareApplication structured data (home and pricing). */
  product?: boolean;
  /** Blog posts: publication date (YYYY-MM-DD), required below /blog/. */
  date?: string;
  /** Blog posts: date of the last real change (YYYY-MM-DD). */
  updated?: string;
  /** Blog posts: built only by the local preview, never deployed or listed. */
  draft?: boolean;
}

/** Facts shared by the structured data and llms.txt: keep in step with Pricing. */
const ORGANIZATION = {
  '@type': 'Organization',
  '@id': `${ORIGIN}/#organization`,
  name: 'Noctiv',
  url: `${ORIGIN}/`,
  logo: `${ORIGIN}/brand/avatar-400.png`,
  email: 'contact@noctiv.io',
  address: { '@type': 'PostalAddress', addressCountry: 'LV' },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: 'contact@noctiv.io',
    availableLanguage: ['en'],
  },
};
const SOFTWARE = {
  '@type': 'SoftwareApplication',
  '@id': `${ORIGIN}/#software`,
  name: 'Noctiv',
  url: `${ORIGIN}/`,
  description:
    "An e-mail assistant for small businesses: it reads the business mailbox, drafts replies from the business's own prices and policies, follows up with customers who went quiet, and makes quotes, invoices and delivery notes. The owner approves with one click.",
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'E-mail assistant',
  operatingSystem: 'Web',
  publisher: { '@id': `${ORIGIN}/#organization` },
  offers: {
    '@type': 'Offer',
    price: '79',
    priceCurrency: 'USD',
    url: `${ORIGIN}/pricing/`,
    description:
      'Per business, per month, plus VAT where applicable. 14 days free, no card to start.',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: '79',
      priceCurrency: 'USD',
      unitText: 'month',
      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
    },
  },
};
/** Names of the section index pages, for breadcrumbs of the pages below them. */
const SECTIONS: Record<string, string> = {
  for: 'Use cases',
  compare: 'Compare',
  help: 'Help',
  blog: 'Blog',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const read = (p: string) => readFileSync(p, 'utf8');

function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function minifyJs(js: string): string {
  // Conservative: drop full-line comments and indentation only.
  return js
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

function minifyHtml(html: string): string {
  return html
    .replace(/<!--(?!\[|\/?email_off)[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function partials(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(SRC, 'partials'))) {
    out[f.replace(/\.html$/, '')] = read(join(SRC, 'partials', f));
  }
  // The logo comes from the brand kit (packages/brand/svg), inlined: the
  // horizontal lockup for night backgrounds. The link around it carries the name.
  out.logo = read(join(ROOT, '../../packages/brand/svg/horizontal-on-dark.svg'))
    .trim()
    .replace(/<title>.*?<\/title>/, '')
    .replace(/ (width|height|role|aria-label)="[^"]*"/g, '')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
  return out;
}

function render(tpl: string, vars: Record<string, string>, parts: Record<string, string>): string {
  let out = tpl;
  // Partials may include partials; three passes are plenty.
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name: string) => {
      if (!(name in parts)) throw new Error(`unknown partial: ${name}`);
      return parts[name]!;
    });
  }
  out = out.replace(/\{\{current:(\w+)\}\}/g, (_, key: string) =>
    vars.nav === key ? ' aria-current="page"' : '',
  );
  return out.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key]! : m));
}

/**
 * Cloudflare Pages headers. Scripts are only the inline ones we wrote, allowed
 * by hash; everything else is same-origin. Styles stay inline (one small block).
 * `no-transform` stops Cloudflare's edge from rewriting pages: without it the
 * zone injected an analytics beacon and replaced mailto: links with its e-mail
 * obfuscation script (both blocked by the CSP; found on the first deploy).
 */
function headers(scripts: string[]): string {
  const hashes = scripts
    .map((s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`)
    .sort()
    .join(' ');
  const csp = [
    "default-src 'none'",
    `script-src ${hashes || "'none'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    // The integrations waitlist forms post to the app's API.
    `form-action 'self' ${new URL(APP_URL).origin}`,
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  return `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Cache-Control: public, max-age=0, must-revalidate, no-transform

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/img/*
  Cache-Control: public, max-age=31536000, immutable

/*.png
  Cache-Control: public, max-age=86400

/*.jpg
  Cache-Control: public, max-age=86400

/favicon.*
  Cache-Control: public, max-age=86400
`;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const oneLine = (html: string) =>
  decode(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

/** JSON-LD for the head; "<" escaped so text can never close the script element. */
const jsonLd = (data: object) =>
  `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c')}</script>`;

/** FAQPage from the page's .faq block (summary = question, the rest = answer). */
function faqSchema(content: string): object | null {
  const faq = /<div class="faq"[^>]*>([\s\S]*?)<\/div>/.exec(content)?.[1];
  if (!faq) return null;
  const items = [...faq.matchAll(/<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map(
    ([, q, a]) => ({
      '@type': 'Question',
      name: oneLine(q!),
      acceptedAnswer: { '@type': 'Answer', text: oneLine(a!) },
    }),
  );
  return items.length ? { '@type': 'FAQPage', mainEntity: items } : null;
}

/** Page text for llms-full.txt: headings, paragraphs and lists as plain Markdown. */
function pageText(content: string): string {
  return decode(
    content
      .replace(/\s+/g, ' ')
      .replace(/<(script|style|svg|form|picture|template)\b[\s\S]*?<\/\1>/g, '')
      .replace(/<time\b[^>]*>/g, ' · ')
      .replace(/<\/b>\s*<span>/g, '</b>: <span>')
      .replace(/<p\b[^>]*>/g, '\n\n')
      .replace(/<nav class="crumbs"[\s\S]*?<\/nav>/g, '')
      .replace(/<(img|input|hr)\b[^>]*>/g, '')
      .replace(/<a class="btn[^"]*"[^>]*>[\s\S]*?<\/a>/g, '')
      .replace(/<h1[^>]*>/g, '\n\n# ')
      .replace(/<h2[^>]*>/g, '\n\n## ')
      .replace(/<(h3|summary)[^>]*>/g, '\n\n### ')
      .replace(/<\/(h[1-6]|summary)>/g, '\n')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(
        /<(p|div|section|article|ol|ul|dl|dt|tr|details|blockquote|figure|figcaption|br)\b[^>]*>/g,
        '\n',
      )
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^- .*)\n\n(?=- )/gm, '$1\n')
    .trim();
}

/** All pages under src/pages, nested folders included ("help/billing.html"). */
function pageFiles(dir = join(SRC, 'pages'), prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? pageFiles(join(dir, e.name), `${prefix}${e.name}/`)
        : e.name.endsWith('.html')
          ? [prefix + e.name]
          : [],
    )
    .sort();
}

/** robots.txt: everyone may crawl; the AI crawlers are named so the intent is explicit. */
const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

export function build({ drafts = false } = {}): { pages: string[] } {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const css = minifyCss(
    ['tokens.css', 'base.css', 'components.css', 'pages.css']
      .map((f) => join(SRC, 'styles', f))
      .filter(existsSync)
      .map(read)
      .join('\n'),
  );
  // Fonts get content-hashed names so they can be cached forever.
  const fontSrc = join(ROOT, 'node_modules/@fontsource-variable/manrope/files');
  mkdirSync(join(DIST, 'fonts'), { recursive: true });
  const fontNames: Record<string, string> = {};
  for (const [name, file] of [
    ['manrope-latin', 'manrope-latin-wght-normal.woff2'],
    ['manrope-latin-ext', 'manrope-latin-ext-wght-normal.woff2'],
  ] as const) {
    const data = readFileSync(join(fontSrc, file));
    const hashed = `${name}.${createHash('sha256').update(data).digest('hex').slice(0, 10)}.woff2`;
    writeFileSync(join(DIST, 'fonts', hashed), data);
    fontNames[`/fonts/${name}.woff2`] = `/fonts/${hashed}`;
  }
  // Illustrations too (src/images → /img/name.<hash>.webp).
  const imageNames: Record<string, string> = {};
  if (existsSync(join(SRC, 'images'))) {
    mkdirSync(join(DIST, 'img'), { recursive: true });
    for (const file of readdirSync(join(SRC, 'images')).filter((f) => f.endsWith('.webp'))) {
      const data = readFileSync(join(SRC, 'images', file));
      const hashed = file.replace(
        /\.webp$/,
        `.${createHash('sha256').update(data).digest('hex').slice(0, 10)}.webp`,
      );
      writeFileSync(join(DIST, 'img', hashed), data);
      imageNames[`/img/${file}`] = `/img/${hashed}`;
    }
  }
  const withFonts = (text: string) =>
    text
      .replace(/\/fonts\/manrope-latin(?:-ext)?\.woff2/g, (m) => fontNames[m] ?? m)
      .replace(/\/img\/[a-z0-9-]+\.webp/g, (m) => {
        const hashed = imageNames[m];
        if (!hashed) throw new Error(`unknown image ${m}`);
        return hashed;
      });

  const parts = partials();
  const layout = parts.layout!;
  const inlineScripts = new Set<string>();
  const pages: string[] = [];
  const sitemap: string[] = [];

  // First pass: every page's meta and path, so breadcrumbs can name their parents.
  const entries = pageFiles()
    .map((file) => {
      const raw = read(join(SRC, 'pages', file));
      const m = /^<script type="application\/json" id="page">([\s\S]*?)<\/script>\s*/.exec(raw);
      if (!m) throw new Error(`${file}: missing page header`);
      const meta = JSON.parse(m[1]!) as PageMeta;
      const slug = file.replace(/\.html$/, '');
      const path =
        slug === 'index'
          ? '/'
          : slug === '404'
            ? '/404'
            : `/${slug.replace(/(^|\/)index$/, '')}/`.replace(/\/\/$/, '/');
      const target = slug === '404' ? '404.html' : join(path.slice(1), 'index.html');
      const post = /^\/blog\/[^/]+\/$/.test(path);
      if (post && !ISO_DATE.test(meta.date ?? ''))
        throw new Error(`${file}: "date" must be YYYY-MM-DD`);
      if (post && meta.updated && !ISO_DATE.test(meta.updated)) {
        throw new Error(`${file}: "updated" must be YYYY-MM-DD`);
      }
      return { file, body: raw.slice(m[0].length), meta, path, target, post };
    })
    .filter((e) => drafts || !e.meta.draft);

  // The blog index lists published posts, newest first. With none it says so
  // and stays out of search engines, so an empty section is never indexed.
  const posts = entries
    .filter((e) => e.post && !e.meta.draft)
    .sort((a, b) => b.meta.date!.localeCompare(a.meta.date!) || a.path.localeCompare(b.path));
  const blogIndex = entries.find((e) => e.path === '/blog/');
  if (blogIndex && posts.length === 0) blogIndex.meta.noindex = true;
  const postList = posts.length
    ? `<ul class="links">${posts
        .map(
          (p) =>
            `<li><a href="${p.path}"><b>${p.meta.title.split(' · ')[0]}</b><span><time datetime="${p.meta.date}">${longDate(p.meta.date!)}</time> · ${p.meta.description}</span></a></li>`,
        )
        .join('')}</ul>`
    : '<p class="lead">No posts yet. The first one is on its way.</p>';
  const crumbName = (meta: PageMeta) => meta.crumb ?? meta.title.split(' · ')[0]!;
  const texts: { path: string; title: string; text: string }[] = [];

  for (const { file, body, meta, path, target, post } of entries) {
    const scripts = (meta.scripts ?? [])
      .map((s) => `<script>${minifyJs(read(join(SRC, 'scripts', s)))}</script>`)
      .join('');

    // Breadcrumbs: Home › section › page (inner pages only).
    const trail: { name: string; path: string }[] = [];
    if (path !== '/' && path !== '/404') {
      trail.push({ name: 'Home', path: '/' });
      const section = /^\/([^/]+)\/[^/]+\/$/.exec(path)?.[1];
      if (section) trail.push({ name: SECTIONS[section] ?? section, path: `/${section}/` });
      trail.push({ name: crumbName(meta), path });
    }
    const crumbs = trail.length
      ? `<nav class="crumbs" aria-label="Breadcrumb"><ol>${trail
          .map((c, i) =>
            i === trail.length - 1
              ? `<li aria-current="page">${c.name}</li>`
              : `<li><a href="${c.path}">${c.name}</a></li>`,
          )
          .join('')}</ol></nav>`
      : '';

    const content = render(
      body,
      {
        app: APP_URL,
        crumbs,
        posts: postList,
        date: meta.date ?? '',
        dateLong: meta.date ? longDate(meta.date) : '',
      },
      parts,
    );
    const graph: object[] = [];
    if (path === '/') {
      graph.push(ORGANIZATION, {
        '@type': 'WebSite',
        '@id': `${ORIGIN}/#website`,
        name: 'Noctiv',
        url: `${ORIGIN}/`,
        publisher: { '@id': `${ORIGIN}/#organization` },
      });
    }
    if (meta.product) graph.push(SOFTWARE);
    if (post) {
      graph.push({
        '@type': 'BlogPosting',
        headline: meta.title.split(' · ')[0],
        description: meta.description,
        datePublished: meta.date,
        dateModified: meta.updated ?? meta.date,
        url: ORIGIN + path,
        mainEntityOfPage: ORIGIN + path,
        image: `${ORIGIN}/og.jpg`,
        inLanguage: 'en',
        author: { '@id': `${ORIGIN}/#organization` },
        publisher: ORGANIZATION,
      });
    }
    const faq = faqSchema(content);
    if (faq) graph.push(faq);
    if (trail.length) {
      graph.push({
        '@type': 'BreadcrumbList',
        itemListElement: trail.map((c, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: c.name,
          item: ORIGIN + c.path,
        })),
      });
    }
    const head = [
      meta.noindex ? '<meta name="robots" content="noindex" />' : '',
      graph.length && !meta.noindex && !meta.draft ? jsonLd({ '@graph': graph }) : '',
      meta.draft ? '<meta name="robots" content="noindex" />' : '',
    ].join('');

    const html = render(
      layout,
      {
        title: escapeAttr(meta.title),
        description: escapeAttr(meta.description),
        url: ORIGIN + path,
        origin: ORIGIN,
        head,
        css,
        // Partials inside the page body are expanded before it goes into the layout.
        content,
        scripts,
        nav: meta.nav ?? '',
        app: APP_URL,
        year: String(new Date().getFullYear()),
      },
      parts,
    );
    mkdirSync(dirname(join(DIST, target)), { recursive: true });
    const finalHtml = withFonts(minifyHtml(html));
    const leftover = /\{\{[^}]*\}\}/.exec(finalHtml);
    if (leftover) throw new Error(`${file}: unresolved template tag ${leftover[0]}`);
    for (const m of finalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) inlineScripts.add(m[1]!);
    writeFileSync(join(DIST, target), finalHtml);
    pages.push(path);
    if (!meta.noindex && !meta.draft && path !== '/404') {
      sitemap.push(ORIGIN + path);
      if (path !== '/') texts.push({ path, title: meta.title, text: pageText(content) });
    }
  }

  if (existsSync(join(SRC, 'public'))) cpSync(join(SRC, 'public'), DIST, { recursive: true });
  writeFileSync(join(DIST, '_headers'), headers([...inlineScripts]));

  writeFileSync(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap
      .sort()
      .map((u) => `  <url><loc>${u}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  );
  writeFileSync(
    join(DIST, 'robots.txt'),
    `${['*', ...AI_CRAWLERS].map((a) => `User-agent: ${a}\nAllow: /\n`).join('\n')}\nSitemap: ${ORIGIN}/sitemap.xml\n`,
  );

  // llms-full.txt: the summary (src/public/llms.txt), then every page's text.
  const order = (p: string) =>
    ['/how-it-works/', '/pricing/', '/integrations/', '/for/', '/compare/', '/help/'].findIndex(
      (x) => p.startsWith(x),
    ) >>> 0;
  writeFileSync(
    join(DIST, 'llms-full.txt'),
    `${read(join(SRC, 'public', 'llms.txt')).trim()}\n\n---\n\nThe full text of every page on ${ORIGIN} follows.\n\n${texts
      .sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path))
      .map((t) => `---\n\nSource: ${ORIGIN}${t.path}\n\n${t.text}`)
      .join('\n\n')}\n`,
  );
  return { pages };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json',
};

/** Local preview. Rebuilds on each HTML request so edits show on reload. */
export function serve(port = 4321): Promise<() => void> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      if (extname(p) === '.html') build({ drafts: true });
      let file = join(DIST, p);
      if (!file.startsWith(DIST) || !existsSync(file)) {
        file = existsSync(join(DIST, p, 'index.html'))
          ? join(DIST, p, 'index.html')
          : join(DIST, '404.html');
        res.statusCode = file.endsWith('404.html') ? 404 : 200;
      }
      // Same global headers as Cloudflare Pages (the "/*" block of _headers).
      const global = /^\/\*\n((?: {2}.+\n)+)/.exec(readFileSync(join(DIST, '_headers'), 'utf8'));
      for (const line of global?.[1]!.trim().split('\n') ?? []) {
        const i = line.indexOf(':');
        if (
          !/^(Strict-Transport|Content-Security)/.test(line.trim()) ||
          extname(file) === '.html'
        ) {
          res.setHeader(line.slice(0, i).trim(), line.slice(i + 1).trim());
        }
      }
      res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
      res.end(readFileSync(file));
    });
    server.listen(port, '127.0.0.1', () => resolve(() => server.close()));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The local preview also shows draft posts; the deployed build never does.
  const { pages } = build({ drafts: process.argv.includes('--serve') });
  console.log(`built ${pages.length} pages → dist/`);
  if (process.argv.includes('--serve')) {
    await serve();
    console.log('serving http://127.0.0.1:4321');
  }
}
