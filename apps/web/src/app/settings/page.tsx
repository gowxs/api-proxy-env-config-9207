'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BillingCard } from '@/components/billing';
import { AppPage } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  inputClass,
  Loading,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { designInfo } from '@/lib/email-design';
import { MODES, modeInfo, modeRank, type Mode } from '@/lib/modes';
import { signOut } from '@/lib/auth';
import { useTenantId } from '@/lib/session';

interface Tenant {
  name: string;
  website_url: string | null;
  timezone: string;
  mode: Mode;
  notify_full_text: boolean;
  max_replies_per_hour: number;
  max_ai_replies_per_sender_24h: number;
  followup_after_days: number;
  followup_max: number;
  retention_days: number;
  reply_signature: string | null;
  email_template: string;
}

function AutoSendDialog({
  target,
  onConfirm,
  onCancel,
  busy,
}: {
  target: Mode;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [ok, setOk] = useState(false);
  const info = modeInfo(target);
  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-dialog-title"
    >
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5">
        <h2 id="mode-dialog-title" className="text-lg font-semibold">
          Switch to mode {info.number}: {info.title}?
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>Replies that pass every safety check are sent without asking you.</li>
          {target === 'full_auto' && (
            <li>
              When a question can&apos;t be answered from your knowledge base, the customer
              immediately gets “Thanks — I&apos;ll check this and get back to you as soon as
              possible.” (in their language), and you get the email to answer yourself.
            </li>
          )}
          <li>
            Complaints, refunds, legal questions, discount requests, angry or urgent emails always
            come to you, with no automatic reply.
          </li>
          <li>
            A reply is only sent automatically if every fact in it is in your knowledge base and a
            second check confirms it. No prices, dates or promises are ever invented.
          </li>
          <li>
            The per-hour and per-customer limits in these settings apply. You can switch back to
            approving everything at any time.
          </li>
        </ul>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={ok}
            onChange={(e) => setOk(e.target.checked)}
          />
          <span>
            I have reviewed Noctiv&apos;s drafts and want{' '}
            {target === 'full_auto' ? 'safe replies and acknowledgements' : 'safe replies'} to be
            sent automatically.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!ok || busy} onClick={onConfirm}>
            Switch on
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsForm({
  t,
  tenantId,
  reload,
}: {
  t: Tenant;
  tenantId: string;
  reload: () => Promise<void>;
}) {
  const [form, setForm] = useState(t);
  const [dialog, setDialog] = useState<Mode | null>(null);
  const [saved, setSaved] = useState(false);
  const mode = useAction();
  const save = useAction();
  useEffect(() => setForm(t), [t]);
  const set = <K extends keyof Tenant>(k: K, v: Tenant[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const setMode = (m: Tenant['mode'], confirm = false) =>
    mode.run(async () => {
      await api(`/v1/tenants/${tenantId}`, {
        method: 'PATCH',
        body: { mode: m, ...(confirm ? { confirmAutoSend: true } : {}) },
      });
      setDialog(null);
      await reload();
    });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Sending mode">
        <p className="text-sm text-neutral-600">
          All three modes are included in your plan. The fact checks and the list of emails that
          always come to you are the same in every mode.
        </p>
        <fieldset className="mt-3 space-y-2" disabled={mode.busy}>
          <legend className="sr-only">Sending mode</legend>
          {MODES.map((m) => {
            const current = t.mode === m.id;
            return (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                  current ? 'border-indigo-600 bg-indigo-50/60' : 'border-neutral-200'
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  className="mt-1 h-5 w-5 accent-indigo-600"
                  checked={current}
                  onChange={() => {
                    if (current) return;
                    // More automatic needs the confirmation; more cautious applies at once.
                    if (modeRank(m.id) > modeRank(t.mode)) setDialog(m.id);
                    else void setMode(m.id);
                  }}
                />
                <span>
                  <span className="block text-sm font-semibold">
                    {m.number}. {m.title}
                    {current && (
                      <span className="ml-2 align-middle">
                        <Badge tone={m.id === 'draft_only' ? 'gray' : 'blue'}>Current</Badge>
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-neutral-600">{m.line}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <ErrorText>{mode.error}</ErrorText>
        {dialog && (
          <AutoSendDialog
            target={dialog}
            busy={mode.busy}
            onCancel={() => setDialog(null)}
            onConfirm={() => void setMode(dialog, true)}
          />
        )}
      </Card>

      <BillingCard showPortal />

      <Card title="Mailbox">
        <Link className="text-sm text-indigo-700" href="/settings/mailboxes">
          Manage connected mailboxes →
        </Link>
      </Card>

      <Card title="E-mail design">
        <p className="text-sm text-neutral-600">
          {designInfo(t.email_template).title}: {designInfo(t.email_template).line}
        </p>
        <Link className="mt-2 inline-block text-sm text-indigo-700" href="/settings/email-design">
          Choose a design and preview it →
        </Link>
      </Card>

      <form
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run(async () => {
            await api(`/v1/tenants/${tenantId}`, {
              method: 'PATCH',
              body: {
                name: form.name,
                websiteUrl: form.website_url || null,
                timezone: form.timezone,
                notifyFullText: form.notify_full_text,
                followupAfterDays: form.followup_after_days,
                followupMax: form.followup_max,
                maxRepliesPerHour: form.max_replies_per_hour,
                maxAiRepliesPerSender24h: form.max_ai_replies_per_sender_24h,
                retentionDays: form.retention_days,
                replySignature: form.reply_signature || null,
              },
            });
            await reload();
            setSaved(true);
          });
        }}
      >
        <Card title="Business">
          <div className="space-y-3">
            <Field label="Business name">
              <input
                className={inputClass}
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field label="Website">
              <input
                className={inputClass}
                type="url"
                value={form.website_url ?? ''}
                onChange={(e) => set('website_url', e.target.value)}
              />
            </Field>
            <Field label="Time zone" hint="Follow-ups go out Mon–Fri 09:00–17:00 in this zone.">
              <select
                className={inputClass}
                value={form.timezone}
                onChange={(e) => set('timezone', e.target.value)}
              >
                {Intl.supportedValuesOf('timeZone').map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </Field>
            <Field label="Signature" hint="Added below every reply.">
              <textarea
                className={`${inputClass} min-h-20`}
                maxLength={1000}
                value={form.reply_signature ?? ''}
                onChange={(e) => set('reply_signature', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card title="Follow-ups and limits">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Follow up after (business days)">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={30}
                value={form.followup_after_days}
                onChange={(e) => set('followup_after_days', Number(e.target.value))}
              />
            </Field>
            <Field label="Follow-ups per conversation">
              <select
                className={inputClass}
                value={form.followup_max}
                onChange={(e) => set('followup_max', Number(e.target.value))}
              >
                {[0, 1, 2].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'None' : n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Automatic replies per hour">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={500}
                value={form.max_replies_per_hour}
                onChange={(e) => set('max_replies_per_hour', Number(e.target.value))}
              />
            </Field>
            <Field label="Automatic replies per customer / 24 h">
              <select
                className={inputClass}
                value={form.max_ai_replies_per_sender_24h}
                onChange={(e) => set('max_ai_replies_per_sender_24h', Number(e.target.value))}
              >
                {[0, 1, 2].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>

        <Card title="Privacy">
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5"
                checked={form.notify_full_text}
                onChange={(e) => set('notify_full_text', e.target.checked)}
              />
              <span>
                Include the customer&apos;s name and the full draft in notification emails.
                <span className="block text-xs text-neutral-500">
                  Off by default: emails then show only the sender&apos;s domain, the subject and a
                  short summary.
                </span>
              </span>
            </label>
            <Field
              label="Keep email text for (days)"
              hint="After this, message and draft text is deleted; statistics stay."
            >
              <input
                className={inputClass}
                type="number"
                min={1}
                max={3650}
                value={form.retention_days}
                onChange={(e) => set('retention_days', Number(e.target.value))}
              />
            </Field>
          </div>
        </Card>

        <div className="space-y-2 md:col-span-2">
          <ErrorText>{save.error}</ErrorText>
          <Button type="submit" disabled={save.busy} className="w-full sm:w-auto">
            Save settings
          </Button>
          {saved && <span className="ml-3 text-sm text-green-800">✓ Saved</span>}
        </div>
      </form>
    </div>
  );
}

function DeleteAccount({ tenantId, name }: { tenantId: string; name: string }) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Card title={<span className="text-red-800">Delete all data</span>}>
      <p className="text-sm text-neutral-700">
        Permanently deletes this business: conversations, drafts, leads, the knowledge base, mailbox
        connections and your login. Nothing is kept except an anonymous record that a deletion
        happened. This cannot be undone.
      </p>
      <p className="mt-2 text-sm text-neutral-700">
        Emails already in your own mailbox are not touched. A subscription is cancelled at once;
        invoices stay available from Paddle.
      </p>
      <label className="mt-3 block text-sm">
        Type <strong>{name}</strong> to confirm
        <input
          className={inputClass}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </label>
      <ErrorText>{error}</ErrorText>
      <Button
        variant="danger"
        className="mt-3"
        disabled={busy || typed.trim() !== name.trim()}
        onClick={() =>
          void run(async () => {
            await api(`/v1/tenants/${tenantId}`, {
              method: 'DELETE',
              body: { confirmName: typed },
            });
            await signOut();
            router.replace('/login?deleted=1');
          })
        }
      >
        Delete everything
      </Button>
    </Card>
  );
}

function Settings() {
  const tenantId = useTenantId();
  const { data, error, reload } = useLoad(() => api<Tenant>(`/v1/tenants/${tenantId}`), [tenantId]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <SettingsForm t={data} tenantId={tenantId} reload={reload} />
      <DeleteAccount tenantId={tenantId} name={data.name} />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AppPage title="Settings">
      <Settings />
    </AppPage>
  );
}
