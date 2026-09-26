import {
  emailBlock,
  generateJson,
  newNonce,
  originForMailbox,
  stripQuotedText,
  TrainingDataPolicyError,
  untrustedEmailRule,
  type LlmProvider,
} from '@noctiv/core';
import { currentBudget, JobError, recordUsage, withTenant, type Job } from '@noctiv/db';
import {
  applyCmrPrefill,
  buildCmrPrefillPrompt,
  CmrPrefillSchema,
  loadDocument,
  writeDocumentData,
  type CmrData,
} from '@noctiv/documents';
import { LlmError } from '@noctiv/llm';
import type { Sql } from 'postgres';

export interface DocumentsPrefillDeps {
  sql: Sql;
  llm: LlmProvider;
}

/**
 * documents.prefill(documentId) — PLAN.md §22.5: a CMR draft filled from the
 * customer's e-mail. Only fields whose source text is in the e-mail are kept
 * (numbers and dates parsed from that text); the owner confirms every one
 * before the PDF can be created. Same data rule as replies: the free AI tier
 * only reads test mailboxes.
 */
export function documentsPrefillHandler(deps: DocumentsPrefillDeps) {
  return async (job: Job) => {
    const tenantId = job.tenantId;
    const documentId = String(job.payload.documentId);
    const loaded = await withTenant(deps.sql, tenantId, async (tx) => {
      const doc = await loadDocument(tx, { id: documentId });
      if (!doc || doc.type !== 'cmr' || doc.prefillStatus !== 'pending' || !doc.sourceMessageId)
        return null;
      const [m] = await tx<
        {
          from_name: string | null;
          subject: string | null;
          body_text: string | null;
          is_test_mailbox: boolean;
        }[]
      >`select m.from_name, m.subject, m.body_text, c.is_test_mailbox
        from public.messages m join public.email_connections c on c.id = m.connection_id
        where m.id = ${doc.sourceMessageId}`;
      const budget = await currentBudget(tx, tenantId);
      return { doc, m, budget: budget.state };
    });
    if (!loaded) return { skipped: true };
    const { m } = loaded;
    const fail = (why: string) =>
      withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`update public.documents set prefill_status = 'failed'
                   where id = ${documentId} and prefill_status = 'pending'`,
      ).then(() => ({ status: 'failed', why }));
    if (!m?.body_text) return fail('message_unreadable');
    if (loaded.budget === 'halted') return fail('budget_halted');

    const body = stripQuotedText(m.body_text);
    const nonce = newNonce();
    let r;
    try {
      r = await generateJson(
        deps.llm,
        {
          tier: 'quality',
          origin: originForMailbox({ isTestMailbox: m.is_test_mailbox }),
          ...buildCmrPrefillPrompt({
            emailBlock: emailBlock(nonce, {
              fromName: m.from_name,
              subject: m.subject,
              bodyText: body,
            }),
            emailRule: untrustedEmailRule(nonce),
          }),
          maxOutputTokens: 2048,
        },
        CmrPrefillSchema,
      );
    } catch (e) {
      if (e instanceof TrainingDataPolicyError) return fail('free_tier_refused');
      if (
        e instanceof LlmError &&
        (e.retryable || e.kind === 'quota_exhausted') &&
        job.attempts < job.maxAttempts
      )
        throw new JobError(`model call failed: ${e.kind}`, { retryable: true });
      return fail('model_error');
    }

    return withTenant(deps.sql, tenantId, async (tx) => {
      await recordUsage(tx, { tenantId, usage: r.usage, llmCalls: r.attempts });
      if (!r.ok) {
        await tx`update public.documents set prefill_status = 'failed' where id = ${documentId}`;
        return { status: 'failed', why: 'invalid_output' };
      }
      const current = await loadDocument(tx, { id: documentId });
      if (!current || current.prefillStatus !== 'pending') return { skipped: true };
      const res = applyCmrPrefill(r.value, `${m.subject ?? ''}\n${body}`, current.data as CmrData);
      await writeDocumentData(tx, current, res.data);
      await tx`update public.documents
               set prefill = ${Object.keys(res.prefill).length ? tx.json(res.prefill) : null},
                   prefill_status = 'done'
               where id = ${documentId}`;
      return {
        status: 'done',
        filled: Object.keys(res.prefill).length,
        dropped: res.dropped.length,
      };
    });
  };
}
