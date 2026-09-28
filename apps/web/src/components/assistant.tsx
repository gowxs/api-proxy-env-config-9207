'use client';

/**
 * Noctiv Assistant (beta), PLAN.md §27: the chat panel (floating button on
 * every page, first screen of onboarding). The assistant only reads and
 * proposes; a proposal changes something only when the owner presses
 * Confirm, and anything that affects sending goes through the same
 * confirmation dialog as Settings.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AutoSendDialog } from '@/components/auto-send-dialog';
import { MailboxForm } from '@/components/mailbox-form';
import { Button, cx, ErrorText } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import {
  browserLocale,
  type DocLine,
  INTL_LOCALE,
  WORDS,
  type AssistantLocale,
  type AssistantMessage,
  type AssistantProposal,
  type AssistantThread,
} from '@/lib/assistant';
import { modeRank, type Mode } from '@/lib/modes';

const money = (cents: number, currency: string, locale: AssistantLocale) =>
  new Intl.NumberFormat(INTL_LOCALE[locale], { style: 'currency', currency }).format(cents / 100);

function SendingDialog({
  locale,
  lines,
  onConfirm,
  onCancel,
  busy,
  text,
}: {
  locale: AssistantLocale;
  lines: [string, string][];
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  /** The e-mail and payment cards say what exactly happens. */
  text?: { title: string; body: string; check: string; button: string; preview?: string };
}) {
  const w = WORDS[locale];
  const [ok, setOk] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sending-dialog-title"
    >
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5">
        <h2 id="sending-dialog-title" className="text-lg font-semibold">
          {text?.title ?? w.sendingTitle}
        </h2>
        <p className="text-sm text-neutral-700">{text?.body ?? w.sendingBody}</p>
        <dl className="space-y-1 rounded-lg bg-neutral-50 p-3 text-sm">
          {lines.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-neutral-500">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        {text?.preview && (
          <p className="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 p-3 text-sm whitespace-pre-wrap">
            {text.preview}
          </p>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={ok}
            onChange={(e) => setOk(e.target.checked)}
          />
          <span>{text?.check ?? w.sendingCheck}</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {w.cancel}
          </Button>
          <Button disabled={!ok || busy} onClick={onConfirm}>
            {text?.button ?? w.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProposalCard({
  p,
  tenantId,
  locale,
  currentMode,
  onChanged,
  waitingFor,
}: {
  p: AssistantProposal;
  /** An e-mail that attaches the document card above: that card's status. */
  waitingFor?: AssistantProposal['status'];
  tenantId: string;
  locale: AssistantLocale;
  currentMode: Mode | null;
  onChanged: (next: AssistantProposal) => void;
}) {
  const w = WORDS[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'mode' | 'sending' | null>(null);
  const targetMode = p.payload.changes?.mode as Mode | undefined;

  const decide = async (action: 'apply' | 'dismiss', confirmSending = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ proposal: AssistantProposal }>(
        `/v1/tenants/${tenantId}/assistant/proposals/${p.id}/${action}`,
        { method: 'POST', body: action === 'apply' && confirmSending ? { confirmSending } : {} },
      );
      onChanged(r.proposal);
      setDialog(null);
    } catch (e) {
      // Close the dialog so the reason is visible under the card.
      setDialog(null);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const [formOpen, setFormOpen] = useState(false);
  const confirm = () => {
    // The mailbox card opens the prefilled form; saving the mailbox completes the card.
    if (p.type === 'connect_mailbox') return setFormOpen((o) => !o);
    if (!p.requires_confirmation) return void decide('apply');
    // Moving to a more automatic mode: the same dialog as Settings → Reply mode.
    if (targetMode && (!currentMode || modeRank(targetMode) > modeRank(currentMode)))
      return setDialog('mode');
    setDialog('sending');
  };

  const a = w.actions;
  const pl = p.payload;
  const cur = pl.currency ?? 'EUR';
  const label =
    p.type === 'knowledge_note'
      ? w.noteCard
      : p.type === 'price_items'
        ? w.priceCard
        : p.type === 'create_document'
          ? pl.docType === 'delivery_note'
            ? a.deliveryNote
            : a.invoice
          : p.type === 'send_email'
            ? a.email
            : p.type === 'mark_paid'
              ? a.paid
              : p.type === 'connect_mailbox'
                ? a.mailbox
                : null;
  const docLines = p.type === 'create_document' ? (pl.lines as unknown as DocLine[]) : [];
  const dialogText =
    p.type === 'send_email'
      ? {
          title: a.sendTitle,
          body: a.sendBody,
          check: a.sendCheck,
          button: a.send,
          preview: `${pl.subject ?? ''}\n\n${pl.body ?? ''}`,
        }
      : p.type === 'mark_paid'
        ? { title: a.paidTitle, body: a.paidBody, check: w.sendingCheck, button: w.confirm }
        : undefined;
  const dialogLines: [string, string][] =
    p.type === 'send_email'
      ? [
          ['To', pl.to ?? ''],
          ...(pl.attachLabels ?? []).map((l, i): [string, string] => [i ? '' : 'Attached', l]),
        ]
      : p.type === 'mark_paid'
        ? [['Document', pl.number ?? '']]
        : (pl.lines ?? []);
  return (
    <div className="mt-2 rounded-xl border border-indigo-200 bg-white p-3 text-sm shadow-sm">
      <p className="text-xs font-semibold tracking-wide text-indigo-700 uppercase">
        {label ?? w.proposedChange}
      </p>
      <p className="mt-1 font-medium">{p.title}</p>
      {p.type === 'settings' && p.payload.lines && (
        <dl className="mt-2 space-y-1">
          {p.payload.lines.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-neutral-500">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.type === 'knowledge_note' && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-2 whitespace-pre-wrap">
          <p className="font-medium">{p.payload.title}</p>
          <p className="mt-1 text-neutral-700">{p.payload.text}</p>
        </div>
      )}
      {p.type === 'price_items' && (
        <ul className="mt-2 divide-y divide-neutral-100">
          {p.payload.items?.map((i) => (
            <li key={i.name} className="flex justify-between gap-3 py-1">
              <span>{i.name}</span>
              <span className="tabular-nums">
                {money(i.unitPriceCents, i.currency, locale)} / {i.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.type === 'create_document' && (
        <div className="mt-2 space-y-2">
          <p className="text-neutral-700">
            <span className="font-medium">{pl.buyer?.name || pl.buyer?.email}</span>
            {pl.buyer?.email && pl.buyer.name ? ` · ${pl.buyer.email}` : ''}
            <br />
            <span className="text-neutral-500">{pl.buyer?.address}</span>
          </p>
          <ul className="divide-y divide-neutral-100">
            {docLines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3 py-1">
                <span>
                  {l.name}
                  {l.qty !== 1 ? ` × ${l.qty} ${l.unit}` : ''}
                </span>
                <span className="tabular-nums">
                  {l.unitPriceCents === null ? '—' : money(l.unitPriceCents, cur, locale)}
                </span>
              </li>
            ))}
          </ul>
          {pl.totals && (
            <dl className="space-y-0.5 border-t border-neutral-200 pt-1 tabular-nums">
              {pl.vatMode !== 'none' && (
                <>
                  <div className="flex justify-between text-neutral-500">
                    <dt>Subtotal</dt>
                    <dd>{money(pl.totals.subtotalCents, cur, locale)}</dd>
                  </div>
                  <div className="flex justify-between text-neutral-500">
                    <dt>
                      VAT {pl.vatRate}%{pl.vatMode === 'inclusive' ? ' (included)' : ''}
                    </dt>
                    <dd>{money(pl.totals.vatCents, cur, locale)}</dd>
                  </div>
                </>
              )}
              <div className="flex justify-between font-semibold">
                <dt>Total</dt>
                <dd>{money(pl.totals.totalCents, cur, locale)}</dd>
              </div>
            </dl>
          )}
          {pl.dueDate && (
            <p className="text-neutral-600">
              Due{' '}
              {new Date(`${pl.dueDate}T12:00:00Z`).toLocaleDateString(INTL_LOCALE[locale], {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          )}
        </div>
      )}
      {p.type === 'send_email' && (
        <div className="mt-2 space-y-2">
          <dl className="space-y-1">
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">To</dt>
              <dd className="text-right font-medium break-all">
                {pl.name ? `${pl.name} <${pl.to}>` : pl.to}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-neutral-500">Subject</dt>
              <dd className="text-right font-medium">{pl.subject}</dd>
            </div>
          </dl>
          <p className="max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-2 whitespace-pre-wrap">
            {pl.body}
          </p>
          {(pl.attachLabels ?? []).map((l) => (
            <p key={l} className="text-neutral-600">
              📎 {waitingFor === 'applied' ? l.replace(/ \(once you confirm it above\)$/, '') : l}
            </p>
          ))}
        </div>
      )}
      {p.type === 'connect_mailbox' && (
        <div className="mt-2 space-y-1">
          <p>
            <span className="font-medium">{pl.label}</span>
            {pl.email ? ` · ${pl.email}` : ''}
          </p>
          {pl.provider === 'generic' && pl.imap && pl.smtp && (
            <p className="text-xs text-neutral-500">
              IMAP {pl.imap.host}:{pl.imap.port} · SMTP {pl.smtp.host}:{pl.smtp.port}
            </p>
          )}
          {pl.source === 'mx' && (
            <p className="text-xs text-neutral-500">Found from your domain&apos;s mail servers.</p>
          )}
          {formOpen && p.status === 'proposed' && (
            <div className="mt-3 border-t border-indigo-100 pt-3">
              <p className="mb-3 text-neutral-700">{a.passwordOnly}</p>
              <MailboxForm
                tenantId={tenantId}
                prefill={{
                  provider: pl.provider ?? 'generic',
                  email: pl.email ?? null,
                  imap: pl.imap ?? null,
                  smtp: pl.smtp ?? null,
                }}
                onSaved={() => void decide('apply')}
              />
            </div>
          )}
        </div>
      )}
      {p.type === 'connect_mailbox' && p.status === 'applied' && (
        <p className="mt-2 text-sm font-medium text-green-800">
          ✓ {a.mailboxDone}
          {p.result?.email ? `: ${p.result.email}` : ''}
        </p>
      )}
      {p.type === 'mark_paid' && (
        <dl className="mt-2 space-y-1">
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">{pl.number}</dt>
            <dd className="text-right font-medium">
              {pl.customer ?? ''}
              {pl.totalCents !== undefined ? ` · ${money(pl.totalCents, cur, locale)}` : ''}
            </dd>
          </div>
        </dl>
      )}
      {p.status === 'applied' && p.result && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 text-sm">
          {p.type === 'create_document' && p.result.documentId && (
            <Link
              className="font-medium text-indigo-700"
              href={`/documents/${p.result.documentId}`}
            >
              {a.ready}: {p.result.number} → {a.open}
            </Link>
          )}
          {p.type === 'send_email' && p.result.threadId && (
            <Link
              className="font-medium text-indigo-700"
              href={`/conversations/${p.result.threadId}`}
            >
              {a.sent} → {a.open}
            </Link>
          )}
          {p.type === 'mark_paid' && p.result.documentId && (
            <Link
              className="font-medium text-indigo-700"
              href={`/documents/${p.result.documentId}`}
            >
              {a.markedPaid}: {p.result.number}
            </Link>
          )}
        </p>
      )}
      {p.type === 'create_document' && p.status === 'failed' && p.result?.documentId && (
        <Link
          className="mt-1 block text-sm font-medium text-indigo-700"
          href={`/documents/${p.result.documentId}`}
        >
          {a.open} →
        </Link>
      )}
      {p.status === 'proposed' && waitingFor !== undefined && waitingFor !== 'applied' && (
        <p className="mt-2 text-xs text-neutral-600">
          {waitingFor === 'proposed' ? a.confirmFirst : a.nothingToAttach}
        </p>
      )}
      {p.status === 'proposed' ? (
        <div className="mt-3 flex gap-2">
          <Button
            className="min-h-10 flex-1"
            disabled={busy || (waitingFor !== undefined && waitingFor !== 'applied')}
            onClick={confirm}
          >
            {p.type === 'send_email'
              ? a.send
              : p.type === 'connect_mailbox'
                ? formOpen
                  ? w.close
                  : a.openForm
                : w.confirm}
          </Button>
          <Button
            variant="secondary"
            className="min-h-10"
            disabled={busy}
            onClick={() => void decide('dismiss')}
          >
            {w.dismiss}
          </Button>
        </div>
      ) : (
        <p
          className={cx(
            'mt-2 text-xs font-medium',
            p.status === 'applied' && 'text-green-800',
            p.status === 'dismissed' && 'text-neutral-500',
            p.status === 'failed' && 'text-red-700',
          )}
        >
          {p.status === 'applied'
            ? `✓ ${w.applied}`
            : p.status === 'dismissed'
              ? w.dismissed
              : w.failed}
          {p.status === 'failed' && p.error ? `: ${p.error}` : ''}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      {dialog === 'mode' && targetMode && (
        <AutoSendDialog
          target={targetMode}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void decide('apply', true)}
        />
      )}
      {dialog === 'sending' && (
        <SendingDialog
          locale={locale}
          lines={dialogLines}
          text={dialogText}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void decide('apply', true)}
        />
      )}
    </div>
  );
}

/** The chat itself: in the floating panel or as the onboarding screen. */
export function AssistantChat({
  tenantId,
  purpose,
  currentMode = null,
  onApplied,
}: {
  tenantId: string;
  purpose: 'app' | 'onboarding';
  currentMode?: Mode | null;
  onApplied?: () => void;
}) {
  const pathname = usePathname();
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [locale, setLocale] = useState<AssistantLocale>('en');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const t = await api<AssistantThread>(`/v1/tenants/${tenantId}/assistant?purpose=${purpose}`);
    setThread(t);
    setLocale(t.conversation?.locale ?? browserLocale());
  }, [tenantId, purpose]);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  // Newest message in view (after the list has rendered).
  useEffect(() => {
    const el = list.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [thread, busy]);

  const w = WORDS[locale];
  const send = async (message: string) => {
    const body = message.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    const optimistic: AssistantMessage = {
      id: `local-${Date.now()}`,
      role: 'owner',
      text: body,
      suggestions: [],
      created_at: new Date().toISOString(),
      proposals: [],
    };
    setThread((t) => ({
      conversation: t?.conversation ?? null,
      messages: [...(t?.messages ?? []), optimistic],
    }));
    try {
      type Turn = {
        pending?: boolean;
        jobId?: string;
        conversation?: AssistantThread['conversation'];
        messages?: AssistantMessage[];
      };
      const first = await api<Turn>(`/v1/tenants/${tenantId}/assistant/messages`, {
        method: 'POST',
        body: {
          text: body,
          locale,
          purpose,
          conversationId: thread?.conversation?.id ?? null,
          contextPath: pathname,
        },
      });
      const conversation = first.conversation ?? null;
      let messages = first.messages ?? [];
      // A slow answer (several lookups): fetched when it is ready.
      if (first.pending && first.jobId) {
        setThread((t) => ({
          conversation,
          messages: [...(t?.messages ?? []).filter((m) => m.id !== optimistic.id), ...messages],
        }));
        const until = Date.now() + 180_000;
        let done: Turn | null = null;
        while (!done && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 1500));
          const r = await api<Turn>(`/v1/tenants/${tenantId}/assistant/turns/${first.jobId}`);
          if (!r.pending) done = r;
        }
        if (!done) throw new Error(w.errors.model_error);
        messages = done.messages ?? [];
        setThread((t) => ({
          conversation: done.conversation ?? conversation,
          messages: [...(t?.messages ?? []), ...messages],
        }));
        return;
      }
      setThread((t) => ({
        conversation,
        messages: [...(t?.messages ?? []).filter((m) => m.id !== optimistic.id), ...messages],
      }));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const known = code ? (w.errors as Record<string, string>)[code] : undefined;
      setError(known ?? (e instanceof Error ? e.message : w.errors.model_error));
    } finally {
      setBusy(false);
    }
  };
  const update = (next: AssistantProposal) => {
    setThread((t) =>
      t
        ? {
            ...t,
            messages: t.messages.map((m) => ({
              ...m,
              proposals: m.proposals.map((p) => (p.id === next.id ? next : p)),
            })),
          }
        : t,
    );
    if (next.status === 'applied') onApplied?.();
  };

  const messages = thread?.messages ?? [];
  const last = messages[messages.length - 1];
  const chips =
    messages.length === 0
      ? purpose === 'onboarding'
        ? w.onboardingSuggestions
        : w.suggestions
      : last?.role === 'assistant'
        ? last.suggestions
        : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={list}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        <div className="max-w-[88%] rounded-2xl rounded-tl-sm bg-neutral-100 px-3 py-2 text-sm">
          {purpose === 'onboarding' ? w.onboardingIntro : w.intro}
        </div>
        {messages.map((m) =>
          m.role === 'owner' ? (
            <div
              key={m.id}
              className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-indigo-700 px-3 py-2 text-sm whitespace-pre-wrap text-white"
            >
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="max-w-[92%]">
              <div className="rounded-2xl rounded-tl-sm bg-neutral-100 px-3 py-2 text-sm whitespace-pre-wrap">
                {m.text}
              </div>
              {m.proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  p={p}
                  waitingFor={
                    p.payload.attachProposalId
                      ? thread?.messages
                          .flatMap((x) => x.proposals)
                          .find((x) => x.id === p.payload.attachProposalId)?.status
                      : undefined
                  }
                  tenantId={tenantId}
                  locale={locale}
                  currentMode={currentMode}
                  onChanged={update}
                />
              ))}
            </div>
          ),
        )}
        {busy && (
          <div className="w-fit rounded-2xl rounded-tl-sm bg-neutral-100 px-3 py-2 text-sm text-neutral-500">
            {w.thinking}
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
      {chips.length > 0 && !busy && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2">
          {chips.map((c) => (
            <button
              key={c}
              className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-800"
              onClick={() => void send(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2 border-t border-neutral-200 bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2.5 text-base outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100"
          rows={1}
          maxLength={2000}
          placeholder={w.placeholder}
          aria-label={w.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <Button type="submit" disabled={busy || !text.trim()} className="min-h-11">
          {w.send}
        </Button>
      </form>
    </div>
  );
}

/** The floating button (every signed-in page) and the panel it opens. */
export function AssistantLauncher({
  tenantId,
  currentMode,
  onApplied,
}: {
  tenantId: string;
  currentMode: Mode | null;
  onApplied?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  const [locale, setLocale] = useState<AssistantLocale>('en');
  useEffect(() => setLocale(browserLocale()), []);
  const w = WORDS[locale];
  return (
    <>
      {!open && (
        <button
          className="fixed right-4 bottom-24 z-30 flex h-14 items-center gap-2 rounded-full bg-indigo-700 px-5 font-medium text-white shadow-lg lg:bottom-6"
          onClick={() => setOpen(true)}
          aria-label={w.title}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path
              d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"
              strokeLinejoin="round"
            />
          </svg>
          <span className="hidden sm:inline">{w.title}</span>
        </button>
      )}
      {open && (
        <div
          className="fixed inset-0 z-40 flex flex-col bg-white lg:inset-auto lg:right-6 lg:bottom-6 lg:h-[640px] lg:w-[400px] lg:rounded-2xl lg:border lg:border-neutral-200 lg:shadow-2xl"
          role="dialog"
          aria-label={w.title}
        >
          <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
            <p className="font-semibold">{w.title}</p>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
              {w.beta}
            </span>
            <button
              className="ml-auto text-sm text-indigo-700"
              onClick={() =>
                void api(`/v1/tenants/${tenantId}/assistant/new`, {
                  method: 'POST',
                  body: { purpose: 'app' },
                }).then(() => setKey((k) => k + 1))
              }
            >
              {w.newChat}
            </button>
            <button
              className="flex h-10 w-10 items-center justify-center rounded-lg text-xl text-neutral-500"
              onClick={() => setOpen(false)}
              aria-label={w.close}
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <AssistantChat
              key={key}
              tenantId={tenantId}
              purpose="app"
              currentMode={currentMode}
              {...(onApplied ? { onApplied } : {})}
            />
          </div>
          <p className="border-t border-neutral-100 px-4 py-2 text-center text-[11px] text-neutral-400">
            {w.cannot}
          </p>
        </div>
      )}
    </>
  );
}
