'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { KnowledgeAdd, SourceList, type KbSource } from '@/components/knowledge';
import { Logo } from '@/components/logo';
import { MailboxForm } from '@/components/mailbox-form';
import {
  Button,
  Card,
  ErrorText,
  Field,
  inputClass,
  Notice,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { SessionProvider, useSession } from '@/lib/session';

const STEPS = ['Your business', 'Mailbox', 'Knowledge', 'Summary'];

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Riga', 'Europe/Berlin', 'Europe/London', 'UTC'];
  }
}

function BusinessStep({ onDone }: { onDone: () => Promise<void> }) {
  const { me } = useSession();
  const guess = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [timezone, setTimezone] = useState('');
  const [invite, setInvite] = useState('');
  const { busy, error, run } = useAction();
  const zones = useMemo(timezones, []);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const w = website.trim();
          await api('/v1/tenants', {
            method: 'POST',
            body: {
              name: name.trim(),
              timezone,
              websiteUrl: w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : null,
              ...(me.inviteRequired ? { inviteCode: invite.trim() } : {}),
            },
          });
          await onDone();
        });
      }}
    >
      <Field label="Business name" hint="Used when the assistant writes on your behalf.">
        <input
          className={inputClass}
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Website (optional)">
        <input
          className={inputClass}
          placeholder="www.your-shop.com"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </Field>
      <Field
        label="Time zone"
        hint="Follow-ups are only sent Mon–Fri, 09:00–17:00 in this time zone."
      >
        <select
          className={inputClass}
          required
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        >
          <option value="" disabled>
            Choose… {guess ? `(this device: ${guess})` : ''}
          </option>
          {guess && <option value={guess}>{guess} (this device)</option>}
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Field>
      {me.inviteRequired && (
        <Field label="Invite code" hint="Noctiv is invite-only during early access.">
          <input
            className={inputClass}
            required
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        </Field>
      )}
      <ErrorText>{error}</ErrorText>
      <Button type="submit" disabled={busy} className="w-full">
        Continue
      </Button>
    </form>
  );
}

function KnowledgeStep({ tenantId, onNext }: { tenantId: string; onNext: () => void }) {
  const { data, reload } = useLoad(
    () => api<KbSource[]>(`/v1/tenants/${tenantId}/kb/sources`),
    [tenantId],
  );
  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-600">
        The assistant only states facts it finds here — prices, delivery times, policies. Anything
        else goes to you.
      </p>
      <KnowledgeAdd tenantId={tenantId} onAdded={() => void reload()} />
      <Card title="Added">
        <SourceList
          tenantId={tenantId}
          sources={data ?? []}
          onChange={() => void reload()}
          compact
        />
      </Card>
      <Button className="w-full" onClick={onNext}>
        {data?.length ? 'Continue' : 'Skip for now'}
      </Button>
    </div>
  );
}

function SummaryStep({ tenantId, onFinish }: { tenantId: string; onFinish: () => Promise<void> }) {
  const { tenant } = useSession();
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-sm">
        <li>✓ Business: {tenant?.name}</li>
        <li>
          {tenant?.mailboxes ? '✓' : '•'} Mailbox connected: {tenant?.mailboxes ?? 0}
        </li>
        <li>
          {tenant?.kb_sources ? '✓' : '•'} Knowledge sources: {tenant?.kb_sources ?? 0}
        </li>
      </ul>
      <Notice>
        You start in <strong>mode 1, Approve everything</strong>: Noctiv writes replies, but nothing
        is sent until you approve it. You get an email for every draft, with Approve and Reject
        buttons. After you have reviewed some drafts you can choose mode 2 (auto-reply to grounded
        questions) or mode 3 (fully automatic) in Settings.
      </Notice>
      <ErrorText>{error}</ErrorText>
      <Button
        className="w-full"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await api(`/v1/tenants/${tenantId}`, {
              method: 'PATCH',
              body: { onboardingCompleted: true },
            });
            await onFinish();
          })
        }
      >
        Go to dashboard
      </Button>
    </div>
  );
}

function Wizard() {
  const router = useRouter();
  const { tenant, refresh } = useSession();
  const initial = !tenant ? 0 : tenant.mailboxes === 0 ? 1 : 2;
  const [step, setStep] = useState(initial);

  useEffect(() => {
    if (tenant?.onboarding_completed_at) router.replace('/');
  }, [tenant, router]);

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <p className="flex items-center gap-2 text-sm font-semibold text-neutral-500">
        <Logo height={24} /> <span>setup</span>
      </p>
      <ol className="my-4 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="text-center">
            <div
              className={`h-1.5 rounded-full ${i <= step ? 'bg-indigo-700' : 'bg-neutral-200'}`}
            />
            <span
              className={`mt-1 block text-[11px] ${i === step ? 'font-medium text-neutral-900' : 'text-neutral-500'}`}
            >
              {s}
            </span>
          </li>
        ))}
      </ol>
      <h1 className="mb-4 text-xl font-semibold">{STEPS[step]}</h1>

      {step === 0 && (
        <BusinessStep
          onDone={async () => {
            await refresh();
            setStep(1);
          }}
        />
      )}
      {step === 1 && tenant && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            Connect the mailbox your customers write to. You need an App Password — a separate
            password just for Noctiv that you can revoke at any time.
          </p>
          <MailboxForm
            tenantId={tenant.id}
            onSaved={() => {
              void refresh();
              setStep(2);
            }}
          />
          <Button variant="ghost" className="w-full" onClick={() => setStep(2)}>
            {tenant.mailboxes > 0
              ? 'Continue with the connected mailbox'
              : 'Skip for now — connect it later in Settings'}
          </Button>
        </div>
      )}
      {step === 2 && tenant && (
        <KnowledgeStep
          tenantId={tenant.id}
          onNext={() => {
            void refresh();
            setStep(3);
          }}
        />
      )}
      {step === 3 && tenant && (
        <SummaryStep
          tenantId={tenant.id}
          onFinish={async () => {
            await refresh();
            router.replace('/');
          }}
        />
      )}
      {step > 1 && (
        <button className="mt-6 text-sm text-neutral-500" onClick={() => setStep(step - 1)}>
          ← Back
        </button>
      )}
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <SessionProvider allowIncompleteOnboarding>
      <Wizard />
    </SessionProvider>
  );
}
