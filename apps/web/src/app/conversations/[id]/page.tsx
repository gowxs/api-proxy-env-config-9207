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
import { ConversationBookings, InsertFormLink } from '@/components/bookings';
import type { Doc } from '@/lib/documents';
import { OWNER_REPLIED_STATUS, reasonText, THREAD_STATUS } from '@/lib/reasons';
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
  message_id_header: string | null;
  /** Read at the provider (null: unknown). */
  seen: boolean | null;
  /** 'owner': written in the owner's own mail client. */
  sent_by: 'noctiv' | 'owner' | null;
  attachment_meta: { filename: string | null; contentType: string; size: number }[] | null;
  /** What the order lookup found, or why it went to the owner (Shopify). */
  order_lookup?: OrderLookup | null;
}
interface OrderLookup {
  platform?: 'shopify' | 'woocommerce';
  result: 'found' | 'escalated';
  reason?: string;
  orderName?: string;
  payment?: string;
  fulfillment?: string;
  cancelled?: boolean;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedOn?: string | null;
  deliveredOn?: string | null;
  checkedAt: string;
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
    | 'compose'
    | 'booking'
    | 'booking_offer';
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
    provider?: string;
    owner_replied?: boolean;
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
  threadId,
  onChange,
}: {
  draft: Draft;
  /** For "Insert form link" (Bookings): the link is tied to this conversation's customer. */
  threadId: string;
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
                  : draft.kind === 'booking'
                    ? 'Booking e-mail (sent automatically)'
                    : draft.kind === 'booking_offer'
                      ? 'Reply with free times'
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
        <>
          <textarea
            className={`${inputClass} min-h-56 text-sm`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mt-2">
            <InsertFormLink
              tenantId={tenantId}
              threadId={threadId}
              onInsert={(line) => setBody((b) => `${b.trimEnd()}\n\n${line}`)}
            />
          </div>
        </>
      ) : (
        <div className="whitespace-pre-wrap rounded-lg bg-white p-3 text-sm ring-1 ring-neutral-200">
          {body || '(empty)'}
        </div>
      )}
      <p className="mt-1 text-xs text-neutral-500">Your signature is added when it is sent.</p>
      <ErrorText>{error}</ErrorText>
      {decidable && (
        <div
          data-sticky-actions
          className="mt-3 flex flex-wrap gap-2 max-lg:sticky max-lg:bottom-[calc(3.75rem+env(safe-area-inset-bottom))] max-lg:z-10 max-lg:-mx-4 max-lg:-mb-4 max-lg:rounded-b-xl max-lg:border-t max-lg:border-amber-200 max-lg:bg-white/95 max-lg:px-4 max-lg:py-3 max-lg:backdrop-blur [&>button]:max-lg:flex-1 [&>button]:max-lg:px-2 [&>button]:max-lg:whitespace-nowrap [&>button:first-child]:max-lg:flex-[2]"
        >
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

const size = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** Gmail / Google Workspace can open a message by its Message-ID; other providers have no such link. */
function webmailUrl(mailbox: string, provider: string | undefined, id: string | null) {
  if (!id || (provider !== 'gmail' && provider !== 'google_workspace')) return null;
  const q = encodeURIComponent(`rfc822msgid:${id.replace(/^<|>$/g, '')}`);
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#search/${q}`;
}

const PAYMENT_TEXT: Record<string, string> = {
  paid: 'Paid',
  pending: 'Payment pending',
  authorized: 'Payment authorised',
  partially_paid: 'Partly paid',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  voided: 'Payment voided',
};
const SHIP_TEXT: Record<string, string> = { shipped: 'Shipped', not_shipped: 'Not shipped yet' };

/** The facts the reply was based on, so the owner can see them (no addresses, no payment details). */
function OrderCard({ o }: { o: OrderLookup }) {
  const shop = o.platform === 'woocommerce' ? 'WooCommerce' : 'Shopify';
  const found = o.result === 'found';
  const https = o.trackingUrl && /^https:\/\//.test(o.trackingUrl) ? o.trackingUrl : null;
  return (
    <div
      className={`mt-2 rounded-lg p-3 text-sm ${found ? 'bg-green-50 ring-1 ring-green-200' : 'bg-amber-50 ring-1 ring-amber-200'}`}
    >
      <p className="font-semibold">
        {found ? `Order found in ${shop}` : `Order lookup in ${shop}`}
        {o.orderName ? ` · ${o.orderName}` : ''}
      </p>
      {o.reason && <p className="text-neutral-700">{reasonText(o.reason)}</p>}
      {o.orderName && o.payment && (
        <p className="text-neutral-700">
          {[
            o.cancelled ? 'Cancelled' : null,
            PAYMENT_TEXT[o.payment] ?? null,
            SHIP_TEXT[o.fulfillment ?? ''] ?? o.fulfillment ?? null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {(o.carrier || o.trackingNumber) && (
        <p className="break-words text-neutral-700">
          {[o.carrier, o.trackingNumber].filter(Boolean).join(' · ')}
          {o.deliveredOn
            ? ` · delivered ${o.deliveredOn}`
            : o.shippedOn
              ? ` · shipped ${o.shippedOn}`
              : ''}
        </p>
      )}
      {https && (
        <a
          className="inline-flex min-h-11 items-center text-indigo-700"
          href={https}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open tracking
        </a>
      )}
      <p className="text-xs text-neutral-500">
        Checked live {fmt(o.checkedAt)}; nothing is stored beyond this summary.
      </p>
    </div>
  );
}

function MessageItem({ m, mailbox, provider }: { m: Message; mailbox: string; provider?: string }) {
  const inbound = m.direction === 'inbound';
  const link = webmailUrl(mailbox, provider, m.message_id_header);
  const files = m.attachment_meta ?? [];
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
        {inbound && m.seen === false && (
          <span className="flex items-center gap-1 text-indigo-700">
            <span className="inline-block size-2 rounded-full bg-indigo-600" aria-hidden />
            Unread in your mailbox
          </span>
        )}
        {m.sent_by === 'owner' && <span>sent from your own mail client</span>}
        {link && (
          <a className="text-indigo-700" href={link} target="_blank" rel="noopener noreferrer">
            Open in Gmail
          </a>
        )}
      </div>
      {m.body_text ? (
        <div className="whitespace-pre-wrap text-sm">{m.body_text}</div>
      ) : (
        <p className="text-sm italic text-neutral-500">Text deleted after the retention period.</p>
      )}
      {m.order_lookup && <OrderCard o={m.order_lookup} />}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1 text-xs text-neutral-600">
          {files.map((f, i) => (
            <li key={i} className="rounded bg-neutral-100 px-2 py-0.5">
              📎 {f.filename || 'attachment'} ({size(f.size)})
            </li>
          ))}
          <li className="self-center text-neutral-500">
            {link ? 'Open in Gmail to download.' : 'Open it in your mail app to download.'}
          </li>
        </ul>
      )}
      {inbound && m.processing_status && (
        <div className="mt-2 flex flex-wrap gap-1">
          {m.summary && (
            <span className="w-full text-xs text-neutral-600">Summary: {m.summary}</span>
          )}
          {(m.processing_status === 'queued' || m.processing_status === 'processing') && (
            <Badge tone="blue">
              Noctiv is still reading this e-mail — a draft appears here soon
            </Badge>
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
  const st =
    t.owner_replied && t.status === 'awaiting_customer'
      ? OWNER_REPLIED_STATUS
      : (THREAD_STATUS[t.status] ?? { text: t.status, tone: 'gray' as const });
  const openDrafts = data.drafts.filter((d) =>
    ['pending_approval', 'suggestion', 'approved', 'send_failed'].includes(d.status),
  );
  const otherDrafts = data.drafts.filter((d) => !openDrafts.includes(d) && d.status !== 'sent');
  const openEsc = data.escalations.filter((e) => !e.resolved_at);
  const latestInbound = [...data.messages].reverse().find((m) => m.direction === 'inbound');

  return (
    <div className="space-y-4">
      <div>
        <Link href="/conversations" className="text-sm text-indigo-700">
          ← Inbox
        </Link>
        <h2 className="mt-2 text-lg font-semibold">{t.subject || '(no subject)'}</h2>
        <p className="text-sm text-neutral-600">
          {!data.messages.some((m) => m.direction === 'inbound')
            ? `You (${t.mailbox}) → ${t.customer_name ? `${t.customer_name} · ` : ''}${t.customer_email}`
            : `${t.customer_name ? `${t.customer_name} · ` : ''}${t.customer_email} · to ${t.mailbox}`}
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
            {e.suggestion_draft_id
              ? 'Check the suggested reply below and send it, or reply from your own mail app. Then mark this as done.'
              : 'Reply from your own mail app, then mark this as done.'}
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

      {openDrafts.length > 0 && latestInbound?.body_text && (
        <details open className="rounded-xl bg-white p-4 ring-1 ring-neutral-200 lg:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
            <span className="min-w-0 flex-1 truncate">
              {latestInbound.from_name || latestInbound.from_address} wrote
            </span>
            <span className="text-xs font-normal text-neutral-500">
              {fmt(latestInbound.received_at)}
            </span>
          </summary>
          <p className="mt-1 text-sm whitespace-pre-wrap">{latestInbound.body_text}</p>
        </details>
      )}

      {openDrafts.map((d) => (
        <DraftCard
          key={d.id}
          draft={d}
          quote={data.quotes?.find((q) => q.draft_id === d.id)}
          document={data.documents?.find(
            (x) => x.draft_id === d.id || x.reminder_draft_id === d.id,
          )}
          tenantId={tenantId}
          threadId={t.id}
          onChange={() => void reload()}
        />
      ))}

      <ConversationBookings tenantId={tenantId} threadId={t.id} />

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
          <MessageItem
            key={m.id}
            m={m}
            mailbox={data.thread.mailbox}
            provider={data.thread.provider}
          />
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
