import { enqueue, withTenant } from '@noctiv/db';
import { detectKbFile, extractFileText, UploadRejectedError } from '@noctiv/kb';
import {
  loadConfirmedItems,
  loadQuoteDocument,
  parseMoney,
  parsePriceCsv,
  qtyHundredths,
  quoteAcceptUrl,
  quoteCoverFor,
  signQuoteToken,
  unitFor,
  writeQuoteLines,
} from '@noctiv/quotes';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';

/** Queue name shared with the worker (apps/worker/src/queues.ts). */
const QUOTES_IMPORT_QUEUE = 'quotes.import';

const tenantParams = z.object({ tenantId: z.uuid() });
const idParams = z.object({ tenantId: z.uuid(), id: z.uuid() });

const qty = z
  .number()
  .refine((n) => qtyHundredths(n) !== null, 'a positive number with at most two decimals')
  .nullable();
const price = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const c = parseMoney(v);
  if (c === null || c > 1_000_000_000) {
    ctx.addIssue({ code: 'custom', message: 'not a price' });
    return z.NEVER;
  }
  return c;
});
const blank = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), t.nullable());

const itemShape = {
  name: z.string().trim().min(1).max(200),
  description: blank(z.string().trim().max(1000)),
  unit: z.string().trim().min(1).max(30),
  unitPrice: price,
  minQty: qty,
  maxQty: qty,
  vatNote: blank(z.string().trim().max(200)),
};
const itemCreate = z
  .object(itemShape)
  .partial({ description: true, minQty: true, maxQty: true, vatNote: true })
  .strict();
const itemPatch = z
  .object({ ...itemShape, status: z.enum(['draft', 'confirmed', 'archived']) })
  .partial()
  .strict();

const quotePatch = z
  .object({
    lines: z
      .array(
        z
          .object({
            priceItemId: z.uuid(),
            qty: z.number().refine((n) => qtyHundredths(n) !== null, 'invalid quantity'),
            customerText: z.string().max(300).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    notes: blank(z.string().trim().max(2000)),
    validUntil: z.iso.date(),
  })
  .partial()
  .strict();

/** Quote settings in Quotes → Setup (merged into PATCH /v1/tenants/:id). */
export const quoteSettingsShape = {
  quotesEnabled: z.boolean(),
  quotesCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'a three-letter currency code'),
  quotesVatMode: z.enum(['none', 'exclusive', 'inclusive']),
  quotesVatRate: z
    .number()
    .min(0)
    .max(99.99)
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'two decimals at most'),
  quotesValidityDays: z.number().int().min(1).max(365),
  quotesAutoSendLimit: price,
};
export type QuoteSettings = Partial<{
  [K in keyof typeof quoteSettingsShape]: z.output<(typeof quoteSettingsShape)[K]>;
}>;

export function quoteSettingsColumns(b: QuoteSettings): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  if (b.quotesEnabled !== undefined) cols.quotes_enabled = b.quotesEnabled;
  if (b.quotesCurrency !== undefined) cols.quotes_currency = b.quotesCurrency;
  if (b.quotesVatMode !== undefined) cols.quotes_vat_mode = b.quotesVatMode;
  if (b.quotesVatRate !== undefined) cols.quotes_vat_rate = b.quotesVatRate;
  if (b.quotesValidityDays !== undefined) cols.quotes_validity_days = b.quotesValidityDays;
  if (b.quotesAutoSendLimit !== undefined)
    cols.quotes_auto_send_limit_cents = b.quotesAutoSendLimit;
  return cols;
}

/**
 * Quotes with their lines, as the dashboard shows them (numbers, not numeric
 * strings). Each line also carries unit_label: the unit as printed after its
 * quantity in the quote's language ("2 boxes", QA #25).
 */
