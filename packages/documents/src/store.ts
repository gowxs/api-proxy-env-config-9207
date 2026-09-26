import { formatMoney, quoteLocale, type VatMode } from '@noctiv/quotes';
import type { TransactionSql } from 'postgres';
import { documentProblems, type Seller } from './checks.ts';
import { documentCoverText } from './cover.ts';
import { docLabels } from './labels.ts';
import { renderCmrPdf } from './pdf/cmr.ts';
import { dateText, type DocBrand } from './pdf/common.ts';
import { renderDeliveryNotePdf, renderInvoicePdf } from './pdf/invoice.ts';
import {
  emptyData,
  parseData,
  type CmrData,
  type DeliveryNoteData,
  type DocData,
  type DocStatus,
  type DocType,
  type InvoiceData,
} from './schema.ts';
import { documentTotals, invoiceTotals, type DocumentTotals } from './totals.ts';

/**
 * Database side of documents, shared by the API and the worker. Always
 * called inside the tenant's RLS context (withTenant).
 */

/** The default number prefix per type; each business may set its own. */
export const NUMBER_PREFIX: Record<DocType, string> = {
  invoice: 'INV',
  delivery_note: 'DN',
  cmr: 'CMR',
};
/** The tenant column holding each type's prefix. */
export const PREFIX_COLUMN: Record<DocType, string> = {
  invoice: 'doc_prefix_invoice',
  delivery_note: 'doc_prefix_delivery_note',
  cmr: 'doc_prefix_cmr',
};
/** A prefix: 1–10 capital letters or digits (no hyphen: it separates the number's parts). */
export const PREFIX_PATTERN = /^[A-Z0-9]{1,10}$/;

/**
 * Per type: has a document already been issued this year (tenant time zone)?
 * Then its prefix is fixed until the next year, so numbering has no gaps.
 */
export async function prefixLocks(tx: TransactionSql): Promise<Record<DocType, boolean>> {
  const rows = await tx<{ type: DocType }[]>`
    select distinct d.type from public.documents d join public.tenants t on t.id = d.tenant_id
    where d.number is not null
      and extract(year from d.issue_date) = extract(year from now() at time zone t.timezone)`;
  const set = new Set(rows.map((r) => r.type));
  return {
    invoice: set.has('invoice'),
    delivery_note: set.has('delivery_note'),
    cmr: set.has('cmr'),
  };
}

export interface DocumentRecord {
  id: string;
  tenantId: string;
  type: DocType;
  number: string | null;
  status: DocStatus;
  language: string;
  threadId: string | null;
  leadId: string | null;
  quoteId: string | null;
  sourceDocumentId: string | null;
  sourceMessageId: string | null;
  draftId: string | null;
  data: DocData;
  prefill: Record<string, { source: string }> | null;
  prefillStatus: 'pending' | 'done' | 'failed' | null;
  currency: string;
  vatMode: VatMode;
  vatRate: number;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  counterpartyName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  createdAt: Date;
  issuedAt: Date | null;
  sentAt: Date | null;
  paidAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  seller: Seller;
  brand: Omit<DocBrand, 'logo'> & { logoUrl: string | null };
  /** Today in the tenant's time zone (ISO date). */
  today: string;
  invoiceDueDays: number;
}

interface Row {
  id: string;
  tenant_id: string;
  type: DocType;
  number: string | null;
  status: DocStatus;
  language: string;
  thread_id: string | null;
  lead_id: string | null;
  quote_id: string | null;
  source_document_id: string | null;
  source_message_id: string | null;
  draft_id: string | null;
  data: unknown;
  prefill: Record<string, { source: string }> | null;
  prefill_status: 'pending' | 'done' | 'failed' | null;
  currency: string;
  vat_mode: VatMode;
  vat_rate: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  counterparty_name: string | null;
  issue_date: string | null;
  due_date: string | null;
  created_at: Date;
  issued_at: Date | null;
  sent_at: Date | null;
  paid_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  seller_legal_name: string | null;
  seller_legal_address: string | null;
  seller_reg_no: string | null;
  seller_vat_no: string | null;
  seller_bank_name: string | null;
  seller_iban: string | null;
  seller_bic: string | null;
  seller_country: string | null;
  tenant_name: string;
  brand_company_name: string | null;
  brand_logo_url: string | null;
  brand_color: string | null;
  brand_website: string | null;
  brand_phone: string | null;
  today: string;
  invoice_due_days: number;
}

