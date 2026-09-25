/**
 * Review sheets: the mark and the lockups on light and dark, as PNG.
 *   node scripts/preview.ts [outDir]   (default: preview/)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRAND } from '../src/tokens.ts';

const ROOT = join(import.meta.dirname, '..');
const out = process.argv[2] ?? join(ROOT, 'preview');
mkdirSync(out, { recursive: true });
const svg = (n: string) => readFileSync(join(ROOT, 'svg', `${n}.svg`), 'utf8');
const uri = (n: string) => `data:image/svg+xml;base64,${Buffer.from(svg(n)).toString('base64')}`;
const font = readFileSync(
  join(ROOT, 'node_modules/@fontsource/manrope/files/manrope-latin-600-normal.woff2'),
).toString('base64');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

async function shot(name: string, html: string, width: number) {
  const p = await browser.newPage({ viewport: { width, height: 400 }, deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: join(out, name), fullPage: true });
  await p.close();
}

const page = (body: string) => `<!doctype html><html><head><style>
@font-face{font-family:M;src:url(data:font/woff2;base64,${font})}
*{margin:0;box-sizing:border-box}
body{font-family:M,sans-serif;font-size:13px;color:#646c8a;background:#fff;padding:32px}
.row{display:flex;gap:24px;align-items:stretch;margin-bottom:24px}
.tile{flex:1;border-radius:16px;padding:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;min-height:240px}
.light{background:${BRAND.paper};border:1px solid #dce0eb}
.dark{background:${BRAND.night};color:#8f98bd}
.white{background:#fff;border:1px solid #dce0eb}
.label{align-self:flex-start;font-weight:600;letter-spacing:.02em}
h2{font-size:15px;color:#131a2e;margin:8px 0 12px}
.sizes{display:flex;gap:28px;align-items:flex-end}
.sizes figure{display:flex;flex-direction:column;align-items:center;gap:8px}
.px{image-rendering:pixelated}
</style></head><body>${body}</body></html>`;

// 1. The mark: large, at real sizes, and 16/32 px blown up (pixel-exact).
const sizes = (v: string) =>
  `<div class="sizes">${[64, 32, 24, 16]
    .map(
      (s) =>
        `<figure><img src="${uri(`mark-${v}`)}" width="${s}" height="${s}"><span>${s}px</span></figure>`,
    )
    .join('')}</div>`;
// Render 16 and 32 px at 1× and scale up without smoothing, to judge small-size legibility.
async function pixels(v: string, bg: string, s: number): Promise<string> {
  const p = await browser.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await p.setContent(
    `<body style="margin:0;background:${bg}"><img src="${uri(`mark-${v}`)}" width="${s}" height="${s}" style="display:block"></body>`,
  );
  const png = await p.screenshot({ type: 'png' });
  await p.close();
  return `data:image/png;base64,${png.toString('base64')}`;
}
const zoom = async (v: string, bg: string) =>
  `<div class="sizes">${(
    await Promise.all(
      [16, 32].map(
        async (s) =>
          `<figure><img class="px" src="${await pixels(v, bg, s)}" width="128" height="128"><span>${s}px, enlarged</span></figure>`,
      ),
    )
  ).join('')}</div>`;

await shot(
  'mark.png',
  page(`<h2>The mark</h2>
<div class="row">
  <div class="tile light"><span class="label">On light</span><img src="${uri('mark-on-light')}" width="200" height="200">${sizes('on-light')}${await zoom('on-light', BRAND.paper)}</div>
  <div class="tile dark"><span class="label">On dark</span><img src="${uri('mark-on-dark')}" width="200" height="200">${sizes('on-dark')}${await zoom('on-dark', BRAND.night)}</div>
</div>
<div class="row">
  <div class="tile white"><span class="label">Monochrome, dark</span><img src="${uri('mark-mono-dark')}" width="120" height="120"></div>
  <div class="tile dark"><span class="label">Monochrome, light</span><img src="${uri('mark-mono-light')}" width="120" height="120"></div>
</div>`),
  1100,
);

// 2. The three lockups on light and dark, plus monochrome.
const lockups = (v: string) => `
  <img src="${uri(`horizontal-${v}`)}" height="64">
  <img src="${uri(`stacked-${v}`)}" height="150">
  <img src="${uri(`mark-${v}`)}" height="72">`;
await shot(
  'lockups.png',
  page(`<h2>Lockups: horizontal, stacked, mark only</h2>
<div class="row">
  <div class="tile light"><span class="label">On light</span>${lockups('on-light')}</div>
  <div class="tile dark"><span class="label">On dark</span>${lockups('on-dark')}</div>
</div>
<div class="row">
  <div class="tile white"><span class="label">Monochrome, dark</span>${lockups('mono-dark')}</div>
  <div class="tile dark"><span class="label">Monochrome, light</span>${lockups('mono-light')}</div>
</div>
<h2>In context: header size (28 px mark)</h2>
<div class="row">
  <div class="tile light" style="min-height:0;padding:20px;align-items:flex-start"><img src="${uri('horizontal-on-light')}" height="28"></div>
  <div class="tile dark" style="min-height:0;padding:20px;align-items:flex-start"><img src="${uri('horizontal-on-dark')}" height="28"></div>
</div>`),
  1100,
);
await browser.close();
console.log('previews written to', out);