export async function selectQuotes(tx: TransactionSql, where: ReturnType<TransactionSql>) {
  const rows = await tx<
    ({ language: string | null; lines: { unit: string; qty: number }[] } & Record<
      string,
      unknown
    >)[]
  >`
    select q.id, q.number, q.status, q.language, q.thread_id, q.draft_id, q.customer_email, q.customer_name,
           q.currency, q.vat_mode, q.vat_rate::float8 as vat_rate, q.subtotal_cents, q.vat_cents,
           q.total_cents, q.valid_until, q.notes, q.hold_reasons, q.created_at, q.sent_at,
           q.viewed_at, q.accepted_at,
           coalesce((select json_agg(json_build_object(
                       'id', l.id, 'price_item_id', l.price_item_id, 'name', l.name, 'unit', l.unit,
                       'qty', l.qty::float8, 'unit_price_cents', l.unit_price_cents,
                       'line_total_cents', l.line_total_cents, 'customer_text', l.customer_text)
                       order by l.position)
                     from public.quote_lines l where l.quote_id = q.id), '[]'::json) as lines
    from public.quotes q
    where ${where}
    order by q.created_at desc
    limit 200`;
  return rows.map((q) => ({
    ...q,
    lines: q.lines.map((l) => ({ ...l, unit_label: unitFor(l.unit, l.qty, q.language) })),
  }));
}

const ITEM_COLUMNS = (tx: TransactionSql) =>
  tx`id, name, description, unit, unit_price_cents, min_qty::float8 as min_qty,
     max_qty::float8 as max_qty, vat_note, status, source, import_id, created_at, updated_at`;

const UPLOAD_MESSAGES: Record<UploadRejectedError['reason'], string> = {
  too_large: 'The file is larger than 10 MB.',
  empty: 'The file is empty.',
  unsupported_type: 'Only PDF, Word (.docx) and plain text files can be used.',
  not_utf8_text: 'The text file could not be read. Save it as UTF-8 and try again.',
};

/**
 * Quotes (beta), owner side: the price list and quote editing (PLAN.md §21).
 * Every route checks membership, then works inside the tenant's RLS context.
 */