const toRecord = (r: Row): DocumentRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  type: r.type,
  number: r.number,
  status: r.status,
  language: r.language,
  threadId: r.thread_id,
  leadId: r.lead_id,
  quoteId: r.quote_id,
  sourceDocumentId: r.source_document_id,
  sourceMessageId: r.source_message_id,
  draftId: r.draft_id,
  data: parseData(r.type, r.data),
  prefill: r.prefill && Object.keys(r.prefill).length ? r.prefill : null,
  prefillStatus: r.prefill_status,
  currency: r.currency,
  vatMode: r.vat_mode,
  vatRate: Number(r.vat_rate),
  subtotalCents: r.subtotal_cents,
  vatCents: r.vat_cents,
  totalCents: r.total_cents,
  counterpartyName: r.counterparty_name,
  issueDate: r.issue_date,
  dueDate: r.due_date,
  createdAt: r.created_at,
  issuedAt: r.issued_at,
  sentAt: r.sent_at,
  paidAt: r.paid_at,
  deliveredAt: r.delivered_at,
  cancelledAt: r.cancelled_at,
  seller: {
    legalName: r.seller_legal_name,
    legalAddress: r.seller_legal_address,
    regNo: r.seller_reg_no,
    vatNo: r.seller_vat_no,
    bankName: r.seller_bank_name,
    iban: r.seller_iban,
    bic: r.seller_bic,
    country: r.seller_country,
  },
  brand: {
    companyName: r.brand_company_name ?? r.seller_legal_name ?? r.tenant_name,
    color: r.brand_color,
    website: r.brand_website,
    phone: r.brand_phone,
    logoUrl: r.brand_logo_url,
  },
  today: r.today,
  invoiceDueDays: r.invoice_due_days,
});

const SELECT = (tx: TransactionSql) => tx`
  select d.id, d.tenant_id, d.type, d.number, d.status, d.language, d.thread_id, d.lead_id, d.quote_id,
         d.source_document_id, d.source_message_id, d.draft_id, d.data, d.prefill, d.prefill_status,
         d.currency, d.vat_mode, d.vat_rate::float8 as vat_rate, d.subtotal_cents, d.vat_cents,
         d.total_cents, d.counterparty_name, d.issue_date::text as issue_date,
         d.due_date::text as due_date, d.created_at, d.issued_at, d.sent_at, d.paid_at,
         d.delivered_at, d.cancelled_at,
         t.seller_legal_name, t.seller_legal_address, t.seller_reg_no, t.seller_vat_no,
         t.seller_bank_name, t.seller_iban, t.seller_bic, t.seller_country, t.name as tenant_name,
         t.brand_company_name, t.brand_logo_url, t.brand_color, t.brand_website, t.brand_phone,
         (now() at time zone t.timezone)::date::text as today, t.invoice_due_days
  from public.documents d join public.tenants t on t.id = d.tenant_id`;

export async function loadDocument(
  tx: TransactionSql,
  where: { id: string } | { draftId: string },
): Promise<DocumentRecord | null> {
  const [r] = await tx<Row[]>`${SELECT(tx)} where ${
    'id' in where ? tx`d.id = ${where.id}` : tx`d.draft_id = ${where.draftId}`
  }`;
  return r ? toRecord(r) : null;
}

