import { buildReplySubject, logoAllowed, resolveReplyRecipient } from '@noctiv/core';
import { enqueue, withTenant } from '@noctiv/db';
import {
  createDocument,
  DOC_TYPES,
  documentCover,
  documentFileName,
  documentJson,
  DocumentSourceError,
  ibanValid,
  issueDocument,
  linkPayment,
  listDocuments,
  listPayments,
  markDocumentPaid,
  normalizeBankDomain,
  loadDocument,
  parseData,
  PREFIX_COLUMN,
  PREFIX_PATTERN,
  prefixLocks,
  renderDocumentPdf,
  vatNoValid,
  writeDocumentData,
  type DocumentRecord,
} from '@noctiv/documents';
import { createSafeFetcher, loadAllowlist, type SafeFetch } from '@noctiv/kb';
import { fetchQuoteLogo } from '@noctiv/quotes';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';

/** Queue names shared with the worker (apps/worker/src/queues.ts). */
const MAIL_SEND_QUEUE = 'mail.send';
const DOCUMENTS_PREFILL_QUEUE = 'documents.prefill';

const tenantParams = z.object({ tenantId: z.uuid() });
const idParams = z.object({ tenantId: z.uuid(), id: z.uuid() });

const blank = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), t.nullable());

const prefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PREFIX_PATTERN, 'Number prefix: 1–10 letters or digits, e.g. INV');

/** Seller details and the module switch (merged into PATCH /v1/tenants/:id). */
export const documentSettingsShape = {
  documentsEnabled: z.boolean(),
  sellerLegalName: blank(z.string().trim().max(200)),
  sellerLegalAddress: blank(z.string().trim().max(500)),
  sellerRegNo: blank(z.string().trim().max(40)),
  sellerVatNo: blank(
    z
      .string()
      .trim()
      .max(30)
      .refine(vatNoValid, 'VAT number: use the country prefix, e.g. GB123456789 or DE123456789'),
  ),
  sellerBankName: blank(z.string().trim().max(100)),
  sellerIban: blank(z.string().trim().max(42).refine(ibanValid, 'That IBAN is not valid')),
  sellerBic: blank(
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, 'BIC: 8 or 11 letters and digits'),
  ),
  sellerSortCode: blank(
    z
      .string()
      .transform((s) => s.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, 'Sort code: 6 digits, e.g. 20-00-00')),
  ),
  sellerAccountNumber: blank(
    z
      .string()
      .transform((s) => s.replace(/\s/g, ''))
      .pipe(z.string().regex(/^\d{8}$/, 'Account number: 8 digits')),
  ),
  sellerCountry: blank(z.string().trim().max(60)),
  invoiceDueDays: z.number().int().min(0).max(365),
  docPrefixInvoice: prefix,
  docPrefixDeliveryNote: prefix,
  docPrefixCmr: prefix,
  /** Automation (PLAN.md §22.11–§22.12). */
  autoInvoiceOnAccept: z.boolean(),
  autoDeliveryNoteAfterPayment: z.boolean(),
};
type DocumentSettings = Partial<{
  [K in keyof typeof documentSettingsShape]: z.output<(typeof documentSettingsShape)[K]>;
}>;

export function documentSettingsColumns(b: DocumentSettings): Record<string, unknown> {
  const map: [keyof DocumentSettings, string][] = [
    ['documentsEnabled', 'documents_enabled'],
    ['sellerLegalName', 'seller_legal_name'],
    ['sellerLegalAddress', 'seller_legal_address'],
    ['sellerRegNo', 'seller_reg_no'],
    ['sellerVatNo', 'seller_vat_no'],
    ['sellerBankName', 'seller_bank_name'],
    ['sellerIban', 'seller_iban'],
    ['sellerBic', 'seller_bic'],
    ['sellerSortCode', 'seller_sort_code'],
    ['sellerAccountNumber', 'seller_account_number'],
    ['sellerCountry', 'seller_country'],
    ['invoiceDueDays', 'invoice_due_days'],
    ['docPrefixInvoice', 'doc_prefix_invoice'],
    ['docPrefixDeliveryNote', 'doc_prefix_delivery_note'],
    ['docPrefixCmr', 'doc_prefix_cmr'],
    ['autoInvoiceOnAccept', 'auto_invoice_on_accept'],
    ['autoDeliveryNoteAfterPayment', 'auto_delivery_note_after_payment'],
  ];
  const cols: Record<string, unknown> = {};
  for (const [k, col] of map) {
    const v = b[k];
    if (v === undefined) continue;
    cols[col] =
      typeof v === 'string' && (k === 'sellerIban' || k === 'sellerVatNo')
        ? v.replace(/\s+/g, '').toUpperCase()
        : v;
  }
  return cols;
}

