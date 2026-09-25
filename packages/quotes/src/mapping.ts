import { z } from 'zod';
import { qtyHundredths } from './money.ts';

/** A confirmed price-list item as the mapping step sees it. */
export interface PricedItem {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  minQty: number | null;
  maxQty: number | null;
  vatNote: string | null;
}

/**
 * What the model may produce when mapping a request to the price list. It
 * sees item labels ("P1"…), names, units and limits, never prices; it names
 * items and quantities only. Code decides what is valid.
 */
export const QuoteMappingSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        item: z.string().trim().max(10),
        qty: z.number(),
        customer_text: z.string().trim().max(200),
      }),
    )
    .max(30),
  unmapped: z.array(z.string().trim().max(200)).max(10),
  language: z.string().trim().toLowerCase().max(3),
});
export type QuoteMapping = z.infer<typeof QuoteMappingSchema>;

export interface MappedLine {
  item: PricedItem;
  qty: number;
  /** The customer's own words for this line. */
  customerText: string;
  /** No quantity in the e-mail: one is assumed. */
  qtyAssumed: boolean;
}

export type UnmappedReason =
  | 'not_on_price_list'
  | 'unknown_item'
  | 'invalid_quantity'
  | 'quantity_not_in_email'
  | 'below_minimum'
  | 'above_maximum'
  | 'duplicate';

export interface Unmapped {
  customerText: string;
  reason: UnmappedReason;
  item?: PricedItem;
}

export interface ValidatedMapping {
  lines: MappedLine[];
  unmapped: Unmapped[];
}

const NUMBER_WORDS: Record<string, number> = {};
// Written-out 1–12 in the reply languages (en, de, nl, fr, es, lv).
(
  [
    [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve',
    ],
    [
      'ein',
      'zwei',
      'drei',
      'vier',
      'fünf',
      'sechs',
      'sieben',
      'acht',
      'neun',
      'zehn',
      'elf',
      'zwölf',
    ],
    [
      'een',
      'twee',
      'drie',
      'vier',
      'vijf',
      'zes',
      'zeven',
      'acht',
      'negen',
      'tien',
      'elf',
      'twaalf',
    ],
    [
      'un',
      'deux',
      'trois',
      'quatre',
      'cinq',
      'six',
      'sept',
      'huit',
      'neuf',
      'dix',
      'onze',
      'douze',
    ],
    [
      'uno',
      'dos',
      'tres',
      'cuatro',
      'cinco',
      'seis',
      'siete',
      'ocho',
      'nueve',
      'diez',
      'once',
      'doce',
    ],
    [
      'viens',
      'divi',
      'trīs',
      'četri',
      'pieci',
      'seši',
      'septiņi',
      'astoņi',
      'deviņi',
      'desmit',
      'vienpadsmit',
      'divpadsmit',
    ],
  ] as const
).forEach((words) => words.forEach((w, i) => (NUMBER_WORDS[w] = i + 1)));
NUMBER_WORDS['dozen'] = 12;
NUMBER_WORDS['dutzend'] = 12;
NUMBER_WORDS['zwei'] = 2;
NUMBER_WORDS['eine'] = 1;
NUMBER_WORDS['una'] = 1;
NUMBER_WORDS['une'] = 1;

/** Every quantity the customer wrote: digits (with , or . decimals) and the words above. */
export function quantitiesInText(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d+(?:[.,]\d{1,2})?/g)) {
    out.add(Number(m[0].replace(',', '.')));
  }
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const n = NUMBER_WORDS[w];
    if (n) out.add(n);
  }
  return out;
}

/**
 * Checks the model's mapping against the confirmed price list and the
 * customer's e-mail. A line survives only if its label names a confirmed
 * item, its quantity is a positive number with at most two decimals, within
 * the item's min/max, and either written in the e-mail or 1 (assumed when the
 * customer named no quantity). Everything else becomes "unmapped", which
 * turns the reply into one clarifying question.
 */
export function validateMapping(
  mapping: QuoteMapping,
  labels: Map<string, PricedItem>,
  emailText: string,
): ValidatedMapping {
  const written = quantitiesInText(emailText);
  const lines: MappedLine[] = [];
  const unmapped: Unmapped[] = mapping.unmapped
    .filter((t) => t.length > 0)
    .map((t) => ({ customerText: t, reason: 'not_on_price_list' as const }));
  const seen = new Set<string>();

  for (const l of mapping.lines) {
    const item = labels.get(l.item.toUpperCase());
    const text = l.customer_text || item?.name || l.item;
    if (!item) {
      unmapped.push({ customerText: text, reason: 'unknown_item' });
      continue;
    }
    if (seen.has(item.id)) {
      unmapped.push({ customerText: text, reason: 'duplicate', item });
      continue;
    }
    if (qtyHundredths(l.qty) === null) {
      unmapped.push({ customerText: text, reason: 'invalid_quantity', item });
      continue;
    }
    const assumed = !written.has(l.qty);
    if (assumed && l.qty !== 1) {
      unmapped.push({ customerText: text, reason: 'quantity_not_in_email', item });
      continue;
    }
    if (item.minQty !== null && l.qty < item.minQty) {
      unmapped.push({ customerText: text, reason: 'below_minimum', item });
      continue;
    }
    if (item.maxQty !== null && l.qty > item.maxQty) {
      unmapped.push({ customerText: text, reason: 'above_maximum', item });
      continue;
    }
    seen.add(item.id);
    lines.push({ item, qty: l.qty, customerText: text, qtyAssumed: assumed });
  }
  return { lines, unmapped };
}

/** P1, P2, … for the prompt; the map resolves them back. */
export function labelItems(items: PricedItem[]): Map<string, PricedItem> {
  return new Map(items.map((it, i) => [`P${i + 1}`, it]));
}