export async function listDocuments(
  tx: TransactionSql,
  f: { type?: DocType; threadId?: string } = {},
): Promise<DocumentRecord[]> {
  const rows = await tx<Row[]>`${SELECT(tx)}
    where ${f.type ? tx`d.type = ${f.type}` : tx`true`}
      and ${f.threadId ? tx`d.thread_id = ${f.threadId}` : tx`true`}
    order by d.created_at desc limit 300`;
  return rows.map(toRecord);
}

/** What is still missing before the document can be issued (empty = ready). */
export const problemsOf = (d: DocumentRecord) =>
  documentProblems(d.type, d.data, d.seller, { vatMode: d.vatMode, today: d.today });

/** The API's JSON shape (the dashboard's `Doc`). */
export function documentJson(d: DocumentRecord) {
  return {
    id: d.id,
    type: d.type,
    number: d.number,
    status: d.status,
    language: d.language,
    thread_id: d.threadId,
    lead_id: d.leadId,
    quote_id: d.quoteId,
    source_document_id: d.sourceDocumentId,
    draft_id: d.draftId,
    data: d.data,
    prefill: d.prefill,
    prefill_status: d.prefillStatus,
    currency: d.currency,
    vat_mode: d.vatMode,
    vat_rate: d.vatRate,
    subtotal_cents: d.subtotalCents,
    vat_cents: d.vatCents,
    total_cents: d.totalCents,
    counterparty_name: d.counterpartyName,
    issue_date: d.issueDate,
    due_date: d.dueDate,
    created_at: d.createdAt,
    issued_at: d.issuedAt,
    sent_at: d.sentAt,
    paid_at: d.paidAt,
    delivered_at: d.deliveredAt,
    cancelled_at: d.cancelledAt,
    problems: d.status === 'draft' || d.status === 'issued' ? problemsOf(d) : [],
    seller: d.seller,
  };
}

const counterparty = (type: DocType, data: DocData): string | null => {
  const n =
    type === 'invoice'
      ? (data as InvoiceData).buyer.name
      : type === 'delivery_note'
        ? (data as DeliveryNoteData).receiver.name
        : (data as CmrData).consignee.name;
  return n.trim() || null;
};

/** Invoices and priced delivery notes (pavadzīme-rēķins) have totals; other documents none. */
export function documentTotalsOf(
  type: DocType,
  data: DocData,
  vatMode: VatMode,
  vatRate: number,
): DocumentTotals {
  if (type === 'invoice')
    return invoiceTotals(data as InvoiceData, { mode: vatMode, ratePercent: vatRate });
  if (type === 'delivery_note' && (data as DeliveryNoteData).withPrices)
    return documentTotals((data as DeliveryNoteData).lines, {
      mode: vatMode,
      ratePercent: vatRate,
    });
  return { unitPrices: [], lineTotals: [], subtotalCents: 0, vatCents: 0, totalCents: 0 };
}

/** Stores a document's fields with the derived totals and counterparty. */
export async function writeDocumentData(
  tx: TransactionSql,
  d: Pick<DocumentRecord, 'id' | 'type' | 'vatMode' | 'vatRate'>,
  data: DocData,
  language?: string,
) {
  const t = documentTotalsOf(d.type, data, d.vatMode, d.vatRate);
  await tx`
    update public.documents
    set data = ${tx.json(data as never)}, subtotal_cents = ${t.subtotalCents}, vat_cents = ${t.vatCents},
        total_cents = ${t.totalCents}, counterparty_name = ${counterparty(d.type, data)},
        due_date = ${d.type === 'invoice' ? (data as InvoiceData).dueDate : null}
        ${language ? tx`, language = ${language}` : tx``}
    where id = ${d.id}`;
}

