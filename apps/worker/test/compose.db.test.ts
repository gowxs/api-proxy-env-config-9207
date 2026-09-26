import { randomUUID } from 'node:crypto';
import type { GenerateRequest } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createDocument, issueDocument, loadDocument, writeDocumentData } from '@noctiv/documents';
import { FakeProvider } from '@noctiv/llm';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { composeAssistHandler } from '../src/jobs/compose-assist.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

async function tenant(label: string) {
  const t = await seedTenant(owner, `${label}-${randomUUID().slice(0, 6)}`, { embeddingAxis: 220 });
  await owner`update public.tenants
              set documents_enabled = true, seller_legal_name = 'SIA Nordlicht',
                  seller_legal_address = 'Rīga', seller_vat_no = 'LV40003123456',
                  seller_iban = 'LV80BANK0000435195001'
              where id = ${t.tenantId}`;
  return t;
}

async function readyInvoice(t: SeededTenant, qty: number) {
  return withTenant(worker, t.tenantId, async (tx) => {
    const id = await createDocument(tx, { tenantId: t.tenantId, type: 'invoice' });
    const d = (await loadDocument(tx, { id }))!;
    await writeDocumentData(tx, d, {
      ...d.data,
      buyer: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '', email: '' },
      lines: [{ name: 'Lavender candle', unit: 'pcs', qty, unitPriceCents: 2400 }],
    } as never);
    const r = await issueDocument(tx, (await loadDocument(tx, { id }))!, {});
    if (!r.ok) throw new Error(r.problems.join('; '));
    return { id, number: r.number };
  });
}

describe('sending a new e-mail', () => {
  it('goes out from the mailbox as a new conversation, with the attached documents', async () => {
    const t = await tenant('compose');
    const shop = GREENMAIL_USERS.composeShop;
    const customer = GREENMAIL_USERS.composeCustomer;
    const connectionId = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const a = await readyInvoice(t, 2);
    const b = await readyInvoice(t, 3);
    // What POST /compose writes (apps/api/src/routes/compose.ts).
    const leadId = randomUUID();
    const threadId = randomUUID();
    const draftId = randomUUID();
    await owner`insert into public.leads (id, tenant_id, email) values (${leadId}, ${t.tenantId}, ${customer.address})`;
    await owner`insert into public.threads (id, tenant_id, connection_id, lead_id, subject)
                values (${threadId}, ${t.tenantId}, ${connectionId}, ${leadId}, 'Your order')`;
    await owner`insert into public.drafts (id, tenant_id, thread_id, kind, to_address, subject, body, status, decided_by, decided_at)
                values (${draftId}, ${t.tenantId}, ${threadId}, 'compose', ${customer.address}, 'Your order',
                        'Hello, both invoices are attached.', 'approved', 'owner', now())`;
    await owner`update public.documents set draft_id = ${draftId}, thread_id = ${threadId}
                where id in (${a.id}, ${b.id})`;

    const res = await mailSendHandler({ sql: worker, keys, allowInsecure: true })({
      id: randomUUID(),
      tenantId: t.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId, sentVia: 'owner_approval' },
      attempts: 1,
      maxAttempts: 5,
    });
    expect(res).toEqual({ status: 'sent' });

    const mail = (await readFolder(gm, customer)).find((m) => m.raw.includes('both invoices'));
    const parsed = await simpleParser(mail!.raw);
    expect(parsed.subject).toBe('Your order');
    expect(parsed.inReplyTo).toBeUndefined();
    expect(parsed.attachments.map((x) => x.filename).sort()).toEqual(
      [`Invoice-${a.number}.pdf`, `Invoice-${b.number}.pdf`].sort(),
    );
    const docs = await owner<{ status: string }[]>`
      select status from public.documents where id in (${a.id}, ${b.id})`;
    expect(docs.map((d) => d.status)).toEqual(['sent', 'sent']);
    const [th] = await owner<{ status: string; next_followup_at: Date | null }[]>`
      select status, next_followup_at from public.threads where id = ${threadId}`;
    expect(th!.status).toBe('awaiting_customer');
    const [lead] = await owner<
      { stage: string }[]
    >`select stage from public.leads where id = ${leadId}`;
    expect(lead!.stage).toBe('sent');
    const out = await owner`
      select 1 from public.messages where thread_id = ${threadId} and direction = 'outbound'`;
    expect(out).toHaveLength(1);
    expect(th!.next_followup_at).not.toBeNull();
  });

  it('no follow-up when the owner unticked “Follow up if no reply” (D6)', async () => {
    const t = await tenant('compose-nofollow');
    const shop = GREENMAIL_USERS.composeShop;
    const customer = GREENMAIL_USERS.composeCustomer;
    const connectionId = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const threadId = randomUUID();
    const draftId = randomUUID();
    await owner`insert into public.threads (id, tenant_id, connection_id, subject, followup_stop_reason)
                values (${threadId}, ${t.tenantId}, ${connectionId}, 'Quick note', 'owner_off')`;
    await owner`insert into public.drafts (id, tenant_id, thread_id, kind, to_address, subject, body, status, decided_by, decided_at)
                values (${draftId}, ${t.tenantId}, ${threadId}, 'compose', ${customer.address}, 'Quick note',
                        'No follow-up for this one.', 'approved', 'owner', now())`;
    const res = await mailSendHandler({ sql: worker, keys, allowInsecure: true })({
      id: randomUUID(),
      tenantId: t.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId, sentVia: 'owner_approval' },
      attempts: 1,
      maxAttempts: 5,
    });
    expect(res).toEqual({ status: 'sent' });
    const [th] = await owner<
      { status: string; next_followup_at: Date | null; followup_stop_reason: string | null }[]
    >`select status, next_followup_at, followup_stop_reason from public.threads where id = ${threadId}`;
    expect(th).toEqual({
      status: 'awaiting_customer',
      next_followup_at: null,
      followup_stop_reason: 'owner_off',
    });
  });
});

