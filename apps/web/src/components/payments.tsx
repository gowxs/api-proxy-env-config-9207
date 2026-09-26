'use client';

import Link from 'next/link';
import { Badge, Button, ErrorText, useAction } from './ui';
import { api } from '@/lib/api';
import { MATCH_TEXT, type Payment } from '@/lib/documents';
import { money, shortDate } from '@/lib/quotes';

export const paymentAmount = (p: Payment) =>
  p.currency ? money(p.amount_cents, p.currency) : (p.amount_cents / 100).toFixed(2);

/** What the bank e-mail said, compactly. */
export function PaymentFacts({ p }: { p: Payment }) {
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold tabular-nums">{paymentAmount(p)}</span>
        <span className="text-neutral-500">{shortDate(p.received_at ?? p.created_at)}</span>
      </div>
      {p.payer_name && <div className="text-neutral-700">From {p.payer_name}</div>}
      {p.reference && (
        <div className="break-words text-xs text-neutral-500">Details: “{p.reference}”</div>
      )}
    </div>
  );
}

/** A payment on the document page: matched details, or a one-click proposal. */
export function DocumentPayment({
  p,
  tenantId,
  onChange,
}: {
  p: Payment;
  tenantId: string;
  onChange: () => Promise<void>;
}) {
  const a = useAction();
  const act = (path: 'confirm' | 'dismiss') =>
    void a.run(async () => {
      await api(`/v1/tenants/${tenantId}/payments/${p.id}/${path}`, { method: 'POST', body: {} });
      await onChange();
    });
  return (
    <div
      className={
        p.status === 'proposed'
          ? 'rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200'
          : 'rounded-lg bg-green-50 p-3 ring-1 ring-green-200'
      }
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={p.status === 'proposed' ? 'amber' : 'green'}>
          {p.status === 'proposed'
            ? 'Payment received?'
            : p.matched_by === 'auto'
              ? 'Paid · matched automatically'
              : 'Paid'}
        </Badge>
      </div>
      <PaymentFacts p={p} />
      {p.match_kind && <p className="mt-1 text-xs text-neutral-600">{MATCH_TEXT[p.match_kind]}</p>}
      {p.status === 'proposed' && (
        <div className="mt-2 flex gap-2">
          <Button disabled={a.busy} onClick={() => act('confirm')}>
            Mark as paid
          </Button>
          <Button variant="ghost" disabled={a.busy} onClick={() => act('dismiss')}>
            Not this one
          </Button>
        </div>
      )}
      <ErrorText>{a.error}</ErrorText>
      {p.status === 'matched' && (
        <Link href="/payments" className="mt-1 inline-block text-xs text-indigo-700">
          All payments →
        </Link>
      )}
    </div>
  );
}
