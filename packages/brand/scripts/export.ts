/**
 * Renders every raster/icon export from the SVGs in svg/ and copies each
 * file to where the site and the app serve it.
 *   node scripts/export.ts
 * Outputs (exports/): favicon.svg, favicon.ico (16+32), apple-touch-icon.png
 * (180), icon-192.png, icon-512.png, icon-maskable-192.png,
 * icon-maskable-512.png, og.jpg (1200×630), email-header.png (1200×160,
 * shown at 600×80), avatar-400.png.
 * Favicons use the small mark (no tail); everything 24 px and up has the tail.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRAND } from '../src/tokens.ts';

const ROOT = join(import.meta.dirname, '..');
const REPO = join(ROOT, '../..');
const OUT = join(ROOT, 'exports');
mkdirSync(OUT, { recursive: true });

const svg = (n: string) => readFileSync(join(ROOT, 'svg', `${n}.svg`), 'utf8');
/** The mark's path data (from the generated SVG). */
const pathOf = (n: string) => /<path[^>]* d="([^"]+)"/.exec(svg(n))![1]!;
const uri = (n: string) => `data:image/svg+xml;base64,${Buffer.from(svg(n)).toString('base64')}`;
const font = readFileSync(
  join(ROOT, 'node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff2'),
).toString('base64');

// ------------------------------------------------------------- favicon.svg
// Dawn crescent on a night tile: legible on light and dark browser chrome.
const tile = (mark: string, inset: number, radius: number) =>
  `<rect width="32" height="32" rx="${radius}" fill="${BRAND.night}"/>` +
  `<path fill="${BRAND.dawn}" transform="translate(${inset} ${inset}) scale(${(32 - 2 * inset) / 32})" d="${pathOf(mark)}"/>`;
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile('mark-small-on-dark', 3, 7)}</svg>\n`;
writeFileSync(join(OUT, 'favicon.svg'), faviconSvg);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
async function render(
  html: string,
  w: number,
  h: number,
  opts: { transparent?: boolean; type?: 'png' | 'jpeg' } = {},
): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(
    `<!doctype html><html><head><style>@font-face{font-family:Manrope;font-weight:800;src:url(data:font/woff2;base64,${font}) format('woff2')}*{margin:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden}${opts.transparent ? 'html,body{background:transparent}' : ''}</style></head><body>${html}</body></html>`,
    { waitUntil: 'load' },
  );
  await p.evaluate(() => document.fonts.ready);
  const buf = await p.screenshot(
    opts.type === 'jpeg'
      ? { type: 'jpeg', quality: 86 }
      : { type: 'png', omitBackground: opts.transparent ?? false },
  );
  await p.close();
  return buf;
}
const svgTag = (inner: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" style="display:block">${inner}</svg>`;

/** An .ico holding PNG images (every current browser reads PNG-in-ICO). */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e);
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

