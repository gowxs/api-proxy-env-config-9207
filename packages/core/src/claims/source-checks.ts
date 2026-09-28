import type { ExcerptSource, LabelledChunk } from '../prompt/build.ts';
import { foldForMatching, wordRegex } from '../text/normalize.ts';
import { detectClaims, type Claim } from './detect.ts';

/**
 * Two checks on a reply that the literal claim check cannot make (production
 * case 2026-09-28, "how much does a business website cost and how long does
 * it take"): a price question answered without the price the knowledge base
 * has, and a figure taken from the website while the owner's note says
 * something else. Pure, deterministic, no model involved.
 */

/** Words asking what something costs, in the six supported languages (case-folded). */
const PRICE_QUESTION_RE = wordRegex(
  [
    // en
    'how much',
    'prices?',
    'pricing',
    'costs?',
    'costing',
    'charges?',
    'rates?',
    'fees?',
    'quote',
    // de
    'preise?',
    'preisliste',
    'kosten',
    'kostet',
    'wie ?viel',
    'angebot',
    // nl
    'prijs',
    'prijzen',
    'kost',
    'hoeveel',
    'offerte',
    'tarief',
    'tarieven',
    // fr
    'prix',
    'combien',
    'co[uû]te?s?',
    'tarifs?',
    'devis',
    // es
    'precios?',
    'cu[aá]nto',
    'cuesta',
    'coste',
    'costo',
    'tarifas?',
    'presupuesto',
    // lv
    'cena',
    'cenas',
    'cenu',
    'cenrād\\p{L}*',
    'cik maksā',
    'maksā',
    'izmaksas',
    'izmaksā',
  ].join('|'),
);

/** The customer asks what something costs (or the classifier says it is a quote request). */
export function asksForPrice(inboundText: string, category?: string): boolean {
  if (category === 'quote_request') return true;
  PRICE_QUESTION_RE.lastIndex = 0;
  return PRICE_QUESTION_RE.test(foldForMatching(inboundText));
}

/** Amounts of money stated in the excerpts the model was shown. */
export function pricesInExcerpts(excerpts: string[]): string[] {
  return excerpts.flatMap((t) =>
    detectClaims(t)
      .filter((c) => c.kind === 'money')
      .map((c) => c.text),
  );
}

// ---------------------------------------------------------------------------
// Source conflicts
// ---------------------------------------------------------------------------

/** Kinds where two sources can state different values for the same thing. */
const COMPARED = new Set<Claim['kind']>(['money', 'duration', 'percentage']);

/** Function words (four letters or more) that say nothing about what a figure is for. */
const STOP = new Set(
  (
    'about above after again also approximately around been before being below between both could does each ' +
    'from have here into just like more most much only other over please same some such take takes taking than that ' +
    'their them then there these they this those typically usually very what when where which while will with ' +
    "within would your yours ours we're you're cost costs price prices long " +
    'eine einer einen eines dein deine ihre sind wird werden nach dass oder auch unsere ihnen etwa ' +
    'jūsu mūsu tiek līdz pēc parasti apmēram ' +
    'onze jouw uw zijn wordt worden ongeveer ' +
    'votre notre sont sera environ avec pour ' +
    'nuestro nuestra usted será unos unas aproximadamente'
  ).split(/\s+/),
);

/**
 * Short words that still say what a figure is for ("EU", "UK", "3D"); every
 * other word of two or three letters is left out.
 */
const SHORT_WORDS = new Set([
  'eu',
  'uk',
  'us',
  'usa',
  'lv',
  'ee',
  'lt',
  'de',
  'seo',
  'app',
  'web',
  'car',
  'van',
  'box',
  'set',
  'kit',
  'pdf',
  'cms',
]);

