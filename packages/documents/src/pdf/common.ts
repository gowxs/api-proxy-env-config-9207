import { PDF_INK as INK, PDF_MUTED as MUTED, formatDate } from '@noctiv/quotes';
import type { Seller } from '../checks.ts';
import { formatIban } from '../checks.ts';

export interface DocBrand {
  companyName: string;
  color: string | null;
  website: string | null;
  phone: string | null;
  /** PNG or JPEG bytes of the tenant's (allowlisted) logo, if it could be fetched. */
  logo: Buffer | null;
}

export interface PdfContext {
  number: string;
  language: string | null;
  /** The document's date (issue date). */
  issueDate: Date;
  seller: Seller;
  brand: DocBrand;
}

/** Logo or company name top left; title, number and dates top right. Returns the next y. */
export function header(
  doc: PDFKit.PDFDocument,
  c: PdfContext,
  title: string,
  facts: [string, string][],
): number {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const y = 48;
  const name = () =>
    doc
      .font('b')
      .fontSize(18)
      .fillColor(INK)
      .text(c.brand.companyName, L, y + 12, { width: W / 2 });
  if (c.brand.logo) {
    try {
      doc.image(c.brand.logo, L, y, { fit: [150, 48] });
    } catch {
      name();
    }
  } else name();
  doc.font('b').fontSize(22).fillColor(INK).text(title, L, y, { width: W, align: 'right' });
  doc
    .font('r')
    .fontSize(10)
    .fillColor(MUTED)
    .text([c.number, ...facts.map(([k, v]) => `${k}: ${v}`)].join('\n'), L, y + 30, {
      width: W,
      align: 'right',
    });
  return Math.max(doc.y, y + 60) + 26;
}

/** Two party blocks side by side (label, then lines); returns the next y. */
export function parties(
  doc: PDFKit.PDFDocument,
  y: number,
  left: { label: string; lines: string[] },
  right: { label: string; lines: string[] },
): number {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  doc
    .font('s')
    .fontSize(9)
    .fillColor(MUTED)
    .text(left.label, L, y)
    .text(right.label, L + W / 2, y);
  doc.font('r').fontSize(10).fillColor(INK);
  doc.text(left.lines.filter(Boolean).join('\n'), L, y + 14, { width: W / 2 - 16 });
  const ly = doc.y;
  doc.text(right.lines.filter(Boolean).join('\n'), L + W / 2, y + 14, { width: W / 2 });
  return Math.max(ly, doc.y, y + 50) + 20;
}

export const sellerLines = (s: Seller, regNo: string, vatNo: string) => [
  s.legalName ?? '',
  s.legalAddress ?? '',
  s.regNo ? `${regNo} ${s.regNo}` : '',
  s.vatNo ? `${vatNo} ${s.vatNo}` : '',
];

export const ibanText = (s: Seller) => (s.iban ? formatIban(s.iban) : '');

export const dateText = (iso: string | Date | null, language: string | null) =>
  iso
    ? formatDate(
        typeof iso === 'string' ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : iso,
        language ?? 'en',
      )
    : '';
