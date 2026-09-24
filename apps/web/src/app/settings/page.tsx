'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
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
import { useTenantId } from '@/lib/session';

interface Tenant {
  name: string;
  website_url: string | null;
  timezone: string;
  mode: 'draft_only' | 'auto_send';
  notify_full_text: boolean;
  max_replies_per_hour: number;
  max_ai_replies_per_sender_24h: number;
  followup_after_days: number;
  followup_max: number;
  retention_days: number;
  reply_signature: string | null;
}

function AutoSendDialog({
  onConfirm,
  onCancel,
  busy,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [ok, setOk] = useState(false);
  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Send replies automatically?</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>Replies that pass every safety check are sent without asking you.</li>
          <li>
            Complaints, refunds, legal questions, discount requests, angry or urgent emails always
            come to you.
          </li>
          <li>
            A reply is only sent automatically if every fact in it is in your knowledge base and a
            second check confirms it.
          </li>
          <li>
            The per-hour and per-customer limits in these settings apply. You can switch back to
            draft-only at any time.
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
            I have reviewed Noctiv&apos;s drafts and want safe replies to be sent automatically.
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
  const [dialog, setDialog] = useState(false);
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
      setDialog(false);
      await reload();
    });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Sending mode">
        <div className="flex items-center gap-2">
          <Badge tone={t.mode === 'auto_send' ? 'blue' : 'gray'}>
            {t.mode === 'auto_send' ? 'Automatic sending' : 'Draft-only'}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-neutral-600">
          {t.mode === 'auto_send'
            ? 'Safe replies go out automatically; everything else waits for you.'
            : 'Nothing is sent until you approve it.'}
        </p>
        <ErrorText>{mode.error}</ErrorText>
        <div className="mt-3">
          {t.mode === 'auto_send' ? (
            <Button
              variant="secondary"
              disabled={mode.busy}
              onClick={() => void setMode('draft_only')}
            >
              Switch to draft-only
            </Button>
          ) : (
            <Button onClick={() => setDialog(true)}>Switch on automatic sending…</Button>
          )}
        </div>
        {dialog && (
          <AutoSendDialog
            busy={mode.busy}
            onCancel={() => setDialog(false)}
            onConfirm={() => void setMode('auto_send', true)}
          />
        )}
      </Card>

      <Card title="Mailbox">
        <Link className="text-sm text-indigo-700" href="/settings/mailboxes">
          Manage connected mailboxes →
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

function Settings() {
  const tenantId = useTenantId();
  const { data, error, reload } = useLoad(() => api<Tenant>(`/v1/tenants/${tenantId}`), [tenantId]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <Loading />;
  return <SettingsForm t={data} tenantId={tenantId} reload={reload} />;
}

export default function SettingsPage() {
  return (
    <AppPage title="Settings">
      <Settings />
    </AppPage>
  );
}
