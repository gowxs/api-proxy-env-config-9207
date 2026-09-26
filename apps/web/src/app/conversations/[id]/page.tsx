'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppPage } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  inputClass,
  Loading,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import type { Quote } from '@/lib/quotes';
import { QuoteBlock } from '@/components/quote';
import { ConversationDocuments, DraftDocument } from '@/components/documents';
import type { Doc } from '@/lib/documents';
import { reasonText, THREAD_STATUS } from '@/lib/reasons';
import { useTenantId } from '@/lib/session';

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  from_address: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  body_purged_at: string | null;
  processing_status: string | null;
  final_action: string | null;
  downgrade_reasons: string[] | null;
  skip_reason: string | null;
  summary: string | null;
}
interface Draft {
  id: string;
  kind:
    | 'reply'
    | 'followup'
    | 'acknowledgement'
    | 'quote'
    | 'document'
    | 'payment_reminder'
    | 'compose';
  status: string;
  to_address: string;
  subject: string;
  body: string | null;
  edited: boolean;
  decided_by: string | null;
  created_at: string;
}
interface Escalation {
  id: string;
  category: 'hard_list' | 'uncertain';
  reason: string;
  summary: string | null;
  suggestion_draft_id: string | null;
  resolved_at: string | null;
}
interface Detail {
  thread: {
    id: string;
    subject: string | null;
    status: string;
    followups_sent: number;
    next_followup_at: string | null;
    followup_stop_reason: string | null;
    customer_email: string | null;
    customer_name: string | null;
    lead_stage: string | null;
    mailbox: string;
  };
  messages: Message[];
  drafts: Draft[];
  escalations: Escalation[];
  /** Quotes (beta) in this conversation. */
  quotes?: Quote[];
  /** Documents (beta) in this conversation; absent when the module is off. */
  documents?: Doc[];
  documentsEnabled?: boolean;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const DRAFT_STATUS: Record<
  string,
  { text: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'blue' }
> = {
  pending_approval: { text: 'Waiting for approval', tone: 'amber' },
  suggestion: { text: 'AI suggestion, unverified', tone: 'red' },
  approved: { text: 'Approved — sending', tone: 'blue' },
  sent: { text: 'Sent', tone: 'green' },
  rejected: { text: 'Rejected', tone: 'gray' },
  send_failed: { text: 'Sending failed', tone: 'red' },
  superseded: { text: 'Replaced', tone: 'gray' },
};

function DraftCard({
  draft,
  quote,
  document,
  tenantId,
  onChange,
}: {
  draft: Draft;
  /** For a document draft: the document it carries. */
  document?: Doc;
  /** For a quote draft: the quote it carries. */
  quote?: Quote;
  tenantId: string;
  onChange: () => void;
}) {
  const [body, setBody] = useState(draft.body ?? '');
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const decidable = draft.status === 'pending_approval' || draft.status === 'suggestion';
  const st = DRAFT_STATUS[draft.status] ?? { text: draft.status, tone: 'gray' as const };
  const base = `/v1/tenants/${tenantId}/drafts/${draft.id}`;
  const changed = body.trim() !== (draft.body ?? '').trim();

  return (
    <div
      id={`draft-${draft.id}`}
      className="rounded-xl border-2 border-amber-200 bg-amber-50/40 p-4"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {draft.kind === 'quote'
            ? 'Quote reply'
            : draft.kind === 'document'
              ? 'Reply with document'
              : draft.kind === 'payment_reminder'
                ? 'Payment reminder'
                : draft.kind === 'compose'
                  ? 'New e-mail'
                  : draft.kind === 'followup'
                    ? 'Follow-up draft'
                    : draft.kind === 'acknowledgement'
                      ? 'Acknowledgement (sent automatically)'
                      : 'Reply draft'}
        </span>
        <Badge tone={st.tone}>{st.text}</Badge>
        {draft.edited && <Badge>Edited</Badge>}
      </div>
      <p className="mb-2 text-xs text-neutral-500">
        To {draft.to_address} · {draft.subject}
      </p>
      {quote && (
        <div className="mb-3">
          <QuoteBlock quote={quote} tenantId={tenantId} onChange={onChange} />
          <p className="mt-2 text-xs text-neutral-500">
            Sent as a PDF attachment with an “Approve quote” link. The message to the customer:
          </p>
        </div>
      )}
      {document && <DraftDocument doc={document} />}
      {draft.status === 'suggestion' && (
        <p className="mb-2 text-xs text-red-800">
          The assistant was not sure about this answer. Check every fact before sending.
        </p>
      )}
      {editing ? (
        <textarea
          className={`${inputClass} min-h-56 text-sm`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      ) : (
        <div className="whitespace-pre-wrap rounded-lg bg-white p-3 text-sm ring-1 ring-neutral-200">
          {body || '(empty)'}
        </div>
      )}
      <p className="mt-1 text-xs text-neutral-500">Your signature is added when it is sent.</p>
      <ErrorText>{error}</ErrorText>
      {decidable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={busy || !body.trim()}
            onClick={() =>
              void run(async () => {
                await api(`${base}/approve`, { method: 'POST', body: changed ? { body } : {} });
                setEditing(false);
                onChange();
              })
            }
          >
            {changed ? 'Save and send' : 'Approve and send'}
          </Button>
          {editing ? (
            changed && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(base, { method: 'PATCH', body: { body } });
                    setEditing(false);
                    onChange();
                  })
                }
              >
                Save draft
              </Button>
            )
          ) : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!confirm('Reject this draft? Nothing will be sent.')) return;
              void run(async () => {
                await api(`${base}/reject`, { method: 'POST', body: {} });
                onChange();
              });
            }}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function MessageItem({ m }: { m: Message }) {
  const inbound = m.direction === 'inbound';
  const reasons = m.downgrade_reasons ?? [];
  return (
    <li
      className={`rounded-xl p-4 ${inbound ? 'bg-white ring-1 ring-neutral-200' : 'ml-6 bg-indigo-50'}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
        <span className="font-medium text-neutral-800">
          {inbound ? m.from_name || m.from_address : 'You'}
        </span>
        <span>{fmt(m.received_at)}</span>
      </div>
      {m.body_text ? (
        <div className="whitespace-pre-wrap text-sm">{m.body_text}</div>
      ) : (
        <p className="text-sm italic text-neutral-500">Text deleted after the retention period.</p>
      )}
      {inbound && m.processing_status && (
        <div className="mt-2 flex flex-wrap gap-1">
          {m.summary && (
            <span className="w-full text-xs text-neutral-600">Summary: {m.summary}</span>
          )}
          {m.skip_reason && <Badge>{reasonText(m.skip_reason)}</Badge>}
          {reasons.map((r) => (
            <Badge key={r} tone="amber">
              {reasonText(r)}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

function ConversationView() {
  const tenantId = useTenantId();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useLoad(
    () => api<Detail>(`/v1/tenants/${tenantId}/conversations/${id}`),
    [tenantId, id],
  );
  const resolve = useAction();
  const sending = data?.drafts.some((d) => d.status === 'approved') ?? false;
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [sending, reload]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  const t = data.thread;
  const st = THREAD_STATUS[t.status] ?? { text: t.status, tone: 'gray' as const };
  const openDrafts = data.drafts.filter((d) =>
    ['pending_approval', 'suggestion', 'approved', 'send_failed'].includes(d.status),
  );
  const otherDrafts = data.drafts.filter((d) => !openDrafts.includes(d) && d.status !== 'sent');
  const openEsc = data.escalations.filter((e) => !e.resolved_at);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/conversations" className="text-sm text-indigo-700">
          ← Inbox
        </Link>
        <h2 className="mt-2 text-lg font-semibold">{t.subject || '(no subject)'}</h2>
        <p className="text-sm text-neutral-600">
          {t.customer_name ? `${t.customer_name} · ` : ''}
          {t.customer_email} · to {t.mailbox}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge tone={st.tone}>{st.text}</Badge>
          {t.next_followup_at && <Badge tone="blue">Follow-up {fmt(t.next_followup_at)}</Badge>}
          {t.followups_sent > 0 && <Badge>{t.followups_sent} follow-up(s) sent</Badge>}
        </div>
      </div>

      {openEsc.map((e) => (
        <Card
          key={e.id}
          title={<span className="text-red-800">Please reply to this yourself</span>}
        >
          <p className="text-sm">{e.summary}</p>
          <p className="mt-1 text-xs text-neutral-500">
            Reason: {e.reason.split(', ').map(reasonText).join(' · ')}
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Reply from your own mail app, then mark this as done.
          </p>
          <ErrorText>{resolve.error}</ErrorText>
          <Button
            variant="secondary"
            className="mt-3"
            disabled={resolve.busy}
            onClick={() =>
              void resolve.run(async () => {
                await api(`/v1/tenants/${tenantId}/escalations/${e.id}/resolve`, {
                  method: 'POST',
                  body: {},
                });
                await reload();
              })
            }
          >
            Mark as done
          </Button>
        </Card>
      ))}

      {openDrafts.map((d) => (
        <DraftCard
          key={d.id}
          draft={d}
          quote={data.quotes?.find((q) => q.draft_id === d.id)}
          document={data.documents?.find(
            (x) => x.draft_id === d.id || x.reminder_draft_id === d.id,
          )}
          tenantId={tenantId}
          onChange={() => void reload()}
        />
      ))}

      {(data.quotes ?? [])
        .filter((q) => !openDrafts.some((d) => d.id === q.draft_id))
        .map((q) => (
          <QuoteBlock key={q.id} quote={q} tenantId={tenantId} onChange={() => void reload()} />
        ))}

      {data.documentsEnabled && (
        <ConversationDocuments
          tenantId={tenantId}
          threadId={t.id}
          documents={data.documents ?? []}
          quotes={data.quotes ?? []}
          latestInboundId={
            [...data.messages].reverse().find((m) => m.direction === 'inbound' && m.body_text)
              ?.id ?? null
          }
        />
      )}

      <ul className="space-y-3">
        {data.messages.map((m) => (
          <MessageItem key={m.id} m={m} />
        ))}
      </ul>

      {otherDrafts.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-600">
            Earlier drafts ({otherDrafts.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {otherDrafts.map((d) => (
              <li key={d.id} className="rounded-lg bg-white p-3 ring-1 ring-neutral-200">
                <Badge tone={DRAFT_STATUS[d.status]?.tone ?? 'gray'}>
                  {DRAFT_STATUS[d.status]?.text ?? d.status}
                </Badge>
                <div className="mt-1 whitespace-pre-wrap text-neutral-700">{d.body}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function ConversationPage() {
  return (
    <AppPage title="Conversation">
      <ConversationView />
    </AppPage>
  );
}
