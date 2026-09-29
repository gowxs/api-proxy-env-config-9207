'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MailboxForm } from '@/components/mailbox-form';
import { AppPage } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  inputClass,
  Loading,
  timeAgo,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useTenantId } from '@/lib/session';

interface Connection {
  id: string;
  provider: 'gmail' | 'google_workspace' | 'yahoo' | 'hostinger' | 'generic' | 'outlook';
  email_address: string;
  status: string;
  last_error_code: string | null;
  last_ok_at: string | null;
  sent_folder_path: string | null;
  sent_sync_error: string | null;
}

/** The Sent folder, asked once when the provider has no \Sent marker (or the name is wrong). */
function SentFolder({
  tenantId,
  c,
  onSaved,
}: {
  tenantId: string;
  c: Connection;
  onSaved: () => void;
}) {
  const [name, setName] = useState(c.sent_folder_path ?? '');
  const { busy, error, run } = useAction();
  if (c.status !== 'connected' || (!c.sent_sync_error && c.sent_folder_path)) return null;
  return (
    <form
      className="mt-3 space-y-2 border-t border-neutral-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/v1/tenants/${tenantId}/connections/${c.id}`, {
            method: 'PATCH',
            body: { sentFolder: name.trim() },
          });
          onSaved();
        });
      }}
    >
      <p className="text-sm text-neutral-700">
        {c.sent_sync_error === 'FOLDER_NOT_FOUND'
          ? 'That Sent folder was not found in this mailbox. Check the exact name.'
          : 'Which folder holds your sent mail? Replies you write in your own mail app then show in the conversation. Only replies to conversations Noctiv already knows are kept.'}
      </p>
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder="e.g. Sent or INBOX.Sent"
          maxLength={200}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
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
          <SentFolder tenantId={tenantId} c={c} onSaved={() => void reload()} />
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
