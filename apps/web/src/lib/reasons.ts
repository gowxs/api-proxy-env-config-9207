/** Owner-facing wording for policy reasons (same meaning as the notification emails). */
const REASONS: Record<string, string> = {
  tenant_draft_only: 'Mode 1: approve everything',
  arrived_while_paused: 'Arrived while the service was paused (no subscription)',
  billing_inactive: 'Service paused: no active subscription',
  budget_limited: 'AI budget nearly used up',
  sender_cap_reached: 'Automatic-reply limit for this customer reached',
  tenant_hour_cap_reached: 'Hourly automatic-reply limit reached',
  mode_changed_to_draft_only: 'You switched to approving everything',
  content_removed: 'Something was removed from the reply (e.g. a link)',
  unsupported_language: 'Language not supported for automatic replies',
  language_mismatch: 'Reply language differs from the customer’s',
  injection_suspected: 'Email looks like it tries to manipulate the assistant',
  reply_to_mismatch: 'Reply address differs from the sender',
  model_chose_draft: 'The assistant was not sure enough',
  not_verified: 'Facts could not be double-checked',
  price_omitted: 'Price asked, but the reply left out the price from your knowledge base',
  contradicts_owner_note: 'A figure differs from your own note',
  source_conflict: 'Your note and your website give different figures',
  invalid_output: 'No usable answer',
  model_escalated: 'The assistant asked for a human',
  low_confidence: 'Low confidence',
  empty_reply: 'Empty reply',
  unknown_source: 'Cited something outside your knowledge base',
  claim_without_sources: 'Stated facts without a source',
  verifier_failed: 'Fact check failed',
  acknowledgement_sent: 'Customer got a short acknowledgement (mode 3)',
  unreadable_message: 'Message too large to read',
  budget_halted: 'AI budget used up for today',
  free_tier_refused: 'Not a test mailbox (free AI tier)',
  quote_over_limit: 'Quote total above your automatic-send limit',
  quote_unmapped: 'Some items are not on your price list',
  quote_empty: 'Nothing matched your price list',
  partial_answer_check: 'Also answers a question outside the price list: check that part',
  invoice_over_limit: 'Invoice total above your automatic-send limit',
  order_needs_check: 'Order answer: check before sending',
  order_payment_not_paid: 'The order is not marked as paid',
  order_not_found: 'No order found for that number or e-mail address',
  order_ambiguous: 'Several orders could match',
  order_identity_mismatch:
    'The sender is not the e-mail address on that order (nothing was shared)',
  order_cancelled_or_refunded: 'The order is cancelled or refunded',
  order_partially_fulfilled: 'The order is partly shipped or in an unusual state',
  order_fulfilled_no_tracking: 'The order is shipped but has no tracking',
  order_shipment_stale: 'No shipping update for a long time',
  order_change_request: 'The customer asks for a change, return or refund',
  order_chargeback: 'The customer mentions a chargeback or dispute',
  order_lookup_unavailable: 'The shop could not be asked',
};

/** What the fact check found without a source (packages/core claims). */
const CLAIM: Record<string, string> = {
  money: 'an amount',
  percentage: 'a percentage',
  duration: 'a time span',
  time: 'a time of day',
  date: 'a date',
  weekday: 'a weekday',
  number: 'a number',
};

export function reasonText(code: string): string {
  if (REASONS[code]) return REASONS[code];
  const [prefix, rest] = code.split(':');
  if (prefix === 'hard_list' && rest) return `Needs a person: ${rest.replace(/_/g, ' ')}`;
  if (prefix === 'unsupported_claim' && rest)
    return `The reply mentions ${CLAIM[rest] ?? `a ${rest.replace(/_/g, ' ')}`} that is not in your knowledge base`;
  if (prefix === 'loop_header' || prefix === 'class')
    return `Ignored (${(rest ?? '').replace(/_/g, ' ')})`;
  return code.replace(/[_:]/g, ' ');
}

/** Waiting for the customer after the owner answered from their own mail client. */
export const OWNER_REPLIED_STATUS = { text: 'You replied', tone: 'gray' as const };

export const THREAD_STATUS: Record<
  string,
  { text: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'blue' }
> = {
  open: { text: 'Open', tone: 'gray' },
  awaiting_customer: { text: 'Waiting for customer', tone: 'blue' },
  customer_replied: { text: 'Customer replied', tone: 'amber' },
  owner_replied: { text: 'You replied', tone: 'gray' },
  escalated: { text: 'Needs you', tone: 'red' },
  closed: { text: 'Closed', tone: 'gray' },
};
