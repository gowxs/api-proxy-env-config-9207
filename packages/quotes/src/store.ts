import type { TransactionSql } from 'postgres';
import { computeTotals, formatQuoteNumber, lineTotalCents, type VatMode } from './money.ts';
import type { PricedItem } from './mapping.ts';
import type { QuotePdfBrand, QuotePdfInput } from './pdf.ts';
import { quoteLabels } from './labels.ts';
import { greetingName, quoteCoverText } from './texts.ts';

/**
 * Database side of quotes, shared by the API (owner edits, accept link, PDF
 * download) and the worker (drafting, sending). Always called inside the
 * tenant's RLS context (withTenant).
 */

/** numeric columns arrive as strings; quantities have two decimals at most. */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadConfirmedItems(
  tx: TransactionSql,
  ids?: string[],
): Promise<PricedItem[]> {
  const rows = await tx<
    {
      id: string;
      name: string;
      description: string | null;
      unit: string;
      unit_price_cents: number;
      min_qty: string | null;
      max_qty: string | null;
      vat_note: string | null;
    }[]
  >`select id, name, description, unit, unit_price_cents, min_qty, max_qty, vat_note
    from public.price_items
    where status = 'confirmed' ${ids ? tx`and id = any(${ids}::uuid[])` : tx``}
    order by name, id`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    unit: r.unit,
    unitPriceCents: r.unit_price_cents,
    minQty: num(r.min_qty),
    maxQty: num(r.max_qty),
    vatNote: r.vat_note,
  }));
}

/**
 * The next quote number for this tenant: numbering restarts every calendar
 * year (in the tenant's time zone), Q-2026-0001 … then Q-2027-0001. The
 * tenant row is locked so two quotes can never take the same number; the
 * unique (tenant_id, number) constraint backs that up.
 */
export async function allocateQuoteNumber(tx: TransactionSql, tenantId: string): Promise<string> {
  const [t] = await tx<{ year: number }[]>`
    select extract(year from now() at time zone timezone)::int as year
    from public.tenants where id = ${tenantId} for update`;
  const year = t!.year;
  const [m] = await tx<{ n: number }[]>`
    select coalesce(max(split_part(number, '-', 3)::int), 0)::int + 1 as n
    from public.quotes where number like ${`Q-${year}-%`}`;
  return formatQuoteNumber(year, m!.n);
}

export interface QuoteLineInput {
  item: PricedItem;
  qty: number;
  customerText: string | null;
}

/** Replaces a quote's lines and stores the totals computed in code. */
export async function writeQuoteLines(
  tx: TransactionSql,
  q: { tenantId: string; quoteId: string; vatMode: VatMode; vatRate: number },
  lines: QuoteLineInput[],
) {
  const priced = lines.map((l) => ({ ...l, total: lineTotalCents(l.qty, l.item.unitPriceCents) }));
  const totals = computeTotals(
    priced.map((l) => l.total),
    { mode: q.vatMode, ratePercent: q.vatRate },
  );
  await tx`delete from public.quote_lines where quote_id = ${q.quoteId}`;
  for (const [i, l] of priced.entries()) {
    await tx`insert into public.quote_lines
               (tenant_id, quote_id, position, price_item_id, name, unit, vat_note, qty,
                unit_price_cents, line_total_cents, customer_text)
             values (${q.tenantId}, ${q.quoteId}, ${i}, ${l.item.id}, ${l.item.name}, ${l.item.unit},
                     ${l.item.vatNote}, ${l.qty}, ${l.item.unitPriceCents}, ${l.total},
                     ${l.customerText?.slice(0, 300) ?? null})`;
  }
  await tx`update public.quotes
           set subtotal_cents = ${totals.subtotalCents}, vat_cents = ${totals.vatCents},
               total_cents = ${totals.totalCents}
           where id = ${q.quoteId}`;
  return totals;
}

export interface QuoteDocument {
  id: string;
  tenantId: string;
  number: string;
  status: string;
  threadId: string;
  leadId: string | null;
  draftId: string | null;
  language: string | null;
  customerName: string | null;
  customerEmail: string;
  currency: string;
  vatMode: VatMode;
  vatRate: number;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  validUntil: Date;
  notes: string | null;
  createdAt: Date;
  lines: {
    id: string;
    priceItemId: string | null;
    name: string;
    unit: string;
    vatNote: string | null;
    qty: number;
    unitPriceCents: number;
    lineTotalCents: number;
    customerText: string | null;
  }[];
  brand: Omit<QuotePdfBrand, 'logo'> & { logoUrl: string | null };
}

