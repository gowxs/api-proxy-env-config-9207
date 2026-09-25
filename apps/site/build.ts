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
/** The web app ("Sign in"). Switch to https://app.noctiv.io/ once that domain points at the app. */
const APP_URL = process.env.SITE_APP_URL ?? 'https://noctiv-app.netlify.app/';

interface PageMeta {
  title: string;
  description: string;
  /** Header link to mark as current: how | pricing | contact. */
  nav?: string;
  /** Excluded from the sitemap and search engines. */
  noindex?: boolean;
  /** Inline scripts from src/scripts, e.g. ["demo.js"]. */
  scripts?: string[];
}

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
    "form-action 'self'",
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

/*.png
  Cache-Control: public, max-age=86400

/favicon.*
  Cache-Control: public, max-age=86400
`;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function build(): { pages: string[] } {
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
  const withFonts = (text: string) =>
    text.replace(/\/fonts\/manrope-latin(?:-ext)?\.woff2/g, (m) => fontNames[m] ?? m);

  const parts = partials();
  const layout = parts.layout!;
  const inlineScripts = new Set<string>();
  const pages: string[] = [];
  const sitemap: string[] = [];

  for (const file of readdirSync(join(SRC, 'pages')).filter((f) => f.endsWith('.html'))) {
    const raw = read(join(SRC, 'pages', file));
    const m = /^<script type="application\/json" id="page">([\s\S]*?)<\/script>\s*/.exec(raw);
    if (!m) throw new Error(`${file}: missing page header`);
    const meta = JSON.parse(m[1]!) as PageMeta;
    const slug = file.replace(/\.html$/, '');
    const path = slug === 'index' ? '/' : slug === '404' ? '/404' : `/${slug}/`;
    const scripts = (meta.scripts ?? [])
      .map((s) => `<script>${minifyJs(read(join(SRC, 'scripts', s)))}</script>`)
      .join('');
    const html = render(
      layout,
      {
        title: escapeAttr(meta.title),
        description: escapeAttr(meta.description),
        url: ORIGIN + path,
        origin: ORIGIN,
        head: meta.noindex ? '<meta name="robots" content="noindex" />' : '',
        css,
        // Partials inside the page body are expanded before it goes into the layout.
        content: render(raw.slice(m[0].length), {}, parts),
        scripts,
        nav: meta.nav ?? '',
        app: APP_URL,
        year: String(new Date().getFullYear()),
      },
      parts,
    );
    const target =
      slug === 'index' ? 'index.html' : slug === '404' ? '404.html' : join(slug, 'index.html');
    mkdirSync(dirname(join(DIST, target)), { recursive: true });
    const finalHtml = withFonts(minifyHtml(html));
    const leftover = /\{\{[^}]*\}\}/.exec(finalHtml);
    if (leftover) throw new Error(`${file}: unresolved template tag ${leftover[0]}`);
    for (const m of finalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) inlineScripts.add(m[1]!);
    writeFileSync(join(DIST, target), finalHtml);
    pages.push(path);
    if (!meta.noindex && slug !== '404') sitemap.push(ORIGIN + path);
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
    `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
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
      if (extname(p) === '.html') build();
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
  const { pages } = build();
  console.log(`built ${pages.length} pages → dist/`);
  if (process.argv.includes('--serve')) {
    await serve();
    console.log('serving http://127.0.0.1:4321');
  }
}
