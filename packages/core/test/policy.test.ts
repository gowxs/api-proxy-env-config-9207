/**
 * No-hallucination downgrade and the full decision table (PLAN.md §4.3).
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_THRESHOLD,
  decideAction,
  hardEscalationReasons,
  type PolicyInput,
} from '../src/index.ts';

function input(
  patch: Partial<PolicyInput> = {},
  gen: Partial<NonNullable<PolicyInput['generation']>> = {},
): PolicyInput {
  return {
    tenant: { mode: 'auto_send', budgetState: 'ok' },
    classification: {
      category: 'product_question',
      sentiment: 'neutral',
      urgency: 'normal',
      language: 'en',
    },
    generation: {
      intent: 'q',
      language: 'en',
      reply: 'A candle costs 24 EUR.',
      sources: ['S1'],
      confidence: 0.9,
      action: 'auto_send',
      escalate_reason: null,
      ...gen,
    },
    unknownSourceLabels: [],
    citedSourceCount: 1,
    claimKinds: ['money'],
    unsupportedClaimKinds: [],
    contentRemoved: false,
    injectionSuspected: false,
    replyToMismatch: false,
    caps: { senderRepliesLast24h: 0, maxPerSender24h: 2, tenantRepliesLastHour: 0, maxPerHour: 20 },
    verifier: 'passed',
    ...patch,
  };
}

describe('baseline', () => {
  it('auto-sends only when every check passes', () => {
    expect(decideAction(input())).toEqual({
      action: 'auto_send',
      keepSuggestion: true,
      reasons: [],
      eligibleForVerification: false,
    });
  });
});

describe('hard escalation list: escalate with no draft (Q16)', () => {
  it.each([
    [{ category: 'complaint' }, 'hard_list:complaint'],
    [{ category: 'refund' }, 'hard_list:refund'],
    [{ category: 'legal_contract' }, 'hard_list:legal_contract'],
    [{ category: 'discount_request' }, 'hard_list:discount_request'],
    [{ sentiment: 'angry' }, 'hard_list:angry'],
    [{ urgency: 'urgent' }, 'hard_list:urgent'],
  ] as const)('%o', (patch, reason) => {
    const d = decideAction(input({ classification: { ...input().classification, ...patch } }));
    expect(d).toEqual({
      action: 'escalate',
      escalation: 'hard_list',
      keepSuggestion: false,
      reasons: [reason],
      eligibleForVerification: false,
    });
  });

  it('applies even when the model is confident and chose auto_send', () => {
    const d = decideAction(
      input(
        { classification: { ...input().classification, category: 'refund' } },
        { confidence: 1 },
      ),
    );
    expect(d.action).toBe('escalate');
  });

  it('is exposed for use before generation', () => {
    expect(
      hardEscalationReasons({ category: 'complaint', sentiment: 'angry', urgency: 'urgent' }),
    ).toEqual(['hard_list:complaint', 'hard_list:angry', 'hard_list:urgent']);
  });
});

describe('no-hallucination downgrade: uncertain escalations keep an "AI suggestion, unverified"', () => {
  it.each([
    ['unsupported price', input({ unsupportedClaimKinds: ['money'] }), 'unsupported_claim:money'],
    [
      'unsupported deadline',
      input({ claimKinds: ['relative_time'], unsupportedClaimKinds: ['relative_time'] }),
      'unsupported_claim:relative_time',
    ],
    [
      'unsupported discount',
      input({ claimKinds: ['discount'], unsupportedClaimKinds: ['discount'] }),
      'unsupported_claim:discount',
    ],
    [
      'unsupported availability',
      input({ claimKinds: ['availability'], unsupportedClaimKinds: ['availability'] }),
      'unsupported_claim:availability',
    ],
    [
      'unsupported promise',
      input({ claimKinds: ['guarantee'], unsupportedClaimKinds: ['guarantee'] }),
      'unsupported_claim:guarantee',
    ],
    [
      'claims without any source',
      input({ citedSourceCount: 0 }, { sources: [] }),
      'claim_without_sources',
    ],
    ['fabricated source label', input({ unknownSourceLabels: ['S9'] }), 'unknown_source'],
    [
      'model escalated',
      input({}, { action: 'escalate', escalate_reason: 'not in KB' }),
      'model_escalated',
    ],
    ['empty reply', input({ claimKinds: [] }, { reply: '   ' }), 'empty_reply'],
    ['verifier failed', input({ verifier: 'failed' }), 'verifier_failed'],
  ])('%s', (_name, i, reason) => {
    const d = decideAction(i);
    expect(d.action).toBe('escalate');
    expect(d.escalation).toBe('uncertain');
    expect(d.reasons).toContain(reason);
  });

  it(`confidence ${CONFIDENCE_THRESHOLD - 0.01} escalates; ${CONFIDENCE_THRESHOLD} does not`, () => {
    expect(decideAction(input({}, { confidence: 0.79 }))).toMatchObject({
      action: 'escalate',
      reasons: ['low_confidence'],
    });
    expect(decideAction(input({}, { confidence: 0.8 })).action).toBe('auto_send');
  });

  it('keeps the suggestion when there is a reply, drops it when there is none', () => {
    expect(decideAction(input({}, { confidence: 0.5 })).keepSuggestion).toBe(true);
    expect(
      decideAction(input({ claimKinds: [] }, { reply: '', confidence: 0.5 })).keepSuggestion,
    ).toBe(false);
  });

  it('invalid output escalates with no suggestion', () => {
    expect(decideAction(input({ generation: null }))).toEqual({
      action: 'escalate',
      escalation: 'uncertain',
      keepSuggestion: false,
      reasons: ['invalid_output'],
      eligibleForVerification: false,
    });
  });

  it('a reply with no claims needs no sources', () => {
    expect(
      decideAction(
        input(
          { claimKinds: [], citedSourceCount: 0 },
          { reply: 'Thanks, we received your message.', sources: [] },
        ),
      ).action,
    ).toBe('auto_send');
  });
});

describe('draft downgrades', () => {
  it.each([
    [
      'tenant in draft-only mode',
      input({ tenant: { mode: 'draft_only', budgetState: 'ok' } }),
      'tenant_draft_only',
    ],
    [
      'budget reached',
      input({ tenant: { mode: 'auto_send', budgetState: 'draft_forced' } }),
      'budget_limited',
    ],
    [
      'sender cap (2 per 24h)',
      input({ caps: { ...input().caps, senderRepliesLast24h: 2 } }),
      'sender_cap_reached',
    ],
    [
      'tenant hourly cap',
      input({ caps: { ...input().caps, tenantRepliesLastHour: 20 } }),
      'tenant_hour_cap_reached',
    ],
    ['sanitizer removed content', input({ contentRemoved: true }), 'content_removed'],
    ['reply language differs', input({}, { language: 'de' }), 'language_mismatch'],
    [
      'unsupported inbound language',
      input({ classification: { ...input().classification, language: 'ru' } }, { language: 'ru' }),
      'unsupported_language',
    ],
    [
      'unknown language',
      input({ classification: { ...input().classification, language: 'und' } }),
      'unsupported_language',
    ],
    ['injection suspected', input({ injectionSuspected: true }), 'injection_suspected'],
    ['Reply-To mismatch', input({ replyToMismatch: true }), 'reply_to_mismatch'],
    ['model chose draft', input({}, { action: 'draft' }), 'model_chose_draft'],
  ])('%s', (_name, i, reason) => {
    const d = decideAction(i);
    expect(d.action).toBe('draft');
    expect(d.reasons).toContain(reason);
    expect(d.eligibleForVerification).toBe(false);
  });

  it('an otherwise clean reply that was not verified is a draft, eligible for verification', () => {
    expect(decideAction(input({ verifier: 'not_run' }))).toEqual({
      action: 'draft',
      keepSuggestion: true,
      reasons: ['not_verified'],
      eligibleForVerification: true,
    });
  });
});

describe('ordering', () => {
  it('escalation beats draft reasons, and reasons are reported together', () => {
    const d = decideAction(
      input({
        tenant: { mode: 'draft_only', budgetState: 'ok' },
        unsupportedClaimKinds: ['money'],
        unknownSourceLabels: ['S7'],
      }),
    );
    expect(d.action).toBe('escalate');
    expect(d.reasons).toEqual(['unknown_source', 'unsupported_claim:money']);
  });

  it('never returns auto_send if the model did not choose it', () => {
    for (const action of ['draft', 'escalate'] as const) {
      expect(decideAction(input({}, { action })).action).not.toBe('auto_send');
    }
  });
});
