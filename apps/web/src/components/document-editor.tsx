'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  inputClass,
  Notice,
  useAction,
  useLoad,
} from './ui';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import {
  DOC_LANGUAGES,
  DOC_STATUS,
  DOC_TYPE,
  editable,
  parseNumber,
  parsePrice,
  priceText,
  type CmrData,
  type CmrGoods,
  type DeliveryLine,
  type Doc,
  type InvoiceLine,
} from '@/lib/documents';
import { money, type PriceItem } from '@/lib/quotes';
import { DocumentPayment } from './payments';

// ------------------------------------------------------------------ helpers
type Obj = Record<string, unknown>;
const getPath = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], o);
function setPath<T>(o: T, path: string, value: unknown): T {
  const [k, ...rest] = path.split('.');
  const cur = (o as Obj)[k!];
  return { ...(o as Obj), [k!]: rest.length ? setPath(cur, rest.join('.'), value) : value } as T;
}

/** Client-side preview only; the API recomputes and stores the real totals. */
/**
 * The unit price the document will print: under reverse charge with
 * VAT-inclusive prices it is recalculated to net (as the API does).
 */
function printedUnitPrice(doc: Doc, reverseCharge: boolean, cents: number | null) {
  if (cents === null) return null;
  if (!reverseCharge || doc.vat_mode !== 'inclusive') return cents;
  const bp = Math.round(doc.vat_rate * 100);
  return Math.floor((2 * cents * 10_000 + 10_000 + bp) / (2 * (10_000 + bp)));
}
const lineTotal = (qty: number | null, unit: number | null) =>
  qty !== null && unit !== null ? Math.floor((2 * Math.round(qty * 100) * unit + 100) / 200) : null;

function previewTotals(doc: Doc, lines: InvoiceLine[], reverseCharge: boolean) {
  const sub = lines.reduce(
    (t, l) => t + (lineTotal(l.qty, printedUnitPrice(doc, reverseCharge, l.unitPriceCents)) ?? 0),
    0,
  );
  if (reverseCharge || doc.vat_mode === 'none') return { sub, vat: 0, total: sub };
  const bp = Math.round(doc.vat_rate * 100);
  if (doc.vat_mode === 'exclusive') {
    const vat = Math.floor((2 * sub * bp + 10_000) / 20_000);
    return { sub, vat, total: sub + vat };
  }
  const net = Math.floor((2 * sub * 10_000 + 10_000 + bp) / (2 * (10_000 + bp)));
  return { sub, vat: sub - net, total: sub };
}

// ------------------------------------------------------------ field widgets
interface Ctx {
  doc: Doc;
  data: Obj;
  set: (path: string, v: unknown) => void;
  locked: boolean;
}

/** A pre-filled field shows where its value came from in the customer's e-mail. */
function Source({ ctx, path }: { ctx: Ctx; path: string }) {
  const p = ctx.doc.prefill?.[path];
  if (!p) return null;
  return (
    <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
      From the e-mail: “{p.source}”
    </span>
  );
}
const prefilled = (ctx: Ctx, path: string) => Boolean(ctx.doc.prefill?.[path]);
const fieldClass = (ctx: Ctx, path: string) =>
  cx(inputClass, prefilled(ctx, path) && 'border-amber-400 bg-amber-50/40');

function Text({
  ctx,
  path,
  label,
  multiline,
  hint,
  placeholder,
}: {
  ctx: Ctx;
  path: string;
  label: string;
  multiline?: boolean;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const v = (getPath(ctx.data, path) as string | null) ?? '';
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea
          className={cx(fieldClass(ctx, path), 'min-h-20')}
          value={v}
          disabled={ctx.locked}
          placeholder={placeholder}
          onChange={(e) => ctx.set(path, e.target.value)}
        />
      ) : (
        <input
          className={fieldClass(ctx, path)}
          value={v}
          disabled={ctx.locked}
          placeholder={placeholder}
          onChange={(e) => ctx.set(path, e.target.value)}
        />
      )}
      <Source ctx={ctx} path={path} />
    </Field>
  );
}

