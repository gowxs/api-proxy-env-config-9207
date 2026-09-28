/**
 * One screenshot per section of a page (design review), at a given width and theme.
 *   node scripts/section-shots.ts <outDir> <path> <width> <light|dark>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build, serve } from '../build.ts';

const [out = 'sections', path = '/', width = '1440', scheme = 'light'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
build();
const close = await serve(4324);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
try {
  const w = Number(width);
  const ctx = await browser.newContext({
    viewport: { width: w, height: 900 },
    deviceScaleFactor: w < 600 ? 2 : 1,
    colorScheme: scheme as 'light' | 'dark',
    reducedMotion: 'reduce',
  });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:4324${path}`, { waitUntil: 'networkidle' });
  // Element shots: the sticky header would sit on top of every section.
  await p.addStyleTag({ content: '.site-header{position:static!important}' });
  await p.evaluate(async () => {
    await document.fonts.ready;
    for (const img of Array.from(document.images)) img.loading = 'eager';
    await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {})));
  });
  const els = p.locator('main > section, main > div, body > footer');
  const n = await els.count();
  for (let i = 0; i < n; i++) {
    const id =
      (await els.nth(i).getAttribute('id')) ??
      (await els.nth(i).evaluate((e) => e.tagName.toLowerCase()));
    await els.nth(i).screenshot({
      path: join(out, `${String(i).padStart(2, '0')}-${id}-${width}-${scheme}.png`),
    });
  }
  await ctx.close();
} finally {
  await browser.close();
  close();
}
