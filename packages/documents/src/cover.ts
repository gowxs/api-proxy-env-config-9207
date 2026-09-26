import { greetingName, quoteLang, type QuoteLanguage } from '@noctiv/quotes';
import type { DocType } from './schema.ts';

/**
 * The reply that carries a document: fixed text per language, every number
 * and date filled in by code. The owner may edit it before approving.
 */
const HELLO: Record<QuoteLanguage, (n: string | null) => string> = {
  en: (n) => (n ? `Hello ${n},` : 'Hello,'),
  de: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
  lv: (n) => (n ? `Labdien, ${n}!` : 'Labdien!'),
  nl: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
  fr: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
  es: (n) => (n ? `Hola ${n}:` : 'Hola:'),
};

const BODY: Record<
  QuoteLanguage,
  {
    invoice: (n: string, total: string, due: string) => string;
    delivery_note: (n: string) => string;
    priced_delivery_note: (n: string, total: string) => string;
    cmr: (n: string) => string;
  }
> = {
  en: {
    invoice: (n, t, d) =>
      `Please find attached invoice ${n} for ${t}, payable by ${d}. The payment details are on the invoice.`,
    delivery_note: (n) => `Please find attached delivery note ${n}.`,
    priced_delivery_note: (n, t) => `Please find attached delivery note and invoice ${n} for ${t}.`,
    cmr: (n) => `Please find attached CMR consignment note ${n}.`,
  },
  de: {
    invoice: (n, t, d) =>
      `anbei erhalten Sie die Rechnung ${n} über ${t}, zahlbar bis ${d}. Die Zahlungsdetails finden Sie auf der Rechnung.`,
    delivery_note: (n) => `anbei erhalten Sie den Lieferschein ${n}.`,
    priced_delivery_note: (n, t) => `anbei erhalten Sie Lieferschein und Rechnung ${n} über ${t}.`,
    cmr: (n) => `anbei erhalten Sie den CMR-Frachtbrief ${n}.`,
  },
  lv: {
    invoice: (n, t, d) =>
      `Pielikumā ir rēķins ${n} par summu ${t}, apmaksas termiņš ${d}. Maksājuma rekvizīti ir norādīti rēķinā.`,
    delivery_note: (n) => `Pielikumā ir preču pavadzīme ${n}.`,
    priced_delivery_note: (n, t) => `Pielikumā ir preču pavadzīme-rēķins ${n} par summu ${t}.`,
    cmr: (n) => `Pielikumā ir CMR pavadzīme ${n}.`,
  },
  nl: {
    invoice: (n, t, d) =>
      `In de bijlage vindt u factuur ${n} van ${t}, te betalen vóór ${d}. De betaalgegevens staan op de factuur.`,
    delivery_note: (n) => `In de bijlage vindt u pakbon ${n}.`,
    priced_delivery_note: (n, t) => `In de bijlage vindt u pakbon en factuur ${n} van ${t}.`,
    cmr: (n) => `In de bijlage vindt u CMR-vrachtbrief ${n}.`,
  },
  fr: {
    invoice: (n, t, d) =>
      `Veuillez trouver ci-joint la facture ${n} d’un montant de ${t}, à régler avant le ${d}. Les coordonnées bancaires figurent sur la facture.`,
    delivery_note: (n) => `Veuillez trouver ci-joint le bon de livraison ${n}.`,
    priced_delivery_note: (n, t) =>
      `Veuillez trouver ci-joint le bon de livraison et la facture ${n} d’un montant de ${t}.`,
    cmr: (n) => `Veuillez trouver ci-joint la lettre de voiture CMR ${n}.`,
  },
  es: {
    invoice: (n, t, d) =>
      `Adjuntamos la factura ${n} por ${t}, con vencimiento el ${d}. Los datos de pago figuran en la factura.`,
    delivery_note: (n) => `Adjuntamos el albarán ${n}.`,
    priced_delivery_note: (n, t) => `Adjuntamos el albarán y factura ${n} por ${t}.`,
    cmr: (n) => `Adjuntamos la carta de porte CMR ${n}.`,
  },
};

export function documentCoverText(i: {
  type: DocType;
  language: string | null;
  customerName: string | null;
  number: string;
  /** Invoice (and priced delivery note): formatted total; invoice: due date. */
  total?: string;
  due?: string;
  /** A delivery note with prices (pavadzīme-rēķins). */
  priced?: boolean;
}): string {
  const l = quoteLang(i.language);
  const b = BODY[l];
  const body =
    i.type === 'invoice'
      ? b.invoice(i.number, i.total ?? '', i.due ?? '')
      : i.type === 'delivery_note'
        ? i.priced
          ? b.priced_delivery_note(i.number, i.total ?? '')
          : b.delivery_note(i.number)
        : b.cmr(i.number);
  return [HELLO[l](greetingName(i.customerName)), '', body].join('\n');
}
