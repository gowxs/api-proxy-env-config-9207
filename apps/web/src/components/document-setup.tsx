'use client';

/** Documents setup: business details and bank senders (on the Documents page). */

import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, ErrorText, Field, inputClass, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { VAT_LABEL, type VatMode } from '@/lib/quotes';

export interface DocSettings {
  name: string;
  documents_enabled: boolean;
  seller_legal_name: string | null;
  seller_legal_address: string | null;
  seller_reg_no: string | null;
  seller_vat_no: string | null;
  seller_bank_name: string | null;
  seller_iban: string | null;
  seller_bic: string | null;
  seller_sort_code: string | null;
  seller_account_number: string | null;
  seller_country: string | null;
  invoice_due_days: number;
  doc_prefix_invoice: string;
  doc_prefix_delivery_note: string;
  doc_prefix_cmr: string;
  /** Per type: a document was issued this year, so its prefix is fixed until next year. */
  doc_prefix_locks: { invoice: boolean; delivery_note: boolean; cmr: boolean };
  quotes_currency: string;
  quotes_vat_mode: VatMode;
  quotes_vat_rate: number;
  quotes_auto_send_limit_cents: number;
  auto_invoice_on_accept: boolean;
  auto_delivery_note_after_payment: boolean;
}

const FIELDS: [keyof DocSettings, string, string, string?][] = [
  ['seller_legal_name', 'sellerLegalName', 'Legal name', 'As registered, e.g. “Hearth & Wick Ltd”'],
  ['seller_legal_address', 'sellerLegalAddress', 'Legal address'],
  ['seller_country', 'sellerCountry', 'Country', 'Printed on CMR notes, e.g. “United Kingdom”'],
  ['seller_reg_no', 'sellerRegNo', 'Registration number'],
  [
    'seller_vat_no',
    'sellerVatNo',
    'VAT number',
    'With the country prefix, e.g. GB123456789 or DE123456789',
  ],
  ['seller_bank_name', 'sellerBankName', 'Bank'],
  ['seller_sort_code', 'sellerSortCode', 'Sort code', '6 digits, e.g. 20-00-00'],
  ['seller_account_number', 'sellerAccountNumber', 'Account number', '8 digits'],
  ['seller_iban', 'sellerIban', 'IBAN'],
  ['seller_bic', 'sellerBic', 'BIC / SWIFT', 'Optional'],
];

/** UK sellers (by country, VAT number or IBAN) are paid by sort code and account number. */
const UK_COUNTRY =
  /^\s*(united kingdom|uk|u\.k\.|gb|great britain|england|scotland|wales|northern ireland)\s*$/i;
const isUk = (f: Record<string, string>) =>
  UK_COUNTRY.test(f.sellerCountry ?? '') ||
  /^\s*gb/i.test(f.sellerVatNo ?? '') ||
  /^\s*gb/i.test(f.sellerIban ?? '');
const UK_ONLY = new Set(['sellerSortCode', 'sellerAccountNumber']);

