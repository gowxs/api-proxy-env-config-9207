/**
 * Characters that render invisibly or reorder text: zero-width spaces/joiners,
 * bidi embeddings/overrides/isolates, BOM, soft hyphen, word joiner, and
 * Unicode "tag" characters (used to smuggle hidden instructions).
 */
// Written as escaped strings: formatters may otherwise turn escapes into the
// invisible characters themselves.
const INVISIBLE_SOURCE =
  '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|[\\u{E0000}-\\u{E007F}]';
const INVISIBLE_RE = new RegExp(INVISIBLE_SOURCE, 'gu');

/** C0/C1 control characters except tab, line feed and carriage return. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

export function hasInvisible(text: string): boolean {
  INVISIBLE_RE.lastIndex = 0;
  return INVISIBLE_RE.test(text);
}

/** Untrusted text as it may appear inside a prompt: no invisibles, no control chars, NFC. */
export function cleanUntrustedText(text: string): string {
  return stripInvisible(text).replace(CONTROL_RE, '').normalize('NFC');
}

/** Lowercase, NFKC-folded, invisible-free form used for pattern matching only. */
export function foldForMatching(text: string): string {
  return stripInvisible(text).normalize('NFKC').toLowerCase();
}

/**
 * Letter/number-aware word boundaries. JavaScript's \b only understands
 * ASCII, which breaks on words like "rīt", "mañana" or "réduction".
 */
export function wordRegex(source: string, flags = 'giu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, flags);
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[…truncated]`;
}
