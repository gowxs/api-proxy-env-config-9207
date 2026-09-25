/**
 * Site illustrations → responsive WebP files (committed in src/images/).
 *   node scripts/images.ts                     re-encode from assets/illustrations/*.webp
 *   node scripts/images.ts --import a b c      first import: hero, stores, services PNGs
 * Chromium does the resizing and WebP encoding (no native image tools needed).
 * The build copies src/images/* to /img/ with content-hashed names.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const ROOT = join(import.meta.dirname, '..');
const MASTERS = join(ROOT, 'assets/illustrations');
const OUT = join(ROOT, 'src/images');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page: Page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');

interface Crop {
  /** Source rectangle as fractions of the image (x, y, w, h). */
  rect?: [number, number, number, number];
  width: number;
  height: number;
  quality: number;
}

async function encode(src: Buffer, mime: string, c: Crop): Promise<Buffer> {
  const dataUrl = `data:${mime};base64,${src.toString('base64')}`;
  const out = await page.evaluate(
    async ({ dataUrl, c }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const [fx, fy, fw, fh] = c.rect ?? [0, 0, 1, 1];
      const sx = fx * img.naturalWidth;
      const sy = fy * img.naturalHeight;
      const sw = fw * img.naturalWidth;
      const sh = fh * img.naturalHeight;
      // Downscale in halving steps for a sharper result than one big step.
      let canvas = document.createElement('canvas');
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      canvas.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      while (canvas.width / 2 >= c.width) {
        const next = document.createElement('canvas');
        next.width = Math.round(canvas.width / 2);
        next.height = Math.round(canvas.height / 2);
        const nctx = next.getContext('2d')!;
        nctx.imageSmoothingQuality = 'high';
        nctx.drawImage(canvas, 0, 0, next.width, next.height);
        canvas = next;
      }
      const final = document.createElement('canvas');
      final.width = c.width;
      final.height = c.height;
      const fctx = final.getContext('2d')!;
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(canvas, 0, 0, c.width, c.height);
      return final.toDataURL('image/webp', c.quality);
    },
    { dataUrl, c },
  );
  return Buffer.from(out.split(',')[1]!, 'base64');
}

const args = process.argv.slice(2);
if (args[0] === '--import') {
  const names = ['hero', 'stores', 'services'];
  for (const [i, file] of args.slice(1).entries()) {
    const src = readFileSync(file);
    const probe = await page.evaluate(
      async (u) => {
        const i = new Image();
        i.src = u;
        await i.decode();
        return [i.naturalWidth, i.naturalHeight];
      },
      `data:image/png;base64,${src.toString('base64')}`,
    );
    const out = await encode(src, 'image/png', {
      width: probe[0]!,
      height: probe[1]!,
      quality: 0.95,
    });
    writeFileSync(join(MASTERS, `${names[i]}.webp`), out);
    console.log(`master ${names[i]}.webp ${probe.join('×')} ${Math.round(out.length / 1024)} KB`);
  }
}

const master = (n: string) => readFileSync(join(MASTERS, `${n}.webp`));
// Masters are 1672×941 (16:9 within half a pixel).
const H169: [number, number, number, number] = [0, 0.0003, 1, 0.9994];
const jobs: [string, string, Crop][] = [
  // Hero, wide screens: the whole scene.
  ['hero', 'hero-1280', { width: 1280, height: 720, quality: 0.72 }],
  ['hero', 'hero-1672', { width: 1672, height: 941, quality: 0.72 }],
  // Hero, phones: a portrait slice around the envelope and the sun (3:4).
  ['hero', 'hero-phone', { rect: [0.3125, 0, 0.375, 1], width: 627, height: 941, quality: 0.72 }],
  ...(['stores', 'services'] as const).flatMap((n) =>
    [560, 880, 1200].map(
      (w) =>
        [
          n,
          `${n}-${w}`,
          { rect: H169, width: w, height: Math.round((w * 9) / 16), quality: 0.78 },
        ] as [string, string, Crop],
    ),
  ),
];
for (const [src, name, crop] of jobs) {
  const out = await encode(master(src), 'image/webp', crop);
  writeFileSync(join(OUT, `${name}.webp`), out);
  console.log(`${name}.webp ${crop.width}×${crop.height} ${Math.round(out.length / 1024)} KB`);
}
await browser.close();