export function quoteRoutes(app: FastifyInstance, deps: AppDeps & { publicApiUrl: string }): void {
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
    targetType: string,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ) => tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
          values (${tenantId}, 'owner', ${userId}, ${action}, ${targetType}, ${targetId}, ${tx.json(metadata as never)})`;

  const checkRange = (min: number | null | undefined, max: number | null | undefined) => {
    if (min != null && max != null && min > max)
      throw new HttpError(400, 'The minimum quantity is larger than the maximum.');
  };

  // ------------------------------------------------------------ price list
  app.get('/v1/tenants/:tenantId/price-items', (req) =>
    tenantTx(req, async (tx) => {
      const q = z
        .object({ status: z.enum(['draft', 'confirmed', 'archived']).optional() })
        .parse(req.query);
      return tx`
        select ${ITEM_COLUMNS(tx)} from public.price_items
        where ${q.status ? tx`status = ${q.status}` : tx`status <> 'archived'`}
        order by (status = 'draft') desc, name, id
        limit 2000`;
    }),
  );

  app.post('/v1/tenants/:tenantId/price-items', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = itemCreate.parse(req.body);
      checkRange(b.minQty, b.maxQty);
      const [row] = await tx<{ id: string }[]>`
        insert into public.price_items
          (tenant_id, name, description, unit, unit_price_cents, min_qty, max_qty, vat_note, status, source)
        values (${tenantId}, ${b.name}, ${b.description ?? null}, ${b.unit}, ${b.unitPrice},
                ${b.minQty ?? null}, ${b.maxQty ?? null}, ${b.vatNote ?? null}, 'confirmed', 'manual')
        returning id`;
      await audit(tx, tenantId, req.user!.userId, 'price_item.created', 'price_item', row!.id);
      return { id: row!.id };
    }),
  );

  app.patch('/v1/tenants/:tenantId/price-items/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = itemPatch.parse(req.body);
      const [cur] = await tx<{ min_qty: number | null; max_qty: number | null }[]>`
        select min_qty::float8 as min_qty, max_qty::float8 as max_qty
        from public.price_items where id = ${id} for update`;
      if (!cur) throw new HttpError(404, 'not found');
      checkRange(
        b.minQty !== undefined ? b.minQty : cur.min_qty,
        b.maxQty !== undefined ? b.maxQty : cur.max_qty,
      );
      const cols: Record<string, unknown> = {};
      if (b.name !== undefined) cols.name = b.name;
      if (b.description !== undefined) cols.description = b.description;
      if (b.unit !== undefined) cols.unit = b.unit;
      if (b.unitPrice !== undefined) cols.unit_price_cents = b.unitPrice;
      if (b.minQty !== undefined) cols.min_qty = b.minQty;
      if (b.maxQty !== undefined) cols.max_qty = b.maxQty;
      if (b.vatNote !== undefined) cols.vat_note = b.vatNote;
      if (b.status !== undefined) cols.status = b.status;
      if (Object.keys(cols).length) {
        await tx`update public.price_items set ${tx(cols)} where id = ${id}`;
        await audit(tx, tenantId, req.user!.userId, 'price_item.updated', 'price_item', id, {
          fields: Object.keys(cols),
        });
      }
      return { ok: true };
    }),
  );

  // Quotes keep a snapshot of every line, so deleting an item never changes a quote.
  app.delete('/v1/tenants/:tenantId/price-items/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const rows = await tx`delete from public.price_items where id = ${id} returning id`;
      if (!rows.length) throw new HttpError(404, 'not found');
      await audit(tx, tenantId, req.user!.userId, 'price_item.deleted', 'price_item', id);
      return { ok: true };
    }),
  );

  app.post('/v1/tenants/:tenantId/price-items/confirm-all', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const rows = await tx`update public.price_items set status = 'confirmed'
                            where status = 'draft' returning id`;
      await audit(tx, tenantId, req.user!.userId, 'price_item.confirmed_all', 'price_item', null, {
        count: rows.length,
      });
      return { confirmed: rows.length };
    }),
  );

  // CSV: the browser reads the file and posts its text; dryRun only checks it.
  app.post('/v1/tenants/:tenantId/price-items/csv', { bodyLimit: 3 * 1024 * 1024 }, (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = z
        .object({
          csv: z
            .string()
            .min(1)
            .max(2 * 1024 * 1024),
          dryRun: z.boolean().default(true),
        })
        .strict()
        .parse(req.body);
      const parsed = parsePriceCsv(b.csv);
      if (parsed.headerError) throw new HttpError(400, parsed.headerError);
      const rows = parsed.rows.map((r) => ({
        line: r.line,
        name: r.item?.name ?? null,
        unit: r.item?.unit ?? null,
        unit_price_cents: r.item?.unitPriceCents ?? null,
        error: r.error ?? null,
      }));
      if (b.dryRun) return { rows, imported: 0 };
      let imported = 0;
      for (const r of parsed.rows) {
        if (!r.item) continue;
        const it = r.item;
        await tx`insert into public.price_items
                   (tenant_id, name, description, unit, unit_price_cents, min_qty, max_qty, vat_note, status, source)
                 values (${tenantId}, ${it.name}, ${it.description}, ${it.unit}, ${it.unitPriceCents},
                         ${it.minQty}, ${it.maxQty}, ${it.vatNote}, 'confirmed', 'csv')`;
        imported++;
      }
      await audit(tx, tenantId, req.user!.userId, 'price_item.csv_imported', 'price_item', null, {
        count: imported,
      });
      return { rows, imported };
    }),
  );

  // A PDF/DOCX price list: text is extracted here (the file is not kept); the
  // worker turns it into draft items that the owner confirms.
  app.post('/v1/tenants/:tenantId/price-imports', { bodyLimit: 15 * 1024 * 1024 }, (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = z
        .object({
          fileName: z.string().trim().min(1).max(255),
          contentBase64: z
            .string()
            .min(1)
            .max(14 * 1024 * 1024),
        })
        .strict()
        .parse(req.body);
      const bytes = Buffer.from(b.contentBase64, 'base64');
      let text: string;
      try {
        text = await extractFileText(detectKbFile(bytes), bytes);
      } catch (e) {
        if (e instanceof UploadRejectedError) throw new HttpError(400, UPLOAD_MESSAGES[e.reason]);
        throw new HttpError(400, 'The file could not be read.');
      }
      text = text.replaceAll('\u0000', '').trim();
      if (!text) throw new HttpError(400, 'No text was found in the file.');
      const [row] = await tx<{ id: string }[]>`
        insert into public.price_imports (tenant_id, file_name, extracted_text, status)
        values (${tenantId}, ${b.fileName}, ${text.slice(0, 200_000)}, 'pending')
        returning id`;
      await enqueue(tx, {
        tenantId,
        queue: QUOTES_IMPORT_QUEUE,
        payload: { importId: row!.id },
        singletonKey: row!.id,
      });
      await audit(tx, tenantId, req.user!.userId, 'price_import.created', 'price_import', row!.id);
      return { id: row!.id, status: 'pending' };
    }),
  );

  app.get('/v1/tenants/:tenantId/price-imports', (req) =>
    tenantTx(
      req,
      (tx) => tx`
        select id, file_name, status, item_count, error, created_at
        from public.price_imports order by created_at desc limit 10`,
    ),
  );

  // ---------------------------------------------------------------- quotes
  app.get('/v1/tenants/:tenantId/quotes', (req) =>
    tenantTx(req, (tx) => selectQuotes(tx, tx`true`)),
  );

  /**
   * The owner edits a quote waiting for approval: lines (confirmed items
   * only; prices always from the price list), notes, validity. Totals are
   * recomputed here and the cover reply is rewritten to match.
   */
  app.patch('/v1/tenants/:tenantId/quotes/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = quotePatch.parse(req.body);
      const [q] = await tx<
        {
          status: string;
          draft_id: string | null;
          vat_mode: 'none' | 'exclusive' | 'inclusive';
          vat_rate: number;
        }[]
      >`select status, draft_id, vat_mode, vat_rate::float8 as vat_rate
        from public.quotes where id = ${id} for update`;
      if (!q) throw new HttpError(404, 'not found');
      const [d] = q.draft_id
        ? await tx<{ status: string }[]>`
            select status from public.drafts where id = ${q.draft_id} for update`
        : [];
      if (q.status !== 'pending_approval' || d?.status !== 'pending_approval')
        throw new HttpError(409, 'Only a quote waiting for approval can be edited.');

      if (b.validUntil !== undefined) {
        const [ok] = await tx<{ ok: boolean }[]>`
          select ${b.validUntil}::date >= (now() at time zone t.timezone)::date
                 and ${b.validUntil}::date <= (now() at time zone t.timezone)::date + 365 as ok
          from public.tenants t`;
        if (!ok?.ok)
          throw new HttpError(400, 'The validity date must be between today and a year from now.');
        await tx`update public.quotes set valid_until = ${b.validUntil} where id = ${id}`;
      }
      if (b.notes !== undefined)
        await tx`update public.quotes set notes = ${b.notes} where id = ${id}`;
      if (b.lines) {
        const ids = [...new Set(b.lines.map((l) => l.priceItemId))];
        if (ids.length !== b.lines.length)
          throw new HttpError(400, 'Each item can appear only once; change its quantity instead.');
        const items = new Map((await loadConfirmedItems(tx, ids)).map((i) => [i.id, i]));
        const missing = ids.filter((i) => !items.has(i));
        if (missing.length)
          throw new HttpError(400, 'Only confirmed items from the price list can be quoted.');
        await writeQuoteLines(
          tx,
          { tenantId, quoteId: id, vatMode: q.vat_mode, vatRate: q.vat_rate },
          b.lines.map((l) => ({
            item: items.get(l.priceItemId)!,
            qty: l.qty,
            customerText: l.customerText ?? null,
          })),
        );
      }
      const doc = await loadQuoteDocument(tx, id);
      if (doc && q.draft_id && deps.actionSecret) {
        const token = signQuoteToken(
          { tenantId, quoteId: id, validUntil: doc.validUntil },
          deps.actionSecret,
        );
        await tx`update public.drafts
                 set body = ${quoteCoverFor(doc, quoteAcceptUrl(deps.publicApiUrl, token))}, edited = true
                 where id = ${q.draft_id}`;
      }
      await audit(tx, tenantId, req.user!.userId, 'quote.edited', 'quote', id, {
        fields: Object.keys(b),
      });
      const [out] = await selectQuotes(tx, tx`q.id = ${id}`);
      return out;
    }),
  );
}
