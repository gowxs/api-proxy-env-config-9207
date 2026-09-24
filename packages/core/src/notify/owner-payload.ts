import { hostOf } from '../mail/addresses.ts';

export interface OwnerNotificationInput {
  /** Per-tenant toggle (PLAN.md §11 Q2); default false = privacy mode. */
  fullText: boolean;
  kind: 'draft_ready' | 'escalation';
  senderAddress: string;
  senderName: string | null;
  subject: string | null;
  summary: string;
  action: 'auto_send' | 'draft' | 'escalate';
  reasons: string[];
  draftText: string | null;
  /** "AI suggestion, unverified" drafts on uncertain escalations (Q16). */
  unverifiedSuggestion: boolean;
}

export interface OwnerNotificationPayload {
  kind: OwnerNotificationInput['kind'];
  senderDomain: string;
  subject: string;
  summary: string;
  action: OwnerNotificationInput['action'];
  reasons: string[];
  unverifiedSuggestion: boolean;
  /** Only in full-text mode. */
  senderName?: string | null;
  draftText?: string | null;
}

/**
 * What an owner notification may contain (founder decision Q2).
 * Privacy mode (default): sender domain, subject, 1–2 sentence summary,
 * chosen action and downgrade reasons. No draft body, no customer name —
 * those stay in the dashboard. Full-text mode adds them.
 */
export function ownerNotificationPayload(i: OwnerNotificationInput): OwnerNotificationPayload {
  const base: OwnerNotificationPayload = {
    kind: i.kind,
    senderDomain: hostOf(i.senderAddress) || 'unknown',
    subject: (i.subject ?? '(no subject)').slice(0, 200),
    summary: i.summary.slice(0, 400),
    action: i.action,
    reasons: i.reasons,
    unverifiedSuggestion: i.unverifiedSuggestion,
  };
  return i.fullText ? { ...base, senderName: i.senderName, draftText: i.draftText } : base;
}
