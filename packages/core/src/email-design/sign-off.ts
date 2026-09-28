/**
 * Exactly one sign-off per e-mail (production case 2026-09-28): the model, or
 * the owner in Compose, may end the text with "Ar cieņu,\nWxs" while the
 * business's signature is added below it. The closing and the name lines
 * after it are removed before the signature goes on.
 */

/** Closing phrases in the six supported languages (lower case, without the trailing comma). */
const CLOSINGS = [
  // en
  'best regards',
  'kind regards',
  'warm regards',
  'warmest regards',
  'regards',
  'best wishes',
  'best',
  'sincerely',
  'yours sincerely',
  'yours faithfully',
  'yours truly',
  'many thanks',
  'thanks',
  'thank you',
  'cheers',
  'all the best',
  // de
  'mit freundlichen grüßen',
  'mit freundlichen grüssen',
  'freundliche grüße',
  'freundliche grüsse',
  'viele grüße',
  'viele grüsse',
  'beste grüße',
  'beste grüsse',
  'liebe grüße',
  'herzliche grüße',
  'mfg',
  'gruß',
  'grüße',
  // lv
  'ar cieņu',
  'ar labiem vēlējumiem',
  'ar vislabākajiem vēlējumiem',
  'sveicieni',
  'ar sveicieniem',
  'visu labu',
  'paldies',
  'jauku dienu',
  // nl
  'met vriendelijke groet',
  'met vriendelijke groeten',
  'vriendelijke groet',
  'vriendelijke groeten',
  'hartelijke groet',
  'hartelijke groeten',
  'groeten',
  'groet',
  // fr
  'cordialement',
  'bien cordialement',
  'bien à vous',
  'salutations',
  'meilleures salutations',
  'sincères salutations',
  'bonne journée',
  // es
  'saludos',
  'un saludo',
  'saludos cordiales',
  'un cordial saludo',
  'atentamente',
  'muchas gracias',
];

const CLOSING_RE = new RegExp(
  `^(?:${CLOSINGS.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[,.!]?$`,
  'iu',
);

/** Lines after a closing that are only a name, a company or a role: short, no sentence. */
const NAME_LINE = /^[\p{L}\p{M}\d .&'’·|/()-]{1,60}$/u;
const MAX_NAME_LINES = 3;

/**
 * The text without a trailing sign-off ("Best regards,\nAnna\nNordlicht").
 * Only the end of the text is touched, and only when the closing stands on
 * its own line followed by at most three short name lines; a sentence that
 * merely contains "thanks" stays.
 */
export function stripSignOff(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  // Walk back over the name lines (at most three) to a closing line.
  for (let names = 0; names <= MAX_NAME_LINES && names < lines.length; names++) {
    const i = lines.length - 1 - names;
    const line = lines[i]!.trim();
    if (CLOSING_RE.test(line)) {
      const tail = lines.slice(i + 1).map((l) => l.trim());
      if (tail.every((l) => l === '' || NAME_LINE.test(l))) {
        const rest = lines.slice(0, i).join('\n').replace(/\s+$/, '');
        // A text that is only "Thanks!" stays as it is.
        return rest ? rest : text;
      }
      return text;
    }
    if (!line || !NAME_LINE.test(line)) return text;
  }
  return text;
}

/** Letters and digits only, lower case: "WXS · Web eXpert Solutions" ⊃ "Wxs". */
export function foldForContains(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** True when the signature already says this (a company name, a website, a phone number). */
export function signatureMentions(
  signature: string | null,
  value: string | null | undefined,
): boolean {
  if (!signature || !value?.trim()) return false;
  const v = foldForContains(value.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, ''));
  return v.length > 0 && foldForContains(signature).includes(v);
}
