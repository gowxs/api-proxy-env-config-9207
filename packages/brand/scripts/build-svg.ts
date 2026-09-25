/**
 * Generates the brand SVGs (svg/*.svg), the source of truth for every export.
 *   node scripts/build-svg.ts
 * The mark is pure geometry on a 32-unit grid; the wordmark is Manrope 800
 * converted to outlines, so no SVG depends on an installed font.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
import { BRAND } from '../src/tokens.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'svg');
mkdirSync(OUT, { recursive: true });
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- the mark
/**
 * A crescent moon that is also a reply bubble: a disc (C1) with a bite taken
 * out of its upper right by a second circle (C2), and a short tail growing
 * from the crescent's thick lower-left back. One solid shape, one colour.
 */
export interface MarkParams {
  /** Offset of the bite's centre (up and to the right). */
  off: number;
  /** Radius of the bite. */
  r2: number;
  /** Tip rounding. */
  rf: number;
  /** Tail: base angles on the outer circle and apex angle/distance past it. */
  tail: [number, number, number, number];
}
export const MARK: MarkParams = { off: 4.2, r2: 9.0, rf: 1.5, tail: [162, 110, 137, 6.4] };

export function markPath(p: MarkParams = MARK): { d: string; box: number } {
  type Pt = { x: number; y: number };
  const C1 = { x: 16, y: 16, r: 12 };
  // The bite: offset up and to the right; this radius keeps the crescent's
  // back thick enough (about 45% of the diameter) to hold at 16 px.
  const off = p.off;
  const C2 = { x: C1.x + off * Math.SQRT1_2, y: C1.y - off * Math.SQRT1_2, r: p.r2 };
  /** Tips are rounded by a small circle touching both edges. */
  const RF = p.rf;
  const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
  const len = (a: Pt) => Math.hypot(a.x, a.y);
  // Circle-circle intersection.
  const cross = (A: Pt, ra: number, B: Pt, rb: number): [Pt, Pt] => {
    const v = sub(B, A);
    const d = len(v);
    const a = (ra * ra - rb * rb + d * d) / (2 * d);
    const h = Math.sqrt(ra * ra - a * a);
    const m = { x: A.x + (a * v.x) / d, y: A.y + (a * v.y) / d };
    return [
      { x: m.x + (h * v.y) / d, y: m.y - (h * v.x) / d },
      { x: m.x - (h * v.y) / d, y: m.y + (h * v.x) / d },
    ];
  };
  // Fillet centres: inside C1 by RF, outside C2 by RF.
  const fillets = cross(C1, C1.r - RF, C2, C2.r + RF);
  const [fTop, fRight] = fillets[0].y < fillets[1].y ? fillets : [fillets[1], fillets[0]];
  const along = (c: Pt, p: Pt, r: number) => {
    const v = sub(p, c);
    const l = len(v);
    return { x: c.x + (v.x / l) * r, y: c.y + (v.y / l) * r };
  };
  const topOuter = along(C1, fTop, C1.r);
  const topInner = along(C2, fTop, C2.r);
  const rightOuter = along(C1, fRight, C1.r);
  const rightInner = along(C2, fRight, C2.r);
  const on = (deg: number): Pt => ({
    x: C1.x + C1.r * Math.cos((deg * Math.PI) / 180),
    y: C1.y + C1.r * Math.sin((deg * Math.PI) / 180),
  });
  // Tail: a short wedge from the crescent's back, pointing down-left, its
  // outer edge nearly continuing the circle like a chat-bubble tail.
  const t1 = on(p.tail[0]);
  const t2 = on(p.tail[1]);
  const ang = (p.tail[2] * Math.PI) / 180;
  const apex = {
    x: C1.x + (C1.r + p.tail[3]) * Math.cos(ang),
    y: C1.y + (C1.r + p.tail[3]) * Math.sin(ang),
  };
  // Centre the ink in the 32 box.
  const xs = [apex.x, C1.x - C1.r, rightOuter.x + RF];
  const ys = [topOuter.y - RF, apex.y, C1.y + C1.r];
  const ox = 16 - (Math.min(...xs) + Math.max(...xs)) / 2;
  const oy = 16 - (Math.min(...ys) + Math.max(...ys)) / 2;
  const P = (p: Pt) => `${r2(p.x + ox)} ${r2(p.y + oy)}`;
  const body =
    `M${P(topOuter)}` +
    `A${C1.r} ${C1.r} 0 1 0 ${P(rightOuter)}` + // the back, through the lower left
    `A${RF} ${RF} 0 0 0 ${P(rightInner)}` + // rounded right tip
    `A${C2.r} ${C2.r} 0 0 1 ${P(topInner)}` + // the bite
    `A${RF} ${RF} 0 0 0 ${P(topOuter)}Z`; // rounded top tip
  const tail = `M${P(t1)}L${P(apex)}L${P(t2)}Z`;
  return { d: body + tail, box: 32 };
}

