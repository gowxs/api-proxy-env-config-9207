'use client';

import { useState } from 'react';
import { Button, Card, ErrorText, inputClass, useAction } from '@/components/ui';
import { api } from '@/lib/api';

interface MoneyTotal {
  currency: string;
  count: number;
  totalCents: number;
}

/** GET /dashboard → value (PLAN.md §26; packages/core value/report.ts). */
export interface ValueData {
  answered: number;
  avgReplySeconds: number | null;
  avgBusinessHoursSeconds: number | null;
  outsideHoursShare: number | null;
  followupsSent: number;
  wonBack: number;
  quotesSent: MoneyTotal[];
  quotesAccepted: MoneyTotal[];
  invoicesPaid: MoneyTotal[];
  minutesSaved: number;
  assumptions: { minutesPerReply: number; minutesPerFollowup: number };
  fastestLine: string | null;
}

/** Same wording as the Monday e-mail (formatDuration in packages/core). */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24
    ? `${d} ${d === 1 ? 'day' : 'days'} ${h % 24} h`
    : `${d} ${d === 1 ? 'day' : 'days'}`;
}

const saved = (minutes: number) =>
  minutes < 60
    ? `${Math.round(minutes)} min`
    : `${minutes / 60 < 10 ? Math.round(minutes / 6) / 10 : Math.round(minutes / 60)} h`;

const money = (m: MoneyTotal[]) =>
  m
    .map((x) =>
      new Intl.NumberFormat('en-GB', { style: 'currency', currency: x.currency }).format(
        x.totalCents / 100,
      ),
    )
    .join(' + ');
const count = (m: MoneyTotal[]) => m.reduce((n, x) => n + x.count, 0);

function Big({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-neutral-50 p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-400">{hint}</div>}
    </div>
  );
}

/** Dashboard "This month": what Noctiv did since the 1st (local time). */
export function ValueCard({
  tenantId,
  value: v,
  reload,
}: {
  tenantId: string;
  value: ValueData;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [reply, setReply] = useState(String(v.assumptions.minutesPerReply));
  const [followup, setFollowup] = useState(String(v.assumptions.minutesPerFollowup));
  const a = useAction();
  const quotes = count(v.quotesSent) + count(v.quotesAccepted) > 0;
  return (
    <Card title="This month">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Big label="E-mails answered" value={String(v.answered)} />
        <Big label="Follow-ups sent" value={String(v.followupsSent)} />
        <Big label="Replies won back" value={String(v.wonBack)} hint="answered after a follow-up" />
        <Big label="Hours saved (estimate)" value={saved(v.minutesSaved)} />
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div>
          <dt className="inline text-neutral-500">Average reply time: </dt>
          <dd className="inline">
            {v.avgReplySeconds === null ? (
              '—'
            ) : (
              <>
                <strong>{duration(v.avgReplySeconds)}</strong> with Noctiv
                {v.avgBusinessHoursSeconds !== null && (
                  <>
                    {' '}
                    · {duration(v.avgBusinessHoursSeconds)} if answered only in business hours
                    (Mon–Fri 09:00–17:00)
                  </>
                )}
              </>
            )}
          </dd>
        </div>
        {v.outsideHoursShare !== null && v.outsideHoursShare > 0 && (
          <p className="text-xs text-neutral-500">
            {Math.round(v.outsideHoursShare * 100)}% of the answered e-mails arrived outside
            business hours.
          </p>
        )}
        {quotes && (
          <div>
            <dt className="inline text-neutral-500">Quotes: </dt>
            <dd className="inline">
              {count(v.quotesSent)} sent{v.quotesSent.length ? ` (${money(v.quotesSent)})` : ''}
              {' · '}
              {count(v.quotesAccepted)} accepted
              {v.quotesAccepted.length ? ` (${money(v.quotesAccepted)})` : ''}
            </dd>
          </div>
        )}
        {v.invoicesPaid.length > 0 && (
          <div>
            <dt className="inline text-neutral-500">Invoices paid: </dt>
            <dd className="inline">
              {count(v.invoicesPaid)} ({money(v.invoicesPaid)})
            </dd>
          </div>
        )}
        {v.fastestLine && <p className="text-neutral-700">{v.fastestLine}.</p>}
      </dl>
      {!editing ? (
        <p className="mt-3 text-xs text-neutral-500">
          Hours saved assumes {v.assumptions.minutesPerReply} min per reply and{' '}
          {v.assumptions.minutesPerFollowup} min per follow-up.{' '}
          <button
            className="-my-3 inline-flex min-h-11 items-center px-1 text-indigo-700 underline"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
        </p>
      ) : (
        <form
          className="mt-3 flex flex-wrap items-end gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await api(`/v1/tenants/${tenantId}`, {
                method: 'PATCH',
                body: {
                  valueMinutesPerReply: Number(reply),
                  valueMinutesPerFollowup: Number(followup),
                },
              });
              await reload();
              setEditing(false);
            });
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-600">Minutes per reply</span>
            <input
              className={`${inputClass} w-24`}
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              required
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-600">Minutes per follow-up</span>
            <input
              className={`${inputClass} w-24`}
              type="number"
              inputMode="numeric"
              min={0}
              max={60}
              required
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={a.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <ErrorText>{a.error}</ErrorText>
        </form>
      )}
    </Card>
  );
}
