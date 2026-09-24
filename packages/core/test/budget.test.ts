import { describe, expect, it } from 'vitest';
import { budgetStateFor, mayCallModel, utcDay } from '../src/index.ts';

describe('budgetStateFor (Q3)', () => {
  it.each([
    [0, 'ok'],
    [99_999, 'ok'],
    [100_000, 'draft_forced'],
    [149_999, 'draft_forced'],
    [150_000, 'halted'],
    [1_000_000, 'halted'],
  ] as const)('%i of 100000 tokens → %s', (used, state) => {
    expect(budgetStateFor(used, 100_000)).toBe(state);
  });

  it('only halted stops model calls (draft-only mode still drafts)', () => {
    expect([mayCallModel('ok'), mayCallModel('draft_forced'), mayCallModel('halted')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('uses UTC days', () => {
    expect(utcDay(new Date('2026-09-24T23:30:00-02:00'))).toBe('2026-09-25');
  });
});
