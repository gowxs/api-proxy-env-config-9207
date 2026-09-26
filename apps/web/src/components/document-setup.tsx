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
}

const FIELDS: [keyof DocSettings, string, string, string?][] = [
  ['seller_legal_name', 'sellerLegalName', 'Legal name', 'As registered, e.g. “SIA Nordlicht”'],
  ['seller_legal_address', 'sellerLegalAddress', 'Legal address'],
  ['seller_country', 'sellerCountry', 'Country', 'Printed on CMR notes, e.g. “Latvia”'],
  ['seller_reg_no', 'sellerRegNo', 'Registration number'],
  ['seller_vat_no', 'sellerVatNo', 'VAT number', 'With the country prefix, e.g. LV40003123456'],
  ['seller_bank_name', 'sellerBankName', 'Bank'],
  ['seller_iban', 'sellerIban', 'IBAN'],
  ['seller_bic', 'sellerBic', 'BIC / SWIFT'],
];

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
        {FIELDS.map(([, key, label, hint]) =>
          key === 'sellerLegalAddress' ? (
            <Field key={key} label={label} hint={hint}>
              <textarea
                className={`${inputClass} min-h-20`}
                value={f[key]}
                onChange={(e) => setF({ ...f, [key]: e.target.value })}
              />
            </Field>
          ) : (
            <Field key={key} label={label} hint={hint}>
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