// ------------------------------------------------------------ the wordmark
const font = opentype.parse(
  readFileSync(join(ROOT, 'node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff'))
    .buffer as ArrayBuffer,
);
const UPM = font.unitsPerEm;
const CAP = (font.tables.os2 as unknown as { sCapHeight: number }).sCapHeight;
/** Tracking, as on the site's headings. */
const TRACKING = -0.03;

/** "Noctiv" as outlines at font size `size`, baseline at y=0 (GPOS kerning + tracking). */
function wordmark(size: number): { d: string; cap: number } {
  // Serialised here: opentype.js 1.3's toPathData() prints NaN for some
  // coordinates (e.g. x = 129.60000000000002).
  const path = font.getPath('Noctiv', 0, 0, size, { kerning: true, letterSpacing: TRACKING });
  const n = (v: number) => String(r2(v));
  const d = path.commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${n(c.x)} ${n(c.y)}`;
        case 'Q':
          return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case 'C':
          return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        default:
          return 'Z';
      }
    })
    .join('');
  if (d.includes('NaN')) throw new Error('wordmark outline contains NaN');
  return { d, cap: (CAP / UPM) * size };
}

// ---------------------------------------------------------------- variants
type Variant = { name: string; mark: string; word: string; label: string };
export const VARIANTS: Variant[] = [
  { name: 'on-light', mark: BRAND.indigo, word: BRAND.night, label: 'On light' },
  { name: 'on-dark', mark: BRAND.dawn, word: BRAND.nightText, label: 'On dark' },
  { name: 'mono-dark', mark: BRAND.night, word: BRAND.night, label: 'Monochrome, dark' },
  { name: 'mono-light', mark: '#FFFFFF', word: '#FFFFFF', label: 'Monochrome, light' },
];

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(w)} ${r2(h)}" width="${r2(w)}" height="${r2(h)}" role="img" aria-label="Noctiv"><title>Noctiv</title>${body}</svg>\n`;

if (process.argv[1]?.endsWith('build-svg.ts')) writeAll();

function writeAll() {
  const mark = markPath();
  const SIZE = 100; // wordmark font size in the lockups (units)
  const wm = wordmark(SIZE);
  const bb = font
    .getPath('Noctiv', 0, 0, SIZE, { kerning: true, letterSpacing: TRACKING })
    .getBoundingBox();

  for (const v of VARIANTS) {
    // Mark only: the 32 grid.
    writeFileSync(
      join(OUT, `mark-${v.name}.svg`),
      svg(32, 32, `<path fill="${v.mark}" d="${mark.d}"/>`),
    );

    // Horizontal: mark 1.55× cap height, centred on the cap height; gap 0.24× mark.
    {
      const m = wm.cap * 1.55;
      const s = m / 32;
      const gap = m * 0.24;
      const pad = 0;
      const h = Math.max(m, bb.y2 - bb.y1);
      const top = Math.min(-wm.cap / 2 - m / 2, bb.y1);
      const bottom = Math.max(-wm.cap / 2 + m / 2, bb.y2);
      const height = bottom - top;
      const wordX = m + gap;
      const width = wordX + bb.x2;
      void h;
      void pad;
      const body =
        `<path fill="${v.mark}" transform="translate(0 ${r2(-wm.cap / 2 - m / 2 - top)}) scale(${r2(s * 1000) / 1000})" d="${mark.d}"/>` +
        `<path fill="${v.word}" transform="translate(${r2(wordX)} ${r2(-top)})" d="${wm.d}"/>`;
      writeFileSync(join(OUT, `horizontal-${v.name}.svg`), svg(width, height, body));
    }

    // Stacked: mark 2.4× cap height above the wordmark, gap 0.25× mark.
    {
      const m = wm.cap * 2.4;
      const s = m / 32;
      const gap = m * 0.22;
      const wordW = bb.x2 - bb.x1;
      const width = Math.max(wordW, m);
      const wordTop = m + gap;
      const height = wordTop + (bb.y2 - bb.y1);
      const body =
        `<path fill="${v.mark}" transform="translate(${r2((width - m) / 2)} 0) scale(${r2(s * 1000) / 1000})" d="${mark.d}"/>` +
        `<path fill="${v.word}" transform="translate(${r2((width - wordW) / 2 - bb.x1)} ${r2(wordTop - bb.y1)})" d="${wm.d}"/>`;
      writeFileSync(join(OUT, `stacked-${v.name}.svg`), svg(width, height, body));
    }
  }
  console.log('svg written:', VARIANTS.length * 3, 'files');
}
