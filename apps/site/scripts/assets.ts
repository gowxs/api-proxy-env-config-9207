/**
 * Renders the social image and app icons from HTML with the site's own fonts.
 *   node scripts/assets.ts   → src/public/og.png, apple-touch-icon.png, favicon.ico
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

const og = `<!doctype html><html><head><style>${fontFace}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;font-family:Manrope;background:#0b1026;color:#eef1fa;position:relative;overflow:hidden}
.glow{position:absolute;left:50%;bottom:-2px;width:1500px;height:260px;transform:translateX(-50%);background:radial-gradient(50% 100% at 50% 100%,rgba(242,169,126,.28),transparent 70%)}
.line{position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,transparent,rgba(246,200,154,.6) 30%,#f2a97e 50%,rgba(246,200,154,.6) 70%,transparent)}
.brand{position:absolute;left:80px;top:72px;display:flex;align-items:center;gap:16px;font-weight:800;font-size:40px;letter-spacing:-.03em}
h1{position:absolute;left:80px;top:170px;width:640px;font-size:76px;line-height:1.02;letter-spacing:-.04em;font-weight:800}
.card{position:absolute;right:80px;top:120px;width:360px;border-radius:24px;background:#121a3a;border:1px solid #2a3566;overflow:hidden}
.sky{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;background:linear-gradient(100deg,#f7d3a8,#fbe6c8 55%,#fdf3e4);color:#3a2410;font-weight:700}
.sky b{font-size:30px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;align-items:center;margin:14px 18px;padding:14px 16px;border-radius:14px;font-size:19px;font-weight:600}
.in{background:#0b1026;border:1px solid #1b2550;color:#b4bcd9}
.draft{background:#f5f6fa;color:#3b2fd0}
.ok{background:#157a51;color:#fff;justify-content:center;gap:10px}
.row span:last-child{font-variant-numeric:tabular-nums;font-weight:700}
.url{position:absolute;left:80px;bottom:64px;font-size:24px;font-weight:600;color:#8f98bd}
</style></head><body><div class="glow"></div><div class="line"></div>
<div class="brand">${moon(44)}Noctiv</div>
<h1>Your inbox, answered while you sleep.</h1>
<div class="card"><div class="sky"><span>Thursday morning</span><b>08:05</b></div>
<div class="row in"><span>Customer e-mail</span><span>23:41</span></div>
<div class="row draft"><span>Draft reply</span><span>23:42</span></div>
<div class="row ok"><span>✓ Approved</span><span>08:05</span></div><div style="height:6px"></div></div>
<div class="url">noctiv.io</div></body></html>`;

const icon = (size: number, radius: number) => `<!doctype html><html><head><style>*{margin:0}
body{width:${size}px;height:${size}px;display:grid;place-items:center;background:#0b1026;border-radius:${radius}px}</style></head>
<body>${moon(Math.round(size * 0.66))}</body></html>`;

async function render(html: string, w: number, h: number, transparent = false): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  const png = await p.screenshot({ type: 'png', omitBackground: transparent });
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
  writeFileSync(join(PUBLIC, 'og.png'), await render(og, 1200, 630));
  writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), await render(icon(180, 0), 180, 180));
  writeFileSync(join(PUBLIC, 'favicon.ico'), ico(await render(icon(32, 7), 32, 32, true), 32));
} finally {
  await browser.close();
}
console.log(
  'assets written:',
  ['og.png', 'apple-touch-icon.png', 'favicon.ico']
    .map((f) => `${f} ${readFileSync(join(PUBLIC, f)).length} B`)
    .join(', '),
);
