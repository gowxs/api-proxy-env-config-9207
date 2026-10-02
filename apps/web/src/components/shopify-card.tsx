'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Loading,
  Notice,
  timeAgo,
  useAction,
} from '@/components/ui';
import { api } from '@/lib/api';

export interface ShopifyStatus {
  configured: boolean;
  installUrl: string | null;
  staleDays: number;
  connection: null | {
    shopDomain: string;
    shopName: string | null;
    scopes: string[];
    status: 'connected' | 'error';
    lastErrorCode: string | null;
    lastCheckedAt: string | null;
  };
}

const RESULT: Record<string, string> = {
  state:
    'That link has expired, or it was opened in a different browser. Start again from Shopify.',
  denied: 'You did not accept the permission in Shopify, so nothing was connected.',
  scopes:
    'Shopify gave Noctiv a permission it does not accept (it must be read-only orders). Nothing was connected.',
  shopify: 'Shopify could not finish the connection. Try again in a minute.',
};

const ERRORS: Record<string, string> = {
  AUTH_FAILED:
    'Shopify no longer accepts the connection (the app was removed, or access was withdrawn). Connect the store again.',
  MISSING_SCOPE:
    'Noctiv is not allowed to read orders in this store. Connect the store again and accept the permission.',
  WRITE_SCOPES: 'The connection can change data in your store. Noctiv refuses it: connect again.',
};

/** What Noctiv reads: shown before and after connecting, so the merchant knows exactly. */
function Reads() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-600">
      <li>
        <b>Only reads orders.</b> Noctiv can never change, cancel or refund anything in your store.
      </li>
      <li>
        When a customer asks about an order, it looks up that one order (or the sender&apos;s most
        recent orders) live: number, date, payment and shipping status, carrier, tracking and the
        items sent.
      </li>
      <li>
        It only uses an order when the sender&apos;s e-mail address is the one on the order. No
        addresses, payment details or other customers&apos; data are used or stored.
      </li>
    </ul>
  );
}

/** Integrations → Shopify: connect (install the app on Shopify, then link it here), test, disconnect. */
export function ShopifyCard({
  tenantId,
  businessName,
  status,
  claim,
  returned,
  reload,
}: {
  tenantId: string;
  businessName: string;
  status: ShopifyStatus;
  /** From the redirect after the Shopify install: links the finished install to this business. */
  claim: string | null;
  /** Reason code when the install did not finish. */
  returned: string | null;
  reload: () => Promise<void> | void;
}) {
  const link = useAction();
  const test = useAction();
  const off = useAction();
  const [tested, setTested] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const claimed = useRef(false);
  const c = status.connection;

  useEffect(() => {
    // Done once; the claim can only be used once and the page may re-render.
    if (!claim || claimed.current) return;
    claimed.current = true;
    void link.run(async () => {
      await api(`/v1/tenants/${tenantId}/shopify/claim`, { method: 'POST', body: { claim } });
      window.history.replaceState(null, '', '/integrations');
      await reload();
    });
  }, [claim]);

  return (
    <Card
      title="Shopify: “Where is my order?”"
      action={
        c ? (
          <Badge tone={c.status === 'connected' ? 'green' : 'red'}>
            {c.status === 'connected' ? 'Connected' : 'Needs attention'}
          </Badge>
        ) : (
          <Badge tone="blue">Beta</Badge>
        )
      }
    >
      <div className="space-y-3">
        {returned && RESULT[returned] && <ErrorText>{RESULT[returned]}</ErrorText>}
        {claim && !link.error && !c && <Loading />}
        <ErrorText>{link.error}</ErrorText>

        {c ? (
          <>
            <p className="text-sm">
              <b>{c.shopName ?? c.shopDomain}</b>
              <span className="block break-all text-neutral-500">{c.shopDomain}</span>
              <span className="text-xs text-neutral-500">
                Last checked {timeAgo(c.lastCheckedAt)}
              </span>
            </p>
            {c.status === 'error' && (
              <ErrorText>
                {ERRORS[c.lastErrorCode ?? ''] ??
                  'The connection stopped working. Test it, or connect the store again.'}
              </ErrorText>
            )}
            <Reads />
            <p className="text-xs text-neutral-500">
              Permission: {c.scopes.length ? c.scopes.join(', ') : 'read_orders'}. E-mails about
              orders that are cancelled, refunded, part-shipped, without tracking, or with no
              shipping update for {status.staleDays} days always go to you (change this in
              Settings).
            </p>
            {tested && <Notice>{tested}</Notice>}
            <ErrorText>{test.error ?? off.error}</ErrorText>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={test.busy}
                onClick={() =>
                  void test.run(async () => {
                    setTested(null);
                    const r = await api<{ status: string; shopName?: string; message?: string }>(
                      `/v1/tenants/${tenantId}/shopify/test`,
                      { method: 'POST', body: {} },
                    );
                    setTested(
                      r.status === 'ok'
                        ? `Connected to ${r.shopName}. Noctiv can read orders.`
                        : r.status === 'pending'
                          ? 'The check is still running. Try again in a moment.'
                          : (r.message ?? 'The connection test failed.'),
                    );
                    await reload();
                  })
                }
              >
                Test connection
              </Button>
              {!confirmOff ? (
                <Button variant="danger" onClick={() => setConfirmOff(true)}>
                  Disconnect and delete token
                </Button>
              ) : (
                <div className="w-full space-y-2 rounded-lg bg-red-50 p-3 text-sm">
                  <p>
                    This uninstalls Noctiv from your Shopify store and deletes the saved access from
                    Noctiv. Order e-mails then get normal replies.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      disabled={off.busy}
                      onClick={() =>
                        void off.run(async () => {
                          await api(`/v1/tenants/${tenantId}/shopify`, { method: 'DELETE' });
                          setConfirmOff(false);
                          await reload();
                        })
                      }
                    >
                      Yes, disconnect
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmOff(false)}>
                      Keep it
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-600">
              When a customer asks where their order is, Noctiv looks the order up in your store and
              answers with the real status and tracking, in the customer&apos;s language.
            </p>
            <Reads />
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              <li>
                Tap <b>Connect Shopify</b>. Shopify opens and asks you to log in.
              </li>
              <li>
                Choose your store and tap <b>Install</b>. The only permission is <b>read orders</b>.
              </li>
              <li>
                You come back here. Tap <b>Link this store</b> to connect it to {businessName}.
              </li>
            </ol>
            {status.installUrl ? (
              <a
                href={status.installUrl}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-indigo-700 px-4 text-base font-semibold text-white hover:bg-indigo-800 sm:w-auto"
              >
                Connect Shopify
              </a>
            ) : (
              <p className="text-sm text-neutral-600">
                Install Noctiv from the Shopify App Store in your Shopify admin, then come back
                here.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
