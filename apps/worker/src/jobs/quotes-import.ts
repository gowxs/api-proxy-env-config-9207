import {
  generateJson,
  newNonce,
  originForTenantKnowledge,
  TrainingDataPolicyError,
  type LlmProvider,
} from '@noctiv/core';
import { currentBudget, JobError, recordUsage, withTenant, type Job } from '@noctiv/db';
import {
  acceptExtractedItems,
  buildPriceListPrompt,
  PriceListExtractionSchema,
} from '@noctiv/quotes';
import { LlmError } from '@noctiv/llm';
import type { Sql } from 'postgres';

export interface QuotesImportDeps {
  sql: Sql;
  llm: LlmProvider;
}

/**
 * quotes.import(importId) — PLAN.md §21.2: the text of an uploaded price
 * list becomes 'draft' price items. The model lists items; code keeps only
 * those whose price is written in the document. The owner confirms them
 * before they can be quoted. Same data rule as the knowledge base.
 */
export function quotesImportHandler(deps: QuotesImportDeps) {
  return async (job: Job) => {
    const importId = String(job.payload.importId);
    const tenantId = job.tenantId;
    const loaded = await withTenant(deps.sql, tenantId, async (tx) => {
      const [imp] = await tx<{ status: string; extracted_text: string | null }[]>`
        select status, extracted_text from public.price_imports where id = ${importId} for update`;
      if (!imp || imp.status === 'ready' || imp.status === 'failed') return null;
      await tx`update public.price_imports set status = 'parsing' where id = ${importId}`;
      const mailboxes = await tx<{ is_test_mailbox: boolean }[]>`
        select is_test_mailbox from public.email_connections`;
      const budget = await currentBudget(tx, tenantId);
      return {
        text: imp.extracted_text ?? '',
        origin: originForTenantKnowledge(
          mailboxes.map((m) => ({ isTestMailbox: m.is_test_mailbox })),
        ),
        budget: budget.state,
      };
    });
    if (!loaded) return { skipped: true };

    const fail = (error: string) =>
      withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`update public.price_imports set status = 'failed', error = ${error}
                   where id = ${importId}`,
      );
    if (!loaded.text.trim()) {
      await fail('No text was found in the file.');
      return { status: 'failed' };
    }
    if (loaded.budget === 'halted') {
      await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`update public.price_imports set status = 'pending' where id = ${importId}`,
      );
      throw new JobError('budget halted', { retryable: true, retryInSeconds: 3_600 });
    }

    let result;
    try {
      result = await generateJson(
        deps.llm,
        {
          tier: 'quality',
          origin: loaded.origin,
          ...buildPriceListPrompt(loaded.text, newNonce()),
          maxOutputTokens: 8192,
        },
        PriceListExtractionSchema,
      );
    } catch (e) {
      if (e instanceof TrainingDataPolicyError) {
        await fail('Reading price lists is not available on the current AI plan.');
        return { status: 'failed' };
      }
      if (e instanceof LlmError && !e.retryable && e.kind !== 'quota_exhausted') {
        await fail('The file could not be read. Try again, or import a CSV file.');
        return { status: 'failed' };
      }
      await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`update public.price_imports set status = 'pending' where id = ${importId}`,
      );
      throw e;
    }

    return withTenant(deps.sql, tenantId, async (tx) => {
      await recordUsage(tx, { tenantId, usage: result.usage, llmCalls: result.attempts });
      if (!result.ok) {
        await tx`update public.price_imports set status = 'failed',
                   error = 'No price list could be read from the file. Try a CSV import.'
                 where id = ${importId}`;
        return { status: 'failed' };
      }
      const { items, dropped } = acceptExtractedItems(result.value, loaded.text);
      for (const it of items) {
        await tx`insert into public.price_items
                   (tenant_id, name, description, unit, unit_price_cents, min_qty, max_qty, vat_note,
                    status, source, import_id)
                 values (${tenantId}, ${it.name}, ${it.description}, ${it.unit}, ${it.unitPriceCents},
                         ${it.minQty}, ${it.maxQty}, ${it.vatNote}, 'draft', 'file', ${importId})`;
      }
      await tx`update public.price_imports
               set status = ${items.length ? 'ready' : 'failed'}, item_count = ${items.length},
                   error = ${items.length ? null : 'No items with a price were found in the file.'},
                   extracted_text = null
               where id = ${importId}`;
      return { status: 'ready', items: items.length, dropped: dropped.length };
    });
  };
}
