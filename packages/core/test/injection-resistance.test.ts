/**
 * Injection resistance (brief: "tests for injection resistance, include sample
 * attack emails"). Every fixture assumes the model was fully fooled; the
 * tenant is in auto-send mode with no caps hit and a passing verifier.
 * The deterministic guards alone must keep each attack from going out.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGenerationPrompt,
  buildReplySubject,
  checkLoop,
  guardReply,
  sanitizeReply,
  type GuardInput,
} from '../src/index.ts';
import {
  ATTACK_FIXTURES,
  SPOOFED_SELF_FIXTURE,
  type AttackEmail,
} from './fixtures/attack-emails.ts';
import { KB_ALLOWLIST, KB_CHUNKS, KB_LABELS, TENANT_ADDRESS } from './fixtures/kb.ts';
import { INVISIBLE_RE } from './fixtures/chars.ts';

function run(
  email: AttackEmail,
  overrides: Partial<GuardInput> & Pick<GuardInput, 'classification' | 'modelOutput'>,
) {
  return guardReply({
    tenant: { mode: 'auto_send', budgetState: 'ok', allowlist: KB_ALLOWLIST },
    inbound: {
      from: email.from,
      replyTo: email.replyTo,
      subject: email.subject,
      messageId: '<inbound-1@example-mail.test>',
      references: [],
      bodyText: email.bodyText,
      html: email.html ?? null,
    },
    labels: KB_LABELS,
    caps: { senderRepliesLast24h: 0, maxPerSender24h: 2, tenantRepliesLastHour: 0, maxPerHour: 20 },
    verifier: 'passed',
    ...overrides,
  });
}

describe('attack fixtures', () => {
  it('there are at least 15 of them', () => {
    expect(ATTACK_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(ATTACK_FIXTURES.map((f) => [f.id, f] as const))('%s', (_id, fixture) => {
    const result = run(fixture.email, {
      classification: fixture.classification,
      modelOutput: fixture.compromisedOutput,
    });

    it('is never auto-sent', () => {
      expect(result.decision.action).not.toBe('auto_send');
    });

    it(`is routed to ${fixture.expect.action} for the expected reasons`, () => {
      expect(result.decision.action).toBe(fixture.expect.action);
      expect(result.decision.reasons).toEqual(expect.arrayContaining(fixture.expect.reasons));
    });

    it('recipient and subject come from the original headers, not the model', () => {
      expect([fixture.email.from, ...fixture.email.replyTo]).toContain(result.envelope.to);
      expect(result.envelope.subject).toBe(buildReplySubject(fixture.email.subject));
      expect(result.envelope.inReplyTo).toBe('<inbound-1@example-mail.test>');
    });

    it('detects the expected injection signals', () => {
      expect(result.injection.signals).toEqual(expect.arrayContaining(fixture.expect.signals));
    });

    it('keeps no link or address outside the knowledge base in any kept text', () => {
      for (const value of fixture.expect.removed ?? []) {
        expect(result.removed.map((r) => r.value)).toContain(value);
      }
      if (result.replyText !== null) {
        expect(sanitizeReply(result.replyText, KB_ALLOWLIST).removed).toEqual([]);
        for (const value of fixture.expect.removed ?? [])
          expect(result.replyText).not.toContain(value);
        expect(result.replyText).not.toMatch(INVISIBLE_RE);
      }
    });
  });

  it(`${SPOOFED_SELF_FIXTURE.id}: mail forged from the tenant's own address is never answered`, () => {
    const e = SPOOFED_SELF_FIXTURE.email;
    expect(
      checkLoop({
        headers: {},
        from: e.from,
        replyTo: e.replyTo,
        ownAddresses: [TENANT_ADDRESS],
        bodyText: e.bodyText,
      }),
    ).toEqual({ skip: true, reason: 'sender_is_self' });
  });
});

describe('the prompt keeps attack text inside the data block', () => {
  it.each(ATTACK_FIXTURES.map((f) => [f.id, f] as const))('%s', (_id, fixture) => {
    const nonce = 'feedfacecafe0123456789ab';
    const prompt = buildGenerationPrompt({
      businessName: 'Nordlicht Candles',
      email: {
        fromName: fixture.email.fromName,
        subject: fixture.email.subject,
        bodyText: fixture.email.bodyText,
      },
      chunks: KB_CHUNKS,
      inboundLanguage: fixture.classification.language,
      nonce,
    });
    const emailPart = prompt.parts.find((p) => p.kind === 'untrusted_email')!.text;
    // Exactly one opening and one closing delimiter: the attacker could not add more.
    expect(emailPart.match(/<<<EMAIL_DATA_/g)).toHaveLength(1);
    expect(emailPart.match(/<<<END_EMAIL_DATA_/g)).toHaveLength(1);
    expect(emailPart.startsWith(`<<<EMAIL_DATA_${nonce}>>>`)).toBe(true);
    expect(emailPart.endsWith(`<<<END_EMAIL_DATA_${nonce}>>>`)).toBe(true);
    expect(emailPart).not.toMatch(INVISIBLE_RE);
    // Between our real delimiters, nothing delimiter-like survives.
    const inner = emailPart.split('\n').slice(1, -1).join('\n');
    expect(inner).not.toMatch(/<<<|>>>|EMAIL_DATA|KB_DATA/i);
    // Attack text never reaches the system instruction.
    expect(prompt.system).not.toContain(fixture.email.bodyText.slice(0, 30));
  });
});

describe('benign controls (the guards do not block everything)', () => {
  const email: AttackEmail = {
    from: 'janis@example-mail.test',
    fromName: 'Jānis',
    replyTo: [],
    subject: 'Candle price',
    bodyText: 'Hello, how much is one candle and how long does delivery within Latvia take?',
  };
  const good = {
    intent: 'price and delivery question',
    language: 'en',
    reply:
      'One candle costs 24 EUR and delivery within Latvia takes 2-3 business days. You can order at https://nordlicht-candles.test/shop',
    sources: ['S1', 'S2'],
    confidence: 0.93,
    action: 'auto_send' as const,
    escalate_reason: null,
  };
  const classification = {
    category: 'product_question' as const,
    sentiment: 'neutral' as const,
    urgency: 'normal' as const,
    language: 'en',
    summary: 'Price and delivery.',
  };

  it('a grounded English answer is auto-sent in auto-send mode', () => {
    const r = run(email, { classification, modelOutput: good });
    expect(r.decision).toMatchObject({ action: 'auto_send', reasons: [] });
    expect(r.replyText).toBe(good.reply);
    expect(r.citedChunkIds).toEqual([KB_CHUNKS[0]!.id, KB_CHUNKS[1]!.id]);
  });

  it('a grounded German answer is auto-sent too', () => {
    const r = run(
      { ...email, subject: 'Versand', bodyText: 'Wie lange dauert der Versand nach Deutschland?' },
      {
        classification: { ...classification, language: 'de' },
        modelOutput: {
          ...good,
          language: 'de',
          reply: 'Der Versand innerhalb der EU dauert 5 Werktage.',
          sources: ['S3'],
        },
      },
    );
    expect(r.decision.action).toBe('auto_send');
  });

  it('accepts the model output as a JSON string', () => {
    expect(run(email, { classification, modelOutput: JSON.stringify(good) }).decision.action).toBe(
      'auto_send',
    );
  });

  it('without verification it stays a draft, flagged as eligible for verification', () => {
    const r = run(email, { classification, modelOutput: good, verifier: 'not_run' });
    expect(r.decision).toMatchObject({
      action: 'draft',
      reasons: ['not_verified'],
      eligibleForVerification: true,
    });
  });

  it('in draft-only mode (the default for new tenants) it is a draft', () => {
    const r = run(email, {
      classification,
      modelOutput: good,
      tenant: { mode: 'draft_only', budgetState: 'ok', allowlist: KB_ALLOWLIST },
    });
    expect(r.decision).toMatchObject({ action: 'draft', reasons: ['tenant_draft_only'] });
  });

  it('malformed model output escalates with no suggestion', () => {
    const r = run(email, { classification, modelOutput: '{"reply": "hi", "action": "send_now"}' });
    expect(r.decision).toMatchObject({
      action: 'escalate',
      escalation: 'uncertain',
      reasons: ['invalid_output'],
      keepSuggestion: false,
    });
    expect(r.validationError).toBeTruthy();
    expect(r.replyText).toBeNull();
  });
});
