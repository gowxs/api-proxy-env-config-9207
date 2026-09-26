import { buildReplySubject, ownerNotificationPayload, resolveReplyRecipient } from '@noctiv/core';
import { enqueue, withTenant, type Job } from '@noctiv/db';
import {
  acceptedInvoiceCover,
  createDocument,
  issueDocument,
  loadDocument,
  paidDeliveryNoteCover,
  writeDocumentData,
  type DocumentRecord,
  type InvoiceData,
} from '@noctiv/documents';
import type { Sql, TransactionSql } from 'postgres';
import { QUEUES } from '../queues.ts';

export interface DocumentsAutomationDeps {
  sql: Sql;
}

type Payload =
  { event: 'quote_accepted'; quoteId: string } | { event: 'invoice_paid'; documentId: string };

export type AutomationResult =
  | { skipped: string }
  | { held: string; documentId: string; problems: string[] }
  | { documentId: string; number: string; draftId: string; autoSend: boolean; reasons: string[] };

/**
 * documents.automation — PLAN.md §22.11–§22.12. Two events, each at most
 * once per source (a unique index backs this up):
 *  - quote_accepted: an invoice from the accepted quote, numbered, and a
 *    reply "Thank you — invoice attached, due <date>" with the PDF;
 *  - invoice_paid: a delivery note from the paid invoice and its reply
 *    (only when the tenant switched this on).
 * Mode rules as for any reply: mode 1 waits for approval; modes 2 and 3
 * send — an invoice only if its total is within the quote auto-send limit.
 * A document that cannot be issued (for example the buyer's address is not
 * known yet) stays a draft and the owner is asked to finish it.
 */
export function documentsAutomationHandler(deps: DocumentsAutomationDeps) {
  return async (job: Job): Promise<AutomationResult> =>
    withTenant(deps.sql, job.tenantId, (tx) =>
      runAutomation(tx, job.tenantId, job.payload as unknown as Payload),
    );
}

