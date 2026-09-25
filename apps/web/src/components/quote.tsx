'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { money, QUOTE_STATUS, qtyText, shortDate, type PriceItem, type Quote } from '@/lib/quotes';
import { Badge, Button, cx, ErrorText, inputClass, useAction, useLoad } from './ui';

interface EditLine {
  key: string;
  priceItemId: string;
  name: string;
  unit: string;
  unitPriceCents: number;
  qty: string;
  customerText: string | null;
}

function Totals({
  q,
}: {
  q: Pick<
    Quote,
    'subtotal_cents' | 'vat_cents' | 'total_cents' | 'vat_mode' | 'vat_rate' | 'currency'
  >;
}) {
  return (
    <dl className="mt-3 space-y-1 text-sm">
      {q.vat_mode !== 'inclusive' && (
        <div className="flex justify-between">
          <dt className="text-neutral-600">Subtotal</dt>
          <dd className="tabular-nums">{money(q.subtotal_cents, q.currency)}</dd>
        </div>
      )}
      {q.vat_mode === 'exclusive' && (
        <div className="flex justify-between">
          <dt className="text-neutral-600">VAT {q.vat_rate}%</dt>
          <dd className="tabular-nums">{money(q.vat_cents, q.currency)}</dd>
        </div>
      )}
      <div className="flex justify-between border-t border-neutral-200 pt-1 text-base font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{money(q.total_cents, q.currency)}</dd>
      </div>
      {q.vat_mode === 'inclusive' && (
        <div className="flex justify-between text-xs text-neutral-500">
          <dt>of which VAT {q.vat_rate}%</dt>
          <dd className="tabular-nums">{money(q.vat_cents, q.currency)}</dd>
        </div>
      )}
    </dl>
  );
}