export function SellerCard({
  s,
  tenantId,
  reload,
}: {
  s: DocSettings;
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const [f, setF] = useState<Record<string, string>>(() =>
    Object.fromEntries([
      ...FIELDS.map(([col, key]) => [key, (s[col] as string | null) ?? '']),
      ['invoiceDueDays', String(s.invoice_due_days)],
      ['docPrefixInvoice', s.doc_prefix_invoice],
      ['docPrefixDeliveryNote', s.doc_prefix_delivery_note],
      ['docPrefixCmr', s.doc_prefix_cmr],
    ]),
  );
  const year = new Date().getFullYear();
  const prefixes: [string, string, keyof DocSettings['doc_prefix_locks']][] = [
    ['docPrefixInvoice', 'Invoices', 'invoice'],
    ['docPrefixDeliveryNote', 'Delivery notes', 'delivery_note'],
    ['docPrefixCmr', 'CMR notes', 'cmr'],
  ];
  const a = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Your business details">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const { invoiceDueDays, ...rest } = f;
            // Locked prefixes are not sent (they cannot change this year).
            for (const [key, , type] of prefixes)
              if (s.doc_prefix_locks[type]) delete (rest as Record<string, string>)[key];
            await api(`/v1/tenants/${tenantId}`, {
              method: 'PATCH',
              body: { ...rest, invoiceDueDays: Number(invoiceDueDays) },
            });
            await reload();
            setSaved(true);
          });
        }}
      >
        <p className="text-sm text-neutral-600">
          Printed on every invoice, delivery note and CMR as the seller, supplier or sender.
        </p>
        {FIELDS.filter(([, key]) => isUk(f) || !UK_ONLY.has(key)).map(([, key, label, hint]) =>
          key === 'sellerLegalAddress' ? (
            <Field key={key} label={label} hint={hint}>
              <textarea
                className={`${inputClass} min-h-20`}
                value={f[key]}
                onChange={(e) => setF({ ...f, [key]: e.target.value })}
              />
            </Field>
          ) : (
            <Field
              key={key}
              label={label}
              hint={
                key === 'sellerIban' && isUk(f)
                  ? 'Not needed if you give sort code and account number'
                  : hint
              }
            >
              <input
                className={inputClass}
                value={f[key]}
                onChange={(e) => setF({ ...f, [key]: e.target.value })}
              />
            </Field>
          ),
        )}
        <Field label="Invoices due after (days)">
          <input
            className={inputClass}
            inputMode="numeric"
            value={f.invoiceDueDays}
            onChange={(e) => setF({ ...f, invoiceDueDays: e.target.value })}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-neutral-800">Number prefixes</legend>
          <div className="grid grid-cols-3 gap-2">
            {prefixes.map(([key, label, type]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-xs text-neutral-600">{label}</span>
                <input
                  className={`${inputClass} uppercase`}
                  value={f[key]}
                  maxLength={10}
                  disabled={s.doc_prefix_locks[type]}
                  aria-label={`${label} number prefix`}
                  onChange={(e) => setF({ ...f, [key]: e.target.value.toUpperCase() })}
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            Numbers read {f.docPrefixInvoice || 'INV'}-{year}-0001 and restart every year. Letters
            and digits only. A prefix is fixed for the rest of the year once a document of that type
            has been issued
            {prefixes.some(([, , t]) => s.doc_prefix_locks[t]) &&
              ` (${prefixes
                .filter(([, , t]) => s.doc_prefix_locks[t])
                .map(([, l]) => l.toLowerCase())
                .join(', ')}: fixed for ${year})`}
            .
          </p>
        </fieldset>
        <p className="text-xs text-neutral-500">
          VAT: {VAT_LABEL[s.quotes_vat_mode]}
          {s.quotes_vat_mode !== 'none' && `, ${s.quotes_vat_rate}%`} · {s.quotes_currency}. Shared
          with quotes;{' '}
          <Link className="text-indigo-700" href="/quotes?tab=setup">
            change it in Quotes → Setup
          </Link>
          .
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

interface BankSender {
  id: string;
  domain: string;
}

export function BankSendersCard({ tenantId }: { tenantId: string }) {
  const list = useLoad(() => api<BankSender[]>(`/v1/tenants/${tenantId}/bank-senders`), [tenantId]);
  const [domain, setDomain] = useState('');
  const a = useAction();
  return (
    <Card title="Incoming payments">
      <p className="text-sm text-neutral-600">
        Add the domain your bank sends “money received” notifications from. Noctiv reads those
        e-mails (never answers them), matches the payment to an open invoice and marks it paid, or
        asks you when it is not sure.
      </p>
      <ul className="mt-3 space-y-1">
        {(list.data ?? []).map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium">{b.domain}</span>
            <button
              type="button"
              className="text-red-700"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await api(`/v1/tenants/${tenantId}/bank-senders/${b.id}`, {
                    method: 'DELETE',
                    body: {},
                  });
                  await list.reload();
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await api(`/v1/tenants/${tenantId}/bank-senders`, {
              method: 'POST',
              body: { domain },
            });
            setDomain('');
            await list.reload();
          });
        }}
      >
        <input
          className={`${inputClass} min-w-0 flex-1`}
          placeholder="e.g. swedbank.lv"
          aria-label="Bank notification domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <Button type="submit" disabled={a.busy || !domain.trim()}>
          Add
        </Button>
      </form>
      <p className="mt-2 text-xs text-neutral-500">
        Only messages your mail provider verified as really coming from that domain (DKIM or DMARC)
        are read; anything else claiming to be your bank is ignored.
      </p>
      <ErrorText>{a.error ?? list.error}</ErrorText>
    </Card>
  );
}

/** Documents automation (PLAN.md §22.11–§22.12): two switches, saved at once. */
export function AutomationCard({
  s,
  tenantId,
  reload,
}: {
  s: DocSettings;
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const a = useAction();
  const set = (field: 'autoInvoiceOnAccept' | 'autoDeliveryNoteAfterPayment', on: boolean) =>
    void a.run(async () => {
      await api(`/v1/tenants/${tenantId}`, { method: 'PATCH', body: { [field]: on } });
      await reload();
    });
  const limit = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: s.quotes_currency,
  }).format(s.quotes_auto_send_limit_cents / 100);
  const row = (
    field: 'autoInvoiceOnAccept' | 'autoDeliveryNoteAfterPayment',
    checked: boolean,
    title: string,
    text: string,
  ) => (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-5 w-5 shrink-0 accent-indigo-700"
        checked={checked}
        disabled={a.busy}
        onChange={(e) => set(field, e.target.checked)}
      />
      <span className="text-sm">
        <span className="block font-medium">{title}</span>
        <span className="block text-neutral-600">{text}</span>
      </span>
    </label>
  );
  return (
    <Card title="Automation">
      <div className="divide-y divide-neutral-100">
        {row(
          'autoInvoiceOnAccept',
          s.auto_invoice_on_accept,
          'Invoice when a quote is accepted',
          `The invoice is made from the quote, numbered, and a reply “Thank you — invoice attached” is prepared. Mode 1: waits for your approval. Modes 2 and 3: sent if the total is up to ${limit} (your quote auto-send limit).`,
        )}
        {row(
          'autoDeliveryNoteAfterPayment',
          s.auto_delivery_note_after_payment,
          'Delivery note after payment',
          'When an invoice is marked paid, the delivery note is made from it and a reply is prepared. Mode 1: waits for your approval. Modes 2 and 3: sent.',
        )}
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        If a detail is missing (for example the buyer’s address), nothing is sent: the document
        waits for you and you get an e-mail.
      </p>
      <ErrorText>{a.error}</ErrorText>
    </Card>
  );
}