export async function runAutomation(
  tx: TransactionSql,
  tenantId: string,
  p: Payload,
): Promise<AutomationResult> {
  const [t] = await tx<
    {
      mode: string;
      notify_full_text: boolean;
      documents_enabled: boolean;
      auto_invoice_on_accept: boolean;
      auto_delivery_note_after_payment: boolean;
      limit_cents: number;
    }[]
  >`select mode, notify_full_text, documents_enabled, auto_invoice_on_accept,
           auto_delivery_note_after_payment, quotes_auto_send_limit_cents as limit_cents
    from public.tenants where id = ${tenantId}`;
  if (!t?.documents_enabled) return { skipped: 'documents_off' };

  let documentId: string;
  let cover: (d: DocumentRecord, customerName: string | null) => string;
  if (p.event === 'quote_accepted') {
    if (!t.auto_invoice_on_accept) return { skipped: 'automation_off' };
    const [q] = await tx<{ number: string; status: string }[]>`
      select number, status from public.quotes where id = ${p.quoteId} for update`;
    if (!q || q.status !== 'accepted') return { skipped: 'quote_not_accepted' };
    // The owner may already have made the invoice by hand.
    const [existing] = await tx<{ id: string }[]>`
      select id from public.documents
      where quote_id = ${p.quoteId} and type = 'invoice' and status <> 'cancelled' limit 1`;
    if (existing) return { skipped: 'invoice_exists' };
    documentId = await createDocument(tx, { tenantId, type: 'invoice', fromQuoteId: p.quoteId });
    await tx`update public.documents set auto_source = 'quote_accepted' where id = ${documentId}`;
    await buyerFromEarlierInvoice(tx, documentId);
    cover = (d, name) => acceptedInvoiceCover(d, name, q.number);
  } else {
    if (!t.auto_delivery_note_after_payment) return { skipped: 'automation_off' };
    const inv = await loadDocument(tx, { id: p.documentId });
    if (!inv || inv.type !== 'invoice' || inv.status !== 'paid')
      return { skipped: 'invoice_not_paid' };
    const [existing] = await tx<{ id: string }[]>`
      select id from public.documents
      where source_document_id = ${inv.id} and type = 'delivery_note' and status <> 'cancelled'
      limit 1`;
    if (existing) return { skipped: 'delivery_note_exists' };
    documentId = await createDocument(tx, {
      tenantId,
      type: 'delivery_note',
      fromDocumentId: inv.id,
    });
    await tx`update public.documents set auto_source = 'invoice_paid' where id = ${documentId}`;
    cover = (d, name) => paidDeliveryNoteCover(d, name, inv.number ?? '');
  }

  const draft = (await loadDocument(tx, { id: documentId }))!;
  const [m] = draft.threadId
    ? await tx<
        {
          id: string;
          from_address: string;
          from_name: string | null;
          reply_to: string | null;
          subject: string | null;
        }[]
      >`select id, from_address, from_name, reply_to, subject from public.messages
        where thread_id = ${draft.threadId} and direction = 'inbound'
        order by received_at desc limit 1`
    : [];
  const issued = await issueDocument(tx, draft, {});
  const problems = issued.ok ? [] : issued.problems;
  if (!m) problems.push('There is no customer e-mail in the conversation to reply to.');
  if (problems.length) {
    await tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${tenantId}, 'email_owner', 'document_needs_you', ${`document_needs_you:${documentId}`},
              ${tx.json({ documentId, type: draft.type, number: issued.ok ? issued.number : null, event: p.event, problems })})
      on conflict (tenant_id, dedupe_key) do nothing`;
    await audit(tx, tenantId, documentId, { event: p.event, held: true, problems });
    return { held: 'needs_owner', documentId, problems };
  }

  const d = (await loadDocument(tx, { id: documentId }))!;
  const to = resolveReplyRecipient({
    from: m!.from_address,
    replyTo: m!.reply_to ? [m!.reply_to] : [],
  }).to;
  const body = cover(d, m!.from_name);
  const reasons: string[] = [];
  if (t.mode === 'draft_only') reasons.push('tenant_draft_only');
  if (d.type === 'invoice' && d.totalCents > t.limit_cents) reasons.push('invoice_over_limit');
  const autoSend = reasons.length === 0;
  const [row] = await tx<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                               status, decided_by, decided_at)
    values (${tenantId}, ${d.threadId}, ${m!.id}, 'document', ${to}, ${buildReplySubject(m!.subject)},
            ${body}, ${autoSend ? 'approved' : 'pending_approval'}, ${autoSend ? 'auto' : null},
            ${autoSend ? new Date() : null})
    returning id`;
  const draftId = row!.id;
  await tx`update public.documents set draft_id = ${draftId} where id = ${documentId}`;
  if (autoSend) {
    await enqueue(tx, {
      tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId, sentVia: 'auto' },
      singletonKey: draftId,
    });
  } else {
    const payload = {
      ...ownerNotificationPayload({
        fullText: t.notify_full_text,
        kind: 'draft_ready',
        senderAddress: m!.from_address,
        senderName: m!.from_name,
        subject: m!.subject,
        summary:
          p.event === 'quote_accepted'
            ? `Invoice ${d.number} for the accepted quote, ready to send.`
            : `Delivery note ${d.number} after payment, ready to send.`,
        action: 'draft',
        reasons,
        draftText: body,
        unverifiedSuggestion: false,
      }),
      draftId,
      documentId,
    };
    await tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${tenantId}, 'email_owner', 'draft_ready', ${`draft:${draftId}`}, ${tx.json(payload as never)})
      on conflict (tenant_id, dedupe_key) do nothing`;
  }
  await audit(tx, tenantId, documentId, { event: p.event, draftId, autoSend, reasons });
  return { documentId, number: d.number!, draftId, autoSend, reasons };
}

/**
 * The quote knows the customer's name and e-mail, not their billing details.
 * If the owner already invoiced this e-mail address, the buyer details they
 * confirmed then are used again (nothing is invented; otherwise the owner
 * fills them in).
 */
async function buyerFromEarlierInvoice(tx: TransactionSql, documentId: string) {
  const d = (await loadDocument(tx, { id: documentId }))!;
  const inv = d.data as InvoiceData;
  if (!inv.buyer.email) return;
  const [prev] = await tx<{ buyer: InvoiceData['buyer'] }[]>`
    select data->'buyer' as buyer from public.documents
    where type = 'invoice' and id <> ${documentId} and number is not null and status <> 'cancelled'
      and lower(data->'buyer'->>'email') = lower(${inv.buyer.email})
      and coalesce(data->'buyer'->>'address', '') <> ''
    order by issued_at desc nulls last limit 1`;
  if (!prev) return;
  await writeDocumentData(tx, d, { ...inv, buyer: { ...prev.buyer, email: inv.buyer.email } });
}

async function audit(
  tx: TransactionSql,
  tenantId: string,
  documentId: string,
  metadata: Record<string, unknown>,
) {
  await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
           values (${tenantId}, 'system', 'document.auto_created', 'document', ${documentId},
                   ${tx.json(metadata as never)})`;
}