try {
  // favicon.ico: 16 and 32, small mark on the rounded night tile.
  const icoImages = [];
  for (const size of [16, 32]) {
    icoImages.push({
      size,
      png: await render(svgTag(tile('mark-small-on-dark', 3, 7), size), size, size, {
        transparent: true,
      }),
    });
  }
  writeFileSync(join(OUT, 'favicon.ico'), ico(icoImages));

  // Full-bleed night squares with the full mark (platforms round the corners).
  // `inset` is the margin per side in 32nds.
  const square = (inset: number, size: number) => svgTag(tile('mark-on-dark', inset, 0), size);
  writeFileSync(join(OUT, 'apple-touch-icon.png'), await render(square(4.5, 180), 180, 180));
  writeFileSync(join(OUT, 'avatar-400.png'), await render(square(5.5, 400), 400, 400));
  for (const size of [192, 512]) {
    // "any": a rounded tile with transparent corners.
    writeFileSync(
      join(OUT, `icon-${size}.png`),
      await render(svgTag(tile('mark-on-dark', 4.5, 7), size), size, size, { transparent: true }),
    );
    // "maskable": full bleed, the mark inside the 80% safe circle.
    writeFileSync(
      join(OUT, `icon-maskable-${size}.png`),
      await render(square(6, size), size, size),
    );
  }

  // E-mail header: 600×80 CSS px, rendered at 2× for sharp screens.
  writeFileSync(
    join(OUT, 'email-header.png'),
    await render(
      `<div style="width:1200px;height:160px;background:${BRAND.night};position:relative;display:flex;align-items:center;padding:0 64px">
        <img src="${uri('horizontal-on-dark')}" style="height:64px;display:block">
        <div style="position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,transparent,rgba(246,200,154,.55) 25%,#f2a97e 50%,rgba(246,200,154,.55) 75%,transparent)"></div>
      </div>`,
      1200,
      160,
    ),
  );

  // OG image: the wordmark on the hero illustration (apps/site/assets).
  const heroArt = readFileSync(join(REPO, 'apps/site/assets/illustrations/hero.webp')).toString(
    'base64',
  );
  writeFileSync(
    join(OUT, 'og.jpg'),
    await render(
      `<div style="position:relative;width:1200px;height:630px;background:${BRAND.night};color:${BRAND.nightText};font-family:Manrope">
        <div style="position:absolute;inset:0;background:url(data:image/webp;base64,${heroArt}) 13% 64%/150% auto no-repeat"></div>
        <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(11,16,38,.92) 0%,rgba(11,16,38,.78) 38%,rgba(11,16,38,.15) 62%,rgba(11,16,38,.25) 100%),linear-gradient(180deg,rgba(11,16,38,.55),transparent 30%)"></div>
        <img src="${uri('horizontal-on-dark')}" style="position:absolute;left:80px;top:72px;height:52px">
        <h1 style="position:absolute;left:80px;top:176px;width:560px;font-size:72px;line-height:1.04;letter-spacing:-.04em;font-weight:800">Your inbox, answered while you sleep.</h1>
        <div style="position:absolute;left:80px;bottom:64px;font-size:24px;font-weight:800;letter-spacing:-.01em;color:#b4bcd9">noctiv.io</div>
      </div>`,
      1200,
      630,
      { type: 'jpeg' },
    ),
  );
} finally {
  await browser.close();
}

// -------------------------------------------------------------- distribute
const COPIES: [string, string][] = [
  // Site (noctiv.io): favicons, OG, and the public copies e-mails and
  // profiles link to.
  ['favicon.svg', 'apps/site/src/public/favicon.svg'],
  ['favicon.ico', 'apps/site/src/public/favicon.ico'],
  ['apple-touch-icon.png', 'apps/site/src/public/apple-touch-icon.png'],
  ['og.jpg', 'apps/site/src/public/og.jpg'],
  ['email-header.png', 'apps/site/src/public/brand/email-header.png'],
  ['avatar-400.png', 'apps/site/src/public/brand/avatar-400.png'],
  // App (app.noctiv.io): Next.js file conventions and the manifest icons.
  ['favicon.svg', 'apps/web/src/app/icon.svg'],
  ['apple-touch-icon.png', 'apps/web/src/app/apple-icon.png'],
  ['favicon.ico', 'apps/web/public/favicon.ico'],
  ['icon-192.png', 'apps/web/public/brand/icon-192.png'],
  ['icon-512.png', 'apps/web/public/brand/icon-512.png'],
  ['icon-maskable-192.png', 'apps/web/public/brand/icon-maskable-192.png'],
  ['icon-maskable-512.png', 'apps/web/public/brand/icon-maskable-512.png'],
];
for (const [from, to] of COPIES) {
  mkdirSync(dirname(join(REPO, to)), { recursive: true });
  copyFileSync(join(OUT, from), join(REPO, to));
}
// The app shows the lockup from its own public folder.
for (const n of ['horizontal-on-light', 'horizontal-on-dark', 'stacked-on-light']) {
  mkdirSync(join(REPO, 'apps/web/public/brand'), { recursive: true });
  copyFileSync(join(ROOT, 'svg', `${n}.svg`), join(REPO, `apps/web/public/brand/${n}.svg`));
}
console.log(
  'exports:',
  [
    'favicon.ico',
    'apple-touch-icon.png',
    'icon-512.png',
    'og.jpg',
    'email-header.png',
    'avatar-400.png',
  ]
    .map((f) => `${f} ${Math.round(readFileSync(join(OUT, f)).length / 1024)} KB`)
    .join(', '),
);