const TYPE_NAME = { invoice: 'invoice', delivery_note: 'delivery note', cmr: 'CMR' } as const;

/**
 * A prefix may change only while no document of that type was issued this
 * year (no gaps, no mixed series), and the three prefixes stay distinct.
 */
export async function checkPrefixChanges(tx: TransactionSql, cols: Record<string, unknown>) {
  const types = (Object.keys(PREFIX_COLUMN) as (keyof typeof PREFIX_COLUMN)[]).filter(
    (t) => cols[PREFIX_COLUMN[t]] !== undefined,
  );
  if (!types.length) return;
  const [cur] = await tx<Record<string, string>[]>`
    select doc_prefix_invoice, doc_prefix_delivery_note, doc_prefix_cmr from public.tenants`;
  const locks = await prefixLocks(tx);
  for (const t of types) {
    if (cols[PREFIX_COLUMN[t]] !== cur![PREFIX_COLUMN[t]] && locks[t])
      throw new HttpError(
        409,
        `The ${TYPE_NAME[t]} prefix is fixed for this year: a ${TYPE_NAME[t]} was already issued with it.`,
      );
  }
  const next = Object.values(PREFIX_COLUMN).map((c) => (cols[c] as string | undefined) ?? cur![c]);
  if (new Set(next).size !== next.length)
    throw new HttpError(400, 'Each document type needs its own prefix.');
}

/** A document can still change while nothing has gone out with it. */
async function lockEditable(tx: TransactionSql, d: DocumentRecord) {
  if (d.status !== 'draft' && d.status !== 'issued')
    throw new HttpError(409, 'This document was sent and can no longer be changed.');
  if (d.draftId) {
    const [dr] = await tx<{ status: string }[]>`
      select status from public.drafts where id = ${d.draftId}`;
    if (dr && (dr.status === 'approved' || dr.status === 'sent'))
      throw new HttpError(409, 'This document is being sent and can no longer be changed.');
  }
}

/** Paths whose value changed between two versions (pre-filled highlights on them are dropped). */
function changedPaths(a: unknown, b: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys)
      for (const p of changedPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        prefix ? `${prefix}.${k}` : k,
      ))
        out.add(p);
  } else if (a !== b) out.add(prefix);
  return out;
}

/**
 * Documents (beta), PLAN.md §22: invoices, delivery notes and CMR notes.
 * Every route checks membership, then works inside the tenant's RLS context.
 */
