'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { BankSendersCard, SellerCard, type DocSettings } from '@/components/document-setup';
import { ModuleBar, ModuleOff, Tabs, useModuleToggle, useTab } from '@/components/module';
import { AppPage } from '@/components/shell';
import { Badge, Button, cx, ErrorText, Loading, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { DOC_STATUS, DOC_TYPE, type Doc, type DocType } from '@/lib/documents';
import { money, shortDate } from '@/lib/quotes';
import { useTenantId } from '@/lib/session';

const TABS: { id: DocType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'invoice', label: 'Invoices' },
  { id: 'delivery_note', label: 'Delivery notes' },
  { id: 'cmr', label: 'CMR' },
];

function DocumentList() {
  const tenantId = useTenantId();
  const router = useRouter();
  const { data, error } = useLoad(
    () => api<Doc[]>(`/v1/tenants/${tenantId}/documents`),
    [tenantId],
  );
  const [tab, setTab] = useState<DocType | 'all'>('all');
  const unpaidOnly = useSearchParams().get('status') === 'unpaid';
  const a = useAction();
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const shown = data.filter(
    (d) =>
      (tab === 'all' || d.type === tab) &&
      (!unpaidOnly || (d.payable && (d.status === 'issued' || d.status === 'sent'))),
  );
  // Invoices and delivery notes with prices (pavadzīme-rēķins) ask for payment.
  const invoices = data.filter((d) => d.payable);
  const currency = invoices[0]?.currency ?? 'EUR';
  const sum = (s: Doc['status'][]) =>
    invoices.filter((d) => s.includes(d.status)).reduce((t, d) => t + d.total_cents, 0);
  const create = (type: DocType) =>
    void a.run(async () => {
      const d = await api<{ id: string }>(`/v1/tenants/${tenantId}/documents`, {
        method: 'POST',
        body: { type },
      });
      router.push(`/documents/${d.id}`);
    });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-white p-3 ring-1 ring-neutral-200">
          <div className="text-lg font-semibold tabular-nums">{money(sum(['sent']), currency)}</div>
          <div className="text-xs text-neutral-500">Invoiced, not yet paid</div>
        </div>
        <div className="rounded-lg bg-white p-3 ring-1 ring-neutral-200">
          <div className="text-lg font-semibold tabular-nums text-green-800">
            {money(sum(['paid']), currency)}
          </div>
          <div className="text-xs text-neutral-500">Paid</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={a.busy} onClick={() => create('invoice')}>
          New invoice
        </Button>
        <Button variant="secondary" disabled={a.busy} onClick={() => create('delivery_note')}>
          New delivery note
        </Button>
        <Button variant="secondary" disabled={a.busy} onClick={() => create('cmr')}>
          New CMR
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link className="text-indigo-700" href="/payments">
          Incoming payments →
        </Link>
        {unpaidOnly && (
          <Link className="text-indigo-700" href="/documents">
            Showing unpaid only · show all
          </Link>
        )}
      </div>
      <ErrorText>{a.error}</ErrorText>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cx(
              'shrink-0 rounded-full px-3 py-1.5 text-sm',
              tab === x.id
                ? 'bg-indigo-700 text-white'
                : 'bg-white text-neutral-700 ring-1 ring-neutral-200',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-neutral-500">No documents here yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-xl bg-white ring-1 ring-neutral-200">
          {shown.map((d) => {
            const st = DOC_STATUS[d.status];
            return (
              <li key={d.id}>
                <Link href={`/documents/${d.id}`} className="block px-4 py-3 hover:bg-neutral-50">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">
                      {d.number ?? `${DOC_TYPE[d.type].short} draft`}
                    </span>
                    <Badge tone={st.tone}>{st.text}</Badge>
                    {d.payable && (
                      <span className="ml-auto text-sm font-semibold tabular-nums">
                        {money(d.total_cents, d.currency)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                    <span className="min-w-0 flex-1 truncate">
                      {DOC_TYPE[d.type].short} · {d.counterparty_name ?? 'no customer yet'}
                    </span>
                    <span>
                      {d.payable && d.status === 'sent' && d.due_date
                        ? `due ${shortDate(d.due_date)}`
                        : shortDate(d.issue_date ?? d.created_at)}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const MODULE_TABS = ['documents', 'setup'] as const;
const TAB_LABELS = { documents: 'Documents', setup: 'Setup' };

function DocumentsModule() {
  const tenantId = useTenantId();
  const t = useLoad(() => api<DocSettings>(`/v1/tenants/${tenantId}`), [tenantId]);
  const toggle = useModuleToggle(tenantId, 'documentsEnabled', t.reload);
  const [tab, setTab] = useTab(MODULE_TABS);
  if (t.error) return <ErrorText>{t.error}</ErrorText>;
  if (!t.data) return <Loading />;
  const s = t.data;
  if (!s.documents_enabled)
    return (
      <ModuleOff
        name="Documents"
        lead="Invoices, delivery notes and CMR notes, made from the conversation."
        points={[
          {
            title: 'From what you already have',
            text: 'Start from an accepted quote, an invoice or a customer’s e-mail, or by hand.',
          },
          {
            title: 'Checked and numbered',
            text: 'Every field is checked; numbers run per type and restart each year.',
          },
          {
            title: 'Sent and followed up',
            text: 'The PDF goes with your reply; bank payment notifications mark invoices paid.',
          },
        ]}
        note="Nothing is sent without you."
        onEnable={() => toggle.set(true)}
        busy={toggle.busy}
        error={toggle.error}
      />
    );
  return (
    <>
      <ModuleBar
        name="Documents"
        line="Invoices, delivery notes and CMR notes, sent as PDFs with your replies."
        onDisable={() => toggle.set(false)}
        busy={toggle.busy}
        error={toggle.error}
      />
      <Tabs tabs={MODULE_TABS} labels={TAB_LABELS} tab={tab} onChange={setTab} />
      {tab === 'documents' && <DocumentList />}
      {tab === 'setup' && (
        <div className="space-y-4">
          <SellerCard s={s} tenantId={tenantId} reload={t.reload} />
          <BankSendersCard tenantId={tenantId} />
        </div>
      )}
    </>
  );
}

export default function DocumentsPage() {
  return (
    <AppPage title="Documents">
      <Suspense fallback={<Loading />}>
        <DocumentsModule />
      </Suspense>
    </AppPage>
  );
}
