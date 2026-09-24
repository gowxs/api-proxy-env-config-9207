/**
 * Phone-size screenshots of the built site (design review).
 *   node scripts/shots.ts [outDir]
 * Uses a locally installed Chromium (CHROMIUM_PATH, default /opt/pw-browsers/chromium).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { build, serve } from '../build.ts';

const out = process.argv[2] ?? 'shots';
mkdirSync(out, { recursive: true });
build();
const close = await serve(4322);
const base = 'http://127.0.0.1:4322';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// iPhone 14/15 viewport.
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

async function page(
  scheme: 'light' | 'dark',
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
): Promise<Page> {
  const ctx = await browser.newContext({ ...phone, colorScheme: scheme, reducedMotion });
  return ctx.newPage();
}

try {
  for (const scheme of ['light', 'dark'] as const) {
    const p = await page(scheme, 'reduce');
    await p.goto(`${base}/design-system/`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: join(out, `design-system-${scheme}.png`), fullPage: true });
    const blocks = p.locator('.ds-intro, .ds-block');
    const n = await blocks.count();
    for (let i = 0; i < n; i++) {
      await blocks
        .nth(i)
        .screenshot({ path: join(out, `ds-${scheme}-${String(i).padStart(2, '0')}.png`) });
    }
    await p.context().close();
  }

  // Hero: first screen, then three moments of the animation.
  const hero = await page('light');
  await hero.goto(`${base}/`, { waitUntil: 'networkidle' });
  await hero.evaluate(() => document.fonts.ready);
  await hero.screenshot({ path: join(out, 'hero-first-screen.png') });
  const demo = hero.locator('.demo');
  await demo.scrollIntoViewIfNeeded();
  // Restart the loop from 23:41 once the demo is in view.
  await hero.waitForFunction(
    () => document.querySelector('.demo')?.getAttribute('data-step') === '0',
    null,
    {
      timeout: 20_000,
    },
  );
  const moments: [string, number][] = [
    ['hero-demo-1-2341-email', 1_300],
    ['hero-demo-2-2342-draft', 2_600],
    ['hero-demo-3-0805-approved', 5_900],
  ];
  for (const [name, wait] of moments) {
    await hero.waitForTimeout(wait);
    await demo.screenshot({ path: join(out, `${name}.png`) });
  }
  await hero.context().close();

  const dark = await page('dark', 'reduce');
  await dark.goto(`${base}/`, { waitUntil: 'networkidle' });
  await dark.evaluate(() => document.fonts.ready);
  await dark.screenshot({ path: join(out, 'hero-full-dark-reduced-motion.png'), fullPage: true });
  await dark.context().close();
} finally {
  await browser.close();
  close();
}
console.log(`screenshots → ${out}/`);
