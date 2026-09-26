'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PaymentFacts } from '@/components/payments';
import { AppPage } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  inputClass,
  Loading,
  Notice,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { MATCH_TEXT, type Doc, type Payment } from '@/lib/documents';
import { money } from '@/lib/quotes';
import { useTenantId } from '@/lib/session';

function Row({
  p,
  open,
  tenantId,
  reload,
}: {
  p: Payment;
  open: Doc[];
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const [target, setTarget] = useState('');
  const a = useAction();
  const post = (path: string, body: unknown = {}) =>
    void a.run(async () => {
      await api(`/v1/tenants/${tenantId}/payments/${p.id}/${path}`, { method: 'POST', body });
      await reload();
    });
  return (
    <li className="space-y-2 px-4 py-3">
      <PaymentFacts p={p} />
      {p.status === 'proposed' && (
        <>
          <p className="text-xs text-neutral-600">
            Looks like{' '}
            <Link className="text-indigo-700" href={`/documents/${p.document_id}`}>
              {p.document_number}
            </Link>{' '}
            ({p.match_kind ? MATCH_TEXT[p.match_kind] : ''}).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={a.busy} onClick={() => post('confirm')}>
              Mark {p.document_number} as paid
            </Button>
            <Button variant="ghost" disabled={a.busy} onClick={() => post('dismiss')}>
              Not this one
            </Button>
          </div>
        </>
      )}
      {p.status === 'unmatched' && (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Open document"
            className={`${inputClass} min-w-0 flex-1`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Link to an open invoice…</option>
            {open.map((d) => (
              <option key={d.id} value={d.id}>
                {d.number} · {d.counterparty_name ?? ''} · {money(d.total_cents, d.currency)}
              </option>
            ))}
          </select>
          <Button disabled={a.busy || !target} onClick={() => post('link', { documentId: target })}>
            Mark paid
          </Button>
          <Button variant="ghost" disabled={a.busy} onClick={() => post('dismiss')}>
            Dismiss
          </Button>
        </div>
      )}
      {p.status === 'matched' && (
        <p className="text-xs text-neutral-600">
          <Badge tone="green">{p.matched_by === 'auto' ? 'Matched automatically' : 'Linked'}</Badge>{' '}
          <Link className="text-indigo-700" href={`/documents/${p.document_id}`}>
            {p.document_number}
          </Link>
        </p>
      )}
      <ErrorText>{a.error}</ErrorText>
    </li>
  );
}

function Payments() {
  const tenantId = useTenantId();
  const payments = useLoad(() => api<Payment[]>(`/v1/tenants/${tenantId}/payments`), [tenantId]);
  const docs = useLoad(() => api<Doc[]>(`/v1/tenants/${tenantId}/documents`), [tenantId]);
  if (payments.error) return <ErrorText>{payments.error}</ErrorText>;
  if (!payments.data || !docs.data) return <Loading />;
  const open = docs.data.filter((d) => d.payable && (d.status === 'issued' || d.status === 'sent'));
  const reload = async () => {
    await Promise.all([payments.reload(), docs.reload()]);
  };
  const group = (s: Payment['status'][]) => payments.data!.filter((p) => s.includes(p.status));
  const sections: [string, Payment[], string][] = [
    ['To check', group(['proposed']), 'Payments that look like one of your invoices.'],
    ['Not matched', group(['unmatched']), 'Link them to an invoice, or dismiss them.'],
    ['Matched', group(['matched']), ''],
  ];
  return (
    <div className="space-y-4">
      {payments.data.length === 0 && (
        <Notice>
          No payments yet. They appear here when your bank&apos;s notification e-mails arrive: add
          your bank in{' '}
          <Link className="underline" href="/documents?tab=setup">
            Documents → Setup
          </Link>
          .
        </Notice>
      )}
      {sections.map(([title, list, hint]) =>
        list.length ? (
          <Card key={title} title={`${title} (${list.length})`}>
            {hint && <p className="-mt-1 mb-2 text-xs text-neutral-500">{hint}</p>}
            <ul className="-mx-4 divide-y divide-neutral-100">
              {list.map((p) => (
                <Row key={p.id} p={p} open={open} tenantId={tenantId} reload={reload} />
              ))}
            </ul>
          </Card>
        ) : null,
      )}
    </div>
  );
}

export default function PaymentsPage() {
  return (
    <AppPage title="Payments">
      <Payments />
    </AppPage>
  );
}
