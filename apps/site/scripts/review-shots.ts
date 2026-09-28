/**
 * Full-page screenshots of pages at phone and desktop width, light and dark (design review).
 *   node scripts/review-shots.ts <outDir> [/path ...]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build, serve } from '../build.ts';

const out = process.argv[2] ?? 'review';
const paths = process.argv.slice(3).length ? process.argv.slice(3) : ['/'];
mkdirSync(out, { recursive: true });
build();
const close = await serve(4323);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const sizes = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: Number(process.env.PHONE_DSF ?? 2),
    isMobile: true,
    hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
try {
  for (const path of paths) {
    const name = path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/\//g, '-');
    for (const [size, opts] of Object.entries(sizes)) {
      for (const scheme of ['light', 'dark'] as const) {
        // Reduced motion: the final state of the demo and no scroll fades, so the page is complete.
        const ctx = await browser.newContext({
          ...opts,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        const p = await ctx.newPage();
        await p.goto(`http://127.0.0.1:4323${path}`, { waitUntil: 'networkidle' });
        await p.evaluate(() => document.fonts.ready);
        // Lazy images: load them all before the full-page shot.
        await p.evaluate(async () => {
          for (const img of Array.from(document.images)) img.loading = 'eager';
          await Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {})));
        });
        await p.screenshot({ path: join(out, `${name}-${size}-${scheme}.png`), fullPage: true });
        await p.screenshot({ path: join(out, `${name}-${size}-${scheme}-top.png`) });
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  close();
}
