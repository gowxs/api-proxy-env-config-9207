/**
 * Loads every page at phone size with the production headers and fails on
 * console errors (including CSP violations), broken same-site links or
 * horizontal scrolling. Saves full-page screenshots.
 *   node scripts/check.ts [outDir]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build, serve } from '../build.ts';

const out = process.argv[2] ?? 'check';
mkdirSync(out, { recursive: true });
const { pages } = build();
const close = await serve(4326);
const base = 'http://127.0.0.1:4326';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const problems: string[] = [];
const links = new Set<string>();

try {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    for (const path of pages) {
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`${scheme} ${path}: console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`${scheme} ${path}: ${e.message}`));
      const res = await page.goto(base + (path === '/404' ? '/404.html' : path), {
        waitUntil: 'networkidle',
      });
      if (path !== '/404' && res?.status() !== 200) problems.push(`${path}: HTTP ${res?.status()}`);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0) problems.push(`${scheme} ${path}: horizontal overflow ${overflow}px`);
      for (const href of await page.$$eval('a[href^="/"]', (as) =>
        as.map((a) => a.getAttribute('href')!),
      )) {
        links.add(href.split('#')[0]!);
      }
      const name = path === '/' ? 'home' : path.replaceAll('/', '');
      await page.screenshot({ path: join(out, `${name}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
  for (const href of links) {
    const r = await fetch(base + href);
    if (r.status !== 200) problems.push(`link ${href}: HTTP ${r.status}`);
  }
} finally {
  await browser.close();
  close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `ok: ${pages.length} pages × 2 themes, ${links.size} internal links, no errors → ${out}/`,
);