function DateField({
  ctx,
  path,
  label,
  hint,
}: {
  ctx: Ctx;
  path: string;
  label: string;
  hint?: string;
}) {
  const v = (getPath(ctx.data, path) as string | null) ?? '';
  return (
    <Field label={label} hint={hint}>
      <input
        type="date"
        className={fieldClass(ctx, path)}
        value={v.slice(0, 10)}
        disabled={ctx.locked}
        onChange={(e) => ctx.set(path, e.target.value || null)}
      />
      <Source ctx={ctx} path={path} />
    </Field>
  );
}

function NumberField({ ctx, path, label }: { ctx: Ctx; path: string; label: string }) {
  const v = getPath(ctx.data, path) as number | null;
  const [text, setText] = useState(
    v === null || v === undefined ? '' : String(v).replace('.', ','),
  );
  return (
    <Field label={label}>
      <input
        className={fieldClass(ctx, path)}
        inputMode="decimal"
        value={text}
        disabled={ctx.locked}
        onChange={(e) => {
          setText(e.target.value);
          ctx.set(path, parseNumber(e.target.value));
        }}
      />
      <Source ctx={ctx} path={path} />
    </Field>
  );
}

function PartyFields({ ctx, base, withEmail }: { ctx: Ctx; base: string; withEmail?: boolean }) {
  return (
    <div className="space-y-3">
      <Text ctx={ctx} path={`${base}.name`} label="Name" />
      <Text ctx={ctx} path={`${base}.address`} label="Address" multiline />
      <div className="grid grid-cols-2 gap-3">
        <Text ctx={ctx} path={`${base}.regNo`} label="Reg. no." />
        <Text ctx={ctx} path={`${base}.vatNo`} label="VAT no." />
      </div>
      {withEmail && <Text ctx={ctx} path={`${base}.email`} label="E-mail" />}
    </div>
  );
}

