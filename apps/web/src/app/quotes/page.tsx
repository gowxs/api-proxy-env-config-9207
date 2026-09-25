'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppPage } from '@/components/shell';
import { Badge, cx, ErrorText, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { money, QUOTE_STATUS, shortDate, type Quote, type QuoteStatus } from '@/lib/quotes';
import { useTenantId } from '@/lib/session';

const FILTERS: { id: string; label: string; statuses: QuoteStatus[] | null }[] = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'approval', label: 'To approve', statuses: ['pending_approval'] },
  { id: 'open', label: 'Sent', statuses: ['sent', 'viewed'] },
  { id: 'accepted', label: 'Accepted', statuses: ['accepted'] },
  { id: 'expired', label: 'Expired', statuses: ['expired'] },
];

function QuoteList() {
  const tenantId = useTenantId();
  const { data, error } = useLoad(() => api<Quote[]>(`/v1/tenants/${tenantId}/quotes`), [tenantId]);
  const [filter, setFilter] = useState('all');
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const f = FILTERS.find((x) => x.id === filter)!;
  const shown = data.filter((q) => !f.statuses || f.statuses.includes(q.status));
  const currency = data[0]?.currency ?? 'EUR';
  const sum = (s: QuoteStatus[]) =>
    data.filter((q) => s.includes(q.status)).reduce((t, q) => t + q.total_cents, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-white p-3 ring-1 ring-neutral-200">
          <div className="text-lg font-semibold tabular-nums">
            {money(sum(['sent', 'viewed']), currency)}
          </div>
          <div className="text-xs text-neutral-500">Open (sent, not yet accepted)</div>
        </div>
        <div className="rounded-lg bg-white p-3 ring-1 ring-neutral-200">
          <div className="text-lg font-semibold tabular-nums text-green-800">
            {money(sum(['accepted']), currency)}
          </div>
          <div className="text-xs text-neutral-500">Accepted</div>
        </div>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4" role="tablist">
        {FILTERS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={filter === x.id}
            onClick={() => setFilter(x.id)}
            className={cx(
              'shrink-0 rounded-full px-3 py-1.5 text-sm',
              filter === x.id
                ? 'bg-indigo-700 text-white'
                : 'bg-white text-neutral-700 ring-1 ring-neutral-200',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-neutral-500">No quotes here yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-xl bg-white ring-1 ring-neutral-200">
          {shown.map((q) => {
            const st = QUOTE_STATUS[q.status];
            return (
              <li key={q.id}>
                <Link
                  href={`/conversations/${q.thread_id}`}
                  className="block px-4 py-3 hover:bg-neutral-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{q.number}</span>
                    <Badge tone={st.tone}>{st.text}</Badge>
                    <span className="ml-auto text-sm font-semibold tabular-nums">
                      {money(q.total_cents, q.currency)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                    <span className="min-w-0 flex-1 truncate">
                      {q.customer_name ?? q.customer_email ?? 'Customer'} · {q.lines.length}{' '}
                      {q.lines.length === 1 ? 'line' : 'lines'}
                    </span>
                    <span>
                      {q.status === 'accepted' && q.accepted_at
                        ? `accepted ${shortDate(q.accepted_at)}`
                        : q.status === 'expired'
                          ? `expired ${shortDate(q.valid_until)}`
                          : `valid until ${shortDate(q.valid_until)}`}
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

export default function QuotesPage() {
  return (
    <AppPage title="Quotes">
      <QuoteList />
    </AppPage>
  );
}
