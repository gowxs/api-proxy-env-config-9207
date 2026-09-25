import { formatMoney, formatQty } from './money.ts';
import type { Unmapped } from './mapping.ts';

/**
 * The reply around a quote and the clarifying question are fixed texts per
 * language; code fills in every name, number and date. The model writes none
 * of it (no-invented-facts rule).
 */
export const QUOTE_LANGUAGES = ['en', 'de', 'lv', 'nl', 'fr', 'es'] as const;
type Lang = (typeof QUOTE_LANGUAGES)[number];
const lang = (l: string | null | undefined): Lang =>
  (QUOTE_LANGUAGES as readonly string[]).includes(l ?? '') ? (l as Lang) : 'en';

const LOCALE: Record<Lang, string> = {
  en: 'en-GB',
  de: 'de-DE',
  lv: 'lv-LV',
  nl: 'nl-NL',
  fr: 'fr-FR',
  es: 'es-ES',
};

const T: Record<
  Lang,
  {
    hello: (name: string | null) => string;
    thanks: string;
    attached: (
      number: string,
      summary: string,
      total: string,
      vat: string,
      until: string,
    ) => string;
    accept: (link: string) => string;
    inclVat: string;
    clarify: (items: string) => string;
    limits: (item: string, range: string) => string;
    close: string;
  }
> = {
  en: {
    hello: (n) => (n ? `Hello ${n},` : 'Hello,'),
    thanks: 'Thank you for your request.',
    attached: (n, s, t, v, u) =>
      `Please find our quote ${n} attached: ${s}, ${t}${v}, valid until ${u}.`,
    accept: (l) => `You can view and accept the quote here: ${l}`,
    inclVat: ' including VAT',
    clarify: (i) => `To prepare an exact quote, could you tell us a little more about ${i}?`,
    limits: (i, r) => `For ${i} we can quote ${r}.`,
    close: 'We will send you the quote as soon as we have your answer.',
  },
  de: {
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    thanks: 'vielen Dank für Ihre Anfrage.',
    attached: (n, s, t, v, u) =>
      `Im Anhang finden Sie unser Angebot ${n}: ${s}, ${t}${v}, gültig bis ${u}.`,
    accept: (l) => `Hier können Sie das Angebot ansehen und annehmen: ${l}`,
    inclVat: ' inkl. MwSt.',
    clarify: (i) =>
      `Damit wir ein genaues Angebot erstellen können: Könnten Sie uns etwas mehr zu ${i} sagen?`,
    limits: (i, r) => `Für ${i} können wir ${r} anbieten.`,
    close: 'Sobald wir Ihre Antwort haben, senden wir Ihnen das Angebot.',
  },
  lv: {
    hello: (n) => (n ? `Labdien, ${n}!` : 'Labdien!'),
    thanks: 'Paldies par jūsu pieprasījumu.',
    attached: (n, s, t, v, u) =>
      `Pielikumā ir mūsu piedāvājums ${n}: ${s}, ${t}${v}, derīgs līdz ${u}.`,
    accept: (l) => `Piedāvājumu varat apskatīt un apstiprināt šeit: ${l}`,
    inclVat: ' ar PVN',
    clarify: (i) =>
      `Lai sagatavotu precīzu piedāvājumu, lūdzu, pastāstiet mazliet vairāk par: ${i}.`,
    limits: (i, r) => `Pozīcijai ${i} varam piedāvāt ${r}.`,
    close: 'Tiklīdz saņemsim jūsu atbildi, nosūtīsim piedāvājumu.',
  },
  nl: {
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    thanks: 'Dank u voor uw aanvraag.',
    attached: (n, s, t, v, u) =>
      `In de bijlage vindt u onze offerte ${n}: ${s}, ${t}${v}, geldig tot ${u}.`,
    accept: (l) => `U kunt de offerte hier bekijken en accepteren: ${l}`,
    inclVat: ' incl. btw',
    clarify: (i) => `Om een exacte offerte te maken: kunt u ons iets meer vertellen over ${i}?`,
    limits: (i, r) => `Voor ${i} kunnen we ${r} aanbieden.`,
    close: 'Zodra we uw antwoord hebben, sturen we u de offerte.',
  },
  fr: {
    hello: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
    thanks: 'Merci pour votre demande.',
    attached: (n, s, t, v, u) =>
      `Veuillez trouver ci-joint notre devis ${n} : ${s}, ${t}${v}, valable jusqu’au ${u}.`,
    accept: (l) => `Vous pouvez consulter et accepter le devis ici : ${l}`,
    inclVat: ' TTC',
    clarify: (i) =>
      `Pour préparer un devis exact, pourriez-vous nous en dire un peu plus sur ${i} ?`,
    limits: (i, r) => `Pour ${i}, nous pouvons proposer ${r}.`,
    close: 'Nous vous enverrons le devis dès réception de votre réponse.',
  },
  es: {
    hello: (n) => (n ? `Hola ${n}:` : 'Hola:'),
    thanks: 'Gracias por su solicitud.',
    attached: (n, s, t, v, u) =>
      `Adjuntamos nuestro presupuesto ${n}: ${s}, ${t}${v}, válido hasta el ${u}.`,
    accept: (l) => `Puede ver y aceptar el presupuesto aquí: ${l}`,
    inclVat: ' IVA incluido',
    clarify: (i) =>
      `Para preparar un presupuesto exacto, ¿podría contarnos un poco más sobre ${i}?`,
    limits: (i, r) => `Para ${i} podemos ofrecer ${r}.`,
    close: 'Le enviaremos el presupuesto en cuanto tengamos su respuesta.',
  },
};

