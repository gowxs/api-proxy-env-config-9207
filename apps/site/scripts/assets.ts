/**
 * Renders the social image and app icons from HTML with the site's own fonts.
 *   node scripts/assets.ts   → src/public/og.jpg, apple-touch-icon.png, favicon.ico
 * Re-run after changing the brand; the outputs are committed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PUBLIC = join(import.meta.dirname, '../src/public');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

const moon = (size: number, color = '#f2d98b') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${color}" d="M20.6 14.4A8.6 8.6 0 0 1 9.6 3.4a8.6 8.6 0 1 0 11 11Z"/><circle cx="18.2" cy="5.4" r="1.3" fill="${color}" opacity=".75"/></svg>`;

// Embedded: a page set with setContent has no origin to load the font from.
const font = readFileSync(
  join(
    import.meta.dirname,
    '../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2',
  ),
).toString('base64');
const fontFace = `@font-face{font-family:Manrope;font-weight:200 800;src:url(data:font/woff2;base64,${font}) format('woff2')}`;

// The hero illustration (assets/illustrations/hero.webp): night sky, a glowing
// envelope, sunrise over water. Text sits on the darkened left.
const heroArt = readFileSync(
  join(import.meta.dirname, '../assets/illustrations/hero.webp'),
).toString('base64');
const og = `<!doctype html><html><head><style>${fontFace}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;font-family:Manrope;background:#0b1026;color:#eef1fa;position:relative;overflow:hidden}
.art{position:absolute;inset:0;background:url(data:image/webp;base64,${heroArt}) 13% 64%/150% auto no-repeat}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(11,16,38,.92) 0%,rgba(11,16,38,.78) 38%,rgba(11,16,38,.15) 62%,rgba(11,16,38,.25) 100%),linear-gradient(180deg,rgba(11,16,38,.55),transparent 30%)}
.brand{position:absolute;left:80px;top:72px;display:flex;align-items:center;gap:16px;font-weight:800;font-size:40px;letter-spacing:-.03em}
h1{position:absolute;left:80px;top:176px;width:560px;font-size:72px;line-height:1.04;letter-spacing:-.04em;font-weight:800}
.url{position:absolute;left:80px;bottom:64px;font-size:24px;font-weight:600;color:#b4bcd9}
</style></head><body><div class="art"></div><div class="shade"></div>
<div class="brand">${moon(44)}Noctiv</div>
<h1>Your inbox, answered while you sleep.</h1>
<div class="url">noctiv.io</div></body></html>`;

const icon = (size: number, radius: number) => `<!doctype html><html><head><style>*{margin:0}
body{width:${size}px;height:${size}px;display:grid;place-items:center;background:#0b1026;border-radius:${radius}px}</style></head>
<body>${moon(Math.round(size * 0.66))}</body></html>`;

async function render(
  html: string,
  w: number,
  h: number,
  transparent = false,
  type: 'png' | 'jpeg' = 'png',
): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  const png = await p.screenshot(
    type === 'jpeg' ? { type, quality: 86 } : { type, omitBackground: transparent },
  );
  await p.close();
  return png;
}

/** An .ico holding one PNG image (supported by every current browser). */
function ico(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

try {
  writeFileSync(join(PUBLIC, 'og.jpg'), await render(og, 1200, 630, false, 'jpeg'));
  writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), await render(icon(180, 0), 180, 180));
  writeFileSync(join(PUBLIC, 'favicon.ico'), ico(await render(icon(32, 7), 32, 32, true), 32));
} finally {
  await browser.close();
}
console.log(
  'assets written:',
  ['og.jpg', 'apple-touch-icon.png', 'favicon.ico']
    .map((f) => `${f} ${readFileSync(join(PUBLIC, f)).length} B`)
    .join(', '),
);
