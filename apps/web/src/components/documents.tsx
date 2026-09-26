'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, ErrorText, useAction } from './ui';
import { api } from '@/lib/api';
import { DOC_STATUS, DOC_TYPE, editable, type Doc, type DocType } from '@/lib/documents';
import { money, type Quote } from '@/lib/quotes';

/** One document as a compact row (conversation page, reply drafts). */
export function DocumentChip({ doc }: { doc: Doc }) {
  const st = DOC_STATUS[doc.status];
  return (
    <Link
      href={`/documents/${doc.id}`}
      className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50"
    >
      <span aria-hidden className="text-neutral-400">
        ▤
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">
          {DOC_TYPE[doc.type].short} {doc.number ?? 'draft'}
        </span>
        {doc.counterparty_name && (
          <span className="text-neutral-500"> · {doc.counterparty_name}</span>
        )}
      </span>
      {doc.payable && <span className="tabular-nums">{money(doc.total_cents, doc.currency)}</span>}
      <Badge tone={st.tone}>{st.text}</Badge>
    </Link>
  );
}

/** The document a reply draft carries, with a way to change it before approval. */
export function DraftDocument({ doc }: { doc: Doc }) {
  return (
    <div className="mb-3 space-y-2">
      <DocumentChip doc={doc} />
      <p className="text-xs text-neutral-500">
        Sent as a PDF attachment
        {doc.type === 'cmr' ? ' (four copies: sender, consignee, carrier, extra)' : ''}.{' '}
        {editable(doc.status) && (
          <Link className="text-indigo-700" href={`/documents/${doc.id}`}>
            Edit the document
          </Link>
        )}{' '}
        The message to the customer:
      </p>
    </div>
  );
}

/** Documents in a conversation, and ways to create one from it. */
export function ConversationDocuments({
  tenantId,
  threadId,
  documents,
  quotes,
  latestInboundId,
}: {
  tenantId: string;
  threadId: string;
  documents: Doc[];
  quotes: Quote[];
  latestInboundId: string | null;
}) {
  const router = useRouter();
  const a = useAction();
  const create = (body: Record<string, unknown>) =>
    void a.run(async () => {
      const d = await api<{ id: string }>(`/v1/tenants/${tenantId}/documents`, {
        method: 'POST',
        body,
      });
      router.push(`/documents/${d.id}`);
    });
  const accepted = quotes.filter((q) => q.status === 'accepted');
  const invoiced = new Set(documents.map((d) => d.quote_id).filter(Boolean));
  return (
    <Card title="Documents (beta)">
      {documents.length > 0 && (
        <ul className="mb-3 space-y-2">
          {documents.map((d) => (
            <li key={d.id}>
              <DocumentChip doc={d} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {accepted
          .filter((q) => !invoiced.has(q.id))
          .map((q) => (
            <Button
              key={q.id}
              disabled={a.busy}
              onClick={() => create({ type: 'invoice', fromQuoteId: q.id })}
            >
              Invoice for {q.number}
            </Button>
          ))}
        {latestInboundId && (
          <Button
            variant="secondary"
            disabled={a.busy}
            onClick={() => create({ type: 'cmr', fromMessageId: latestInboundId })}
          >
            Draft CMR from this e-mail
          </Button>
        )}
        {(['invoice', 'delivery_note'] as DocType[]).map((t) => (
          <Button
            key={t}
            variant="ghost"
            disabled={a.busy}
            onClick={() => create({ type: t, threadId })}
          >
            New {DOC_TYPE[t].name.toLowerCase()}
          </Button>
        ))}
      </div>
      <ErrorText>{a.error}</ErrorText>
    </Card>
  );
}
