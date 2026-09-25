import type { ValidatedMapping } from './mapping.ts';

export type TenantMode = 'draft_only' | 'auto_send' | 'full_auto';

export type QuoteHoldReason =
  'tenant_draft_only' | 'quote_over_limit' | 'quote_unmapped' | 'quote_empty';

export interface QuoteSendDecision {
  action: 'auto_send' | 'draft';
  reasons: string[];
}

/**
 * Quotes follow the tenant mode. In modes 2 and 3 a quote goes out on its
 * own only when every line mapped to a confirmed item, nothing was left
 * unmapped, the total is at or under the tenant's limit, and no other guard
 * (budget, caps, injection signs, reply-to mismatch) holds it back.
 */
export function decideQuoteSend(i: {
  mode: TenantMode;
  mapping: ValidatedMapping;
  totalCents: number;
  limitCents: number;
  /** Reasons from the usual reply guards; any of them holds the quote. */
  guardReasons?: string[];
}): QuoteSendDecision {
  const reasons: string[] = [];
  if (i.mode === 'draft_only') reasons.push('tenant_draft_only');
  if (i.mapping.lines.length === 0) reasons.push('quote_empty');
  if (i.mapping.unmapped.length > 0) reasons.push('quote_unmapped');
  if (i.totalCents > i.limitCents) reasons.push('quote_over_limit');
  reasons.push(...(i.guardReasons ?? []));
  return { action: reasons.length === 0 ? 'auto_send' : 'draft', reasons };
}
