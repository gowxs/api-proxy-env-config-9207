'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import {
  daysLeftText,
  fmtDate,
  fmtEnd,
  openCheckout,
  useBilling,
  waitForSubscription,
  type Billing,
} from '@/lib/billing';
import { useSession } from '@/lib/session';
import { Badge, Button, Card, cx, ErrorText, useAction } from './ui';

export const PRICE_LINE = '$79/month, plus VAT where applicable';

const STATUS: Record<
  Billing['status'],
  { text: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'blue' }
> = {
  trial: { text: 'Free trial', tone: 'blue' },
  trialing: { text: 'Subscribed', tone: 'green' },
  active: { text: 'Subscribed', tone: 'green' },
  past_due: { text: 'Payment failed', tone: 'amber' },
  paused: { text: 'Paused', tone: 'red' },
  canceled: { text: 'Cancelled', tone: 'red' },
  comped: { text: 'Free of charge', tone: 'green' },
};

export function SubscribeButton({ label = 'Subscribe' }: { label?: string }) {
  const { billing, reload } = useBilling();
  const { tenant } = useSession();
  const a = useAction();
  const [waiting, setWaiting] = useState(false);
  if (!billing || !tenant) return null;
  if (!billing.checkout)
    return (
      <p className="text-sm text-neutral-500">
        Subscriptions open soon. Write to contact@noctiv.io.
      </p>
    );
  const checkout = billing.checkout;
  return (
    <div className="space-y-2">
      <Button
        disabled={a.busy || waiting}
        onClick={() =>
          void a.run(() =>
            openCheckout(checkout, tenant.id, () => {
              setWaiting(true);
              void waitForSubscription(reload).then((ok) => {
                setWaiting(false);
                if (!ok)
                  a.setError(
                    'Payment received. Your subscription will show here within a few minutes.',
                  );
              });
            }),
          )
        }
      >
        {waiting ? 'Activating…' : label}
      </Button>
      <ErrorText>{a.error}</ErrorText>
    </div>
  );
}

export function PortalButton() {
  const { tenant } = useSession();
  const a = useAction();
  if (!tenant) return null;
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            const { url } = await api<{ url: string }>(`/v1/tenants/${tenant.id}/billing/portal`, {
              method: 'POST',
            });
            window.location.assign(url);
          })
        }
      >
        Manage billing
      </Button>
      <ErrorText>{a.error}</ErrorText>
    </div>
  );
}

/** Shown on every page while something about billing needs the owner. */
export function BillingBanner() {
  const { billing } = useBilling();
  if (!billing) return null;
  if (!billing.entitled) {
    return (
      <div
        role="status"
        className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
      >
        <p className="font-semibold">
          {billing.status === 'trial'
            ? 'Your free trial has ended.'
            : 'Your subscription is not active.'}{' '}
          Noctiv is not reading or answering your email.
        </p>
        <p className="mt-1">
          Your data, drafts and settings are kept. Subscribe to switch it back on ({PRICE_LINE}).
        </p>
        <div className="mt-3">
          {billing.hasSubscription && billing.portalAvailable ? (
            <div className="flex flex-wrap gap-2">
              <SubscribeButton label="Subscribe again" />
              <PortalButton />
            </div>
          ) : (
            <SubscribeButton />
          )}
        </div>
      </div>
    );
  }
  if (billing.status === 'past_due') {
    return (
      <div
        role="status"
        className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
      >
        <p className="font-semibold">Your last payment failed.</p>
        <p className="mt-1">
          Noctiv keeps working while the payment is retried. Update your card to avoid a pause.
        </p>
        {billing.portalAvailable && (
          <div className="mt-3">
            <PortalButton />
          </div>
        )}
      </div>
    );
  }
  if (billing.status === 'trial' && billing.trialDaysLeft !== null && billing.trialDaysLeft <= 3) {
    return (
      <div
        role="status"
        className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900"
      >
        <p className="font-semibold">
          {billing.trialDaysLeft <= 1
            ? 'Your free trial ends today.'
            : `Your free trial ends in ${billing.trialDaysLeft} days.`}
        </p>
        <p className="mt-1">Subscribe to keep Noctiv answering your email ({PRICE_LINE}).</p>
        <div className="mt-3">
          <SubscribeButton />
        </div>
      </div>
    );
  }
  return null;
}

