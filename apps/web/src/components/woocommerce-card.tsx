'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Notice,
  inputClass,
  timeAgo,
  useAction,
} from '@/components/ui';
import { api } from '@/lib/api';

export interface WooStatus {
  configured: boolean;
  staleDays: number;
  shopifyConnected: boolean;
  connection: null | {
    storeUrl: string;
    storeName: string | null;
    status: 'connected' | 'error';
    lastErrorCode: string | null;
    lastCheckedAt: string | null;
  };
}

const ERRORS: Record<string, string> = {
  AUTH_FAILED:
    'The store no longer accepts the key (it was deleted, or the host blocks it). Create a new key and paste it again.',
  NO_REST_API:
    'The store has no WooCommerce REST API at that address. Check that WooCommerce is active and permalinks are not “Plain”.',
  UNREACHABLE: 'Noctiv could not reach the store. Check that the site is online.',
  UNAVAILABLE: 'The store did not answer in time. Try again in a moment.',
};

function Reads() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-600">
      <li>
        <b>Only reads orders.</b> Create the key with <b>Read</b> access: Noctiv can then never
        change, cancel or refund anything in your store.
      </li>
      <li>
        When a customer asks about an order, it looks up that one order (or the sender&apos;s most
        recent orders) live: number, date, status, tracking and the items sent.
      </li>
      <li>
        It only uses an order when the sender&apos;s e-mail address is the billing e-mail on the
        order. No addresses, phone numbers or payment details are used or stored.
      </li>
      <li>
        Tracking comes from the common <b>Shipment Tracking</b> plugin, or from a customer note that
        says “Tracking number: …”. If a shipped order has none, Noctiv does not guess: the e-mail
        goes to you.
      </li>
    </ul>
  );
}

/** Integrations → WooCommerce: paste a read-only REST key, test, disconnect. */
export function WooCommerceCard({
  tenantId,
  status,
  reload,
}: {
  tenantId: string;
  status: WooStatus;
  reload: () => Promise<void> | void;
}) {
  const save = useAction();
  const test = useAction();
  const off = useAction();
  const [tested, setTested] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [storeUrl, setStoreUrl] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const c = status.connection;
  const [replacing, setReplacing] = useState(false);

  const form = (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(async () => {
          await api(`/v1/tenants/${tenantId}/woocommerce`, {
            method: 'PUT',
            body: { storeUrl, consumerKey, consumerSecret },
          });
          setStoreUrl('');
          setConsumerKey('');
          setConsumerSecret('');
          setReplacing(false);
          await reload();
        });
      }}
    >
      <Field label="Store address" hint="The address of your shop, like https://myshop.com">
        <input
          className={inputClass}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://myshop.com"
          value={storeUrl}
          onChange={(e) => setStoreUrl(e.target.value)}
          required
        />
      </Field>
      <Field label="Consumer key" hint="Starts with ck_">
        <input
          className={inputClass}
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          value={consumerKey}
          onChange={(e) => setConsumerKey(e.target.value)}
          required
        />
      </Field>
      <Field label="Consumer secret" hint="Starts with cs_. Shown only once by WooCommerce.">
        <input
          className={inputClass}
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="new-password"
          value={consumerSecret}
          onChange={(e) => setConsumerSecret(e.target.value)}
          required
        />
      </Field>
      <ErrorText>{save.error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.busy}>
          {save.busy ? 'Checking the key…' : c ? 'Replace key' : 'Connect WooCommerce'}
        </Button>
        {replacing && (
          <Button type="button" variant="secondary" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        Noctiv checks the key with your store, then saves it encrypted. It is never shown again and
        never written to logs.
      </p>
    </form>
  );

  return (
    <Card
      title="WooCommerce: “Where is my order?”"
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
        {c && (
          <>
            <p className="text-sm">
              <b>{c.storeName ?? c.storeUrl}</b>
              <span className="block break-all text-neutral-500">{c.storeUrl}</span>
              <span className="text-xs text-neutral-500">
                Last checked {timeAgo(c.lastCheckedAt)}
              </span>
            </p>
            {c.status === 'error' && (
              <ErrorText>
                {ERRORS[c.lastErrorCode ?? ''] ??
                  'The connection stopped working. Test it, or paste a new key.'}
              </ErrorText>
            )}
          </>
        )}
        <Reads />
        {c && (
          <p className="text-xs text-neutral-500">
            E-mails about orders that are cancelled, refunded, on hold, shipped without tracking, or
            with no shipping update for {status.staleDays} days always go to you (change this in
            Settings).
          </p>
        )}

        {!c && status.shopifyConnected && (
          <Notice>
            This business already has Shopify connected. Disconnect it to use WooCommerce.
          </Notice>
        )}
        {!c && !status.shopifyConnected && (
          <>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">
              <li>
                In WordPress open <b>WooCommerce → Settings → Advanced → REST API</b> and tap{' '}
                <b>Add key</b>.
              </li>
              <li>
                Description: <b>Noctiv</b>. User: an administrator. Permissions: <b>Read</b>.
              </li>
              <li>
                Tap <b>Generate API key</b>, then copy the consumer key and secret into the form
                below. WooCommerce shows the secret only once.
              </li>
            </ol>
            {form}
          </>
        )}

        {c && (
          <>
            {replacing && form}
            {tested && <Notice>{tested}</Notice>}
            <ErrorText>{test.error ?? off.error}</ErrorText>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={test.busy}
                onClick={() =>
                  void test.run(async () => {
                    setTested(null);
                    const r = await api<{
                      status: string;
                      storeName?: string | null;
                      message?: string;
                    }>(`/v1/tenants/${tenantId}/woocommerce/test`, { method: 'POST', body: {} });
                    setTested(
                      r.status === 'ok'
                        ? `Connected to ${r.storeName ?? c.storeUrl}. Noctiv can read orders.`
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
              {!replacing && (
                <Button variant="secondary" onClick={() => setReplacing(true)}>
                  Replace key
                </Button>
              )}
              {!confirmOff ? (
                <Button variant="danger" onClick={() => setConfirmOff(true)}>
                  Disconnect and delete keys
                </Button>
              ) : (
                <div className="w-full space-y-2 rounded-lg bg-red-50 p-3 text-sm">
                  <p>
                    This deletes the saved key from Noctiv. Order e-mails then get normal replies.
                    To be safe, also delete the key in WooCommerce → Settings → Advanced → REST API:
                    only you can revoke it there.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      disabled={off.busy}
                      onClick={() =>
                        void off.run(async () => {
                          await api(`/v1/tenants/${tenantId}/woocommerce`, { method: 'DELETE' });
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
        )}
      </div>
    </Card>
  );
}
