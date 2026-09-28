'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  DAYS,
  dayLabel,
  FIELD_TYPES,
  localDateKey,
  LOCATIONS,
  PROBLEMS,
  timeLabel,
  type Booking,
  type BookingSettings,
  type BookingSetup,
  type Day,
  type FieldType,
  type FormField,
  type IntakeForm,
} from '@/lib/bookings';
import {
  Badge,
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
} from './ui';

// ------------------------------------------------------------------ list

const STATUS: Record<
  Booking['status'],
  { text: string; tone: 'green' | 'amber' | 'gray' | 'red' }
> = {
  confirmed: { text: 'Confirmed', tone: 'green' },
  pending: { text: 'Confirming', tone: 'amber' },
  taken: { text: 'Not booked', tone: 'gray' },
  cancelled: { text: 'Cancelled', tone: 'red' },
  rescheduled: { text: 'Moved', tone: 'gray' },
};

/** Upcoming (or past, cancelled) bookings grouped by day, in the business's time zone. */
export function BookingList({ tenantId, timeZone }: { tenantId: string; timeZone: string }) {
  const [scope, setScope] = useState<'upcoming' | 'past' | 'cancelled'>('upcoming');
  const list = useLoad(
    () => api<Booking[]>(`/v1/tenants/${tenantId}/bookings?scope=${scope}`),
    [tenantId, scope],
  );
  const cancel = useAction();
  const days = new Map<string, Booking[]>();
  for (const b of list.data ?? []) {
    const k = localDateKey(b.starts_at, timeZone);
    days.set(k, [...(days.get(k) ?? []), b]);
  }
  return (
    <div className="space-y-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4" role="tablist">
        {(['upcoming', 'past', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={scope === s}
            onClick={() => setScope(s)}
            className={cx(
              'shrink-0 rounded-full px-3 py-1.5 text-sm capitalize',
              scope === s
                ? 'bg-indigo-700 text-white'
                : 'bg-white text-neutral-700 ring-1 ring-neutral-200',
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <ErrorText>{list.error ?? cancel.error}</ErrorText>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-sm text-neutral-500 ring-1 ring-neutral-200">
          {scope === 'upcoming'
            ? 'No upcoming bookings yet. Share your booking page, or let replies offer free times.'
            : 'Nothing here.'}
        </p>
      ) : (
        [...days.entries()].map(([k, items]) => (
          <section key={k}>
            <h3 className="mb-2 text-sm font-semibold text-neutral-700">
              {dayLabel(items[0]!.starts_at, timeZone)}
            </h3>
            <ul className="divide-y divide-neutral-100 rounded-xl bg-white ring-1 ring-neutral-200">
              {items.map((b) => {
                const st = STATUS[b.status];
                return (
                  <li key={b.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-12 shrink-0 text-sm font-semibold tabular-nums">
                        {timeLabel(b.starts_at, timeZone)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{b.name}</p>
                        <p className="truncate text-xs text-neutral-500">
                          {b.email}
                          {b.phone ? ` · ${b.phone}` : ''}
                        </p>
                      </div>
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </div>
                    {(b.note || b.answers.length > 0) && (
                      <div className="mt-2 space-y-0.5 pl-15 text-xs text-neutral-600">
                        {b.note && <p className="line-clamp-2">“{b.note}”</p>}
                        {b.answers.slice(0, 3).map((a) => (
                          <p key={a.label} className="truncate">
                            <span className="text-neutral-500">
                              {a.label}
                              {/[?:]$/.test(a.label) ? '' : ':'}
                            </span>{' '}
                            {a.value}
                          </p>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3 pl-15 text-sm">
                      {b.thread_id && (
                        <Link
                          className="text-indigo-700 underline"
                          href={`/conversations/${b.thread_id}`}
                        >
                          Conversation
                        </Link>
                      )}
                      {b.meet_url && (
                        <a
                          className="text-indigo-700 underline"
                          href={b.meet_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Meet link
                        </a>
                      )}
                      {scope === 'upcoming' && b.status === 'confirmed' && (
                        <button
                          className="text-red-700 underline disabled:opacity-50"
                          disabled={cancel.busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel ${b.name}'s booking? They get an e-mail saying you had to cancel, with a link to book again.`,
                              )
                            )
                              void cancel.run(async () => {
                                await api(`/v1/tenants/${tenantId}/bookings/${b.id}/cancel`, {
                                  method: 'POST',
                                });
                                await list.reload();
                              });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// ----------------------------------------------------------------- setup

const CALENDAR_REASONS: Record<string, string> = {
  denied: 'You did not allow access in Google.',
  scopes: 'Both calendar permissions are needed: tick them on Google’s screen.',
  expired: 'That took too long. Please try again.',
  state: 'The link was not valid. Please try again.',
  google: 'Google did not answer. Please try again.',
  not_configured: 'Google Calendar is not set up on this server yet.',
};

export function BookingSetupCard({
  tenantId,
  setup,
  reload,
  calendarResult,
}: {
  tenantId: string;
  setup: BookingSetup;
  reload: () => Promise<void>;
  calendarResult: { status: string | null; reason: string | null };
}) {
  const [s, setS] = useState<BookingSettings>(setup.settings);
  const [slug, setSlug] = useState(setup.slug ?? '');
  const save = useAction();
  const cal = useAction();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setS(setup.settings), [setup.settings]);
  const set = <K extends keyof BookingSettings>(k: K, v: BookingSettings[K]) => {
    setSaved(false);
    setS((x) => ({ ...x, [k]: v }));
  };
  const setDay = (d: Day, on: boolean) =>
    set('hours', {
      ...s.hours,
      [d]: on ? (s.hours[d]?.length ? s.hours[d] : [{ from: '09:00', to: '17:00' }]) : [],
    });
  const setWindow = (d: Day, i: number, k: 'from' | 'to', v: string) =>
    set('hours', {
      ...s.hours,
      [d]: (s.hours[d] ?? []).map((w, j) => (j === i ? { ...w, [k]: v } : w)),
    });

  const submit = () =>
    void save.run(async () => {
      await api(`/v1/tenants/${tenantId}/bookings/setup`, {
        method: 'PATCH',
        body: { ...s, ...(slug !== setup.slug ? { slug } : {}) },
      });
      await reload();
      setSaved(true);
    });

  const location = LOCATIONS.find((l) => l.id === s.locationKind)!;
  return (
    <div className="space-y-4">
      {setup.problems.length > 0 && (
        <Notice>
          <span className="font-medium">Before customers can book:</span>
          <ul className="mt-1 list-disc pl-5">
            {setup.problems.map((p) => (
              <li key={p}>{PROBLEMS[p] ?? p}</li>
            ))}
          </ul>
        </Notice>
      )}

      <Card title="Booking page">
        {setup.pageUrl && (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-100 px-3 py-2 text-sm">
              {setup.pageUrl}
            </code>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(setup.pageUrl!);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <a
              className="text-sm text-indigo-700 underline"
              href={setup.pageUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open
            </a>
          </div>
        )}
        <div className="mt-3">
          <Field
            label="Address"
            hint="Letters, digits and hyphens. Links you already sent stop working if you change it."
          >
            <div className="flex items-center rounded-lg border border-neutral-300 bg-white focus-within:border-indigo-600">
              <span className="pl-3 text-sm text-neutral-500">…/book/</span>
              <input
                className="min-w-0 flex-1 rounded-lg px-1 py-2.5 text-base outline-none"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                autoCapitalize="none"
              />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Calendar">
        {calendarResult.status === 'connected' && <Notice>Google Calendar connected.</Notice>}
        {calendarResult.status === 'error' && (
          <ErrorText>
            {CALENDAR_REASONS[calendarResult.reason ?? ''] ??
              'The calendar could not be connected.'}
          </ErrorText>
        )}
        {setup.calendar ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                Google Calendar
                <Badge tone={setup.calendar.status === 'connected' ? 'green' : 'red'}>
                  {setup.calendar.status === 'connected'
                    ? 'Connected'
                    : setup.calendar.status === 'revoking'
                      ? 'Disconnecting'
                      : 'Not working'}
                </Badge>
              </p>
              <p className="truncate text-xs text-neutral-500">{setup.calendar.email}</p>
            </div>
            {setup.calendar.status === 'error' && setup.googleConfigured && (
              <Button
                onClick={() =>
                  void cal.run(
                    async () =>
                      void (window.location.href = (
                        await api<{ url: string }>(
                          `/v1/tenants/${tenantId}/calendar/google/start`,
                          { method: 'POST' },
                        )
                      ).url),
                  )
                }
              >
                Connect again
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={cal.busy || setup.calendar.status === 'revoking'}
              onClick={() => {
                if (
                  window.confirm(
                    'Disconnect Google Calendar? Existing bookings stay; new ones are not added to your calendar.',
                  )
                )
                  void cal.run(async () => {
                    await api(`/v1/tenants/${tenantId}/calendar`, { method: 'DELETE' });
                    await reload();
                  });
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-600">
              Noctiv reads when you are busy, so those times are never offered, and adds each
              booking to your calendar. It only sees busy times and the events it books.
            </p>
            <Button
              disabled={!setup.googleConfigured || cal.busy}
              onClick={() =>
                void cal.run(async () => {
                  const { url } = await api<{ url: string }>(
                    `/v1/tenants/${tenantId}/calendar/google/start`,
                    {
                      method: 'POST',
                    },
                  );
                  window.location.href = url;
                })
              }
            >
              Connect Google Calendar
            </Button>
            {!setup.googleConfigured && (
              <p className="text-xs text-neutral-500">
                Google Calendar is not set up on this server yet.
              </p>
            )}
            <p className="text-xs text-neutral-500">
              Without a calendar, only bookings made in Noctiv are seen. Microsoft 365: coming
              later.
            </p>
          </div>
        )}
        <ErrorText>{cal.error}</ErrorText>
      </Card>

      <Card title={`Bookable hours (${setup.timezone.replace(/_/g, ' ')})`}>
        <ul className="divide-y divide-neutral-100">
          {DAYS.map((d) => {
            const ws = s.hours[d.id] ?? [];
            const on = ws.length > 0;
            return (
              <li key={d.id} className="flex min-h-12 flex-wrap items-center gap-3 py-2">
                <label className="flex w-24 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-indigo-700"
                    checked={on}
                    onChange={(e) => setDay(d.id, e.target.checked)}
                  />
                  {d.short}
                </label>
                {on ? (
                  ws.map((w, i) => (
                    <span key={i} className="flex items-center gap-1 text-sm">
                      <input
                        type="time"
                        aria-label={`${d.long} from`}
                        className="rounded-lg border border-neutral-300 px-2 py-1.5"
                        value={w.from}
                        onChange={(e) => setWindow(d.id, i, 'from', e.target.value)}
                      />
                      –
                      <input
                        type="time"
                        aria-label={`${d.long} until`}
                        className="rounded-lg border border-neutral-300 px-2 py-1.5"
                        value={w.to}
                        onChange={(e) => setWindow(d.id, i, 'to', e.target.value)}
                      />
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-neutral-400">Closed</span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Length">
            <select
              className={inputClass}
              value={s.slotMinutes}
              onChange={(e) => set('slotMinutes', Number(e.target.value))}
            >
              {[15, 20, 30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </Field>
          <Field label="Buffer">
            <select
              className={inputClass}
              value={s.bufferMinutes}
              onChange={(e) => set('bufferMinutes', Number(e.target.value))}
            >
              {[0, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notice">
            <select
              className={inputClass}
              value={s.noticeHours}
              onChange={(e) => set('noticeHours', Number(e.target.value))}
            >
              {[0, 1, 2, 4, 12, 24, 48, 72].map((h) => (
                <option key={h} value={h}>
                  {h === 0 ? 'None' : `${h} h`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Up to">
            <select
              className={inputClass}
              value={s.horizonDays}
              onChange={(e) => set('horizonDays', Number(e.target.value))}
            >
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card title="The meeting">
        <div className="space-y-3">
          <Field label="Title" hint="Shown on the booking page and in both calendars.">
            <input
              className={inputClass}
              value={s.meetingTitle}
              placeholder="Intro call"
              maxLength={120}
              onChange={(e) => set('meetingTitle', e.target.value)}
            />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-neutral-800">Where</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {LOCATIONS.map((l) => (
                <label
                  key={l.id}
                  className={cx(
                    'flex cursor-pointer gap-3 rounded-lg border p-3 text-sm',
                    s.locationKind === l.id
                      ? 'border-indigo-600 bg-indigo-50'
                      : 'border-neutral-200',
                  )}
                >
                  <input
                    type="radio"
                    name="where"
                    className="mt-0.5 h-4 w-4 accent-indigo-700"
                    checked={s.locationKind === l.id}
                    onChange={() => set('locationKind', l.id)}
                  />
                  <span>
                    <span className="block font-medium">{l.label}</span>
                    <span className="block text-xs text-neutral-500">{l.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {(s.locationKind === 'online_link' || s.locationKind === 'in_person') && (
            <Field label={location.id === 'online_link' ? 'Meeting link' : 'Address'}>
              <input
                className={inputClass}
                value={s.locationText}
                placeholder={location.id === 'online_link' ? 'https://…' : 'Street, city'}
                inputMode={location.id === 'online_link' ? 'url' : 'text'}
                onChange={(e) => set('locationText', e.target.value)}
              />
            </Field>
          )}
          <Field
            label="Questions when booking"
            hint="An intake form asked on the booking page (Forms tab)."
          >
            <select
              className={inputClass}
              value={s.formId ?? ''}
              onChange={(e) => set('formId', e.target.value || null)}
            >
              <option value="">None (name, e-mail, phone and a note)</option>
              {setup.forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button disabled={save.busy} onClick={submit}>
          Save
        </Button>
        {saved && <span className="text-sm text-green-800">Saved</span>}
      </div>
      <ErrorText>{save.error}</ErrorText>
      <p className="text-xs text-neutral-500">
        Confirmations, moves and cancellations are e-mailed to the customer from your mailbox
        automatically, with a calendar invite. When a customer asks for a meeting, replies offer
        your next three free times.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- forms

const blankField = (): FormField => ({ label: '', type: 'text', required: false });

function FormEditor({
  tenantId,
  form,
  onDone,
}: {
  tenantId: string;
  form: IntakeForm | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(form?.name ?? '');
  const [intro, setIntro] = useState(form?.intro ?? '');
  const [fields, setFields] = useState<FormField[]>(
    form?.fields.length ? form.fields : [blankField()],
  );
  const save = useAction();
  const update = (i: number, f: Partial<FormField>) =>
    setFields((xs) => xs.map((x, j) => (j === i ? { ...x, ...f } : x)));
  const move = (i: number, by: number) =>
    setFields((xs) => {
      const next = [...xs];
      const [x] = next.splice(i, 1);
      next.splice(i + by, 0, x!);
      return next;
    });
  return (
    <Card title={form ? 'Edit form' : 'New form'}>
      <div className="space-y-3">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            maxLength={100}
            placeholder="Project questions"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Intro" hint="Shown above the questions.">
          <textarea
            className={inputClass}
            rows={2}
            maxLength={1000}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
          />
        </Field>
        <p className="text-sm text-neutral-600">
          Name and e-mail are always asked. Up to 10 questions:
        </p>
        <ol className="space-y-3">
          {fields.map((f, i) => (
            <li key={i} className="rounded-lg border border-neutral-200 p-3">
              <div className="flex gap-2">
                <input
                  className={cx(inputClass, 'flex-1')}
                  aria-label={`Question ${i + 1}`}
                  placeholder={`Question ${i + 1}`}
                  value={f.label}
                  maxLength={100}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
                <select
                  className="rounded-lg border border-neutral-300 bg-white px-2 text-sm"
                  aria-label={`Type of question ${i + 1}`}
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as FieldType;
                    update(
                      i,
                      type === 'choice'
                        ? { type, options: f.options?.length ? f.options : ['', ''] }
                        : { type, options: undefined },
                    );
                  }}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              {f.type === 'choice' && (
                <div className="mt-2 space-y-1.5 pl-3">
                  {(f.options ?? []).map((o, k) => (
                    <input
                      key={k}
                      className={cx(inputClass, 'py-1.5 text-sm')}
                      aria-label={`Option ${k + 1}`}
                      placeholder={`Option ${k + 1}`}
                      value={o}
                      maxLength={80}
                      onChange={(e) =>
                        update(i, {
                          options: (f.options ?? []).map((x, j) => (j === k ? e.target.value : x)),
                        })
                      }
                    />
                  ))}
                  {(f.options?.length ?? 0) < 20 && (
                    <button
                      className="text-sm text-indigo-700"
                      onClick={() => update(i, { options: [...(f.options ?? []), ''] })}
                    >
                      + Option
                    </button>
                  )}
                </div>
              )}
              <div className="mt-2 flex items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-700"
                    checked={f.required}
                    onChange={(e) => update(i, { required: e.target.checked })}
                  />
                  Required
                </label>
                <span className="flex-1" />
                <button
                  className="text-neutral-500 disabled:opacity-30"
                  disabled={i === 0}
                  aria-label="Move up"
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="text-neutral-500 disabled:opacity-30"
                  disabled={i === fields.length - 1}
                  aria-label="Move down"
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  className="text-red-700"
                  onClick={() => setFields((xs) => xs.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
        {fields.length < 10 && (
          <Button variant="secondary" onClick={() => setFields((xs) => [...xs, blankField()])}>
            + Question
          </Button>
        )}
        <div className="flex gap-2">
          <Button
            disabled={save.busy}
            onClick={() =>
              void save.run(async () => {
                const body = {
                  name,
                  intro,
                  fields: fields
                    .filter((f) => f.label.trim())
                    .map((f) => ({
                      ...f,
                      options:
                        f.type === 'choice' ? (f.options ?? []).filter((o) => o.trim()) : undefined,
                    })),
                };
                await api(
                  form
                    ? `/v1/tenants/${tenantId}/forms/${form.id}`
                    : `/v1/tenants/${tenantId}/forms`,
                  {
                    method: form ? 'PATCH' : 'POST',
                    body,
                  },
                );
                onDone();
              })
            }
          >
            Save form
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <ErrorText>{save.error}</ErrorText>
      </div>
    </Card>
  );
}

export function FormsPanel({ tenantId }: { tenantId: string }) {
  const forms = useLoad(() => api<IntakeForm[]>(`/v1/tenants/${tenantId}/forms`), [tenantId]);
  const [editing, setEditing] = useState<IntakeForm | 'new' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const act = useAction();
  if (editing)
    return (
      <FormEditor
        tenantId={tenantId}
        form={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          void forms.reload();
        }}
      />
    );
  return (
    <div className="space-y-3">
      <ErrorText>{forms.error ?? act.error}</ErrorText>
      {!forms.data ? (
        <Loading />
      ) : forms.data.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-sm text-neutral-600 ring-1 ring-neutral-200">
          Ask customers a few questions before a visit or a project: what they need, their budget,
          when. Send the link in a reply, let the assistant send it, or ask it on the booking page.
          Answers are saved with the lead.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-xl bg-white ring-1 ring-neutral-200">
          {forms.data.map((f) => (
            <li key={f.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                <span className="text-xs text-neutral-500">
                  {f.fields.length} {f.fields.length === 1 ? 'question' : 'questions'} ·{' '}
                  {f.submissions} answered
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-sm">
                <button className="text-indigo-700 underline" onClick={() => setEditing(f)}>
                  Edit
                </button>
                <button
                  className="text-indigo-700 underline"
                  onClick={() =>
                    void act.run(async () => {
                      const { url } = await api<{ url: string }>(
                        `/v1/tenants/${tenantId}/forms/${f.id}/link`,
                        {
                          method: 'POST',
                          body: {},
                        },
                      );
                      await navigator.clipboard?.writeText(url);
                      setCopied(f.id);
                    })
                  }
                >
                  {copied === f.id ? 'Link copied' : 'Copy link'}
                </button>
                <button
                  className="text-red-700 underline"
                  onClick={() => {
                    if (window.confirm(`Remove “${f.name}”? Answers already given are kept.`))
                      void act.run(async () => {
                        await api(`/v1/tenants/${tenantId}/forms/${f.id}`, { method: 'DELETE' });
                        await forms.reload();
                      });
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => setEditing('new')}>New form</Button>
    </div>
  );
}

/** "Insert form link" for a reply draft: the link for this conversation's customer. */
export function InsertFormLink({
  tenantId,
  threadId,
  onInsert,
}: {
  tenantId: string;
  threadId: string;
  onInsert: (text: string) => void;
}) {
  const forms = useLoad(() => api<IntakeForm[]>(`/v1/tenants/${tenantId}/forms`), [tenantId]);
  const a = useAction();
  if (!forms.data?.length) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <select
        className="rounded-lg border border-neutral-300 bg-white px-2 py-2 text-sm"
        aria-label="Insert form link"
        value=""
        disabled={a.busy}
        onChange={(e) => {
          const f = forms.data!.find((x) => x.id === e.target.value);
          if (f)
            void a.run(async () => {
              const { url } = await api<{ url: string }>(
                `/v1/tenants/${tenantId}/forms/${f.id}/link`,
                {
                  method: 'POST',
                  body: { threadId },
                },
              );
              onInsert(`${f.name}: ${url}`);
            });
        }}
      >
        <option value="">Insert form link…</option>
        {forms.data.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {a.error && <span className="text-xs text-red-700">{a.error}</span>}
    </span>
  );
}

/** On a conversation: the customer's bookings and form answers (nothing when there are none). */
export function ConversationBookings({
  tenantId,
  threadId,
}: {
  tenantId: string;
  threadId: string;
}) {
  const data = useLoad(
    () =>
      api<{
        bookings: (Booking & { answers: { label: string; value: string }[] })[];
        submissions: {
          id: string;
          form_name: string;
          answers: { label: string; value: string }[];
          created_at: string;
        }[];
      }>(`/v1/tenants/${tenantId}/conversations/${threadId}/bookings`),
    [tenantId, threadId],
  );
  const d = data.data;
  if (!d || (!d.bookings.length && !d.submissions.length)) return null;
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <Card title="Bookings and forms">
      <ul className="space-y-3 text-sm">
        {d.bookings.map((b) => (
          <li key={b.id} className="flex items-center gap-2">
            <span className="font-medium">{when(b.starts_at)}</span>
            <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].text}</Badge>
            {b.meet_url && (
              <a
                className="text-indigo-700 underline"
                href={b.meet_url}
                target="_blank"
                rel="noreferrer"
              >
                Meet
              </a>
            )}
          </li>
        ))}
        {d.submissions.map((s) => (
          <li key={s.id}>
            <p className="font-medium">
              {s.form_name}{' '}
              <span className="font-normal text-neutral-500">· {when(s.created_at)}</span>
            </p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {s.answers.map((a) => (
                <div key={a.label} className="contents">
                  <dt className="text-neutral-500">{a.label}</dt>
                  <dd className="whitespace-pre-wrap">{a.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </Card>
  );
}