/** The next number of this type: INV-2026-0001 … (the tenant's prefix), restarting each year (tenant row locked). */
export async function allocateDocumentNumber(
  tx: TransactionSql,
  tenantId: string,
  type: DocType,
): Promise<{ number: string; today: string }> {
  const [t] = await tx<{ year: number; today: string; prefix: string }[]>`
    select extract(year from now() at time zone timezone)::int as year,
           (now() at time zone timezone)::date::text as today,
           ${tx(PREFIX_COLUMN[type])} as prefix
    from public.tenants where id = ${tenantId} for update`;
  const prefix = `${t!.prefix}-${t!.year}-`;
  const [m] = await tx<{ n: number }[]>`
    select coalesce(max(split_part(number, '-', 3)::int), 0)::int + 1 as n
    from public.documents where type = ${type} and number like ${`${prefix}%`}`;
  return { number: `${prefix}${String(m!.n).padStart(4, '0')}`, today: t!.today };
}

export interface CreateInput {
  tenantId: string;
  type: DocType;
  threadId?: string | null;
  fromQuoteId?: string;
  fromDocumentId?: string;
  fromMessageId?: string;
}

export class DocumentSourceError extends Error {}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * A new draft with everything that can be copied from its source: an
 * accepted quote (invoice), an invoice (delivery note), the conversation's
 * customer, the seller details. Nothing is invented.
 */
