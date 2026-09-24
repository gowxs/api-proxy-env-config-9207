import { originForMailbox, originForTenantKnowledge, TrainingDataPolicyError } from '@noctiv/core';
import { describe, expect, it } from 'vitest';
import { FakeProvider, fakeEmbedding, partitionMailboxes } from '../src/index.ts';

const boxes = [
  { tenantId: 't1', connectionId: 'real', isTestMailbox: false },
  { tenantId: 't2', connectionId: 'test', isTestMailbox: true },
];

describe('startup guard: free-tier provider processes test mailboxes only', () => {
  it('refuses every mailbox not flagged is_test_mailbox while a free-tier provider is active', () => {
    expect(partitionMailboxes({ trainingPolicy: 'may_train_on_data' }, boxes)).toEqual({
      allowed: [boxes[1]],
      refused: [boxes[0]],
    });
  });

  it('processes all mailboxes with a no-training provider', () => {
    expect(partitionMailboxes({ trainingPolicy: 'no_training' }, boxes)).toEqual({
      allowed: boxes,
      refused: [],
    });
  });

  it('second lock: even if a real mailbox slipped through, the provider refuses its data', async () => {
    const freeTier = new FakeProvider({
      trainingPolicy: 'may_train_on_data',
      responder: () => '{}',
    });
    const origin = originForMailbox(boxes[0]!);
    expect(origin).toBe('customer_data');
    await expect(
      freeTier.generate({
        tier: 'fast',
        origin,
        system: '',
        parts: [],
        responseJsonSchema: {},
        maxOutputTokens: 10,
      }),
    ).rejects.toBeInstanceOf(TrainingDataPolicyError);
    expect(freeTier.calls).toHaveLength(0);
  });

  it("a tenant's knowledge base is test data only if all its mailboxes are test mailboxes", () => {
    expect(originForTenantKnowledge([{ isTestMailbox: true }])).toBe('test_mailbox');
    expect(originForTenantKnowledge([{ isTestMailbox: true }, { isTestMailbox: false }])).toBe(
      'customer_data',
    );
    expect(originForTenantKnowledge([])).toBe('customer_data');
  });
});

describe('FakeProvider embeddings', () => {
  it('are deterministic unit vectors where shared words mean higher similarity', () => {
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = fakeEmbedding('shipping to germany');
    expect(fakeEmbedding('shipping to germany')).toEqual(q);
    expect(q).toHaveLength(768);
    expect(dot(q, q)).toBeCloseTo(1);
    expect(dot(q, fakeEmbedding('Shipping to Germany takes 5 days'))).toBeGreaterThan(
      dot(q, fakeEmbedding('candle prices')),
    );
  });
});
