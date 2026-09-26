'use client';

/** Quotes setup: price list, import and quote settings (on the Quotes page). */

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  inputClass,
  Loading,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  money,
  shortDate,
  VAT_LABEL,
  type PriceImport,
  type PriceItem,
  type QuoteSettings,
  type VatMode,
} from '@/lib/quotes';

const toPrice = (cents: number) => (cents / 100).toFixed(2);

interface ItemForm {
  name: string;
  description: string;
  unit: string;
  unitPrice: string;
  minQty: string;
  maxQty: string;
  vatNote: string;
}
const emptyItem: ItemForm = {
  name: '',
  description: '',
  unit: 'pcs',
  unitPrice: '',
  minQty: '',
  maxQty: '',
  vatNote: '',
};
const itemToForm = (i: PriceItem): ItemForm => ({
  name: i.name,
  description: i.description ?? '',
  unit: i.unit,
  unitPrice: toPrice(i.unit_price_cents),
  minQty: i.min_qty?.toString() ?? '',
  maxQty: i.max_qty?.toString() ?? '',
  vatNote: i.vat_note ?? '',
});
const formToBody = (f: ItemForm) => ({
  name: f.name,
  description: f.description || null,
  unit: f.unit,
  unitPrice: f.unitPrice,
  minQty: f.minQty ? Number(f.minQty.replace(',', '.')) : null,
  maxQty: f.maxQty ? Number(f.maxQty.replace(',', '.')) : null,
  vatNote: f.vatNote || null,
});