describe('Write with AI', () => {
  const job = (t: SeededTenant, notes: string) => ({
    id: randomUUID(),
    tenantId: t.tenantId,
    queue: QUEUES.composeAssist,
    payload: { notes, subject: 'Consulting', to: 'someone@example.test' },
    attempts: 1,
    maxAttempts: 1,
  });

  it('writes from the notes and the knowledge base; numbers nothing backs are pointed out', async () => {
    const t = await tenant('assist');
    let seen: GenerateRequest | undefined;
    const llm = new FakeProvider({
      responder: (req) => {
        seen = req;
        return JSON.stringify({
          subject: 'Consulting',
          body: 'Hello, consulting costs 100 EUR. We can start within 3 days.',
          sources: ['S1'],
        });
      },
    });
    const run = composeAssistHandler({ sql: worker, llm, embeddings: new FakeProvider() });
    const r = await run(job(t, 'Tell them what consulting costs'));
    expect(r).toMatchObject({
      ok: true,
      subject: 'Consulting',
      body: 'Hello, consulting costs 100 EUR. We can start within 3 days.',
      unsupportedNumbers: ['3'],
    });
    if (!r.ok) throw new Error('not ok');
    expect(r.sources[0]).toContain('consulting costs 100 EUR');
    expect(seen!.parts.map((p) => p.kind)).toEqual(['kb_context', 'instruction']);
    const [u] = await owner<{ llm_calls: number }[]>`
      select llm_calls from public.usage_daily where tenant_id = ${t.tenantId}`;
    expect(u!.llm_calls).toBeGreaterThan(0);
  });

  it('the free AI tier is refused for real mailboxes', async () => {
    const t = await tenant('assist-free');
    const llm = new FakeProvider({ trainingPolicy: 'may_train_on_data' });
    const run = composeAssistHandler({ sql: worker, llm, embeddings: new FakeProvider() });
    expect(await run(job(t, 'Tell them what consulting costs'))).toEqual({
      ok: false,
      error: 'free_tier_refused',
    });
    expect(llm.calls).toHaveLength(0);
  });
});
