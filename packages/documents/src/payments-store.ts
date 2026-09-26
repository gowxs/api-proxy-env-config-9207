import type { TransactionSql } from 'postgres';
import { matchPayment, type OpenDocument, type ReadPayment } from './payments.ts';

/** Database side of incoming payments (inside the tenant's RLS context). */

export interface PaymentRow {
  id: string;
  message_id: string | null;
  amount_cents: number;
  currency: string | null;
  payer_name: string | null;
  reference: string | null;
  status: 'unmatched' | 'proposed' | 'matched' | 'dismissed';
  match_kind: 'exact' | 'amount' | 'payer' | 'manual' | null;
  document_id: string | null;
  document_number: string | null;
  matched_by: 'auto' | 'owner' | null;
  matched_at: Date | null;
  sources: Record<string, string>;
  received_at: Date | null;
  created_at: Date;
}

export function listPayments(
  tx: TransactionSql,
  f: { documentId?: string; id?: string } = {},
): Promise<PaymentRow[]> {
  return tx<PaymentRow[]>`
    select p.id, p.message_id, p.amount_cents, p.currency, p.payer_name, p.reference, p.status,
           p.match_kind, p.document_id, d.number as document_number, p.matched_by, p.matched_at,
           p.sources, m.received_at, p.created_at
    from public.payments p
    left join public.documents d on d.id = p.document_id
    left join public.messages m on m.id = p.message_id
    where ${f.documentId ? tx`p.document_id = ${f.documentId}` : tx`true`}
      and ${f.id ? tx`p.id = ${f.id}` : tx`true`}
    order by p.created_at desc limit 300`;
}

/** Documents that can still be paid: payable, issued or sent, numbered. */
export async function openDocuments(tx: TransactionSql): Promise<OpenDocument[]> {
  const rows = await tx<
    {
      id: string;
      number: string;
      total_cents: number;
      currency: string;
      counterparty_name: string | null;
      payment_reference: string | null;
    }[]
  >`select id, number, total_cents, currency, counterparty_name,
           nullif(data->>'paymentReference', '') as payment_reference
    from public.documents
    where payable and status in ('issued', 'sent') and number is not null`;
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    totalCents: r.total_cents,
    currency: r.currency,
    counterpartyName: r.counterparty_name,
    paymentReference: r.payment_reference,
  }));
}

/** Marks a document paid; a payment reminder that has not gone out yet is dropped. */
export async function markDocumentPaid(tx: TransactionSql, documentId: string): Promise<boolean> {
  const [d] = await tx<{ reminder_draft_id: string | null }[]>`
    update public.documents set status = 'paid', paid_at = now()
    where id = ${documentId} and payable and status in ('issued', 'sent')
    returning reminder_draft_id`;
  if (!d) return false;
  if (d.reminder_draft_id)
    await tx`update public.drafts set status = 'superseded'
             where id = ${d.reminder_draft_id} and status in ('pending_approval', 'approved')
               and not exists (select 1 from public.outbound_emails o
                               where o.draft_id = ${d.reminder_draft_id} and o.status in ('sending', 'sent'))`;
  return true;
}

async function notify(
  tx: TransactionSql,
  tenantId: string,
  kind: 'payment_matched' | 'payment_proposed',
  paymentId: string,
  payload: Record<string, unknown>,
) {
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'email_owner', ${kind}, ${`${kind}:${paymentId}`}, ${tx.json({ paymentId, ...payload } as never)})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

export type RecordOutcome = 'matched' | 'proposed' | 'unmatched' | 'duplicate';

/**
 * Stores a payment read from a bank e-mail and matches it: an exact match
 * marks the invoice paid in modes 2 and 3 (the owner is told); every other
 * match is a proposal the owner confirms with one click; no match waits in
 * the Payments list.
 */
export async function recordPayment(
  tx: TransactionSql,
  o: { tenantId: string; messageId: string; mode: string; payment: ReadPayment },
): Promise<{ outcome: RecordOutcome; paymentId: string | null }> {
  const p = o.payment;
  const match = matchPayment(p, await openDocuments(tx));
  const auto = match.kind === 'exact' && o.mode !== 'draft_only';
  const status = match.kind === null ? 'unmatched' : auto ? 'matched' : 'proposed';
  const [row] = await tx<{ id: string }[]>`
    insert into public.payments (tenant_id, message_id, amount_cents, currency, payer_name, reference,
                                 status, match_kind, document_id, matched_by, matched_at, sources)
    values (${o.tenantId}, ${o.messageId}, ${p.amountCents}, ${p.currency}, ${p.payerName}, ${p.reference},
            ${status}, ${match.kind}, ${match.documentId}, ${auto ? 'auto' : null}, ${auto ? new Date() : null},
            ${tx.json(p.sources)})
    on conflict (message_id) do nothing
    returning id`;
  if (!row) return { outcome: 'duplicate', paymentId: null };
  if (!match.documentId) return { outcome: 'unmatched', paymentId: row.id };
  const [doc] = await tx<{ number: string }[]>`
    select number from public.documents where id = ${match.documentId}`;
  const payload = {
    documentId: match.documentId,
    number: doc?.number ?? '',
    amountCents: p.amountCents,
    currency: p.currency,
    matchKind: match.kind,
  };
  if (auto) {
    await markDocumentPaid(tx, match.documentId);
    await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
             values (${o.tenantId}, 'system', 'document.paid', 'document', ${match.documentId},
                     ${tx.json({ via: 'bank_notification', paymentId: row.id })})`;
    await notify(tx, o.tenantId, 'payment_matched', row.id, payload);
    return { outcome: 'matched', paymentId: row.id };
  }
  await notify(tx, o.tenantId, 'payment_proposed', row.id, payload);
  return { outcome: 'proposed', paymentId: row.id };
}

/** The owner links a payment to a document (a proposal, or any open one) and it is marked paid. */
export async function linkPayment(
  tx: TransactionSql,
  paymentId: string,
  documentId: string | null,
): Promise<'ok' | 'not_found' | 'not_open' | 'already_matched'> {
  const [p] = await tx<{ status: string; document_id: string | null }[]>`
    select status, document_id from public.payments where id = ${paymentId} for update`;
  if (!p) return 'not_found';
  if (p.status === 'matched') return 'already_matched';
  const target = documentId ?? p.document_id;
  if (!target) return 'not_open';
  if (!(await markDocumentPaid(tx, target))) return 'not_open';
  await tx`update public.payments
           set status = 'matched', document_id = ${target}, matched_by = 'owner', matched_at = now(),
               match_kind = ${target === p.document_id ? tx`match_kind` : 'manual'}
           where id = ${paymentId}`;
  return 'ok';
}