export async function createDocument(tx: TransactionSql, c: CreateInput): Promise<string> {
  const [t] = await tx<
    {
      seller_legal_name: string | null;
      seller_legal_address: string | null;
      seller_country: string | null;
      quotes_currency: string;
      quotes_vat_mode: VatMode;
      quotes_vat_rate: number;
      invoice_due_days: number;
      today: string;
    }[]
  >`select seller_legal_name, seller_legal_address, seller_country, quotes_currency, quotes_vat_mode,
           quotes_vat_rate::float8 as quotes_vat_rate, invoice_due_days,
           (now() at time zone timezone)::date::text as today
    from public.tenants where id = ${c.tenantId}`;
  let data = emptyData(c.type);
  let threadId = c.threadId ?? null;
  let leadId: string | null = null;
  let quoteId: string | null = null;
  let sourceDocumentId: string | null = null;
  let language: string | null = null;
  let currency = t!.quotes_currency;
  let vatMode = t!.quotes_vat_mode;
  let vatRate = t!.quotes_vat_rate;

  if (c.fromQuoteId) {
    if (c.type !== 'invoice')
      throw new DocumentSourceError('Only an invoice can be made from a quote.');
    const [q] = await tx<
      {
        id: string;
        status: string;
        thread_id: string;
        lead_id: string | null;
        language: string | null;
        customer_name: string | null;
        customer_email: string;
        currency: string;
        vat_mode: VatMode;
        vat_rate: number;
      }[]
    >`select id, status, thread_id, lead_id, language, customer_name, customer_email, currency, vat_mode,
             vat_rate::float8 as vat_rate
      from public.quotes where id = ${c.fromQuoteId}`;
    if (!q) throw new DocumentSourceError('Quote not found.');
    if (q.status !== 'accepted')
      throw new DocumentSourceError('Only an accepted quote can be turned into an invoice.');
    const lines = await tx<{ name: string; unit: string; qty: string; unit_price_cents: number }[]>`
      select name, unit, qty, unit_price_cents from public.quote_lines
      where quote_id = ${q.id} order by position`;
    ({ id: quoteId, thread_id: threadId, lead_id: leadId, language, currency } = q);
    vatMode = q.vat_mode;
    vatRate = q.vat_rate;
    data = {
      ...(data as InvoiceData),
      buyer: {
        name: q.customer_name ?? '',
        address: '',
        regNo: '',
        vatNo: '',
        email: q.customer_email,
      },
      lines: lines.map((l) => ({
        name: l.name,
        unit: l.unit,
        qty: Number(l.qty),
        unitPriceCents: l.unit_price_cents,
      })),
    };
  } else if (c.fromDocumentId) {
    const src = await loadDocument(tx, { id: c.fromDocumentId });
    if (!src) throw new DocumentSourceError('Document not found.');
    if (c.type !== 'delivery_note' || src.type !== 'invoice')
      throw new DocumentSourceError('A delivery note can be made from an invoice.');
    const inv = src.data as InvoiceData;
    ({ threadId, leadId, language } = src);
    sourceDocumentId = src.id;
    data = {
      ...(data as DeliveryNoteData),
      receiver: {
        name: inv.buyer.name,
        address: inv.buyer.address,
        regNo: inv.buyer.regNo,
        vatNo: inv.buyer.vatNo,
      },
      loadingAddress: t!.seller_legal_address ?? '',
      deliveryAddress: inv.buyer.address,
      // Prices are copied too, and shown only if the owner turns on the pavadzīme-rēķins.
      lines: inv.lines.map((l) => ({
        name: l.name,
        unit: l.unit,
        qty: l.qty,
        unitPriceCents: l.unitPriceCents,
      })),
    };
  } else if (c.fromMessageId) {
    if (c.type !== 'cmr')
      throw new DocumentSourceError('Only a CMR can be drafted from an e-mail.');
    const [m] = await tx<
      { thread_id: string | null; direction: string; body_text: string | null }[]
    >`
      select thread_id, direction, body_text from public.messages where id = ${c.fromMessageId}`;
    if (!m || m.direction !== 'inbound' || !m.body_text)
      throw new DocumentSourceError('That e-mail can no longer be read.');
    threadId = m.thread_id;
  }

  if (threadId && !leadId) {
    const [th] = await tx<{ lead_id: string | null; name: string | null; email: string | null }[]>`
      select th.lead_id, l.name, l.email from public.threads th left join public.leads l on l.id = th.lead_id
      where th.id = ${threadId}`;
    if (!th) throw new DocumentSourceError('Conversation not found.');
    leadId = th.lead_id;
    if (c.type === 'invoice' && !c.fromQuoteId) {
      const inv = data as InvoiceData;
      data = { ...inv, buyer: { ...inv.buyer, name: th.name ?? '', email: th.email ?? '' } };
    }
    if (c.type === 'delivery_note' && !c.fromDocumentId) {
      const dn = data as DeliveryNoteData;
      data = {
        ...dn,
        receiver: { ...dn.receiver, name: th.name ?? '' },
        loadingAddress: t!.seller_legal_address ?? '',
      };
    }
  }
  if (threadId && !language) {
    const [lang] = await tx<{ language: string | null }[]>`
      select p.classification->>'language' as language
      from public.messages m join public.message_processing p on p.message_id = m.id
      where m.thread_id = ${threadId} and m.direction = 'inbound' and p.classification is not null
      order by m.received_at desc limit 1`;
    language = lang?.language ?? null;
  }
  if (c.type === 'invoice') {
    data = { ...(data as InvoiceData), dueDate: addDays(t!.today, t!.invoice_due_days) };
  }
  if (c.type === 'cmr') {
    const cmr = data as CmrData;
    const country = t!.seller_country ?? '';
    data = {
      ...cmr,
      sender: { name: t!.seller_legal_name ?? '', address: t!.seller_legal_address ?? '', country },
      takingOver: { ...cmr.takingOver, country },
      establishedOn: t!.today,
    };
  }

  const lang = ['en', 'de', 'lv', 'nl', 'fr', 'es'].includes(language ?? '') ? language! : 'en';
  const [row] = await tx<{ id: string }[]>`
    insert into public.documents (tenant_id, type, status, language, thread_id, lead_id, quote_id,
                                  source_document_id, source_message_id, data, prefill_status,
                                  currency, vat_mode, vat_rate)
    values (${c.tenantId}, ${c.type}, 'draft', ${lang}, ${threadId}, ${leadId}, ${quoteId},
            ${sourceDocumentId}, ${c.fromMessageId ?? null}, ${tx.json(data as never)},
            ${c.fromMessageId ? 'pending' : null}, ${currency}, ${vatMode}, ${vatRate})
    returning id`;
  await writeDocumentData(tx, { id: row!.id, type: c.type, vatMode, vatRate }, data);
  return row!.id;
}