/** Plan and billing (dashboard and Settings). */
export function BillingCard({ showPortal = false }: { showPortal?: boolean }) {
  const { billing } = useBilling();
  if (!billing) return null;
  const s = STATUS[billing.status];
  return (
    <div id="plan" className="scroll-mt-20">
      <Card title="Plan">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">Noctiv</span>
          <Badge tone={billing.entitled ? s.tone : 'red'}>
            {billing.status === 'trial' && !billing.entitled ? 'Trial ended' : s.text}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          {billing.status === 'trial' &&
            (billing.entitled
              ? `Free trial — ${daysLeftText(billing.trialDaysLeft ?? 0)}. It ends on ${fmtEnd(billing.trialEndsAt, billing.timezone)}. No card needed.`
              : `The free trial ended on ${fmtEnd(billing.trialEndsAt, billing.timezone)}.`)}
          {(billing.status === 'active' || billing.status === 'trialing') &&
            (billing.cancelsAt
              ? `Cancelled; Noctiv keeps working until ${fmtDate(billing.cancelsAt)}.`
              : `${PRICE_LINE}. Next payment ${fmtDate(billing.periodEndsAt)}.`)}
          {billing.status === 'past_due' &&
            'The last payment failed; Paddle retries it. Update your card below.'}
          {billing.status === 'canceled' &&
            'The subscription was cancelled. Subscribe again at any time.'}
          {billing.status === 'paused' && 'The subscription is paused.'}
          {billing.status === 'comped' && 'This account is free of charge.'}
        </p>
        {billing.status === 'trial' && (
          <p className="mt-1 text-xs text-neutral-500">
            {PRICE_LINE}. Billing starts the day you subscribe. Cancel any time.{' '}
            <Link className="underline" href="https://noctiv.io/refunds/">
              Refund policy
            </Link>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {(billing.status === 'trial' || billing.status === 'canceled') && <SubscribeButton />}
          {showPortal && billing.portalAvailable && billing.status !== 'comped' && <PortalButton />}
        </div>
        {showPortal && billing.portalAvailable && (
          <p className="mt-2 text-xs text-neutral-500">
            Card changes, invoices and cancellation are handled by Paddle, our reseller and merchant
            of record.
          </p>
        )}
      </Card>
    </div>
  );
}

/** Plan chip for the navigation: trial days left, or the subscription state. */
export function PlanChip({ className }: { className?: string }) {
  const { billing } = useBilling();
  if (!billing) return null;
  const s = STATUS[billing.status];
  const trial = billing.status === 'trial';
  const text = !billing.entitled
    ? trial
      ? 'Trial ended'
      : s.text
    : trial && billing.trialDaysLeft !== null
      ? `Trial · ${daysLeftText(billing.trialDaysLeft)}`
      : s.text;
  const tone = !billing.entitled
    ? 'bg-red-100 text-red-900'
    : trial && (billing.trialDaysLeft ?? 99) <= 3
      ? 'bg-amber-100 text-amber-900'
      : s.tone === 'green'
        ? 'bg-green-100 text-green-900'
        : s.tone === 'amber'
          ? 'bg-amber-100 text-amber-900'
          : 'bg-indigo-50 text-indigo-800';
  return (
    <Link
      href="/settings#billing"
      title={
        trial ? `Free trial ends on ${fmtEnd(billing.trialEndsAt, billing.timezone)}` : undefined
      }
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap',
        tone,
        className,
      )}
    >
      {text}
    </Link>
  );
}
