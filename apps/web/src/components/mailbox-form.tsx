'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorText, Field, inputClass, Notice } from './ui';

type Provider = 'gmail' | 'google_workspace' | 'yahoo' | 'hostinger' | 'generic' | 'outlook';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'google_workspace', label: 'Google Workspace' },
  { id: 'yahoo', label: 'Yahoo Mail' },
  { id: 'hostinger', label: 'Hostinger' },
  { id: 'generic', label: 'Other (IMAP/SMTP)' },
  { id: 'outlook', label: 'Outlook / Microsoft 365' },
];

/** App Password guides. Screenshots are placeholders until the founder supplies them (Q13). */
const GUIDES: Partial<Record<Provider, { steps: string[]; shots: string[] }>> = {
  gmail: {
    steps: [
      'Open myaccount.google.com and go to Security.',
      'Turn on 2-Step Verification if it is off (Google requires it for App Passwords).',
      'Open myaccount.google.com/apppasswords.',
      'Enter the name "Noctiv" and choose Create.',
      'Copy the 16-character password and paste it below. Spaces do not matter.',
    ],
    shots: [
      'Google Account → Security → 2-Step Verification',
      'App passwords page with "Noctiv" entered',
      'The generated 16-character password',
    ],
  },
  google_workspace: {
    steps: [
      'Your Workspace admin must allow App Passwords (Admin console → Security → Less secure apps / App passwords).',
      'Turn on 2-Step Verification for your account.',
      'Open myaccount.google.com/apppasswords, create one named "Noctiv".',
      'Copy the 16-character password and paste it below.',
    ],
    shots: ['Admin console setting', 'App passwords page', 'The generated password'],
  },
  yahoo: {
    steps: [
      'Sign in at login.yahoo.com and open Account info → Account security.',
      'Choose "Generate app password" (or "Manage app passwords").',
      'Enter the name "Noctiv" and choose Generate.',
      'Copy the password and paste it below.',
    ],
    shots: [
      'Yahoo Account security page',
      'Generate app password dialog',
      'The generated password',
    ],
  },
  hostinger: {
    steps: [
      'Use your full email address and the mailbox password from hPanel → Emails.',
      'If you enabled two-factor sign-in for webmail, create a separate password for apps.',
    ],
    shots: ['hPanel → Emails → mailbox settings'],
  },
  generic: {
    steps: [
      'Ask your email host for the IMAP and SMTP server names and ports.',
      'Use an app-specific password if your host offers one.',
      'Only encrypted connections are accepted (IMAP 993, SMTP 465 or 587).',
    ],
    shots: [],
  },
};

type TestResult =
  | { status: 'ok'; testId: string; sentAppendMode: string }
  | { status: 'failed'; code: string; stage: string; message: string; detail?: string }
  | { status: 'pending'; testId: string };

export function MailboxForm({
  tenantId,
  reconnect,
  onSaved,
}: {
  tenantId: string;
  reconnect?: { id: string; email: string; provider: Provider };
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(reconnect?.provider ?? 'gmail');
  const [email, setEmail] = useState(reconnect?.email ?? '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(465);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guide = GUIDES[provider];

  async function test(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        provider,
        emailAddress: email.trim(),
        // Google shows App Passwords in groups of four; the spaces are not part of it.
        password:
          provider === 'gmail' || provider === 'google_workspace'
            ? password.replace(/\s+/g, '')
            : password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(reconnect ? { reconnectId: reconnect.id } : {}),
        ...(provider === 'generic'
          ? {
              imap: { host: imapHost.trim(), port: imapPort, secure: true },
              smtp: {
                host: smtpHost.trim(),
                port: smtpPort,
                security: smtpPort === 465 ? 'tls' : 'starttls',
              },
            }
          : {}),
      };
      setResult(
        await api<TestResult>(`/v1/tenants/${tenantId}/connections/test`, { method: 'POST', body }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (result?.status !== 'ok') return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/tenants/${tenantId}/connections`, {
        method: 'POST',
        body: { testId: result.testId },
      });
      setPassword('');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Saving failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={test} className="space-y-4">
      {!reconnect && (
        <Field label="Email provider">
          <select
            className={inputClass}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setResult(null);
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      {provider === 'outlook' ? (
        <Notice>
          Microsoft no longer allows password sign-in for Outlook and Microsoft 365 mailboxes, so
          they can&apos;t be connected in this version. Support is planned.
        </Notice>
      ) : (
        <>
          {guide && (
            <details
              className="rounded-lg border border-neutral-200 bg-neutral-50 p-3"
              open={!reconnect}
            >
              <summary className="cursor-pointer text-sm font-medium">
                How to create an App Password
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
                {guide.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {guide.shots.length > 0 && (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {guide.shots.map((s) => (
                    <div
                      key={s}
                      className="flex h-24 items-center justify-center rounded-md border border-dashed border-neutral-300 bg-white p-2 text-center text-xs text-neutral-400"
                    >
                      [Screenshot: {s}]
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-neutral-500">
                Noctiv reads your inbox without marking anything as read, and sends only replies you
                approve (or, if you switch it on later, replies that pass every safety check).
              </p>
            </details>
          )}
          <Field label="Email address">
            <input
              className={inputClass}
              type="email"
              required
              readOnly={Boolean(reconnect)}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {!reconnect && (
            <Field label="Sender name (optional)" hint="Shown to customers, e.g. your shop name.">
              <input
                className={inputClass}
                value={displayName}
                maxLength={200}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
          )}
          <Field
            label="App Password"
            hint="Stored encrypted. Only the mail worker can unlock it; nobody can read it back."
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {provider === 'generic' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field label="IMAP server">
                  <input
                    className={inputClass}
                    required
                    value={imapHost}
                    placeholder="imap.example.com"
                    onChange={(e) => setImapHost(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  required
                  value={imapPort}
                  onChange={(e) => setImapPort(Number(e.target.value))}
                />
              </Field>
              <div className="col-span-2">
                <Field label="SMTP server">
                  <input
                    className={inputClass}
                    required
                    value={smtpHost}
                    placeholder="smtp.example.com"
                    onChange={(e) => setSmtpHost(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Port">
                <input
                  className={inputClass}
                  type="number"
                  required
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value))}
                />
              </Field>
            </div>
          )}

          <ErrorText>{error}</ErrorText>
          {result?.status === 'failed' && (
            <ErrorText>
              <strong>
                {result.stage === 'smtp'
                  ? 'Sending'
                  : result.stage === 'imap'
                    ? 'Reading mail'
                    : 'Setup'}{' '}
                failed:
              </strong>{' '}
              {result.message}
              {result.detail && (
                <span className="mt-1 block text-xs opacity-75">Server said: {result.detail}</span>
              )}
            </ErrorText>
          )}
          {result?.status === 'pending' && (
            <Notice>The mail server is slow to answer. Please try the test again.</Notice>
          )}
          {result?.status === 'ok' ? (
            <div className="space-y-3">
              <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                ✓ Connection works: Noctiv can read your inbox and send from this address.
              </p>
              <Button type="button" disabled={busy} onClick={() => void save()} className="w-full">
                {reconnect ? 'Reconnect mailbox' : 'Save mailbox'}
              </Button>
            </div>
          ) : (
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Testing… (up to 25 seconds)' : 'Test connection'}
            </Button>
          )}
        </>
      )}
    </form>
  );
}