/** A quote: read-only once sent; editable (lines, notes, validity) while it waits for approval. */
export function QuoteBlock({
  quote,
  tenantId,
  onChange,
}: {
  quote: Quote;
  tenantId: string;
  onChange: () => void;
}) {
  const editable = quote.status === 'pending_approval';
  const [editing, setEditing] = useState(false);
  const st = QUOTE_STATUS[quote.status];

  return (
    <section
      className="rounded-lg bg-white p-3 ring-1 ring-neutral-200"
      aria-label={`Quote ${quote.number}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Quote {quote.number}</span>
        <Badge tone={st.tone}>{st.text}</Badge>
        <span className="ml-auto text-xs text-neutral-500">
          Valid until {shortDate(quote.valid_until)}
        </span>
      </div>
      {editing ? (
        <QuoteEditor
          quote={quote}
          tenantId={tenantId}
          onDone={() => {
            setEditing(false);
            onChange();
          }}
        />
      ) : (
        <>
          <ul className="mt-2 divide-y divide-neutral-100">
            {quote.lines.map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <div className="flex gap-3">
                  <span className="min-w-0 flex-1 font-medium">{l.name}</span>
                  <span className="tabular-nums">{money(l.line_total_cents, quote.currency)}</span>
                </div>
                <div className="text-xs text-neutral-500">
                  {qtyText(l.qty)} {l.unit} × {money(l.unit_price_cents, quote.currency)}
                  {l.customer_text && <> · asked: “{l.customer_text}”</>}
                </div>
              </li>
            ))}
          </ul>
          <Totals q={quote} />
          {quote.notes && (
            <p className="mt-2 text-sm whitespace-pre-wrap text-neutral-700">{quote.notes}</p>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            Every price comes from your price list; totals are calculated, not written by the AI.
            {quote.viewed_at && <> Viewed {shortDate(quote.viewed_at)}.</>}
            {quote.accepted_at && <> Accepted {shortDate(quote.accepted_at)}.</>}
          </p>
          {editable && (
            <Button variant="secondary" className="mt-2" onClick={() => setEditing(true)}>
              Edit quote
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function QuoteEditor({
  quote,
  tenantId,
  onDone,
}: {
  quote: Quote;
  tenantId: string;
  onDone: () => void;
}) {
  const items = useLoad(
    () => api<PriceItem[]>(`/v1/tenants/${tenantId}/price-items?status=confirmed`),
    [tenantId],
  );
  const [lines, setLines] = useState<EditLine[]>(() =>
    quote.lines
      .filter((l) => l.price_item_id)
      .map((l) => ({
        key: l.id,
        priceItemId: l.price_item_id!,
        name: l.name,
        unit: l.unit,
        unitPriceCents: l.unit_price_cents,
        qty: qtyText(l.qty),
        customerText: l.customer_text,
      })),
  );
  const [notes, setNotes] = useState(quote.notes ?? '');
  const [validUntil, setValidUntil] = useState(quote.valid_until.slice(0, 10));
  const [adding, setAdding] = useState('');
  const save = useAction();

  // Preview totals the way the API calculates them (the API's figures are what is saved).
  const preview = useMemo(() => {
    const subtotal = lines.reduce(
      (s, l) => s + Math.round(Number(l.qty.replace(',', '.')) * l.unitPriceCents || 0),
      0,
    );
    const rate = quote.vat_rate / 100;
    const vat =
      quote.vat_mode === 'exclusive'
        ? Math.round(subtotal * rate)
        : quote.vat_mode === 'inclusive'
          ? Math.round(subtotal - subtotal / (1 + rate))
          : 0;
    return {
      subtotal_cents: subtotal,
      vat_cents: vat,
      total_cents: quote.vat_mode === 'exclusive' ? subtotal + vat : subtotal,
      vat_mode: quote.vat_mode,
      vat_rate: quote.vat_rate,
      currency: quote.currency,
    };
  }, [lines, quote]);

  const set = (key: string, qty: string) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty } : l)));

  return (
    <div className="mt-2">
      <ul className="divide-y divide-neutral-100">
        {lines.map((l) => (
          <li key={l.key} className="flex items-center gap-2 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{l.name}</div>
              <div className="text-xs text-neutral-500">
                {money(l.unitPriceCents, quote.currency)} / {l.unit}
              </div>
            </div>
            <input
              aria-label={`Quantity of ${l.name}`}
              className={cx(
                inputClass.replace('w-full', 'w-20'),
                'shrink-0 py-2 text-right tabular-nums',
              )}
              inputMode="decimal"
              value={l.qty}
              onChange={(e) => set(l.key, e.target.value)}
            />
            <button
              type="button"
              aria-label={`Remove ${l.name}`}
              className="flex h-11 w-9 items-center justify-center rounded-lg text-lg text-neutral-500 hover:bg-neutral-100"
              onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <select
          aria-label="Add an item from your price list"
          className={cx(inputClass, 'min-w-0 flex-1 py-2')}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        >
          <option value="">Add an item from your price list…</option>
          {(items.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {money(i.unit_price_cents, quote.currency)} / {i.unit}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          disabled={!adding}
          onClick={() => {
            const it = items.data?.find((i) => i.id === adding);
            if (!it) return;
            setLines((ls) => [
              ...ls,
              {
                key: `new-${it.id}-${ls.length}`,
                priceItemId: it.id,
                name: it.name,
                unit: it.unit,
                unitPriceCents: it.unit_price_cents,
                qty: String(it.min_qty ?? 1),
                customerText: null,
              },
            ]);
            setAdding('');
          }}
        >
          Add
        </Button>
      </div>
      <Totals q={preview} />
      <label className="mt-3 block text-sm">
        <span className="mb-1 block font-medium text-neutral-800">Notes on the quote</span>
        <textarea
          className={cx(inputClass, 'min-h-20 text-sm')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block font-medium text-neutral-800">Valid until</span>
        <input
          type="date"
          className={inputClass}
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
        />
      </label>
      <p className="mt-2 text-xs text-neutral-500">
        Saving recalculates the totals and updates the message to the customer to match.
      </p>
      <ErrorText>{save.error}</ErrorText>
      <div className="mt-3 flex gap-2">
        <Button
          disabled={save.busy || lines.length === 0}
          onClick={() =>
            void save.run(async () => {
              await api(`/v1/tenants/${tenantId}/quotes/${quote.id}`, {
                method: 'PATCH',
                body: {
                  lines: lines.map((l) => ({
                    priceItemId: l.priceItemId,
                    qty: Number(l.qty.replace(',', '.')),
                    customerText: l.customerText,
                  })),
                  notes: notes.trim() || null,
                  validUntil,
                },
              });
              onDone();
            })
          }
        >
          {save.busy ? 'Saving…' : 'Save quote'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
