import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';
import { formatMoney, formatQty } from './money.ts';
import { formatDate } from './texts.ts';

const require = createRequire(import.meta.url);
const FONT_DIR = dirname(require.resolve('@expo-google-fonts/manrope/package.json'));
const FONTS = {
  regular: join(FONT_DIR, '400Regular/Manrope_400Regular.ttf'),
  semibold: join(FONT_DIR, '600SemiBold/Manrope_600SemiBold.ttf'),
  bold: join(FONT_DIR, '800ExtraBold/Manrope_800ExtraBold.ttf'),
};

export interface QuotePdfBrand {
  companyName: string;
  color: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  /** PNG or JPEG bytes of the tenant's (allowlisted) logo, if it could be fetched. */
  logo: Buffer | null;
}

export interface QuotePdfInput {
  number: string;
  language: string | null;
  createdAt: Date;
  validUntil: Date;
  customer: { name: string | null; email: string };
  currency: string;
  vatMode: 'none' | 'exclusive' | 'inclusive';
  vatRatePercent: number;
  lines: {
    name: string;
    unit: string;
    qty: number;
    unitPriceCents: number;
    lineTotalCents: number;
    vatNote: string | null;
  }[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  notes: string | null;
  acceptUrl: string;
  brand: QuotePdfBrand;
}

const INK = '#1F2430';
const MUTED = '#5B6275';
const RULE = '#E3E6EE';

/** A one- or multi-page A4 quote. Deterministic for the same input (fixed creation date). */
export function renderQuotePdf(q: QuotePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: {
      Title: `Quote ${q.number}`,
      Author: q.brand.companyName,
      Creator: 'Noctiv',
      CreationDate: q.createdAt,
    },
  });
  doc.registerFont('r', FONTS.regular);
  doc.registerFont('s', FONTS.semibold);
  doc.registerFont('b', FONTS.bold);
  // No ligatures: Manrope joins "tt", so copied text ("https", "written") would lose letters.
  const NO_LIGATURES = {
    liga: false,
    clig: false,
    dlig: false,
  } as unknown as PDFKit.Mixins.OpenTypeFeatures[];
  for (const m of ['text', 'heightOfString', 'widthOfString'] as const) {
    const orig = (doc[m] as (...a: unknown[]) => unknown).bind(doc);
    (doc as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
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

  const brand =
    q.brand.color && /^#[0-9A-Fa-f]{6}$/.test(q.brand.color) ? q.brand.color : '#2F3A56';
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const money = (c: number) => formatMoney(c, q.currency);
  const date = (d: Date) => formatDate(d, q.language ?? 'en');

  // Brand bar.
  doc.rect(0, 0, doc.page.width, 6).fill(brand);

  // Logo or company name, top left; the quote's facts, top right.
  let y = 48;
  if (q.brand.logo) {
    try {
      doc.image(q.brand.logo, L, y, { fit: [150, 48] });
    } catch {
      doc
        .font('b')
        .fontSize(18)
        .fillColor(INK)
        .text(q.brand.companyName, L, y + 12, { width: W / 2 });
    }
  } else {
    doc
      .font('b')
      .fontSize(18)
      .fillColor(INK)
      .text(q.brand.companyName, L, y + 12, { width: W / 2 });
  }
  doc.font('b').fontSize(22).fillColor(INK).text('Quote', L, y, { width: W, align: 'right' });
  doc
    .font('r')
    .fontSize(10)
    .fillColor(MUTED)
    .text(
      `${q.number}\nDate: ${date(q.createdAt)}\nValid until: ${date(q.validUntil)}`,
      L,
      y + 30,
      {
        width: W,
        align: 'right',
      },
    );

  // From / to.
  y = 140;
  const from = [q.brand.companyName, q.brand.address, q.brand.phone, q.brand.website]
    .filter(Boolean)
    .join('\n');
  const to = [q.customer.name, q.customer.email].filter(Boolean).join('\n');
  doc
    .font('s')
    .fontSize(9)
    .fillColor(MUTED)
    .text('FROM', L, y)
    .text('FOR', L + W / 2, y);
  doc
    .font('r')
    .fontSize(10)
    .fillColor(INK)
    .text(from, L, y + 14, { width: W / 2 - 16 });
  doc.text(to, L + W / 2, y + 14, { width: W / 2 });
  y = Math.max(doc.y, y + 60) + 24;

  // Lines.
  const col = { item: L, qty: L + W * 0.52, unit: L + W * 0.64, total: L + W * 0.82 };
  const header = () => {
    doc.font('s').fontSize(9).fillColor(MUTED);
    doc.text('ITEM', col.item, y);
    doc.text('QTY', col.qty, y, { width: W * 0.1, align: 'right' });
    doc.text('UNIT PRICE', col.unit, y, { width: W * 0.16, align: 'right' });
    doc.text('TOTAL', col.total, y, { width: W * 0.18, align: 'right' });
    y += 16;
    doc
      .moveTo(L, y)
      .lineTo(L + W, y)
      .strokeColor(RULE)
      .lineWidth(1)
      .stroke();
    y += 8;
  };
  header();
  for (const l of q.lines) {
    const nameH = doc
      .font('r')
      .fontSize(10)
      .heightOfString(l.name, { width: W * 0.5 });
    const noteH = l.vatNote ? doc.fontSize(8).heightOfString(l.vatNote, { width: W * 0.5 }) + 2 : 0;
    if (y + nameH + noteH + 12 > doc.page.height - 200) {
      doc.addPage();
      y = 56;
      header();
    }
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(l.name, col.item, y, { width: W * 0.5 });
    if (l.vatNote)
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(l.vatNote, col.item, y + nameH + 2, { width: W * 0.5 });
    doc.fontSize(10).fillColor(INK);
    doc.text(`${formatQty(l.qty)} ${l.unit}`, col.qty - W * 0.06, y, {
      width: W * 0.16,
      align: 'right',
    });
    doc.text(money(l.unitPriceCents), col.unit, y, { width: W * 0.16, align: 'right' });
    doc.text(money(l.lineTotalCents), col.total, y, { width: W * 0.18, align: 'right' });
    y += nameH + noteH + 10;
    doc
      .moveTo(L, y - 4)
      .lineTo(L + W, y - 4)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  }

  // Totals.
  y += 6;
  const row = (label: string, value: string, strong = false) => {
    doc
      .font(strong ? 'b' : 'r')
      .fontSize(strong ? 12 : 10)
      .fillColor(strong ? INK : MUTED)
      .text(label, L + W * 0.5, y, { width: W * 0.3, align: 'right' });
    doc.fillColor(INK).text(value, col.total, y, { width: W * 0.18, align: 'right' });
    y += strong ? 20 : 16;
  };
  if (q.vatMode === 'exclusive') {
    row('Subtotal', money(q.subtotalCents));
    row(`VAT ${q.vatRatePercent}%`, money(q.vatCents));
    row('Total', money(q.totalCents), true);
  } else if (q.vatMode === 'inclusive') {
    row('Total', money(q.totalCents), true);
    row(`of which VAT ${q.vatRatePercent}%`, money(q.vatCents));
  } else {
    row('Total', money(q.totalCents), true);
  }

  // Notes, then how to accept.
  y += 12;
  if (q.notes) {
    doc.font('s').fontSize(9).fillColor(MUTED).text('NOTES', L, y);
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(q.notes, L, y + 14, { width: W });
    y = doc.y + 16;
  }
  doc.rect(L, y, W, 54).fill('#F4F5F7');
  doc
    .font('s')
    .fontSize(10)
    .fillColor(INK)
    .text(`Accept this quote online (valid until ${date(q.validUntil)}):`, L + 14, y + 12, {
      width: W - 28,
    });
  doc
    .font('r')
    .fontSize(9)
    .fillColor(brand)
    .text(q.acceptUrl, L + 14, y + 28, { width: W - 28, link: q.acceptUrl, underline: true });

  doc.end();
  return done;
}
