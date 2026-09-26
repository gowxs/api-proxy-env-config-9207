import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const FONT_DIR = dirname(require.resolve('@expo-google-fonts/manrope/package.json'));
const FONTS = {
  regular: join(FONT_DIR, '400Regular/Manrope_400Regular.ttf'),
  semibold: join(FONT_DIR, '600SemiBold/Manrope_600SemiBold.ttf'),
  bold: join(FONT_DIR, '800ExtraBold/Manrope_800ExtraBold.ttf'),
};

export const PDF_INK = '#1F2430';
export const PDF_MUTED = '#5B6275';
export const PDF_RULE = '#E3E6EE';

/** The tenant's brand colour, or the default navy. */
export const pdfBrandColor = (c: string | null | undefined) =>
  c && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : '#2F3A56';

/**
 * An A4 pdfkit document with the Noctiv fonts registered as 'r' (regular),
 * 's' (semibold) and 'b' (bold), ligatures off (Manrope joins "tt", so
 * copied text would lose letters), and a promise of the finished bytes.
 */
export function newPdf(o: { title: string; author: string; createdAt: Date; margins?: number }): {
  doc: PDFKit.PDFDocument;
  done: Promise<Buffer>;
} {
  const m = o.margins ?? 56;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: m, bottom: m, left: m, right: m },
    info: { Title: o.title, Author: o.author, Creator: 'Noctiv', CreationDate: o.createdAt },
  });
  doc.registerFont('r', FONTS.regular);
  doc.registerFont('s', FONTS.semibold);
  doc.registerFont('b', FONTS.bold);
  const NO_LIGATURES = {
    liga: false,
    clig: false,
    dlig: false,
  } as unknown as PDFKit.Mixins.OpenTypeFeatures[];
  for (const k of ['text', 'heightOfString', 'widthOfString'] as const) {
    const orig = (doc[k] as (...a: unknown[]) => unknown).bind(doc);
    (doc as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (args.length > 1 && last && typeof last === 'object')
        args[args.length - 1] = { features: NO_LIGATURES, ...last };
      else args.push({ features: NO_LIGATURES });
      return orig(...args);
    };
  }
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  return { doc, done };
}
