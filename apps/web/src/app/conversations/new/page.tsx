'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppPage } from '@/components/shell';
import {
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  inputClass,
  Loading,
  Notice,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { DOC_TYPE, type Doc } from '@/lib/documents';
import { useNav } from '@/lib/nav';
import { money } from '@/lib/quotes';
import { useTenantId } from '@/lib/session';

interface ComposeInfo {
  from: { address: string; name: string | null } | null;
  documents: Doc[];
  followup: { afterDays: number } | null;
}
interface Assist {
  subject: string;
  body: string;
  sources: string[];
  unsupportedNumbers: string[];
}

function WithAi({
  tenantId,
  to,
  subject,
  onDraft,
}: {
  tenantId: string;
  to: string;
  subject: string;
  onDraft: (a: Assist) => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<Assist | null>(null);
  const a = useAction();
  if (!open)
    return (
      <button
        type="button"
        className="text-sm font-medium text-indigo-700"
        onClick={() => setOpen(true)}
      >
        ✨ Write with AI
      </button>
    );
  return (
    <div className="space-y-3 rounded-xl bg-indigo-50/60 p-3 ring-1 ring-indigo-100">
      <Field
        label="What should the e-mail say?"
        hint="Facts about your business come only from your knowledge base. You can edit the text before sending."
      >
        <textarea
          className={`${inputClass} min-h-20`}
          maxLength={2000}
          value={notes}
          placeholder="e.g. Tell Rūta the lavender candles are back in stock and ask if she still wants 20."
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={a.busy || notes.trim().length < 3}
          onClick={() =>
            void a.run(async () => {
              const r = await api<Assist>(`/v1/tenants/${tenantId}/compose/assist`, {
                method: 'POST',
                body: { notes, subject: subject || null, to: to || null },
              });
              setResult(r);
              onDraft(r);
            })
          }
        >
          {a.busy ? 'Writing…' : result ? 'Write again' : 'Write draft'}
        </Button>
        <button type="button" className="text-sm text-neutral-500" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <ErrorText>{a.error}</ErrorText>
      {result && result.unsupportedNumbers.length > 0 && (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Check these numbers — they are not in your notes or knowledge base:{' '}
          <strong>{result.unsupportedNumbers.join(', ')}</strong>
        </p>
      )}
      {result && result.sources.length > 0 && (
        <details className="text-xs text-neutral-600">
          <summary className="cursor-pointer">
            Based on {result.sources.length} knowledge-base
            {result.sources.length === 1 ? ' excerpt' : ' excerpts'}
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {result.sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Compose() {
  const tenantId = useTenantId();
  const router = useRouter();
  const { reload: reloadNav } = useNav();
  const info = useLoad(() => api<ComposeInfo>(`/v1/tenants/${tenantId}/compose`), [tenantId]);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [followUp, setFollowUp] = useState(true);
  const send = useAction();
  if (info.error) return <ErrorText>{info.error}</ErrorText>;
  if (!info.data) return <Loading />;
  const { from, documents, followup } = info.data;
  if (!from)
    return (
      <Notice>
        Connect a mailbox first: new e-mails are sent from it.{' '}
        <Link className="underline" href="/settings/mailboxes">
          Connect a mailbox
        </Link>
      </Notice>
    );
  const toggleDoc = (id: string) =>
    setDocs((d) => (d.includes(id) ? d.filter((x) => x !== id) : d.length < 5 ? [...d, id] : d));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send.run(async () => {
          const r = await api<{ threadId: string }>(`/v1/tenants/${tenantId}/compose`, {
            method: 'POST',
            body: { to, subject, body, documentIds: docs, followUp: followup ? followUp : false },
          });
          await reloadNav();
          router.push(`/conversations/${r.threadId}`);
        });
      }}
    >
      <Card>
        <div className="space-y-3">
          <p className="text-sm text-neutral-600">
            From <span className="font-medium text-neutral-900">{from.address}</span>
          </p>
          <Field label="To">
            <input
              className={inputClass}
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label="Subject">
            <input
              className={inputClass}
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <WithAi
            tenantId={tenantId}
            to={to}
            subject={subject}
            onDraft={(a) => {
              setBody(a.body);
              if (!subject && a.subject) setSubject(a.subject);
            }}
          />
          <Field label="Message" hint="Your signature and e-mail design are added automatically.">
            <textarea
              className={`${inputClass} min-h-48`}
              required
              maxLength={20000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title="Attach documents">
        {documents.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No ready documents. Documents become ready when you create them in{' '}
            <Link className="text-indigo-700" href="/documents">
              Documents
            </Link>
            .
          </p>
        ) : (
          <ul className="-mx-1 divide-y divide-neutral-100">
            {documents.map((d) => {
              const on = docs.includes(d.id);
              return (
                <li key={d.id}>
                  <label
                    className={cx(
                      'flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-1 py-2',
                      on && 'bg-indigo-50/60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-indigo-700"
                      checked={on}
                      onChange={() => toggleDoc(d.id)}
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">
                        {DOC_TYPE[d.type].short} {d.number}
                      </span>
                      <span className="block truncate text-xs text-neutral-500">
                        {d.counterparty_name ?? 'no customer'}
                      </span>
                    </span>
                    {d.payable && (
                      <span className="text-sm tabular-nums">
                        {money(d.total_cents, d.currency)}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {docs.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            {docs.length} attached as PDF · marked as sent when the e-mail goes out.
          </p>
        )}
      </Card>

      {followup && (
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3">
          <input
            type="checkbox"
            className="h-5 w-5 shrink-0 accent-indigo-700"
            checked={followUp}
            onChange={(e) => setFollowUp(e.target.checked)}
          />
          <span className="text-sm">
            Follow up if no reply
            <span className="block text-xs text-neutral-500">
              A short reminder after {followup.afterDays}{' '}
              {followup.afterDays === 1 ? 'day' : 'days'}, as for replies. It stops when the
              customer answers.
            </span>
          </span>
        </label>
      )}

      <ErrorText>{send.error}</ErrorText>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={send.busy} className="w-full sm:w-auto">
          {send.busy ? 'Sending…' : 'Send'}
        </Button>
        <Link className="text-sm text-neutral-600" href="/conversations">
          Cancel
        </Link>
      </div>
      <p className="text-xs text-neutral-500">
        Starts a new conversation and adds the address to your leads. Replies arrive in your Inbox.
      </p>
    </form>
  );
}

export default function NewEmailPage() {
  return (
    <AppPage title="New e-mail">
      <Compose />
    </AppPage>
  );
}
