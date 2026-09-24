import { budgetStateFor, utcDay, type BudgetState, type TokenUsage } from '@noctiv/core';
import type { TransactionSql } from 'postgres';

export interface UsageRecord {
  tenantId: string;
  /** Generation usage (input + output + thinking tokens). */
  usage?: TokenUsage;
  llmCalls?: number;
  /** Embedding tokens (estimated from characters where the API reports none). */
  embedTokens?: number;
  now?: Date;
}

export interface BudgetStatus {
  state: BudgetState;
  previous: BudgetState;
  usedTokens: number;
  dailyBudget: number;
}

async function statusFor(tx: TransactionSql, tenantId: string, day: string): Promise<BudgetStatus> {
  const [row] = await tx<{ used: string; budget: number; stored: BudgetState }[]>`
    select coalesce(u.tokens_in + u.tokens_out + u.embed_tokens, 0)::text as used,
           t.daily_token_budget as budget,
           t.budget_state as stored
    from public.tenants t
    left join public.usage_daily u on u.tenant_id = t.id and u.day = ${day}::date
    where t.id = ${tenantId}`;
  if (!row) throw new Error('tenant not visible in this transaction (missing withTenant?)');
  const usedTokens = Number(row.used);
  return {
    state: budgetStateFor(usedTokens, row.budget),
    previous: row.stored,
    usedTokens,
    dailyBudget: row.budget,
  };
}

/**
 * Keeps tenants.budget_state in step with today's usage and queues alerts on
 * transitions: admin on draft_forced and halted, owner on halted. Alerts are
 * deduplicated per tenant, day and state. Must run inside withTenant().
 */
async function applyTransition(
  tx: TransactionSql,
  tenantId: string,
  day: string,
  status: BudgetStatus,
): Promise<void> {
  if (status.state === status.previous) return;
  await tx`update public.tenants set budget_state = ${status.state} where id = ${tenantId}`;
  if (status.state === 'ok') return;
  const payload = {
    day,
    state: status.state,
    usedTokens: status.usedTokens,
    dailyBudget: status.dailyBudget,
  };
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'telegram_admin', 'budget_state', ${`budget:${day}:${status.state}:admin`}, ${tx.json(payload)})
    on conflict (tenant_id, dedupe_key) do nothing`;
  if (status.state === 'halted') {
    await tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${tenantId}, 'telegram_owner', 'budget_halted', ${`budget:${day}:halted:owner`}, ${tx.json(payload)})
      on conflict (tenant_id, dedupe_key) do nothing`;
  }
}

/** Adds usage to today's row and returns the resulting budget state. */
export async function recordUsage(tx: TransactionSql, record: UsageRecord): Promise<BudgetStatus> {
  const day = utcDay(record.now ?? new Date());
  const u = record.usage ?? { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  const output = u.outputTokens + u.thinkingTokens;
  await tx`
    insert into public.usage_daily (tenant_id, day, llm_calls, tokens_in, tokens_out, embed_tokens)
    values (${record.tenantId}, ${day}::date, ${record.llmCalls ?? 0}, ${u.inputTokens}, ${output}, ${record.embedTokens ?? 0})
    on conflict (tenant_id, day) do update set
      llm_calls = usage_daily.llm_calls + excluded.llm_calls,
      tokens_in = usage_daily.tokens_in + excluded.tokens_in,
      tokens_out = usage_daily.tokens_out + excluded.tokens_out,
      embed_tokens = usage_daily.embed_tokens + excluded.embed_tokens`;
  const status = await statusFor(tx, record.tenantId, day);
  await applyTransition(tx, record.tenantId, day, status);
  return status;
}

/**
 * Today's budget state, computed from today's usage — so a new UTC day
 * starts at 'ok' without a reset job. Also refreshes the stored column.
 */
export async function currentBudget(
  tx: TransactionSql,
  tenantId: string,
  now = new Date(),
): Promise<BudgetStatus> {
  const day = utcDay(now);
  const status = await statusFor(tx, tenantId, day);
  await applyTransition(tx, tenantId, day, status);
  return status;
}
