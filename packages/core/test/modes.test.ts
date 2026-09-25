/**
 * Three sending modes (founder decision 2026-09-25). The fact rules and the
 * hard list are identical in all three; only what happens to a grounded reply
 * (modes 2, 3) and to a message that can't be grounded (mode 3) differs.
 */
import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENTS,
  decideAcknowledgement,
  decideAction,
  SUPPORTED_LANGUAGES,
  TENANT_MODES,
  type PolicyInput,
  type TenantMode,
} from '../src/index.ts';

function input(mode: TenantMode, patch: Partial<PolicyInput> = {}): PolicyInput {
  return {
    tenant: { mode, budgetState: 'ok' },
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

describe('grounded replies', () => {
  it('wait for approval in mode 1 and go out in modes 2 and 3', () => {
    expect(decideAction(input('draft_only')).action).toBe('draft');
    expect(decideAction(input('auto_send')).action).toBe('auto_send');
    expect(decideAction(input('full_auto')).action).toBe('auto_send');
  });
});

describe('rules that hold in every mode', () => {
  it.each(TENANT_MODES)('%s: an invented price is never sent', (mode) => {
    const d = decideAction(input(mode, { unsupportedClaimKinds: ['money'] }));
    expect(d.action).toBe('escalate');
    expect(d.reasons).toContain('unsupported_claim:money');
  });

  it.each(TENANT_MODES)('%s: hard-list cases always go to the owner', (mode) => {
    for (const c of [
      { category: 'complaint' as const },
      { category: 'refund' as const },
      { category: 'legal_contract' as const },
      { category: 'discount_request' as const },
      { sentiment: 'angry' as const },
      { urgency: 'urgent' as const },
    ]) {
      const d = decideAction(
        input(mode, { classification: { ...input(mode).classification, ...c } }),
      );
      expect(d).toMatchObject({ action: 'escalate', escalation: 'hard_list' });
      expect(
        decideAcknowledgement({
          mode,
          decision: d,
          budgetState: 'ok',
          language: 'en',
          caps: input(mode).caps,
          injectionSuspected: false,
          replyToMismatch: false,
        }).send,
      ).toBe(false);
    }
  });
});

describe('acknowledgement (mode 3)', () => {
  const uncertain = decideAction(input('full_auto', { verifier: 'failed' }));
  const ack = (patch: Partial<Parameters<typeof decideAcknowledgement>[0]> = {}) =>
    decideAcknowledgement({
      mode: 'full_auto',
      decision: uncertain,
      budgetState: 'ok',
      language: 'de',
      caps: input('full_auto').caps,
      injectionSuspected: false,
      replyToMismatch: false,
      ...patch,
    });

  it('is sent for a message that could not be grounded, in the customer language', () => {
    expect(uncertain).toMatchObject({ action: 'escalate', escalation: 'uncertain' });
    expect(ack()).toEqual({ send: true, language: 'de', text: ACKNOWLEDGEMENTS.de });
  });

  it('is never sent in modes 1 and 2', () => {
    expect(ack({ mode: 'draft_only' })).toEqual({ send: false, blocked: ['not_full_auto'] });
    expect(ack({ mode: 'auto_send' })).toEqual({ send: false, blocked: ['not_full_auto'] });
  });

  it('is not sent for a grounded reply or a draft', () => {
    expect(ack({ decision: { action: 'auto_send' } }).send).toBe(false);
    expect(ack({ decision: { action: 'draft' } }).send).toBe(false);
  });

  it.each([
    [{ budgetState: 'draft_forced' as const }, 'budget_limited'],
    [{ caps: { ...input('full_auto').caps, senderRepliesLast24h: 2 } }, 'sender_cap_reached'],
    [
      { caps: { ...input('full_auto').caps, tenantRepliesLastHour: 20 } },
      'tenant_hour_cap_reached',
    ],
    [{ language: 'ja' }, 'unsupported_language'],
    [{ injectionSuspected: true }, 'injection_suspected'],
    [{ replyToMismatch: true }, 'reply_to_mismatch'],
  ])('is blocked by the same gates as any automatic send: %o', (patch, reason) => {
    expect(ack(patch)).toEqual({ send: false, blocked: [reason] });
  });

  it('exists for every supported language and states no price, number or link', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const text = ACKNOWLEDGEMENTS[lang];
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/\d|[€$£%]|https?:|@/);
    }
  });
});