export function documentRoutes(
  app: FastifyInstance,
  deps: AppDeps & { fetchLogo?: SafeFetch },
): void {
  const fetchLogo =
    deps.fetchLogo ?? createSafeFetcher({ maxBytes: 1024 * 1024, timeoutMs: 8_000 });
  const tenantTx = async <T>(
    req: { params: unknown; user?: { userId: string } },
    fn: (tx: TransactionSql, tenantId: string) => Promise<T>,
  ): Promise<T> => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, (tx) => fn(tx, tenantId));
  };
  const audit = (
    tx: TransactionSql,
    tenantId: string,
    userId: string,
    action: string,
    id: string,
    metadata: Record<string, unknown> = {},
  ) => tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
          values (${tenantId}, 'owner', ${userId}, ${action}, 'document', ${id}, ${tx.json(metadata as never)})`;
  const load = async (tx: TransactionSql, id: string) => {
    const d = await loadDocument(tx, { id });
    if (!d) throw new HttpError(404, 'not found');
    return d;
  };

  app.get('/v1/tenants/:tenantId/documents', (req) =>
    tenantTx(req, async (tx) => {
      const q = z.object({ type: z.enum(DOC_TYPES).optional() }).parse(req.query);
      return (await listDocuments(tx, q)).map(documentJson);
    }),
  );

  app.get('/v1/tenants/:tenantId/documents/:id', (req) =>
    tenantTx(req, async (tx) => {
      const d = await load(tx, idParams.parse(req.params).id);
      return {
        ...documentJson(d),
        payments: (await listPayments(tx, { documentId: d.id })).filter(
          (p) => p.status !== 'dismissed',
        ),
      };
    }),
  );

  app.post('/v1/tenants/:tenantId/documents', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = z
        .object({
          type: z.enum(DOC_TYPES),
          threadId: z.uuid().optional(),
          fromQuoteId: z.uuid().optional(),
          fromDocumentId: z.uuid().optional(),
          fromMessageId: z.uuid().optional(),
        })
        .strict()
        .parse(req.body);
      const [t] = await tx<{ documents_enabled: boolean }[]>`
        select documents_enabled from public.tenants`;
      if (!t?.documents_enabled)
        throw new HttpError(409, 'Documents are switched off (Documents → Setup).');
      let id: string;
      try {
        id = await createDocument(tx, { tenantId, ...b });
      } catch (e) {
        if (e instanceof DocumentSourceError) throw new HttpError(400, e.message);
        throw e;
      }
      if (b.fromMessageId) {
        await enqueue(tx, {
          tenantId,
          queue: DOCUMENTS_PREFILL_QUEUE,
          payload: { documentId: id },
          singletonKey: id,
        });
      }
      await audit(tx, tenantId, req.user!.userId, 'document.created', id, {
        type: b.type,
        from: b.fromQuoteId
          ? 'quote'
          : b.fromDocumentId
            ? 'document'
            : b.fromMessageId
              ? 'email'
              : 'manual',
      });
      return { id };
    }),
  );

  app.patch('/v1/tenants/:tenantId/documents/:id', { bodyLimit: 256 * 1024 }, (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = z
        .object({
          data: z.unknown().optional(),
          language: z.enum(['en', 'de', 'lv', 'nl', 'fr', 'es']).optional(),
        })
        .strict()
        .parse(req.body);
      const d = await load(tx, id);
      await lockEditable(tx, d);
      if (d.prefillStatus === 'pending')
        throw new HttpError(409, 'The e-mail is still being read; try again in a moment.');
      const data = b.data === undefined ? d.data : parseData(d.type, b.data);
      await writeDocumentData(tx, d, data, b.language);
      // A highlight means "copied from the e-mail"; a field the owner changed no longer is.
      if (d.prefill && b.data !== undefined) {
        const changed = changedPaths(d.data, data);
        const kept = Object.fromEntries(Object.entries(d.prefill).filter(([p]) => !changed.has(p)));
        await tx`update public.documents set prefill = ${Object.keys(kept).length ? tx.json(kept) : null}
                 where id = ${id}`;
      }
      // The reply waiting for approval states the number, total and due date: keep it in step.
      const after = (await loadDocument(tx, { id }))!;
      if (after.draftId && after.status === 'issued') {
        const [m] = await tx<{ from_name: string | null }[]>`
          select m.from_name from public.drafts dr join public.messages m on m.id = dr.source_message_id
          where dr.id = ${after.draftId}`;
        await tx`update public.drafts set body = ${documentCover(after, m?.from_name ?? null)}
                 where id = ${after.draftId} and status = 'pending_approval' and not edited`;
      }
      await audit(tx, tenantId, req.user!.userId, 'document.edited', id);
      return documentJson(after);
    }),
  );

  app.post('/v1/tenants/:tenantId/documents/:id/issue', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = z
        .object({ confirmPrefill: z.literal(true).optional() })
        .strict()
        .parse(req.body ?? {});
      const d = await load(tx, id);
      if (d.status !== 'draft') throw new HttpError(409, 'Already issued.');
      const r = await issueDocument(tx, d, { confirmPrefill: b.confirmPrefill === true });
      if (!r.ok) throw new HttpError(400, r.problems.join(' · '));
      await audit(tx, tenantId, req.user!.userId, 'document.issued', id, {
        number: r.number,
        prefillConfirmed: Boolean(d.prefill),
      });
      return documentJson((await loadDocument(tx, { id }))!);
    }),
  );

  /**
   * Attaches an issued document to a reply in its conversation. Mode 1: the
   * reply waits for approval like every draft. Modes 2 and 3: the owner's
   * click is the approval, and it goes out.
   */
  app.post('/v1/tenants/:tenantId/documents/:id/send', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const d = await load(tx, id);
      if (d.status !== 'issued')
        throw new HttpError(409, 'Only a document that is ready can be sent.');
      if (!d.threadId)
        throw new HttpError(
          409,
          'Not linked to a conversation: download the PDF to send it yourself.',
        );
      if (d.draftId) {
        const [dr] = await tx<{ status: string }[]>`
          select status from public.drafts where id = ${d.draftId}`;
        if (dr && ['pending_approval', 'approved'].includes(dr.status))
          return { draftId: d.draftId, status: dr.status };
      }
      const [m] = await tx<
        {
          id: string;
          from_address: string;
          from_name: string | null;
          reply_to: string | null;
          subject: string | null;
        }[]
      >`select id, from_address, from_name, reply_to, subject from public.messages
        where thread_id = ${d.threadId} and direction = 'inbound'
        order by received_at desc limit 1`;
      if (!m) throw new HttpError(409, 'This conversation has no customer e-mail to reply to.');
      const to = resolveReplyRecipient({
        from: m.from_address,
        replyTo: m.reply_to ? [m.reply_to] : [],
      }).to;
      const [t] = await tx<{ mode: string }[]>`select mode from public.tenants`;
      const now = t!.mode !== 'draft_only';
      const [draft] = await tx<{ id: string }[]>`
        insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                   status, decided_by, decided_at)
        values (${tenantId}, ${d.threadId}, ${m.id}, 'document', ${to}, ${buildReplySubject(m.subject)},
                ${documentCover(d, m.from_name)}, ${now ? 'approved' : 'pending_approval'},
                ${now ? 'owner' : null}, ${now ? new Date() : null})
        returning id`;
      await tx`update public.documents set draft_id = ${draft!.id} where id = ${id}`;
      if (now) {
        await enqueue(tx, {
          tenantId,
          queue: MAIL_SEND_QUEUE,
          payload: { draftId: draft!.id, sentVia: 'owner_approval' },
          singletonKey: draft!.id,
        });
      }
      await audit(tx, tenantId, req.user!.userId, 'document.send', id, { draftId: draft!.id, now });
      return { draftId: draft!.id, status: now ? 'approved' : 'pending_approval' };
    }),
  );

  app.post('/v1/tenants/:tenantId/documents/:id/mark', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const { status } = z
        .object({ status: z.enum(['paid', 'delivered']) })
        .strict()
        .parse(req.body);
      const d = await load(tx, id);
      if ((status === 'paid') !== d.payable)
        throw new HttpError(
          400,
          d.payable ? 'This document asks for payment: mark it as paid.' : 'Mark it as delivered.',
        );
      if (d.status !== 'issued' && d.status !== 'sent')
        throw new HttpError(409, `It is ${d.status}.`);
      if (status === 'paid') await markDocumentPaid(tx, id);
      else
        await tx`update public.documents set status = 'delivered', delivered_at = now() where id = ${id}`;
      await audit(tx, tenantId, req.user!.userId, `document.${status}`, id);
      return documentJson((await loadDocument(tx, { id }))!);
    }),
  );

  // An issued document keeps its number when cancelled (no gaps).
  app.post('/v1/tenants/:tenantId/documents/:id/cancel', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const d = await load(tx, id);
      if (d.status !== 'issued')
        throw new HttpError(409, 'Only a document that is ready (not sent) can be cancelled.');
      await lockEditable(tx, d);
      await tx`update public.documents set status = 'cancelled', cancelled_at = now() where id = ${id}`;
      if (d.draftId)
        await tx`update public.drafts set status = 'rejected', decided_by = 'owner', decided_at = now()
                 where id = ${d.draftId} and status = 'pending_approval'`;
      await audit(tx, tenantId, req.user!.userId, 'document.cancelled', id, { number: d.number });
      return documentJson((await loadDocument(tx, { id }))!);
    }),
  );

  app.delete('/v1/tenants/:tenantId/documents/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const rows =
        await tx`delete from public.documents where id = ${id} and status = 'draft' returning id`;
      if (!rows.length)
        throw new HttpError(409, 'Only a draft can be deleted; cancel an issued document.');
      await audit(tx, tenantId, req.user!.userId, 'document.deleted', id);
      return { ok: true };
    }),
  );

  // ------------------------------------------------------ incoming payments
  app.get('/v1/tenants/:tenantId/bank-senders', (req) =>
    tenantTx(
      req,
      (tx) => tx`select id, domain, created_at from public.bank_senders order by domain`,
    ),
  );

  /** The owner confirms a sender domain as their bank's notifications (once). */
  app.post('/v1/tenants/:tenantId/bank-senders', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { domain } = z
        .object({ domain: z.string().max(300) })
        .strict()
        .parse(req.body);
      const d = normalizeBankDomain(domain);
      if (!d)
        throw new HttpError(
          400,
          'Enter the domain your bank sends notifications from, e.g. swedbank.lv',
        );
      const own = await tx<{ n: number }[]>`
        select count(*)::int as n from public.email_connections where split_part(email_address, '@', 2) = ${d}`;
      if (own[0]!.n) throw new HttpError(400, 'That is your own mailbox’s domain, not a bank.');
      await tx`
        insert into public.bank_senders (tenant_id, domain, created_by)
        values (${tenantId}, ${d}, ${req.user!.userId})
        on conflict (tenant_id, domain) do nothing`;
      const [row] = await tx<{ id: string }[]>`
        select id from public.bank_senders where domain = ${d}`;
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
               values (${tenantId}, 'owner', ${req.user!.userId}, 'bank_sender.added', 'bank_sender', ${row!.id},
                       ${tx.json({ domain: d })})`;
      return { id: row!.id, domain: d };
    }),
  );

  app.delete('/v1/tenants/:tenantId/bank-senders/:id', (req) =>
    tenantTx(req, async (tx) => {
      const { id } = idParams.parse(req.params);
      const rows = await tx`delete from public.bank_senders where id = ${id} returning id`;
      if (!rows.length) throw new HttpError(404, 'not found');
      return { ok: true };
    }),
  );

  app.get('/v1/tenants/:tenantId/payments', (req) => tenantTx(req, (tx) => listPayments(tx)));

  const paymentAction = (
    path: string,
    fn: (tx: TransactionSql, id: string, body: unknown) => Promise<string>,
  ) =>
    app.post(`/v1/tenants/:tenantId/payments/:id/${path}`, (req) =>
      tenantTx(req, async (tx, tenantId) => {
        const { id } = idParams.parse(req.params);
        const r = await fn(tx, id, req.body ?? {});
        if (r === 'not_found') throw new HttpError(404, 'not found');
        if (r === 'already_matched') throw new HttpError(409, 'This payment is already linked.');
        if (r === 'not_open') throw new HttpError(409, 'That document is not open for payment.');
        await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
                 values (${tenantId}, 'owner', ${req.user!.userId}, ${`payment.${path}`}, 'payment', ${id})`;
        return (await listPayments(tx, { id }))[0];
      }),
    );
  // Accept the proposed match: the document is marked paid.
  paymentAction('confirm', (tx, id) => linkPayment(tx, id, null));
  // Link to any open document (manual matching).
  paymentAction('link', (tx, id, body) =>
    linkPayment(tx, id, z.object({ documentId: z.uuid() }).strict().parse(body).documentId),
  );
  // Not ours to match (e.g. a refund or a transfer between own accounts).
  paymentAction('dismiss', async (tx, id) => {
    const rows = await tx`update public.payments set status = 'dismissed', document_id = null
                          where id = ${id} and status in ('unmatched', 'proposed') returning id`;
    return rows.length ? 'ok' : 'not_found';
  });

  /** The owner's copy of the PDF (the same file the customer gets). */
  app.get('/v1/tenants/:tenantId/documents/:id/pdf', async (req, reply) => {
    const found = await tenantTx(req, async (tx) => {
      const d = await load(tx, idParams.parse(req.params).id);
      if (d.status === 'draft') throw new HttpError(409, 'Create the PDF first.');
      return { d, allowed: logoAllowed(d.brand.logoUrl, await loadAllowlist(tx)) };
    });
    const logo = found.allowed ? await fetchQuoteLogo(fetchLogo, found.d.brand.logoUrl) : null;
    const pdf = await renderDocumentPdf(found.d, logo);
    return reply
      .headers({
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${documentFileName(found.d)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(pdf);
  });
}