function ItemEditor({
  initial,
  currency,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ItemForm;
  currency: string;
  submitLabel: string;
  onSubmit: (f: ItemForm) => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const a = useAction();
  const set = (k: keyof ItemForm, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form
      className="space-y-3 rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(() => onSubmit(f));
      }}
    >
      <Field label="Name">
        <input
          className={inputClass}
          required
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>
      <Field label="Description (optional)">
        <input
          className={inputClass}
          value={f.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Unit price (${currency})`}>
          <input
            className={inputClass}
            required
            inputMode="decimal"
            placeholder="24.00"
            value={f.unitPrice}
            onChange={(e) => set('unitPrice', e.target.value)}
          />
        </Field>
        <Field label="Unit">
          <input
            className={inputClass}
            required
            value={f.unit}
            onChange={(e) => set('unit', e.target.value)}
          />
        </Field>
        <Field label="Min. quantity">
          <input
            className={inputClass}
            inputMode="decimal"
            value={f.minQty}
            onChange={(e) => set('minQty', e.target.value)}
          />
        </Field>
        <Field label="Max. quantity">
          <input
            className={inputClass}
            inputMode="decimal"
            value={f.maxQty}
            onChange={(e) => set('maxQty', e.target.value)}
          />
        </Field>
      </div>
      <Field label="VAT note (optional)" hint="Shown on the quote line, e.g. “reduced rate 12%”.">
        <input
          className={inputClass}
          value={f.vatNote}
          onChange={(e) => set('vatNote', e.target.value)}
        />
      </Field>
      <ErrorText>{a.error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" disabled={a.busy}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PriceList({ tenantId, currency }: { tenantId: string; currency: string }) {
  const base = `/v1/tenants/${tenantId}/price-items`;
  const { data, error, reload } = useLoad(() => api<PriceItem[]>(base), [tenantId]);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const act = useAction();
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const drafts = data.filter((i) => i.status === 'draft');
  const q = query.trim().toLowerCase();
  const shown = data.filter(
    (i) =>
      !q || i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q),
  );

  return (
    <Card
      title={`Price list (${data.filter((i) => i.status === 'confirmed').length} items)`}
      action={
        !adding && (
          <Button variant="ghost" className="min-h-9 px-2" onClick={() => setAdding(true)}>
            + Add item
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-neutral-600">
        Quotes use only confirmed items, at exactly these prices. Nothing else can appear on a
        quote.
      </p>
      {drafts.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="flex-1">
            {drafts.length} {drafts.length === 1 ? 'item' : 'items'} read from an upload: check and
            confirm.
          </span>
          <Button
            variant="secondary"
            className="min-h-9"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api(`${base}/confirm-all`, { method: 'POST', body: {} });
                await reload();
              })
            }
          >
            Confirm all
          </Button>
        </div>
      )}
      {adding && (
        <div className="mb-3">
          <ItemEditor
            initial={emptyItem}
            currency={currency}
            submitLabel="Add to price list"
            onCancel={() => setAdding(false)}
            onSubmit={async (f) => {
              await api(base, { method: 'POST', body: formToBody(f) });
              setAdding(false);
              await reload();
            }}
          />
        </div>
      )}
      {data.length > 6 && (
        <input
          className={cx(inputClass, 'mb-2')}
          type="search"
          placeholder="Search the price list"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <ErrorText>{act.error}</ErrorText>
      {data.length === 0 && !adding && (
        <p className="text-sm text-neutral-500">
          No items yet. Add them one by one or import a file below.
        </p>
      )}
      <ul className="divide-y divide-neutral-100">
        {shown.map((i) =>
          editing === i.id ? (
            <li key={i.id} className="py-3">
              <ItemEditor
                initial={itemToForm(i)}
                currency={currency}
                submitLabel={i.status === 'draft' ? 'Save and confirm' : 'Save'}
                onCancel={() => setEditing(null)}
                onSubmit={async (f) => {
                  await api(`${base}/${i.id}`, {
                    method: 'PATCH',
                    body: { ...formToBody(f), status: 'confirmed' },
                  });
                  setEditing(null);
                  await reload();
                }}
              />
            </li>
          ) : (
            <li
              key={i.id}
              className={cx('py-3', i.status === 'draft' && '-mx-2 rounded-lg bg-amber-50/60 px-2')}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{i.name}</span>
                    {i.status === 'draft' && <Badge tone="amber">To confirm</Badge>}
                  </div>
                  {i.description && <p className="text-xs text-neutral-600">{i.description}</p>}
                  <p className="text-xs text-neutral-500">
                    {[
                      i.min_qty !== null && `min ${i.min_qty}`,
                      i.max_qty !== null && `max ${i.max_qty}`,
                      i.vat_note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">
                    {money(i.unit_price_cents, currency)}
                  </div>
                  <div className="text-xs text-neutral-500">per {i.unit}</div>
                </div>
              </div>
              <div className="mt-1 flex gap-3 text-sm">
                {i.status === 'draft' && (
                  <button
                    className="font-medium text-indigo-700"
                    onClick={() =>
                      void act.run(async () => {
                        await api(`${base}/${i.id}`, {
                          method: 'PATCH',
                          body: { status: 'confirmed' },
                        });
                        await reload();
                      })
                    }
                  >
                    Confirm
                  </button>
                )}
                <button className="text-indigo-700" onClick={() => setEditing(i.id)}>
                  Edit
                </button>
                <button
                  className="text-neutral-500"
                  onClick={() =>
                    void act.run(async () => {
                      await api(`${base}/${i.id}`, { method: 'DELETE', body: {} });
                      await reload();
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </Card>
  );
}

interface CsvResult {
  rows: { line: number; name?: string; unit_price_cents?: number; unit?: string; error?: string }[];
  imported: number;
}

export function Imports({
  tenantId,
  currency,
  onImported,
}: {
  tenantId: string;
  currency: string;
  onImported: () => void;
}) {
  const imports = useLoad(
    () => api<PriceImport[]>(`/v1/tenants/${tenantId}/price-imports`),
    [tenantId],
  );
  const [csv, setCsv] = useState<{ name: string; text: string; result: CsvResult } | null>(null);
  const a = useAction();

  const readFile = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error('The file could not be read.'));
      r.readAsDataURL(f);
    });

  return (
    <Card title="Import">
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium">From a spreadsheet (CSV)</p>
          <p className="mb-2 text-xs text-neutral-500">
            Columns: name, description, unit, unit_price, min_qty, max_qty, vat_note. Name and
            unit_price are required; comma or semicolon separated.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            className="block w-full text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void a.run(async () => {
                const text = await f.text();
                const result = await api<CsvResult>(`/v1/tenants/${tenantId}/price-items/csv`, {
                  method: 'POST',
                  body: { csv: text, dryRun: true },
                });
                setCsv({ name: f.name, text, result });
              });
            }}
          />
          {csv && (
            <div className="mt-2 rounded-lg bg-neutral-50 p-3 text-sm ring-1 ring-neutral-200">
              <p className="font-medium">{csv.name}</p>
              <ul className="mt-1 max-h-48 space-y-1 overflow-auto text-xs">
                {csv.result.rows.map((r) => (
                  <li key={r.line} className={r.error ? 'text-red-700' : 'text-neutral-700'}>
                    Line {r.line}:{' '}
                    {r.error ??
                      `${r.name} · ${money(r.unit_price_cents ?? 0, currency)} / ${r.unit}`}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button
                  disabled={a.busy || !csv.result.rows.some((r) => !r.error)}
                  onClick={() =>
                    void a.run(async () => {
                      await api(`/v1/tenants/${tenantId}/price-items/csv`, {
                        method: 'POST',
                        body: { csv: csv.text, dryRun: false },
                      });
                      setCsv(null);
                      onImported();
                    })
                  }
                >
                  Import {csv.result.rows.filter((r) => !r.error).length} items
                </Button>
                <Button variant="ghost" onClick={() => setCsv(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-medium">From a price list document (PDF or Word)</p>
          <p className="mb-2 text-xs text-neutral-500">
            Noctiv reads the items and prices into the list above as drafts. Nothing is quoted until
            you confirm each item.
          </p>
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="block w-full text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void a.run(async () => {
                const dataUrl = await readFile(f);
                await api(`/v1/tenants/${tenantId}/price-imports`, {
                  method: 'POST',
                  body: { fileName: f.name, contentBase64: dataUrl.split(',')[1] ?? '' },
                });
                await imports.reload();
              });
            }}
          />
          {(imports.data ?? []).length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-neutral-600">
              {imports.data!.map((i) => (
                <li key={i.id}>
                  {i.file_name} · {shortDate(i.created_at)} ·{' '}
                  {i.status === 'ready' ? (
                    `${i.item_count} items read`
                  ) : i.status === 'failed' ? (
                    <span className="text-red-700">{i.error ?? 'could not be read'}</span>
                  ) : (
                    'reading…'
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorText>{a.error}</ErrorText>
      </div>
    </Card>
  );
}

export function QuoteSettingsCard({
  s,
  tenantId,
  reload,
}: {
  s: QuoteSettings;
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const [f, setF] = useState({
    currency: s.quotes_currency,
    vatMode: s.quotes_vat_mode,
    vatRate: String(s.quotes_vat_rate),
    validityDays: String(s.quotes_validity_days),
    limit: toPrice(s.quotes_auto_send_limit_cents),
  });
  const a = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Quote settings">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(`/v1/tenants/${tenantId}`, {
              method: 'PATCH',
              body: {
                quotesCurrency: f.currency,
                quotesVatMode: f.vatMode,
                quotesVatRate: Number(f.vatRate.replace(',', '.')),
                quotesValidityDays: Number(f.validityDays),
                quotesAutoSendLimit: f.limit,
              },
            });
            await reload();
            setSaved(true);
          });
        }}
      >
        {/* A fieldset, not <Field> (a <label>): the group label must not attach to the first radio (QA #27). */}
        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-neutral-800">VAT</legend>
          <div className="space-y-1">
            {(['exclusive', 'inclusive', 'none'] as VatMode[]).map((m) => (
              <label key={m} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="quotes-vat-mode"
                  checked={f.vatMode === m}
                  onChange={() => setF({ ...f, vatMode: m })}
                />
                {VAT_LABEL[m]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          {f.vatMode !== 'none' && (
            <Field label="VAT rate (%)">
              <input
                className={inputClass}
                inputMode="decimal"
                value={f.vatRate}
                onChange={(e) => setF({ ...f, vatRate: e.target.value })}
              />
            </Field>
          )}
          <Field label="Currency">
            <select
              className={inputClass}
              value={f.currency}
              onChange={(e) => setF({ ...f, currency: e.target.value })}
            >
              {['EUR', 'USD', 'GBP', 'SEK', 'NOK', 'DKK', 'PLN', 'CHF'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Valid for (days)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={f.validityDays}
              onChange={(e) => setF({ ...f, validityDays: e.target.value })}
            />
          </Field>
          <Field label={`Auto-send up to (${f.currency})`}>
            <input
              className={inputClass}
              inputMode="decimal"
              value={f.limit}
              onChange={(e) => setF({ ...f, limit: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-neutral-500">
          In modes 2 and 3 a quote goes out on its own only when every line is on your price list
          and the total is at or under this amount. Everything else waits for your approval. In mode
          1 you approve every quote.
        </p>
        <ErrorText>{a.error}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={a.busy}>
            Save
          </Button>
          {saved && <span className="text-sm text-green-700">Saved.</span>}
        </div>
      </form>
    </Card>
  );
}