/** A first name safe to put in a greeting (letters only), or null. */
export function greetingName(fromName: string | null | undefined): string | null {
  const first = (fromName ?? '').trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'-]{0,29}$/u.test(first) ? first : null;
}

export function formatDate(d: Date, language: string): string {
  return d.toLocaleDateString(LOCALE[lang(language)], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export interface CoverInput {
  language: string | null;
  customerName: string | null;
  number: string;
  lines: { qty: number; name: string }[];
  totalCents: number;
  currency: string;
  vatMode: 'none' | 'exclusive' | 'inclusive';
  validUntil: Date;
  acceptUrl: string;
}

/** The reply that carries the quote (the PDF is attached). */
export function quoteCoverText(i: CoverInput): string {
  const t = T[lang(i.language)];
  const summary = i.lines.map((l) => `${formatQty(l.qty)} × ${l.name}`).join('; ');
  const total = formatMoney(i.totalCents, i.currency, LOCALE[lang(i.language)]);
  return [
    t.hello(i.customerName),
    '',
    `${t.thanks} ${t.attached(i.number, summary, total, i.vatMode === 'none' ? '' : t.inclVat, formatDate(i.validUntil, i.language ?? 'en'))}`,
    '',
    t.accept(i.acceptUrl),
  ].join('\n');
}

/** One clarifying question naming what could not be matched (plus any quantity limits). */
export function clarifyingQuestionText(i: {
  language: string | null;
  customerName: string | null;
  unmapped: Unmapped[];
}): string {
  const t = T[lang(i.language)];
  const names = [...new Set(i.unmapped.map((u) => `“${u.customerText}”`))].slice(0, 3);
  const joined =
    names.length > 1
      ? `${names.slice(0, -1).join(', ')} / ${names[names.length - 1]}`
      : (names[0] ?? '');
  const limits = i.unmapped
    .filter((u) => u.item && (u.reason === 'below_minimum' || u.reason === 'above_maximum'))
    .map((u) => {
      const it = u.item!;
      const range =
        it.minQty !== null && it.maxQty !== null
          ? `${formatQty(it.minQty)}–${formatQty(it.maxQty)} ${it.unit}`
          : it.minQty !== null
            ? `≥ ${formatQty(it.minQty)} ${it.unit}`
            : `≤ ${formatQty(it.maxQty!)} ${it.unit}`;
      return t.limits(it.name, range);
    });
  return [
    t.hello(i.customerName),
    '',
    `${t.thanks} ${t.clarify(joined)}`,
    ...limits,
    '',
    t.close,
  ].join('\n');
}
