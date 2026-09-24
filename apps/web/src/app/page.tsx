'use client';

import Link from 'next/link';
import { AppPage } from '@/components/shell';
import { Badge, Card, ErrorText, Loading, timeAgo, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

interface Dashboard {
  mode: 'draft_only' | 'auto_send';
  timezone: string;
  connections: {
    id: string;
    email_address: string;
    status: string;
    last_ok_at: string | null;
    error_message: string | null;
    is_test_mailbox: boolean;
  }[];
  today: {
    received: number;
    skipped: number;
    auto_sent: number;
    approved_sent: number;
    escalated: number;
  };
  open: { awaiting_approval: number; open_escalations: number };
  budget: {
    state: string;
    dailyTokens: number;
    usedTokens: number;
    llmCalls: number;
    estCostEur: number;
  };
  knowledge: Record<string, number>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-neutral-50 p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );
}

function DashboardView() {
  const tenantId = useTenantId();
  const { data, error } = useLoad(
    () => api<Dashboard>(`/v1/tenants/${tenantId}/dashboard`),
    [tenantId],
  );
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const pct = Math.min(100, Math.round((data.budget.usedTokens / data.budget.dailyTokens) * 100));
  const needs = data.open.awaiting_approval + data.open.open_escalations;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {needs > 0 && (
        <Link
          href="/conversations?filter=needs_action"
          className="rounded-xl bg-indigo-700 p-4 text-white md:col-span-2"
        >
          <div className="text-lg font-semibold">
            {needs} {needs === 1 ? 'item needs' : 'items need'} you
          </div>
          <div className="text-sm text-indigo-100">
            {data.open.awaiting_approval} draft{data.open.awaiting_approval === 1 ? '' : 's'} to
            approve · {data.open.open_escalations} to answer yourself →
          </div>
        </Link>
      )}

      <Card
        title="Mailbox"
        action={
          <Link className="text-sm text-indigo-700" href="/settings/mailboxes">
            Manage
          </Link>
        }
      >
        {data.connections.length === 0 && (
          <p className="text-sm">
            No mailbox connected.{' '}
            <Link className="text-indigo-700" href="/settings/mailboxes">
              Connect one
            </Link>
          </p>
        )}
        <ul className="space-y-3">
          {data.connections.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{c.email_address}</span>
                <Badge
                  tone={
                    c.status === 'connected' ? 'green' : c.status === 'pending' ? 'amber' : 'red'
                  }
                >
                  {c.status === 'connected'
                    ? 'Connected'
                    : c.status === 'disconnected'
                      ? 'Disconnected'
                      : c.status}
                </Badge>
              </div>
              <div className="text-xs text-neutral-500">
                Last check: {timeAgo(c.last_ok_at)}
                {c.is_test_mailbox && ' · test mailbox'}
              </div>
              {c.status !== 'connected' && c.error_message && (
                <p className="mt-1 text-xs text-red-700">
                  {c.error_message}{' '}
                  <Link className="underline" href="/settings/mailboxes">
                    Reconnect
                  </Link>
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Mode">
        <div className="flex items-center gap-2">
          <Badge tone={data.mode === 'auto_send' ? 'blue' : 'gray'}>
            {data.mode === 'auto_send' ? 'Automatic sending' : 'Draft-only'}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          {data.mode === 'auto_send'
            ? 'Replies that pass every safety check are sent automatically; everything else waits for you.'
            : 'Every reply waits for your approval.'}{' '}
          <Link className="text-indigo-700" href="/settings">
            Change
          </Link>
        </p>
      </Card>

      <Card title={`Today (${data.timezone})`}>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Emails in" value={data.today.received} />
          <Stat label="Sent automatically" value={data.today.auto_sent} />
          <Stat label="Sent after approval" value={data.today.approved_sent} />
          <Stat label="Handed to you" value={data.today.escalated} />
          <Stat label="Ignored (newsletters…)" value={data.today.skipped} />
          <Stat label="Waiting for approval" value={data.open.awaiting_approval} />
        </div>
      </Card>

      <Card title="AI budget today">
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span>
            {pct}% used
            {data.budget.state !== 'ok' && (
              <Badge tone="red">
                {data.budget.state === 'halted'
                  ? 'Paused until tomorrow'
                  : 'Draft-only until tomorrow'}
              </Badge>
            )}
          </span>
          <span className="text-xs text-neutral-500">
            {data.budget.llmCalls} AI calls · ≈ €{data.budget.estCostEur.toFixed(2)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
          <div
            className={`h-full ${pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-600'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-neutral-500">Resets at 00:00 UTC.</p>
      </Card>

      <Card
        title="Knowledge base"
        action={
          <Link className="text-sm text-indigo-700" href="/knowledge">
            Open
          </Link>
        }
      >
        <p className="text-sm text-neutral-700">
          {data.knowledge.ready ?? 0} ready
          {(data.knowledge.pending ?? 0) + (data.knowledge.processing ?? 0) > 0 &&
            ` · ${(data.knowledge.pending ?? 0) + (data.knowledge.processing ?? 0)} being read`}
          {(data.knowledge.failed ?? 0) > 0 && ` · ${data.knowledge.failed} failed`}
        </p>
      </Card>
    </div>
  );
}

export default function HomePage() {
  return (
    <AppPage title="Dashboard">
      <DashboardView />
    </AppPage>
  );
}
