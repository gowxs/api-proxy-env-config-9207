/**
 * Per-tenant daily token budget (brief; PLAN.md §3.6, founder decision Q3):
 *   < 100 %  ok
 *   ≥ 100 %  draft_forced — no auto-send, admin alerted
 *   ≥ 150 %  halted       — no more model calls today, owner notified
 * Days are UTC days.
 */
export type BudgetState = 'ok' | 'draft_forced' | 'halted';

export const DRAFT_FORCED_AT = 1.0;
export const HALTED_AT = 1.5;

export function budgetStateFor(usedTokens: number, dailyBudget: number): BudgetState {
  if (dailyBudget <= 0) return 'halted';
  const ratio = usedTokens / dailyBudget;
  if (ratio >= HALTED_AT) return 'halted';
  if (ratio >= DRAFT_FORCED_AT) return 'draft_forced';
  return 'ok';
}

/** Model calls are allowed unless the tenant is halted. */
export function mayCallModel(state: BudgetState): boolean {
  return state !== 'halted';
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
