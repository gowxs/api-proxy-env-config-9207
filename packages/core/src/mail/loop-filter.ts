import { hostOf, localPart, normalizeAddress } from './addresses.ts';

/** Header map with lower-cased names. Multi-valued headers keep every value. */
export type HeaderMap = Record<string, string | string[] | undefined>;

export interface LoopCheckInput {
  headers: HeaderMap;
  /** Envelope/From address of the inbound message. */
  from: string;
  /** Reply-To addresses, if any. */
  replyTo: string[];
  /** Every mailbox address connected for this tenant (and its aliases). */
  ownAddresses: string[];
  /** Plain-text body with quoted history already removed. */
  bodyText: string;
}

export type LoopSkipReason =
  | 'loop_header:auto-submitted'
  | 'loop_header:precedence'
  | 'loop_header:list'
  | 'loop_header:autoreply'
  | 'loop_header:auto-response-suppress'
  | 'loop_header:x-loop'
  | 'bounce:null-return-path'
  | 'bounce:delivery-report'
  | 'automated_sender'
  | 'sender_is_self'
  | 'empty_body';

export type LoopCheckResult = { skip: false } | { skip: true; reason: LoopSkipReason };

/**
 * Local parts used by machines, not people. Matches the whole local part or a
 * prefix followed by a separator: "noreply", "no-reply+abc", "bounce-123",
 * "notifications.github". Plain words that merely contain these ("reynold")
 * are not matched.
 */
const AUTOMATED_LOCAL_PART_RE =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|auto[-_.]?reply|automated|alerts?)(?:[-+._].*)?$/i;

/** Hosts that only send automated mail (bounce processors, notification relays). */
const AUTOMATED_HOST_RE = /(?:^|\.)(?:bounces?|bounce-mail|notifications?|mailer-daemon)\./i;

function values(headers: HeaderMap, name: string): string[] {
  const v = headers[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim());
}

function has(headers: HeaderMap, name: string): boolean {
  return values(headers, name).length > 0;
}

export function isAutomatedSender(address: string): boolean {
  return (
    AUTOMATED_LOCAL_PART_RE.test(localPart(address)) || AUTOMATED_HOST_RE.test(hostOf(address))
  );
}

/**
 * Deterministic "never reply" rules (PLAN.md §4.2 step 2). Runs before any
 * model call; a skipped message costs no tokens.
 */
export function checkLoop(input: LoopCheckInput): LoopCheckResult {
  const h = input.headers;

  // RFC 3834: anything other than "no" means machine-generated.
  if (values(h, 'auto-submitted').some((v) => v.toLowerCase() !== 'no')) {
    return { skip: true, reason: 'loop_header:auto-submitted' };
  }
  if (values(h, 'precedence').some((v) => /^(bulk|list|junk|auto[-_]?reply)$/i.test(v))) {
    return { skip: true, reason: 'loop_header:precedence' };
  }
  if (has(h, 'list-unsubscribe') || has(h, 'list-id') || has(h, 'list-post')) {
    return { skip: true, reason: 'loop_header:list' };
  }
  if (has(h, 'x-autoreply') || has(h, 'x-autorespond') || has(h, 'x-autoresponder')) {
    return { skip: true, reason: 'loop_header:autoreply' };
  }
  // Microsoft's "do not auto-respond to this" signal (OOF replies, NDRs, etc.).
  if (values(h, 'x-auto-response-suppress').some((v) => /\b(all|oof|autoreply)\b/i.test(v))) {
    return { skip: true, reason: 'loop_header:auto-response-suppress' };
  }
  if (has(h, 'x-loop')) {
    return { skip: true, reason: 'loop_header:x-loop' };
  }
  if (values(h, 'return-path').some((v) => v === '<>' || v === '')) {
    return { skip: true, reason: 'bounce:null-return-path' };
  }
  if (values(h, 'content-type').some((v) => /multipart\/report/i.test(v))) {
    return { skip: true, reason: 'bounce:delivery-report' };
  }

  const own = new Set(input.ownAddresses.map(normalizeAddress));
  const replyTargets = input.replyTo.length ? input.replyTo : [input.from];

  // Replies go to Reply-To when present, so that is what must be a person.
  // (Contact forms often send From: noreply@shop with Reply-To: the customer.)
  if (replyTargets.some(isAutomatedSender)) {
    return { skip: true, reason: 'automated_sender' };
  }
  // A message from our own mailbox is skipped unless it carries an external
  // Reply-To — that is how website contact forms deliver customer enquiries.
  if (replyTargets.every((a) => own.has(normalizeAddress(a)))) {
    return { skip: true, reason: 'sender_is_self' };
  }
  if (input.bodyText.trim().length === 0) {
    return { skip: true, reason: 'empty_body' };
  }
  return { skip: false };
}
