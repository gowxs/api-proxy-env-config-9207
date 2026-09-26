'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppPage } from '@/components/shell';
import { Badge, Card, ErrorText, Loading, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

type Soon = 'xero' | 'quickbooks' | 'zoho_books' | 'shopify' | 'woocommerce';

const NOW: { title: string; beta?: boolean; line: string; href: string; link: string }[] = [
  {
    title: 'E-mail replies & follow-ups',
    line: 'Answers customers in their language from your own facts, and follows up when a conversation goes quiet.',
    href: '/settings',
    link: 'Sending mode →',
  },
  {
    title: 'Leads',
    line: 'Every new enquiry becomes a lead with who asked and what they need.',
    href: '/leads',
    link: 'Open leads →',
  },
  {
    title: 'Quotes',
    beta: true,
    line: 'A price request becomes a quote from your price list, as a PDF the customer accepts with one click.',
    href: '/settings/quotes',
    link: 'Quote settings →',
  },
  {
    title: 'Invoices, delivery notes and CMR',
    beta: true,
    line: 'Issued from the conversation and sent as PDFs; bank payment notifications are matched to open invoices.',
    href: '/settings/documents',
    link: 'Document settings →',
  },
];

const ACCOUNTING = (n: string) =>
  `Invoices you issue in Noctiv go to ${n} automatically. Payments Noctiv matches are recorded there too.`;
const STORE = (n: string) =>
  `“Where is my order?” answered with the order's real status. Tracking and order details come from your ${n} store.`;

const SOON: { id: Soon; name: string; line: string }[] = [
  { id: 'xero', name: 'Xero', line: ACCOUNTING('Xero') },
  { id: 'quickbooks', name: 'QuickBooks', line: ACCOUNTING('QuickBooks') },
  { id: 'zoho_books', name: 'Zoho Books', line: ACCOUNTING('Zoho Books') },
  { id: 'shopify', name: 'Shopify', line: STORE('Shopify') },
  { id: 'woocommerce', name: 'WooCommerce', line: STORE('WooCommerce') },
];

/** Settings → Integrations (PLAN.md §23): what works today, and "notify me" for what's next. */
export default function IntegrationsPage() {
  const tenantId = useTenantId();
  const t = useLoad(
    () => api<{ integrations_notify: Soon[] }>(`/v1/tenants/${tenantId}`),
    [tenantId],
  );
  const [on, setOn] = useState<Soon[]>([]);
  useEffect(() => {
    if (t.data) setOn(t.data.integrations_notify ?? []);
  }, [t.data]);
  const save = useAction();

  const toggle = (id: Soon, value: boolean) => {
    const prev = on;
    const next = value ? [...on.filter((x) => x !== id), id] : on.filter((x) => x !== id);
    setOn(next);
    void save.run(async () => {
      try {
        await api(`/v1/tenants/${tenantId}`, {
          method: 'PATCH',
          body: { integrationsNotify: next },
        });
      } catch (e) {
        setOn(prev);
        throw e;
      }
    });
  };

  return (
    <AppPage title="Integrations">
      <p className="text-sm text-neutral-600">
        One inbox, one platform. See also{' '}
        <a className="text-indigo-700" href="https://noctiv.io/integrations/">
          noctiv.io/integrations
        </a>
        .
      </p>

      <h2 className="text-sm font-semibold text-neutral-700">Available now</h2>
      {NOW.map((c) => (
        <Card
          key={c.title}
          title={c.title}
          action={c.beta ? <Badge tone="blue">Beta</Badge> : <Badge tone="green">On</Badge>}
        >
          <p className="text-sm text-neutral-600">{c.line}</p>
          <Link className="mt-2 inline-block text-sm text-indigo-700" href={c.href}>
            {c.link}
          </Link>
        </Card>
      ))}

      <h2 className="text-sm font-semibold text-neutral-700">Coming soon</h2>
      <p className="text-sm text-neutral-600">
        Switch on “Notify me” and we&apos;ll e-mail the account owner once, when it&apos;s ready. No
        other e-mails.
      </p>
      <ErrorText>{t.error ?? save.error}</ErrorText>
      {!t.data && !t.error ? (
        <Loading />
      ) : (
        SOON.map((c) => (
          <Card key={c.id} title={c.name} action={<Badge>Coming soon</Badge>}>
            <p className="text-sm text-neutral-600">{c.line}</p>
            <label className="mt-3 flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-medium">
              Notify me when it&apos;s ready
              <input
                type="checkbox"
                role="switch"
                className="h-5 w-5 accent-indigo-700"
                checked={on.includes(c.id)}
                disabled={!t.data}
                onChange={(e) => toggle(c.id, e.target.checked)}
              />
            </label>
          </Card>
        ))
      )}
    </AppPage>
  );
}
