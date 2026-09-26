'use client';

import Link from 'next/link';
import { BillingCard } from '@/components/billing';
import { AppPage } from '@/components/shell';
import { Icon, type IconName } from '@/components/icons';
import { Badge, Card, cx, ErrorText, Loading, timeAgo, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';
import type { Mode } from '@/lib/modes';

interface Dashboard {
  mode: Mode;
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
  quotes?: { enabled: boolean; open: number; accepted: number };
  documents?: {
    paymentsToReview?: number;
    enabled: boolean;
    drafts: number;
    unpaid: number;
    unpaidCents: number;
    currency: string;
    overdue?: number;
  };
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-neutral-50 p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );
}

const fmtMoney = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);

interface Need {
  key: string;
  icon: IconName;
  n: number;
  title: string;
  detail?: string;
  href: string;
  tone: 'blue' | 'amber';
}

function NeedsYou({ data }: { data: Dashboard }) {
  const d = data.documents;
  const needs: Need[] = [
    {
      key: 'drafts',
      icon: 'inbox',
      n: data.open.awaiting_approval,
      title: data.open.awaiting_approval === 1 ? 'draft to approve' : 'drafts to approve',
      href: '/conversations?filter=needs_action',
      tone: 'blue',
    },
    {
      key: 'escalations',
      icon: 'inbox',
      n: data.open.open_escalations,
      title:
        data.open.open_escalations === 1
          ? 'e-mail to answer yourself'
          : 'e-mails to answer yourself',
      href: '/conversations?filter=needs_action',
      tone: 'amber',
    },
  ];
  if (d && (d.enabled || (d.paymentsToReview ?? 0) > 0))
    needs.push({
      key: 'payments',
      icon: 'payments',
      n: d.paymentsToReview ?? 0,
      title:
        (d.paymentsToReview ?? 0) === 1
          ? 'incoming payment to check'
          : 'incoming payments to check',
      href: '/payments',
      tone: 'amber',
    });
  if (d?.enabled)
    needs.push({
      key: 'unpaid',
      icon: 'documents',
      n: d.unpaid,
      title: d.unpaid === 1 ? 'unpaid invoice' : 'unpaid invoices',
      detail:
        d.unpaid > 0
          ? `${fmtMoney(d.unpaidCents, d.currency)}${d.overdue ? ` · ${d.overdue} overdue` : ''}`
          : undefined,
      href: '/documents?status=unpaid',
      tone: 'blue',
    });
  const open = needs.filter((x) => x.n > 0);
  return (
    <Card title="Needs you">
      {open.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-neutral-600">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-100 text-green-800">
            ✓
          </span>
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="-mx-2 divide-y divide-neutral-100">
          {open.map((x) => (
            <li key={x.key}>
              <Link
                href={x.href}
                className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50"
              >
                <span
                  className={cx(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    x.tone === 'amber'
                      ? 'bg-amber-50 text-amber-800'
                      : 'bg-indigo-50 text-indigo-800',
                  )}
                >
                  <Icon name={x.icon} width={18} height={18} />
                </span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-semibold tabular-nums">{x.n}</span> {x.title}
                  {x.detail && <span className="block text-xs text-neutral-500">{x.detail}</span>}
                </span>
                <span aria-hidden className="text-neutral-400">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Today({ data }: { data: Dashboard }) {
  const pct = Math.min(100, Math.round((data.budget.usedTokens / data.budget.dailyTokens) * 100));
  return (
    <Card title={`Today (${data.timezone})`}>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Emails in" value={data.today.received} />
        <Stat label="Sent automatically" value={data.today.auto_sent} />
        <Stat label="Sent after approval" value={data.today.approved_sent} />
        <Stat label="Handed to you" value={data.today.escalated} />
        <Stat label="Ignored (newsletters…)" value={data.today.skipped} />
        <Stat label="Waiting for approval" value={data.open.awaiting_approval} />
      </div>
      <div className="mt-4">
        <div className="mb-1.5 flex flex-col gap-0.5 text-xs text-neutral-500 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
          <span>
            AI budget: {pct}% used
            {data.budget.state !== 'ok' && (
              <span className="ml-2">
                <Badge tone="red">
                  {data.budget.state === 'halted'
                    ? 'Paused until tomorrow'
                    : 'Approval only until tomorrow'}
                </Badge>
              </span>
            )}
          </span>
          <span>
            {data.budget.llmCalls} AI calls · ≈ €{data.budget.estCostEur.toFixed(2)} · resets 00:00
            UTC
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
          <div
            className={`h-full ${pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-600'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

function MailboxHealth({ data }: { data: Dashboard }) {
  return (
    <Card
      title="Mailbox health"
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
                tone={c.status === 'connected' ? 'green' : c.status === 'pending' ? 'amber' : 'red'}
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
  );
}

function HomeView() {
  const tenantId = useTenantId();
  const { data, error } = useLoad(
    () => api<Dashboard>(`/v1/tenants/${tenantId}/dashboard`),
    [tenantId],
  );
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <NeedsYou data={data} />
        <Today data={data} />
      </div>
      <div className="space-y-4 lg:col-span-2">
        <MailboxHealth data={data} />
        <BillingCard />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <AppPage title="Home">
      <HomeView />
    </AppPage>
  );
}
