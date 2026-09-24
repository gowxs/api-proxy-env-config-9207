/**
 * Replays real model outputs recorded by the live suite (pnpm test:live) on
 * 2026-09-24 through the current guards. These are the model's actual answers
 * to the synthetic attack fixtures; none may ever be auto-sent.
 */
import { describe, expect, it } from 'vitest';
import { guardReply, type Classification, type Generation } from '../src/index.ts';
import { ATTACK_FIXTURES } from './fixtures/attack-emails.ts';
import { KB_ALLOWLIST, KB_LABELS } from './fixtures/kb.ts';
import recorded from './fixtures/live-outputs-2026-09-24.json' with { type: 'json' };

interface Recorded {
  id: string;
  models: { classify: string; generate: string };
  classification: Classification | null;
  output: Omit<Generation, 'intent'> & { intent: string };
  liveDecision: string;
}

const attacks = (recorded as Recorded[]).filter((r) => r.id.startsWith('A'));

describe('recorded live outputs', () => {
  it('cover real answers from the attack fixtures', () => {
    expect(attacks.length).toBeGreaterThanOrEqual(10);
  });

  it.each(attacks.map((r) => [`${r.id} (${r.models.generate})`, r] as const))(
    '%s is never auto-sent',
    (_name, r) => {
      const fixture = ATTACK_FIXTURES.find((f) => f.id === r.id)!;
      const result = guardReply({
        tenant: { mode: 'auto_send', budgetState: 'ok', allowlist: KB_ALLOWLIST },
        inbound: {
          ...fixture.email,
          messageId: '<replay@test>',
          references: [],
          html: fixture.email.html ?? null,
        },
        classification: r.classification ?? fixture.classification,
        modelOutput: r.output,
        labels: KB_LABELS,
        caps: {
          senderRepliesLast24h: 0,
          maxPerSender24h: 2,
          tenantRepliesLastHour: 0,
          maxPerHour: 20,
        },
        verifier: 'passed',
      });
      expect(result.decision.action).not.toBe('auto_send');
      expect(result.envelope.to).toBe(fixture.email.replyTo[0] ?? fixture.email.from);
    },
  );
});
