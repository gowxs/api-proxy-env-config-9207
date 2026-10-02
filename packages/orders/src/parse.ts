/**
 * Order references in a customer's e-mail. Pure code: the model never picks
 * the order. "#1234", "order 1234", "Bestellung Nr. 1234", "commande n°1234",
 * "pedido 1234", "pasūtījums 1234". A bare number counts only when it is the
 * one candidate in the whole message.
 */

export interface OrderRefs {
  /** Distinct order numbers (digits only), in order of appearance. */
  numbers: string[];
  /** At least one came from "#" or an order word, not from a bare number. */
  explicit: boolean;
}

const WORDS =
  '(?:order|orders|ordre|bestellung|bestell|bestelling|bestelnummer|commande|pedido|pasūtījum\\p{L}*|pasutijum\\p{L}*|ordine|zamówieni\\p{L}*)';
const HASH_RE = /(?<![\p{L}\p{N}&])#\s?(\d{3,9})(?!\d)/gu;
const WORD_RE = new RegExp(
  `(?<![\\p{L}])${WORDS}\\s*(?:no\\.?|nr\\.?|n°|number|num\\.?|numurs|nummer|#)?\\s*[:#]?\\s*(?:#\\s?)?(\\d{3,9})(?!\\d)`,
  'giu',
);
// A standalone number that is not a date, time, price, phone number or part of a longer token.
// Digit groups split by a space ("+371 2000 1234") are one longer number, not candidates.
const BARE_RE =
  /(?<![\p{L}\p{N}.,:/+@#€$£-])(?<!\d[ \u00a0])(\d{3,8})(?![\p{L}\p{N}]|[.,:/@-]\d|[€$£%]|[ \u00a0]\d)/gu;

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.replace(/^0+(?=\d)/, '')))];
}

export function parseOrderRefs(text: string): OrderRefs {
  const t = text.normalize('NFKC');
  const explicit: { at: number; n: string }[] = [];
  for (const m of t.matchAll(HASH_RE)) explicit.push({ at: m.index ?? 0, n: m[1]! });
  for (const m of t.matchAll(WORD_RE)) explicit.push({ at: m.index ?? 0, n: m[1]! });
  if (explicit.length)
    return {
      numbers: uniq(explicit.sort((a, b) => a.at - b.at).map((x) => x.n)),
      explicit: true,
    };
  // A year ("in 2026") is not an order number; use # or the word "order" for those.
  const bare = [...t.matchAll(BARE_RE)].map((m) => m[1]!).filter((n) => !/^(?:19|20)\d\d$/.test(n));
  // Several loose numbers could be anything (a phone number, a quantity): no guess.
  const one = uniq(bare);
  return { numbers: one.length === 1 ? one : [], explicit: false };
}

/** Asks for something an order lookup must not answer: a refund, a return, an address change, a cancellation. */
const CHANGE_RE = new RegExp(
  [
    // English
    'refund',
    'money back',
    'return(?:ing)? (?:it|the|my|this|these)',
    'send (?:it )?back',
    'cancel(?:l?ing)? (?:the |my |this )?order',
    'change (?:the |my |our )?(?:delivery |shipping )?address',
    'wrong address',
    'update (?:the |my )?address',
    'different address',
    // German
    'rückerstattung',
    'erstattung',
    'zurücksenden',
    'rücksendung',
    'stornier',
    'adresse (?:ändern|aendern)',
    'lieferadresse',
    // Dutch
    'terugbetal',
    'retour',
    'annuler',
    'adres wijzig',
    // French
    'rembours',
    'annulation',
    "changer l'adresse",
    "modifier l'adresse",
    // Spanish
    'reembolso',
    'devolución',
    'devolver',
    'cancelar (?:el |mi )?pedido',
    'cambiar (?:la )?direcci[oó]n',
    // Latvian
    'atmaks',
    'atgriez',
    'atcelt',
    'mainīt adresi',
    'mainit adresi',
  ].join('|'),
  'iu',
);
export const asksForChange = (text: string): boolean => CHANGE_RE.test(text);

/** A chargeback or dispute threat: always a person. */
const CHARGEBACK_RE =
  /charge[- ]?back|dispute (?:the )?(?:charge|payment)|paypal dispute|rückbuchung|terugboeking|rétrofacturation|contracargo|maksājuma strīd/iu;
export const mentionsChargeback = (text: string): boolean => CHARGEBACK_RE.test(text);
