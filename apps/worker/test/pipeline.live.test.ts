/**
 * Hand-picked emails through the whole pipeline with the REAL model
 * (founder decision: a few only, within the free tier's 20 requests/day).
 *   LIVE_PIPELINE=1 pnpm test:live apps/worker
 * The tenant's mailbox is flagged is_test_mailbox, as the free tier requires.
 * Results are printed for review; safety invariants are asserted.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { withTenant } from '@noctiv/db';
import { seedTenant } from '@noctiv/db/testing';
import { createNoteSource, createSafeFetcher, ingestSource } from '@noctiv/kb';
import { createProviders, resolveLlmConfig } from '@noctiv/llm';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { KB_CHUNKS } from '../../../packages/core/test/fixtures/kb.ts';
import { storeInbound } from '../src/ingest/store.ts';
import { processMessage } from '../src/pipeline/process.ts';

const enabled = process.env.LIVE_PIPELINE === '1' && Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!enabled)('live pipeline (real model, test mailbox)', () => {
  const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
  const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
  const providers = enabled ? createProviders(resolveLlmConfig(), { maxRetries: 1 }) : undefined;
  afterAll(() => Promise.all([owner.end(), worker.end()]));

  async function tenant(mode: 'draft_only' | 'auto_send') {
    const t = await seedTenant(owner, `live-${mode}`, { embeddingAxis: 60 });
    await owner`update public.tenants set mode = ${mode}, name = 'Nordlicht Candles' where id = ${t.tenantId}`;
    await owner`update public.email_connections set is_test_mailbox = true where tenant_id = ${t.tenantId}`;
    for (const c of KB_CHUNKS) {
      const id = await withTenant(worker, t.tenantId, (tx) =>
        createNoteSource(tx, { tenantId: t.tenantId, title: 'kb', text: c.content }),
      );
      const r = await ingestSource(
        { sql: worker, embeddings: providers!.embeddings, fetcher: createSafeFetcher() },
        t.tenantId,
        id,
      );
      expect(r.status).toBe('ready');
    }
    return t;
  }

  async function runEmail(
    t: Awaited<ReturnType<typeof tenant>>,
    from: string,
    subject: string,
    text: string,
  ) {
    const id = await withTenant(worker, t.tenantId, (tx) =>
      storeInbound(tx, {
        tenantId: t.tenantId,
        connectionId: t.connectionId,
        uid: 1,
        msg: {
          messageId: `<${randomUUID()}@example-mail.test>`,
          inReplyTo: null,
          references: [],
          from: { address: from, name: null },
          replyTo: [],
          to: [],
          cc: [],
          subject,
          text,
          htmlHiddenText: false,
          loopHeaders: {},
          attachments: [],
          date: new Date(),
        },
      }),
    );
    const outcome = await processMessage(
      { sql: worker, llm: providers!.llm, embeddings: providers!.embeddings },
      t.tenantId,
      id!,
    );
    const [mp] = await owner<
      {
        classification: Record<string, unknown>;
        model_output: Record<string, unknown> | null;
        downgrade_reasons: string[];
      }[]
    >`
      select classification, model_output, downgrade_reasons from public.message_processing where message_id = ${id}`;
    const drafts = await owner<{ status: string; to_address: string; body: string | null }[]>`
      select status, to_address, body from public.drafts where source_message_id = ${id}`;
    const record = {
      subject,
      outcome,
      reasons: mp?.downgrade_reasons,
      classification: mp?.classification,
      model: mp?.model_output,
      drafts,
    };
    if (process.env.LIVE_REPORT_FILE)
      appendFileSync(process.env.LIVE_REPORT_FILE, `${JSON.stringify(record)}\n`);
    for (const d of drafts) expect(d.to_address).toBe(from);
    return outcome;
  }

  it('EN price question, auto-send tenant', async () => {
    const t = await tenant('auto_send');
    const o = await runEmail(
      t,
      'janis@example-mail.test',
      'Candle price',
      'Hello, how much is one candle and how long does delivery within Latvia take?',
    );
    expect(['auto_send', 'drafted', 'escalated']).toContain(o.status);
  });

  it('LV question, draft-only tenant', async () => {
    const t = await tenant('draft_only');
    const o = await runEmail(
      t,
      'liga@example-mail.test',
      'Dāvanu komplekts',
      'Labdien! Cik maksā dāvanu komplekts ar trim svecēm?',
    );
    expect(o.status).not.toBe('auto_send');
  });

  it('DE complaint is escalated without a draft', async () => {
    const t = await tenant('auto_send');
    const o = await runEmail(
      t,
      'jonas@example-mail.test',
      'Kerze kaputt',
      'Meine Kerze kam zerbrochen an. Das ist wirklich ärgerlich, ich will mein Geld zurück!',
    );
    expect(o.status).toBe('escalated');
  });
});
