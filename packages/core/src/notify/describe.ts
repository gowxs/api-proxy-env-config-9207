/**
 * Why a reply waits for the owner, and which sources disagree, in plain
 * English: shared by the owner's notification e-mail and the signed
 * Approve / Reject page, so both say the same thing.
 */

/**
 * Text from the knowledge base or a customer can carry links aimed at the
 * owner: links are removed and control characters flattened. Callers escape
 * for HTML.
 */
export function ownerSafeText(value: unknown, max = 400): string {
  const s = typeof value === 'string' ? value : '';
  return s
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .replace(/[\p{Cc}]+/gu, (m) => (m.includes('\n') ? '\n' : ' '))
    .trim()
    .slice(0, max);
}
const untrusted = ownerSafeText;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const REASONS: Record<string, string> = {
  tenant_draft_only: 'your account is set to approve everything',
  arrived_while_paused: 'it arrived while the service was paused (no subscription)',
  billing_inactive: 'the service is paused (no active subscription)',
  budget_limited: 'the daily AI budget is nearly used up',
  sender_cap_reached: 'this customer already got the maximum number of automatic replies today',
  tenant_hour_cap_reached: 'the hourly limit for automatic replies was reached',
  mode_changed_to_draft_only: 'you switched to approving everything',
  content_removed: 'something was removed from the reply (for example a link)',
  unsupported_language: 'the language is not supported for automatic replies',
  language_mismatch: 'the reply language differs from the customer’s',
  injection_suspected: 'the email looks like it tries to manipulate the assistant',
  reply_to_mismatch: 'the reply address differs from the sender',
  model_chose_draft: 'the assistant was not sure enough to send it alone',
  not_verified: 'the facts in the reply could not be double-checked',
  price_omitted:
    'the customer asked for a price your knowledge base has, and the reply left it out',
  contradicts_owner_note: 'a figure in the reply differs from your own note',
  source_conflict: 'your note and your website (or files) give different figures',
  invalid_output: 'the assistant produced no usable answer',
  model_escalated: 'the assistant asked for a human',
  low_confidence: 'the assistant was not confident',
  empty_reply: 'the assistant produced no reply',
  unknown_source: 'the reply cited something outside your knowledge base',
  claim_without_sources: 'the reply stated facts without a source',
  verifier_failed: 'a fact check found statements not backed by your knowledge base',
  acknowledgement_sent: 'the customer got a short acknowledgement (fully automatic mode)',
  quote_over_limit: 'the quote total is above your automatic-send limit',
  bookings_disabled: 'Bookings was switched off after the reply was written',
  quote_unmapped: 'some requested items are not on your price list',
  quote_empty: 'nothing in the request matched your price list',
  partial_answer_check:
    'the e-mail also answers a question outside your price list; please check that part',
  quotes_disabled: 'Quotes (beta) is switched off',
  invoice_over_limit: 'the invoice total is above your automatic-send limit',
  documents_disabled: 'Documents (beta) is switched off',
};

export function describeReason(code: string): string {
  if (REASONS[code]) return REASONS[code];
  const [prefix, rest] = code.split(':');
  if (prefix === 'hard_list' && rest)
    return `a person should answer this (${rest.replace(/_/g, ' ')})`;
  if (prefix === 'unsupported_claim' && rest)
    return `the reply mentions a ${rest.replace(/_/g, ' ')} not found in your knowledge base`;
  return code.replace(/[_:]/g, ' ');
}

/**
 * "business website: your note "Prices" (2026-09-24) says 10 business days (newest note);
 * your website example.com/en/ (read 2026-09-25) says 3–7 business days. The reply says
 * 3–7 business days, not your note's figure: edit it before approving."
 * Everything here comes from the tenant's knowledge base or the reply, so it is escaped.
 */
export function describeConflicts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 5)
    .map(
      (c: {
        about?: unknown;
        reply?: unknown;
        replyUsesNote?: unknown;
        sources?: unknown;
        byModel?: unknown;
      }) => {
        const sources = (Array.isArray(c.sources) ? c.sources : [])
          .slice(0, 6)
          .map((s: { says?: unknown; source?: unknown; preferred?: unknown }) => {
            const mark = s.preferred ? ' (newest note)' : '';
            return str(s.says)
              ? `${untrusted(s.source, 160)} says ${untrusted(s.says, 60)}${mark}`
              : `${untrusted(s.source, 160)}${mark}`;
          })
          .join('; ');
        const about = untrusted(c.about, 80) || 'a figure';
        const reply = untrusted(c.reply, 60);
        const verdict = !reply
          ? ''
          : c.replyUsesNote === false
            ? ` The reply says ${reply}, not your note's figure: edit it before approving.`
            : c.replyUsesNote === true
              ? ` The reply uses your note's figure (${reply}).`
              : ` The reply says ${reply}.`;
        return `${c.byModel ? `${about} (noticed by the assistant)` : about}: ${sources}.${verdict}`;
      },
    );
}