function SellerCard({ doc }: { doc: Doc }) {
  const s = doc.seller;
  const rows: [string, string | null][] = [
    ['Name', s.legalName],
    ['Address', s.legalAddress],
    ['Reg. no.', s.regNo],
    ['VAT no.', s.vatNo],
    ...(doc.type === 'invoice'
      ? ([
          ['Bank', s.bankName],
          ['IBAN', s.iban],
          ['BIC', s.bic],
        ] as [string, string | null][])
      : []),
  ];
  return (
    <Card
      title={
        doc.type === 'cmr'
          ? 'Your details'
          : doc.type === 'invoice'
            ? 'Seller (you)'
            : 'Supplier (you)'
      }
      action={
        <Link className="text-sm text-indigo-700" href="/settings/documents">
          Edit
        </Link>
      }
    >
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{k}</dt>
            <dd className={cx('min-w-0 break-words', !v && 'text-red-700')}>{v || 'missing'}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ------------------------------------------------------------ line editors
function InvoiceLines({ ctx, tenantId }: { ctx: Ctx; tenantId: string }) {
  const lines = (ctx.data.lines as InvoiceLine[]) ?? [];
  const [picking, setPicking] = useState(false);
  const items = useLoad(
    () =>
      picking
        ? api<PriceItem[]>(`/v1/tenants/${tenantId}/price-items?status=confirmed`)
        : Promise.resolve([] as PriceItem[]),
    [picking, tenantId],
  );
  const setLines = (l: InvoiceLine[]) => ctx.set('lines', l);
  const upd = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-3">
      {lines.map((l, i) => (
        <div key={i} className="space-y-2 rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200">
          <input
            aria-label={`Item ${i + 1}`}
            className={inputClass}
            value={l.name}
            placeholder="Item"
            disabled={ctx.locked}
            onChange={(e) => upd(i, { name: e.target.value })}
          />
          <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-2">
            <input
              aria-label={`Quantity of line ${i + 1}`}
              className={inputClass}
              inputMode="decimal"
              defaultValue={l.qty === null ? '' : String(l.qty).replace('.', ',')}
              placeholder="Qty"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { qty: parseNumber(e.target.value) })}
            />
            <input
              aria-label={`Unit of line ${i + 1}`}
              className={inputClass}
              value={l.unit}
              placeholder="Unit"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { unit: e.target.value })}
            />
            <input
              aria-label={`Unit price of line ${i + 1}`}
              className={inputClass}
              inputMode="decimal"
              defaultValue={priceText(l.unitPriceCents)}
              placeholder="Price"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { unitPriceCents: parsePrice(e.target.value) })}
            />
          </div>
          <div className="flex items-center justify-between text-sm">
            {!ctx.locked ? (
              <button
                type="button"
                className="text-red-700"
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            ) : (
              <span />
            )}
            <span className="font-semibold tabular-nums">
              {(() => {
                const up = printedUnitPrice(
                  ctx.doc,
                  Boolean(ctx.data.reverseCharge),
                  l.unitPriceCents,
                );
                const lt = lineTotal(l.qty, up);
                if (lt === null) return '—';
                return up !== l.unitPriceCents
                  ? `${money(up!, ctx.doc.currency)} net × ${l.qty} = ${money(lt, ctx.doc.currency)}`
                  : money(lt, ctx.doc.currency);
              })()}
            </span>
          </div>
        </div>
      ))}
      {!ctx.locked && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setLines([...lines, { name: '', unit: 'pcs', qty: 1, unitPriceCents: null }])
            }
          >
            Add line
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPicking((p) => !p)}>
            {picking ? 'Close price list' : 'From price list'}
          </Button>
        </div>
      )}
      {picking && (
        <ul className="max-h-64 divide-y divide-neutral-100 overflow-auto rounded-lg ring-1 ring-neutral-200">
          {(items.data ?? []).map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50"
                onClick={() => {
                  setLines([
                    ...lines,
                    { name: it.name, unit: it.unit, qty: 1, unitPriceCents: it.unit_price_cents },
                  ]);
                  setPicking(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className="tabular-nums text-neutral-600">
                  {money(it.unit_price_cents, ctx.doc.currency)} / {it.unit}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryLines({ ctx }: { ctx: Ctx }) {
  const lines = (ctx.data.lines as DeliveryLine[]) ?? [];
  const priced = Boolean(ctx.data.withPrices);
  const setLines = (l: DeliveryLine[]) => ctx.set('lines', l);
  const upd = (i: number, patch: Partial<DeliveryLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const t = priced ? previewTotals(ctx.doc, lines, false) : null;
  const cur = ctx.doc.currency;
  return (
    <div className="space-y-3">
      {lines.map((l, i) => (
        <div key={i} className="space-y-2">
          <div className="grid grid-cols-[1fr_4.5rem_4.5rem] gap-2">
            <input
              aria-label={`Item ${i + 1}`}
              className={inputClass}
              value={l.name}
              placeholder="Item"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { name: e.target.value })}
            />
            <input
              aria-label={`Quantity of line ${i + 1}`}
              className={inputClass}
              inputMode="decimal"
              defaultValue={l.qty === null ? '' : String(l.qty).replace('.', ',')}
              placeholder="Qty"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { qty: parseNumber(e.target.value) })}
            />
            <input
              aria-label={`Unit of line ${i + 1}`}
              className={inputClass}
              value={l.unit}
              placeholder="Unit"
              disabled={ctx.locked}
              onChange={(e) => upd(i, { unit: e.target.value })}
            />
          </div>
          {priced && (
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
              <input
                aria-label={`Unit price of line ${i + 1}`}
                className={inputClass}
                inputMode="decimal"
                defaultValue={priceText(l.unitPriceCents)}
                placeholder={`Unit price (${cur})`}
                disabled={ctx.locked}
                onChange={(e) => upd(i, { unitPriceCents: parsePrice(e.target.value) })}
              />
              <span className="min-w-20 text-right text-sm font-semibold tabular-nums">
                {(() => {
                  const lt = lineTotal(l.qty, l.unitPriceCents);
                  return lt === null ? '—' : money(lt, cur);
                })()}
              </span>
            </div>
          )}
        </div>
      ))}
      {!ctx.locked && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setLines([...lines, { name: '', unit: 'pcs', qty: 1, unitPriceCents: null }])
          }
        >
          Add line
        </Button>
      )}
      {t && (
        <dl className="space-y-1 border-t border-neutral-200 pt-3 text-sm">
          {ctx.doc.vat_mode === 'exclusive' && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">
                Subtotal · VAT {ctx.doc.vat_rate}% {money(t.vat, cur)}
              </dt>
              <dd className="tabular-nums">{money(t.sub, cur)}</dd>
            </div>
          )}
          <div className="flex justify-between text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(t.total, cur)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function CmrGoodsEditor({ ctx }: { ctx: Ctx }) {
  const goods = (ctx.data.goods as CmrGoods[]) ?? [];
  return (
    <div className="space-y-3">
      {goods.map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200">
          <p className="text-xs font-semibold text-neutral-500">Goods line {i + 1}</p>
          <Text ctx={ctx} path={`goods.${i}.nature`} label="9 · Nature of the goods" />
          <div className="grid grid-cols-2 gap-3">
            <NumberField ctx={ctx} path={`goods.${i}.packages`} label="7 · Packages" />
            <Text ctx={ctx} path={`goods.${i}.packing`} label="8 · Packing" />
            <NumberField ctx={ctx} path={`goods.${i}.grossKg`} label="11 · Gross kg" />
            <NumberField ctx={ctx} path={`goods.${i}.volumeM3`} label="12 · Volume m³" />
            <Text ctx={ctx} path={`goods.${i}.marks`} label="6 · Marks and nos." />
            <Text ctx={ctx} path={`goods.${i}.statNo`} label="10 · Statistical no." />
          </div>
          {!ctx.locked && goods.length > 1 && (
            <button
              type="button"
              className="text-sm text-red-700"
              onClick={() =>
                ctx.set(
                  'goods',
                  goods.filter((_, j) => j !== i),
                )
              }
            >
              Remove goods line
            </button>
          )}
        </div>
      ))}
      {!ctx.locked && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            ctx.set('goods', [
              ...goods,
              {
                marks: '',
                packages: null,
                packing: '',
                nature: '',
                statNo: '',
                grossKg: null,
                volumeM3: null,
              },
            ])
          }
        >
          Add goods line
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- type forms
function InvoiceForm({ ctx, tenantId }: { ctx: Ctx; tenantId: string }) {
  const lines = (ctx.data.lines as InvoiceLine[]) ?? [];
  const rc = Boolean(ctx.data.reverseCharge);
  const t = previewTotals(ctx.doc, lines, rc);
  const cur = ctx.doc.currency;
  return (
    <>
      <SellerCard doc={ctx.doc} />
      <Card title="Buyer">
        <PartyFields ctx={ctx} base="buyer" withEmail />
      </Card>
      <Card title="Lines">
        <InvoiceLines ctx={ctx} tenantId={tenantId} />
        <dl className="mt-4 space-y-1 border-t border-neutral-200 pt-3 text-sm">
          {ctx.doc.vat_mode === 'exclusive' && !rc && (
            <>
              <div className="flex justify-between">
                <dt className="text-neutral-500">Subtotal</dt>
                <dd className="tabular-nums">{money(t.sub, cur)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-500">VAT {ctx.doc.vat_rate}%</dt>
                <dd className="tabular-nums">{money(t.vat, cur)}</dd>
              </div>
            </>
          )}
          <div className="flex justify-between text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(t.total, cur)}</dd>
          </div>
          {ctx.doc.vat_mode === 'inclusive' && !rc && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">of which VAT {ctx.doc.vat_rate}%</dt>
              <dd className="tabular-nums">{money(t.vat, cur)}</dd>
            </div>
          )}
          {rc && (
            <p className="text-xs text-neutral-500">Reverse charge: no VAT on this invoice.</p>
          )}
        </dl>
      </Card>
      <Card title="Payment">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <DateField ctx={ctx} path="dueDate" label="Due date" />
            <DateField
              ctx={ctx}
              path="supplyDate"
              label="Supply date"
              hint="If not the issue date"
            />
          </div>
          <Text
            ctx={ctx}
            path="paymentReference"
            label="Payment reference"
            hint="Empty: the invoice number is used."
          />
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={rc}
              disabled={ctx.locked}
              onChange={(e) => ctx.set('reverseCharge', e.target.checked)}
            />
            <span>
              Reverse charge (EU business buyer)
              <span className="block text-xs text-neutral-500">
                No VAT; the invoice carries the standard note. Needs both VAT numbers.
                {ctx.doc.vat_mode === 'inclusive' &&
                  ' Your prices include VAT, so each price is recalculated to net.'}
              </span>
            </span>
          </label>
          <Text ctx={ctx} path="notes" label="Notes (optional)" multiline />
        </div>
      </Card>
    </>
  );
}

function DeliveryNoteForm({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <SellerCard doc={ctx.doc} />
      <Card title="Receiver">
        <PartyFields ctx={ctx} base="receiver" />
      </Card>
      <Card title="Delivery">
        <div className="space-y-3">
          <Text ctx={ctx} path="loadingAddress" label="Loading address" multiline />
          <Text ctx={ctx} path="deliveryAddress" label="Delivery address" multiline />
          <DateField ctx={ctx} path="deliveryDate" label="Delivery date" />
          <div className="grid grid-cols-2 gap-3">
            <Text ctx={ctx} path="vehicle" label="Vehicle (optional)" />
            <Text ctx={ctx} path="driver" label="Driver (optional)" />
          </div>
        </div>
      </Card>
      <Card title="Goods">
        <label className="mb-3 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={Boolean(ctx.data.withPrices)}
            disabled={ctx.locked}
            onChange={(e) => ctx.set('withPrices', e.target.checked)}
          />
          <span>
            Show prices and totals (pavadzīme-rēķins)
            <span className="block text-xs text-neutral-500">
              The delivery note then also works as the invoice: it has a due date and is marked
              paid, not delivered.
            </span>
          </span>
        </label>
        <DeliveryLines ctx={ctx} />
        {Boolean(ctx.data.withPrices) && (
          <div className="mt-3">
            <DateField
              ctx={ctx}
              path="dueDate"
              label="Payment due"
              hint="Printed with the bank details"
            />
          </div>
        )}
      </Card>
      <Card title="Notes">
        <Text ctx={ctx} path="notes" label="Notes (optional)" multiline />
      </Card>
    </>
  );
}

function CmrPlaceFields({ ctx, base }: { ctx: Ctx; base: string }) {
  return (
    <div className="space-y-3">
      <Text ctx={ctx} path={`${base}.name`} label="Name" />
      <Text ctx={ctx} path={`${base}.address`} label="Address" multiline />
      <Text ctx={ctx} path={`${base}.country`} label="Country" />
    </div>
  );
}

function CmrForm({ ctx }: { ctx: Ctx }) {
  const d = ctx.data as unknown as CmrData;
  return (
    <>
      <Card title="1 · Sender">
        <CmrPlaceFields ctx={ctx} base="sender" />
      </Card>
      <Card title="2 · Consignee">
        <CmrPlaceFields ctx={ctx} base="consignee" />
      </Card>
      <Card title="3 · Place of delivery">
        <div className="grid grid-cols-[1.6fr_1fr] gap-3">
          <Text ctx={ctx} path="deliveryPlace.place" label="Place" />
          <Text ctx={ctx} path="deliveryPlace.country" label="Country" />
        </div>
      </Card>
      <Card title="4 · Taking over the goods">
        <div className="space-y-3">
          <div className="grid grid-cols-[1.6fr_1fr] gap-3">
            <Text ctx={ctx} path="takingOver.place" label="Place" />
            <Text ctx={ctx} path="takingOver.country" label="Country" />
          </div>
          <DateField ctx={ctx} path="takingOver.date" label="Date" />
        </div>
      </Card>
      <Card title="5 · Documents attached">
        <Text
          ctx={ctx}
          path="documentsAttached"
          label="Documents"
          placeholder="e.g. invoice INV-2026-0012"
        />
      </Card>
      <Card title="6–12 · Goods">
        <CmrGoodsEditor ctx={ctx} />
      </Card>
      <Card title="13–15 · Instructions and payment">
        <div className="space-y-3">
          <Text ctx={ctx} path="senderInstructions" label="13 · Sender's instructions" multiline />
          <Field label="14 · Payment for carriage">
            <select
              className={inputClass}
              value={d.carriagePayment ?? ''}
              disabled={ctx.locked}
              onChange={(e) => ctx.set('carriagePayment', e.target.value || null)}
            >
              <option value="">Not stated</option>
              <option value="paid">Carriage paid (franco)</option>
              <option value="forward">Carriage forward (non franco)</option>
            </select>
            <Source ctx={ctx} path="carriagePayment" />
          </Field>
          <Text ctx={ctx} path="cashOnDelivery" label="15 · Cash on delivery (optional)" />
        </div>
      </Card>
      <Card title="16–17 · Carrier">
        <div className="space-y-3">
          <CmrPlaceFields ctx={ctx} base="carrier" />
          <div className="grid grid-cols-2 gap-3">
            <Text ctx={ctx} path="vehicleTractor" label="Vehicle reg." />
            <Text ctx={ctx} path="vehicleTrailer" label="Trailer reg." />
          </div>
          <Text ctx={ctx} path="successiveCarriers" label="17 · Successive carriers (optional)" />
        </div>
      </Card>
      <Card title="18–21 · Remarks">
        <div className="space-y-3">
          <Text
            ctx={ctx}
            path="carrierReservations"
            label="18 · Carrier's reservations"
            multiline
          />
          <Text ctx={ctx} path="specialAgreements" label="19 · Special agreements" multiline />
          <Text ctx={ctx} path="toBePaidBy" label="20 · To be paid by" />
          <div className="grid grid-cols-2 gap-3">
            <Text ctx={ctx} path="establishedIn" label="21 · Established in" />
            <DateField ctx={ctx} path="establishedOn" label="21 · on" />
          </div>
        </div>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------- editor
export function DocumentEditor({
  doc,
  tenantId,
  reload,
}: {
  doc: Doc;
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const [data, setData] = useState<Obj>(doc.data as unknown as Obj);
  const [language, setLanguage] = useState(doc.language);
  const [dirty, setDirty] = useState(false);
  const [checked, setChecked] = useState(false);
  const a = useAction();
  const locked = !editable(doc.status);
  const base = `/v1/tenants/${tenantId}/documents/${doc.id}`;
  const ctx: Ctx = {
    doc,
    data,
    locked,
    set: (p, v) => {
      setData((d) => setPath(d, p, v));
      setDirty(true);
    },
  };
  const st = DOC_STATUS[doc.status];
  const hasPrefill = Boolean(doc.prefill && Object.keys(doc.prefill).length);
  const save = async () => {
    await api(base, { method: 'PATCH', body: { data, language } });
    setDirty(false);
    await reload();
  };
  const downloadPdf = async () => {
    const token = await getAccessToken();
    const res = await fetch(`/api${base}/pdf`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('The PDF could not be created.');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank');
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            {DOC_TYPE[doc.type].name} {doc.number ?? ''}
          </h2>
          <Badge tone={st.tone}>{st.text}</Badge>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {doc.counterparty_name ?? 'No customer yet'}
          {doc.payable && ` · ${money(doc.total_cents, doc.currency)}`}
          {doc.issue_date && ` · issued ${doc.issue_date.slice(0, 10)}`}
        </p>
        {doc.type !== 'cmr' && (
          <div className="mt-3">
            <Field label="Document language" hint="Labels on the PDF and the text of the reply.">
              <select
                className={inputClass}
                value={language}
                disabled={locked}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  setDirty(true);
                }}
              >
                {DOC_LANGUAGES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {doc.type === 'cmr' && (
          <p className="mt-2 text-xs text-neutral-500">
            Standard CMR form, English and French. The PDF has four copies: sender, consignee,
            carrier and one extra.
          </p>
        )}
      </Card>

      {doc.prefill_status === 'pending' && (
        <Notice>Reading the e-mail… the fields will fill in shortly.</Notice>
      )}
      {doc.prefill_status === 'failed' && (
        <ErrorText>
          The e-mail could not be read automatically. Fill in the fields yourself.
        </ErrorText>
      )}
      {hasPrefill && editable(doc.status) && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Highlighted fields were filled from the customer&apos;s e-mail. Each shows the text it was
          copied from. Check every one before you create the PDF.
        </p>
      )}

      {doc.type === 'invoice' && <InvoiceForm ctx={ctx} tenantId={tenantId} />}
      {doc.type === 'delivery_note' && <DeliveryNoteForm ctx={ctx} />}
      {doc.type === 'cmr' && <CmrForm ctx={ctx} />}

      {(doc.payments ?? []).length > 0 && (
        <Card title="Payment">
          <div className="space-y-2">
            {doc.payments!.map((p) => (
              <DocumentPayment key={p.id} p={p} tenantId={tenantId} onChange={reload} />
            ))}
          </div>
        </Card>
      )}

      {!locked && doc.problems.length > 0 && !dirty && (
        <div className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-800">
          <p className="font-medium">Before the PDF can be created:</p>
          <ul className="mt-1 list-disc pl-5">
            {doc.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <ErrorText>{a.error}</ErrorText>

      <div className="sticky bottom-20 z-10 space-y-2 rounded-xl bg-white/95 p-3 ring-1 ring-neutral-200 backdrop-blur md:bottom-4">
        {!locked && (
          <>
            {hasPrefill && doc.status === 'draft' && (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                I checked every highlighted field against the e-mail.
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={a.busy || !dirty}
                variant="secondary"
                onClick={() => void a.run(save)}
              >
                Save
              </Button>
              {doc.status === 'draft' && (
                <Button
                  disabled={a.busy || (hasPrefill && !checked)}
                  onClick={() =>
                    void a.run(async () => {
                      if (dirty) await api(base, { method: 'PATCH', body: { data, language } });
                      await api(`${base}/issue`, {
                        method: 'POST',
                        body: hasPrefill ? { confirmPrefill: true } : {},
                      });
                      setDirty(false);
                      await reload();
                    })
                  }
                >
                  Create PDF
                </Button>
              )}
            </div>
          </>
        )}
        {doc.status !== 'draft' && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={a.busy || dirty}
              onClick={() => void a.run(downloadPdf)}
            >
              Download PDF
            </Button>
            {doc.status === 'issued' && doc.thread_id && (
              <Button
                disabled={a.busy || dirty}
                onClick={() =>
                  void a.run(async () => {
                    await api(`${base}/send`, { method: 'POST', body: {} });
                    router.push(`/conversations/${doc.thread_id}`);
                  })
                }
              >
                Attach to reply
              </Button>
            )}
            {doc.payable && (doc.status === 'sent' || doc.status === 'issued') && (
              <Button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api(`${base}/mark`, { method: 'POST', body: { status: 'paid' } });
                    await reload();
                  })
                }
              >
                Mark as paid
              </Button>
            )}
            {!doc.payable && (doc.status === 'sent' || doc.status === 'issued') && (
              <Button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await api(`${base}/mark`, { method: 'POST', body: { status: 'delivered' } });
                    await reload();
                  })
                }
              >
                Mark as delivered
              </Button>
            )}
            {doc.type === 'invoice' && doc.status !== 'cancelled' && (
              <Button
                variant="ghost"
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    const d = await api<{ id: string }>(`/v1/tenants/${tenantId}/documents`, {
                      method: 'POST',
                      body: { type: 'delivery_note', fromDocumentId: doc.id },
                    });
                    router.push(`/documents/${d.id}`);
                  })
                }
              >
                Create delivery note
              </Button>
            )}
          </div>
        )}
        {doc.status === 'issued' && !doc.thread_id && (
          <p className="text-xs text-neutral-500">
            Not linked to a conversation: download the PDF to send it yourself.
          </p>
        )}
        {(doc.status === 'draft' || doc.status === 'issued') && (
          <Button
            variant="ghost"
            className="text-red-700 hover:bg-red-50"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                if (doc.status === 'draft') {
                  await api(base, { method: 'DELETE', body: {} });
                  router.push('/documents');
                } else {
                  if (!window.confirm('Cancel this document? Its number stays used.')) return;
                  await api(`${base}/cancel`, { method: 'POST', body: {} });
                  await reload();
                }
              })
            }
          >
            {doc.status === 'draft' ? 'Delete draft' : 'Cancel document'}
          </Button>
        )}
      </div>
    </div>
  );
}
