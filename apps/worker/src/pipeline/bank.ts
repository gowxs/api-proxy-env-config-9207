import {
  addUsage,
  emailBlock,
  generateJson,
  mayCallModel,
  newNonce,
  originForMailbox,
  untrustedEmailRule,
  ZERO_USAGE,
} from '@noctiv/core';
import { currentBudget, recordUsage, withTenant } from '@noctiv/db';
import {
  buildPaymentPrompt,
  PaymentExtractionSchema,
  readPayment,
  recordPayment,
  senderVerified,
} from '@noctiv/documents';
import type { Loaded, PipelineDeps, ProcessOutcome } from './process.ts';

/**
 * A message from the business's own bank (a sender domain the owner listed):
 * never answered, never a lead. A credit notification is read and matched to
 * open invoices (PLAN.md §22.9). A message that only claims to be from the
 * bank (its provider did not verify DKIM/DMARC for that domain) is ignored.
 */
export async function handleBankEmail(
  deps: PipelineDeps,
  tenantId: string,
  l: Loaded,
  bankDomain: string,
): Promise<ProcessOutcome> {
  const m = l.message;
  const skip = async (reason: string) => {
    await withTenant(
      deps.sql,
      tenantId,
      (tx) => tx`update public.message_processing
                 set status = 'skipped', skip_reason = ${reason}, final_action = 'skip'
                 where message_id = ${m.id}`,
    );
    return { status: 'skipped' as const, reason };
  };
  if (!senderVerified(l.message.loopHeaders['authentication-results'], bankDomain))
    return skip('bank_sender_unverified');
  if (!l.entitled || !l.tenant.documentsEnabled || !m.bodyText) return skip('bank_notification');

  const budget = await withTenant(deps.sql, tenantId, (tx) => currentBudget(tx, tenantId));
  if (!mayCallModel(budget.state)) return skip('budget_halted');
  const origin = originForMailbox({ isTestMailbox: l.isTestMailbox });
  if (deps.llm.trainingPolicy === 'may_train_on_data' && origin === 'customer_data')
    return skip('free_tier_refused');

  const nonce = newNonce();
  const r = await generateJson(
    deps.llm,
    {
      tier: 'fast',
      origin,
      ...buildPaymentPrompt({
        emailBlock: emailBlock(nonce, {
          fromName: m.fromName,
          subject: m.subject,
          bodyText: m.bodyText,
        }),
        emailRule: untrustedEmailRule(nonce),
      }),
      maxOutputTokens: 512,
    },
    PaymentExtractionSchema,
  );
  const usage = addUsage(ZERO_USAGE, r.usage);
  const payment = r.ok ? readPayment(r.value, `${m.subject ?? ''}\n${m.bodyText}`) : null;
  const outcome = await withTenant(deps.sql, tenantId, async (tx) => {
    await recordUsage(tx, { tenantId, usage, llmCalls: r.attempts });
    if (!payment) return null;
    return recordPayment(tx, { tenantId, messageId: m.id, mode: l.tenant.mode, payment });
  });
  return skip(outcome ? `bank_payment:${outcome.outcome}` : 'bank_notification');
}
