import { isEmailAddress, normalizeAddress, sameOrganization } from './addresses.ts';

export interface OriginalHeaders {
  from: string;
  replyTo: string[];
  subject: string | null;
  messageId: string;
  references: string[];
}

export interface ReplyRecipient {
  /** Where the reply goes. Always one of the original header addresses. */
  to: string;
  /** Reply-To points somewhere other than the sender's organization. */
  replyToMismatch: boolean;
}

/**
 * The recipient comes from the original headers only — never from model
 * output (PLAN.md §3.5 rule 4). Reply-To wins when it names exactly one valid
 * address (contact forms rely on it); if it points to a different
 * organization than From, the reply can still be drafted but never auto-sent.
 */
export function resolveReplyRecipient(
  original: Pick<OriginalHeaders, 'from' | 'replyTo'>,
): ReplyRecipient {
  const replyTo = original.replyTo.map((a) => a.trim()).filter(Boolean);
  if (replyTo.length === 1 && isEmailAddress(replyTo[0]!)) {
    const to = replyTo[0]!;
    const mismatch =
      normalizeAddress(to) !== normalizeAddress(original.from) &&
      !sameOrganization(to, original.from);
    return { to, replyToMismatch: mismatch };
  }
  // Several or malformed Reply-To values: answer the sender, flag for review.
  return { to: original.from.trim(), replyToMismatch: replyTo.length > 0 };
}

/** Reply prefixes used by common clients in our languages (EN, DE, NL, FR, ES, LV, Nordic). */
const REPLY_PREFIX_RE = /^\s*(?:re|aw|antw|sv|vs|atb|r|réf|ref|rif)\s*(?:\[\d+\])?\s*:/i;

export function buildReplySubject(subject: string | null): string {
  const s = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!s) return 'Re:';
  return REPLY_PREFIX_RE.test(s) ? s : `Re: ${s}`;
}

/** Keep References bounded: first id (thread root) + the most recent ones. */
const MAX_REFERENCES = 20;

export function buildThreadingHeaders(
  original: Pick<OriginalHeaders, 'messageId' | 'references'>,
): {
  inReplyTo: string;
  references: string[];
} {
  const chain = [...original.references.filter(Boolean), original.messageId];
  const unique = chain.filter((id, i) => chain.indexOf(id) === i);
  const references =
    unique.length <= MAX_REFERENCES ? unique : [unique[0]!, ...unique.slice(-(MAX_REFERENCES - 1))];
  return { inReplyTo: original.messageId, references };
}