export async function loadQuoteDocument(
  tx: TransactionSql,
  quoteId: string,
): Promise<QuoteDocument | null> {
  const [q] = await tx<
    {
      id: string;
      tenant_id: string;
      number: string;
      status: string;
      thread_id: string;
      lead_id: string | null;
      draft_id: string | null;
      language: string | null;
      customer_name: string | null;
      customer_email: string;
      currency: string;
      vat_mode: VatMode;
      vat_rate: string;
      subtotal_cents: number;
      vat_cents: number;
      total_cents: number;
      valid_until: Date;
      notes: string | null;
      created_at: Date;
      tenant_name: string;
      brand_company_name: string | null;
      brand_logo_url: string | null;
      brand_color: string | null;
      brand_website: string | null;
      brand_phone: string | null;
      brand_address: string | null;
    }[]
  >`select q.id, q.tenant_id, q.number, q.status, q.thread_id, q.lead_id, q.draft_id, q.language,
           q.customer_name, q.customer_email, q.currency, q.vat_mode, q.vat_rate, q.subtotal_cents,
           q.vat_cents, q.total_cents, q.valid_until, q.notes, q.created_at,
           t.name as tenant_name, t.brand_company_name, t.brand_logo_url, t.brand_color,
           t.brand_website, t.brand_phone, t.brand_address
    from public.quotes q join public.tenants t on t.id = q.tenant_id
    where q.id = ${quoteId}`;
  if (!q) return null;
  const lines = await tx<
    {
      id: string;
      price_item_id: string | null;
      name: string;
      unit: string;
      vat_note: string | null;
      qty: string;
      unit_price_cents: number;
      line_total_cents: number;
      customer_text: string | null;
    }[]
  >`select id, price_item_id, name, unit, vat_note, qty, unit_price_cents, line_total_cents, customer_text
    from public.quote_lines where quote_id = ${quoteId} order by position`;
  return {
    id: q.id,
    tenantId: q.tenant_id,
    number: q.number,
    status: q.status,
    threadId: q.thread_id,
    leadId: q.lead_id,
    draftId: q.draft_id,
    language: q.language,
    customerName: q.customer_name,
    customerEmail: q.customer_email,
    currency: q.currency,
    vatMode: q.vat_mode,
    vatRate: Number(q.vat_rate),
    subtotalCents: q.subtotal_cents,
    vatCents: q.vat_cents,
    totalCents: q.total_cents,
    validUntil: q.valid_until,
    notes: q.notes,
    createdAt: q.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      priceItemId: l.price_item_id,
      name: l.name,
      unit: l.unit,
      vatNote: l.vat_note,
      qty: Number(l.qty),
      unitPriceCents: l.unit_price_cents,
      lineTotalCents: l.line_total_cents,
      customerText: l.customer_text,
    })),
    brand: {
      companyName: q.brand_company_name ?? q.tenant_name,
      color: q.brand_color,
      website: q.brand_website,
      phone: q.brand_phone,
      address: q.brand_address,
      logoUrl: q.brand_logo_url,
    },
  };
}

/** The customer's link: `<public API URL>/q/<token>`. */
export const quoteAcceptUrl = (publicApiUrl: string, token: string) =>
  `${publicApiUrl.replace(/\/+$/, '')}/q/${token}`;

/**
 * File name of the attachment, in the quote's language, ASCII only so it is
 * safe in HTTP headers and every mail client ("Piedāvājums" → "Piedavajums").
 */
export const quotePdfFileName = (number: string, language: string | null = null) =>
  `${quoteLabels(language)
    .quote.normalize('NFKD')
    .replace(/[^A-Za-z]/g, '')}-${number}.pdf`;

export function quotePdfInput(
  d: QuoteDocument,
  acceptUrl: string,
  logo: Buffer | null,
): QuotePdfInput {
  const { logoUrl: _logoUrl, ...brand } = d.brand;
  return {
    number: d.number,
    language: d.language,
    createdAt: d.createdAt,
    validUntil: d.validUntil,
    customer: { name: d.customerName, email: d.customerEmail },
    currency: d.currency,
    vatMode: d.vatMode,
    vatRatePercent: d.vatRate,
    lines: d.lines.map((l) => ({
      name: l.name,
      unit: l.unit,
      qty: l.qty,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      vatNote: l.vatNote,
    })),
    subtotalCents: d.subtotalCents,
    vatCents: d.vatCents,
    totalCents: d.totalCents,
    notes: d.notes,
    acceptUrl,
    brand: { ...brand, logo },
  };
}

/** The cover reply for the quote draft (fixed text; every number from the document). */
export const quoteCoverFor = (d: QuoteDocument, acceptUrl: string) =>
  quoteCoverText({
    language: d.language,
    customerName: greetingName(d.customerName),
    number: d.number,
    lines: d.lines.map((l) => ({ qty: l.qty, name: l.name })),
    totalCents: d.totalCents,
    currency: d.currency,
    vatMode: d.vatMode,
    validUntil: d.validUntil,
    acceptUrl,
  });

type LogoFetch = (url: string, accept: string) => Promise<{ status: number; body: Uint8Array }>;

/**
 * The tenant's logo for the PDF: PNG or JPEG only (what pdfkit embeds),
 * fetched with the caller's safe fetcher. Any failure → null (company name
 * instead). The caller checks the knowledge-base allowlist first.
 */
export async function fetchQuoteLogo(
  fetcher: LogoFetch,
  url: string | null,
): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const r = await fetcher(url, 'image/png,image/jpeg;q=0.9');
    if (r.status !== 200) return null;
    const b = Buffer.from(r.body);
    const png = b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    return png || jpeg ? b : null;
  } catch {
    return null;
  }
}
