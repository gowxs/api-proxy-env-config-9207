'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AppPage } from '@/components/shell';
import { Badge, ErrorText, Loading, timeAgo, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { THREAD_STATUS } from '@/lib/reasons';
import { useTenantId } from '@/lib/session';

interface Row {
  id: string;
  subject: string | null;
  status: string;
  last_inbound_at: string | null;
  created_at: string;
  customer_email: string | null;
  customer_name: string | null;
  pending_drafts: number;
  open_escalations: number;
  preview: string | null;
}

function List() {
  const tenantId = useTenantId();
  const router = useRouter();
  const params = useSearchParams();
  const filter = params.get('filter') === 'needs_action' ? 'needs_action' : 'all';
  const { data, error } = useLoad(
    () => api<Row[]>(`/v1/tenants/${tenantId}/conversations?filter=${filter}`),
    [tenantId, filter],
  );

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1 text-sm sm:w-80">
        {(['needs_action', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() =>
              router.replace(f === 'all' ? '/conversations' : '/conversations?filter=needs_action')
            }
            className={`min-h-10 rounded-md ${filter === f ? 'bg-white font-medium shadow-sm' : 'text-neutral-600'}`}
          >
            {f === 'needs_action' ? 'Needs you' : 'All'}
          </button>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {filter === 'needs_action' ? 'Nothing needs you right now.' : 'No conversations yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {data.map((r) => {
            const st = THREAD_STATUS[r.status] ?? { text: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link
                  href={`/conversations/${r.id}`}
                  className="block px-4 py-3 hover:bg-neutral-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {r.customer_name || r.customer_email || 'Unknown sender'}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {timeAgo(r.last_inbound_at ?? r.created_at)}
                    </span>
                  </div>
                  <div className="truncate text-sm">{r.subject || '(no subject)'}</div>
                  {r.preview && (
                    <div className="truncate text-xs text-neutral-500">{r.preview}</div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.pending_drafts > 0 && <Badge tone="amber">Draft to approve</Badge>}
                    {r.open_escalations > 0 && <Badge tone="red">Reply yourself</Badge>}
                    {!r.pending_drafts && !r.open_escalations && (
                      <Badge tone={st.tone}>{st.text}</Badge>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export default function ConversationsPage() {
  return (
    <AppPage title="Inbox">
      <Suspense>
        <List />
      </Suspense>
    </AppPage>
  );
}