/** Content words of a text, roughly singular ("websites" → "website"). */
function subjectWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[\p{L}]{2,}/gu) ?? []) {
    if (w.length < 4 && !SHORT_WORDS.has(w)) continue;
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

/** List items, sentences and comma-separated clauses: each states one thing. */
function segments(text: string): string[] {
  return foldForMatching(text)
    .split(/\n+|;|(?<=\p{L})[.!?](?=\s)|,\s+(?=\p{L})|\s[-–•*]\s|\s›\s/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalised value of a claim: "3–7 business days" → "duration:3-7". */
function valueKey(c: Claim): string {
  return `${c.kind}:${c.numbers.map((readings) => readings[0] ?? '?').join('-')}`;
}

interface Statement {
  kind: Claim['kind'];
  value: string;
  text: string;
  /** Words before the figure: what it is for. */
  subject: Set<string>;
}

function statements(text: string): Statement[] {
  const out: Statement[] = [];
  for (const seg of segments(text)) {
    for (const c of detectClaims(seg)) {
      if (!COMPARED.has(c.kind)) continue;
      out.push({
        kind: c.kind,
        value: valueKey(c),
        text: c.text,
        subject: subjectWords(seg.slice(0, c.start)),
      });
    }
  }
  return out;
}

export interface SourceConflict {
  kind: Claim['kind'];
  /** What the figure is for, in the source's words ("business website"). */
  about: string;
  /** The figure in the reply. */
  replyValue: string;
  /** Every source that states a figure for the same thing. */
  statements: { label: string; text: string; source?: ExcerptSource }[];
  /** The newest owner note's figure, if a note is among them. */
  preferred?: { label: string; text: string };
  /** True when the reply uses the preferred figure. */
  replyUsesPreferred: boolean;
}

const MIN_SHARED_WORDS = 2;

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * For each price, duration or percentage in the reply, finds the excerpt
 * statements about the same thing (at least two shared content words
 * before the figure, the customer's question counting as context) and
 * reports a conflict when they state different values. The newest owner
 * note is preferred; website pages and files may be out of date.
 */
export function findSourceConflicts(input: {
  reply: string;
  inboundText: string;
  excerpts: { label: string; chunk: LabelledChunk }[];
}): SourceConflict[] {
  const question = subjectWords(foldForMatching(input.inboundText));
  const excerptStatements = input.excerpts.flatMap((e) =>
    statements(e.chunk.content).map((s) => ({ ...s, label: e.label, source: e.chunk.source })),
  );
  const conflicts: SourceConflict[] = [];
  const seen = new Set<string>();
  for (const seg of segments(input.reply)) {
    for (const c of detectClaims(seg)) {
      if (!COMPARED.has(c.kind)) continue;
      // The reply's own words first ("a landing page costs €290"); the customer's
      // question only when the sentence does not say what the figure is for.
      const own = subjectWords(seg.slice(0, c.start));
      const about = (context: Set<string>) =>
        excerptStatements.filter(
          (s) =>
            s.kind === c.kind &&
            s.subject.size > 0 &&
            shared(s.subject, context) >= Math.min(MIN_SHARED_WORDS, s.subject.size),
        );
      let found = about(own);
      if (!found.length) found = about(new Set([...question, ...own]));
      // A conflict is two excerpts saying different things; one excerpt listing
      // two items ("Latvia 2-3 days; EU 5 days") is not one.
      const related = found.filter((s) =>
        found.some((o) => o.label !== s.label && o.value !== s.value),
      );
      const values = new Set(related.map((s) => s.value));
      if (values.size < 2) continue;
      const key = `${valueKey(c)}@${[...values].sort().join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const notes = related
        .filter((s) => s.source?.type === 'note')
        .sort((a, b) => b.source!.updatedAt.getTime() - a.source!.updatedAt.getTime());
      const preferred = notes[0];
      conflicts.push({
        kind: c.kind,
        about: [...(preferred ?? related[0]!).subject].join(' '),
        replyValue: c.text,
        statements: related.map((s) => ({
          label: s.label,
          text: s.text,
          ...(s.source ? { source: s.source } : {}),
        })),
        ...(preferred ? { preferred: { label: preferred.label, text: preferred.text } } : {}),
        replyUsesPreferred: preferred ? preferred.value === valueKey(c) : false,
      });
    }
  }
  return conflicts;
}