export type IssueResult = { ok: true; number: string } | { ok: false; problems: string[] };

/**
 * Validates and numbers a draft; from here the PDF exists. Pre-filled
 * fields must have been confirmed by the owner; their e-mail excerpts are
 * dropped once confirmed.
 */
export async function issueDocument(
  tx: TransactionSql,
  d: DocumentRecord,
  o: { confirmPrefill?: boolean },
): Promise<IssueResult> {
  const problems = problemsOf(d);
  if (d.prefillStatus === 'pending') problems.push('The e-mail is still being read.');
  if (d.prefill && !o.confirmPrefill)
    problems.push('Confirm that you checked every field filled from the e-mail.');
  if (problems.length) return { ok: false, problems };
  const { number, today } = await allocateDocumentNumber(tx, d.tenantId, d.type);
  await tx`
    update public.documents
    set status = 'issued', number = ${number}, issue_date = ${today}, issued_at = now(), prefill = null
    where id = ${d.id} and status = 'draft'`;
  return { ok: true, number };
}

/** The reply text that carries an issued document, in the document's language. */
export function documentCover(d: DocumentRecord, customerName: string | null): string {
  const locale = quoteLocale(d.language);
  return documentCoverText({
    type: d.type,
    language: d.language,
    customerName,
    number: d.number ?? '',
    total: formatMoney(d.totalCents, d.currency, locale),
    due: dateText(d.dueDate, d.language),
    priced: d.type === 'delivery_note' && (d.data as DeliveryNoteData).withPrices,
  });
}

/** File name in the document's language, ASCII only ("Rekins-INV-2026-0001.pdf"). */
export function documentFileName(
  d: Pick<DocumentRecord, 'type' | 'number' | 'language'> & { data?: DocData },
): string {
  const t = docLabels(d.language);
  const priced =
    d.type === 'delivery_note' && Boolean((d.data as DeliveryNoteData | undefined)?.withPrices);
  const word =
    d.type === 'cmr'
      ? 'CMR'
      : d.type === 'invoice'
        ? t.invoice
        : priced
          ? t.deliveryNoteInvoice
          : t.deliveryNote;
  const ascii = word
    .normalize('NFKD')
    .replace(/[^A-Za-z -]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return d.type === 'cmr' ? `${d.number ?? 'draft'}.pdf` : `${ascii}-${d.number ?? 'draft'}.pdf`;
}

/** The PDF of an issued document (CMR: four copies in one file). */
export function renderDocumentPdf(d: DocumentRecord, logo: Buffer | null): Promise<Buffer> {
  if (!d.number || !d.issueDate) throw new Error('only issued documents have a PDF');
  const issueDate = new Date(`${d.issueDate}T00:00:00Z`);
  const ctx = {
    number: d.number,
    language: d.language,
    issueDate,
    seller: d.seller,
    brand: { ...d.brand, logo },
  };
  if (d.type === 'invoice') {
    const data = d.data as InvoiceData;
    return renderInvoicePdf({
      ...ctx,
      data,
      currency: d.currency,
      vatMode: d.vatMode,
      vatRatePercent: d.vatRate,
      totals: invoiceTotals(data, { mode: d.vatMode, ratePercent: d.vatRate }),
      dueDate: d.dueDate,
    });
  }
  if (d.type === 'delivery_note') {
    const data = d.data as DeliveryNoteData;
    return renderDeliveryNotePdf({
      ...ctx,
      data,
      ...(data.withPrices
        ? {
            priced: {
              currency: d.currency,
              vatMode: d.vatMode,
              vatRatePercent: d.vatRate,
              totals: documentTotals(data.lines, { mode: d.vatMode, ratePercent: d.vatRate }),
            },
          }
        : {}),
    });
  }
  return renderCmrPdf({
    number: d.number,
    issueDate,
    data: d.data as CmrData,
    author: d.seller.legalName ?? d.brand.companyName,
  });
}
