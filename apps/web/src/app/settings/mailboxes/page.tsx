'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MailboxForm } from '@/components/mailbox-form';
import { AppPage } from '@/components/shell';
import { Badge, Button, Card, ErrorText, Loading, timeAgo, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

interface Connection {
  id: string;
  provider: 'gmail' | 'google_workspace' | 'yahoo' | 'hostinger' | 'generic' | 'outlook';
  email_address: string;
  status: string;
  last_error_code: string | null;
  last_ok_at: string | null;
}

function Mailboxes() {
  const tenantId = useTenantId();
  const { data, error, reload } = useLoad(
    () => api<Connection[]>(`/v1/tenants/${tenantId}/connections`),
    [tenantId],
  );
  const [form, setForm] = useState<null | 'new' | Connection>(null);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm text-indigo-700">
        ← Settings
      </Link>
      {data.map((c) => (
        <Card key={c.id}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{c.email_address}</span>
            <Badge tone={c.status === 'connected' ? 'green' : 'red'}>
              {c.status === 'connected' ? 'Connected' : 'Disconnected'}
            </Badge>
          </div>
          <p className="text-xs text-neutral-500">Last successful check: {timeAgo(c.last_ok_at)}</p>
          {c.status !== 'connected' && (
            <div className="mt-3">
              <p className="mb-2 text-sm text-red-800">
                This mailbox stopped working (usually a changed or revoked App Password). New emails
                are not read until you reconnect it.
              </p>
              {form !== c && <Button onClick={() => setForm(c)}>Reconnect</Button>}
            </div>
          )}
          {typeof form === 'object' && form?.id === c.id && (
            <div className="mt-4 border-t border-neutral-100 pt-4">
              <MailboxForm
                tenantId={tenantId}
                reconnect={{ id: c.id, email: c.email_address, provider: c.provider }}
                onSaved={() => {
                  setForm(null);
                  void reload();
                }}
              />
            </div>
          )}
        </Card>
      ))}
      {form === 'new' ? (
        <Card title="Connect a mailbox">
          <MailboxForm
            tenantId={tenantId}
            onSaved={() => {
              setForm(null);
              void reload();
            }}
          />
        </Card>
      ) : (
        <Button variant="secondary" onClick={() => setForm('new')}>
          + Connect another mailbox
        </Button>
      )}
    </div>
  );
}

export default function MailboxesPage() {
  return (
    <AppPage title="Mailboxes">
      <Mailboxes />
    </AppPage>
  );
}
