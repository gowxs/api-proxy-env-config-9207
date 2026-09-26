'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppPage } from '@/components/shell';
import {
  Button,
  Card,
  ErrorText,
  Field,
  inputClass,
  Loading,
  Notice,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { VAT_LABEL, type VatMode } from '@/lib/quotes';
import { useTenantId } from '@/lib/session';

interface DocSettings {
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

function SellerCard({
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
    ]),
  );
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
        <p className="text-xs text-neutral-500">
          VAT: {VAT_LABEL[s.quotes_vat_mode]}
          {s.quotes_vat_mode !== 'none' && `, ${s.quotes_vat_rate}%`} · {s.quotes_currency}. Shared
          with quotes;{' '}
          <Link className="text-indigo-700" href="/settings/quotes">
            change it in Settings → Quotes
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

function DocumentsSettings() {
  const tenantId = useTenantId();
  const t = useLoad(() => api<DocSettings>(`/v1/tenants/${tenantId}`), [tenantId]);
  const toggle = useAction();
  if (t.error) return <ErrorText>{t.error}</ErrorText>;
  if (!t.data) return <Loading />;
  const s = t.data;
  return (
    <div className="space-y-4">
      <Card title="Documents (beta)">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={s.documents_enabled}
            disabled={toggle.busy}
            onChange={(e) =>
              void toggle.run(async () => {
                await api(`/v1/tenants/${tenantId}`, {
                  method: 'PATCH',
                  body: { documentsEnabled: e.target.checked },
                });
                await t.reload();
              })
            }
          />
          <span className="text-sm">
            <span className="font-medium">Invoices, delivery notes and CMR</span>
            <span className="block text-neutral-600">
              Create them from a quote, an invoice or a customer&apos;s e-mail, check every field,
              and send the PDF with your reply. Nothing is sent without you.
            </span>
          </span>
        </label>
        <ErrorText>{toggle.error}</ErrorText>
        {s.documents_enabled && (
          <Link className="mt-2 inline-block text-sm text-indigo-700" href="/documents">
            See all documents →
          </Link>
        )}
      </Card>
      {!s.documents_enabled && (
        <Notice>Documents are off. You can fill in your business details now.</Notice>
      )}
      <SellerCard s={s} tenantId={tenantId} reload={t.reload} />
    </div>
  );
}

export default function DocumentsSettingsPage() {
  return (
    <AppPage title="Documents">
      <DocumentsSettings />
    </AppPage>
  );
}
