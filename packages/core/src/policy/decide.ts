import type { ClaimKind } from '../claims/detect.ts';
import { isSupportedLanguage } from '../claims/lexicon.ts';
import {
  HARD_ESCALATION_CATEGORIES,
  type Action,
  type Classification,
  type Generation,
} from '../llm/schemas.ts';

export const CONFIDENCE_THRESHOLD = 0.8;

/**
 * Sending modes (one plan, owner's choice, default draft_only):
 *  - draft_only: every reply waits for approval.
 *  - auto_send: replies fully backed by the knowledge base go out; the rest waits.
 *  - full_auto: as auto_send; a message that cannot be answered from the knowledge
 *    base also gets a fixed acknowledgement (see acknowledge.ts) and goes to the owner.
 * The no-invented-facts rules and the hard list apply identically in every mode.
 */
export const TENANT_MODES = ['draft_only', 'auto_send', 'full_auto'] as const;
export type TenantMode = (typeof TENANT_MODES)[number];

/** Modes in which grounded replies may be sent without approval. */
export function isAutomaticMode(mode: TenantMode): boolean {
  return mode === 'auto_send' || mode === 'full_auto';
}

export type EscalateReason =
  | `hard_list:${'complaint' | 'refund' | 'legal_contract' | 'discount_request' | 'angry' | 'urgent'}`
  | 'invalid_output'
  | 'model_escalated'
  | 'low_confidence'
  | 'empty_reply'
  | 'unknown_source'
  | 'claim_without_sources'
  | `unsupported_claim:${ClaimKind}`
  | 'verifier_failed';

export type DraftReason =
  | 'tenant_draft_only'
  /** Set by the worker: the message arrived while service was stopped (no subscription). */
  | 'arrived_while_paused'
  | 'budget_limited'
  | 'sender_cap_reached'
  | 'tenant_hour_cap_reached'
  | 'content_removed'
  | 'unsupported_language'
  | 'language_mismatch'
  | 'injection_suspected'
  | 'reply_to_mismatch'
  | 'model_chose_draft'
  | 'not_verified';

export type Reason = EscalateReason | DraftReason;

/** Hard-list reasons (PLAN.md §11 Q16): humans write these replies; no AI draft is kept. */
export function hardEscalationReasons(
  c: Pick<Classification, 'category' | 'sentiment' | 'urgency'>,
): EscalateReason[] {
  const reasons: EscalateReason[] = [];
  if ((HARD_ESCALATION_CATEGORIES as readonly string[]).includes(c.category)) {
    reasons.push(
      `hard_list:${c.category as 'complaint' | 'refund' | 'legal_contract' | 'discount_request'}`,
    );
  }
  if (c.sentiment === 'angry') reasons.push('hard_list:angry');
  if (c.urgency === 'urgent') reasons.push('hard_list:urgent');
  return reasons;
}

export interface PolicyInput {
  tenant: { mode: TenantMode; budgetState: 'ok' | 'draft_forced' | 'halted' };
  classification: Pick<Classification, 'category' | 'sentiment' | 'urgency' | 'language'>;
  /** null when the model output failed validation (after the retry). */
  generation: Generation | null;
  unknownSourceLabels: string[];
  citedSourceCount: number;
  claimKinds: ClaimKind[];
  unsupportedClaimKinds: ClaimKind[];
  contentRemoved: boolean;
  injectionSuspected: boolean;
  replyToMismatch: boolean;
  caps: {
    senderRepliesLast24h: number;
    maxPerSender24h: number;
    tenantRepliesLastHour: number;
    maxPerHour: number;
  };
  /** Result of the optional grounding verifier (Q6). Auto-send requires 'passed'. */
  verifier: 'passed' | 'failed' | 'not_run';
}

export interface PolicyDecision {
  action: Action;
  /** Set when action is 'escalate'. */
  escalation?: 'hard_list' | 'uncertain';
  /** Uncertain escalations keep the generated reply as an "AI suggestion, unverified". */
  keepSuggestion: boolean;
  reasons: Reason[];
  /** True when only verification stands between this reply and auto-send. */
  eligibleForVerification: boolean;
}

/**
 * The final say on what happens to a reply (PLAN.md §4.3). Pure and total:
 * the model's own `action` is one input among many and can only make the
 * outcome more cautious. Most restrictive result wins:
 *   escalate  >  draft  >  auto_send
 */
export function decideAction(input: PolicyInput): PolicyDecision {
  const hard = hardEscalationReasons(input.classification);
  if (hard.length) {
    return {
      action: 'escalate',
      escalation: 'hard_list',
      keepSuggestion: false,
      reasons: hard,
      eligibleForVerification: false,
    };
  }

  const g = input.generation;
  const escalate: EscalateReason[] = [];
  if (!g) {
    escalate.push('invalid_output');
  } else {
    if (g.action === 'escalate') escalate.push('model_escalated');
    if (g.confidence < CONFIDENCE_THRESHOLD) escalate.push('low_confidence');
    if (g.reply.trim().length === 0) escalate.push('empty_reply');
    if (input.unknownSourceLabels.length) escalate.push('unknown_source');
    if (input.claimKinds.length > 0 && input.citedSourceCount === 0)
      escalate.push('claim_without_sources');
    for (const kind of new Set(input.unsupportedClaimKinds))
      escalate.push(`unsupported_claim:${kind}`);
    if (input.verifier === 'failed') escalate.push('verifier_failed');
  }
  if (escalate.length) {
    const keep = Boolean(g && g.reply.trim().length > 0);
    return {
      action: 'escalate',
      escalation: 'uncertain',
      keepSuggestion: keep,
      reasons: escalate,
      eligibleForVerification: false,
    };
  }

  // From here on g is a valid, grounded reply.
  const reply = g!;
  const draft: DraftReason[] = [];
  if (!isAutomaticMode(input.tenant.mode)) draft.push('tenant_draft_only');
  if (input.tenant.budgetState !== 'ok') draft.push('budget_limited');
  if (input.caps.senderRepliesLast24h >= input.caps.maxPerSender24h)
    draft.push('sender_cap_reached');
  if (input.caps.tenantRepliesLastHour >= input.caps.maxPerHour)
    draft.push('tenant_hour_cap_reached');
  if (input.contentRemoved) draft.push('content_removed');
  if (!isSupportedLanguage(input.classification.language) || !isSupportedLanguage(reply.language)) {
    draft.push('unsupported_language');
  } else if (reply.language !== input.classification.language) {
    draft.push('language_mismatch');
  }
  if (input.injectionSuspected) draft.push('injection_suspected');
  if (input.replyToMismatch) draft.push('reply_to_mismatch');
  if (reply.action === 'draft') draft.push('model_chose_draft');

  if (draft.length) {
    return {
      action: 'draft',
      keepSuggestion: true,
      reasons: draft,
      eligibleForVerification: false,
    };
  }
  if (input.verifier !== 'passed') {
    return {
      action: 'draft',
      keepSuggestion: true,
      reasons: ['not_verified'],
      eligibleForVerification: true,
    };
  }
  return { action: 'auto_send', keepSuggestion: true, reasons: [], eligibleForVerification: false };
}
