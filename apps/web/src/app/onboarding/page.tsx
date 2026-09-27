'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AssistantChat } from '@/components/assistant';
import { browserLocale } from '@/lib/assistant';
import { KnowledgeAdd, SourceList, type KbSource } from '@/components/knowledge';
import { Logo } from '@/components/logo';
import { MailboxForm } from '@/components/mailbox-form';
import {
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  inputClass,
  Notice,
  useAction,
  useLoad,
  usePollWhile,
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

function BusinessStep({ onDone }: { onDone: (tenantId: string) => Promise<void> }) {
  const { me } = useSession();
  const guess = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  // The device's time zone is almost always the right one; it can be changed.
  const [timezone, setTimezone] = useState(guess ?? '');
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
          const created = await api<{ id: string }>('/v1/tenants', {
            method: 'POST',
            body: {
              name: name.trim(),
              timezone,
              websiteUrl: w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : null,
              ...(me.inviteRequired ? { inviteCode: invite.trim() } : {}),
            },
          });
          await onDone(created.id);
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

function KnowledgeStep({
  tenantId,
  website,
  onNext,
}: {
  tenantId: string;
  website: string | null;
  onNext: () => void;
}) {
  const { data, reload } = useLoad(
    () => api<KbSource[]>(`/v1/tenants/${tenantId}/kb/sources`),
    [tenantId],
  );
  usePollWhile(
    Boolean(data?.some((s) => s.status === 'pending' || s.status === 'processing')),
    reload,
  );
  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-600">
        The assistant only states facts it finds here — prices, delivery times, policies. Anything
        else goes to you.
      </p>
      <KnowledgeAdd
        tenantId={tenantId}
        // Prefilled only while nothing is added yet, so it is not suggested twice.
        defaultUrl={data && data.length === 0 ? website : null}
        onAdded={() => void reload()}
      />
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
        Open Noctiv
      </Button>
    </div>
  );
}

/** First screen of onboarding (PLAN.md §27): set up with the assistant, or step by step. */
function ChoosePath({ onChoose }: { onChoose: (p: 'assistant' | 'manual') => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">
        Noctiv needs your business details, your mailbox and a few facts about what you sell. How
        would you like to set it up?
      </p>
      <button
        className="block w-full rounded-xl border-2 border-indigo-600 bg-indigo-50 p-4 text-left"
        onClick={() => onChoose('assistant')}
      >
        <span className="flex items-center gap-2 font-semibold text-indigo-900">
          Set up with the assistant
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            beta
          </span>
        </span>
        <span className="mt-1 block text-sm text-neutral-700">
          Chat in your language. It asks about your business, writes your knowledge-base note and
          price list with you, and proposes settings for you to confirm.
        </span>
      </button>
      <button
        className="block w-full rounded-xl border border-neutral-300 bg-white p-4 text-left"
        onClick={() => onChoose('manual')}
      >
        <span className="font-semibold">Set up manually</span>
        <span className="mt-1 block text-sm text-neutral-700">
          Four short steps: business, mailbox, knowledge, summary.
        </span>
      </button>
    </div>
  );
}

/** The assistant path: the business is created first (name, time zone, invite code), then the chat. */
function AssistantSetup({ onManual }: { onManual: () => void }) {
  const router = useRouter();
  const { tenant, refresh } = useSession();
  const { busy, error, run } = useAction();
  // Settings is only reachable after setup, so the mailbox is connected here.
  const [connecting, setConnecting] = useState(false);
  if (!tenant)
    return (
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">
          First your business name; the assistant takes it from there.
        </p>
        <BusinessStep
          onDone={async (tenantId) => {
            // Starting the conversation now also marks this business as set up with the assistant.
            await api(`/v1/tenants/${tenantId}/assistant/new`, {
              method: 'POST',
              body: { purpose: 'onboarding', locale: browserLocale() },
            });
            await refresh();
          }}
        />
      </div>
    );
  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="min-h-0 flex-1">
        {connecting ? (
          <div className="h-full space-y-4 overflow-y-auto p-4">
            <p className="text-sm text-neutral-600">
              Connect the mailbox your customers write to. You need an App Password — ask the
              assistant how to get one for your provider.
            </p>
            <MailboxForm
              tenantId={tenant.id}
              onSaved={() => {
                void refresh();
                setConnecting(false);
              }}
            />
            <Button variant="ghost" className="w-full" onClick={() => setConnecting(false)}>
              Back to the assistant
            </Button>
          </div>
        ) : (
          <AssistantChat
            tenantId={tenant.id}
            purpose="onboarding"
            onApplied={() => void refresh()}
          />
        )}
      </div>
      {!connecting && (
        <div className="border-t border-neutral-200 px-3 py-2.5 text-sm">
          {tenant.mailboxes > 0 ? (
            <span className="text-neutral-600">✓ Mailbox connected</span>
          ) : (
            <button className="font-medium text-indigo-700" onClick={() => setConnecting(true)}>
              Connect mailbox
            </button>
          )}
        </div>
      )}
      <div
        className={cx(
          'flex items-center gap-3 border-t border-neutral-200 p-3',
          connecting && 'hidden',
        )}
      >
        <Button
          className="flex-1"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api(`/v1/tenants/${tenant.id}`, {
                method: 'PATCH',
                body: { onboardingCompleted: true },
              });
              await refresh();
              router.replace('/');
            })
          }
        >
          Finish setup
        </Button>
        <button className="text-sm text-neutral-600" onClick={onManual}>
          Set up manually
        </button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

const PATH_KEY = 'noctiv.onboarding.path';
function savedPath(): 'assistant' | 'manual' | null {
  try {
    const v = localStorage.getItem(PATH_KEY);
    return v === 'assistant' || v === 'manual' ? v : null;
  } catch {
    return null;
  }
}
function savePath(p: 'assistant' | 'manual') {
  try {
    localStorage.setItem(PATH_KEY, p);
  } catch {
    // Private mode: the choice is simply not remembered.
  }
}

function Wizard() {
  const router = useRouter();
  const { tenant, refresh } = useSession();
  const initial = !tenant ? 0 : tenant.mailboxes === 0 ? 1 : 2;
  const [step, setStep] = useState(initial);
  // A business created on the assistant path comes back to the assistant after a reload.
  const [path, setPathState] = useState<'choose' | 'assistant' | 'manual' | 'resolving'>(() =>
    !tenant ? 'choose' : (savedPath() ?? 'resolving'),
  );
  const setPath = (p: 'assistant' | 'manual') => {
    savePath(p);
    setPathState(p);
  };
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (path !== 'resolving' || !tenant) return;
    let live = true;
    api<{ conversation: unknown }>(`/v1/tenants/${tenant.id}/assistant?purpose=onboarding`)
      .then((r) => live && setPathState(r.conversation ? 'assistant' : 'manual'))
      .catch(() => live && setPathState('manual'));
    return () => {
      live = false;
    };
  }, [path, tenant]);

  useEffect(() => {
    if (tenant?.onboarding_completed_at) router.replace('/');
  }, [tenant, router]);

  if (path === 'resolving') return null;
  if (path !== 'manual')
    return (
      <main className="mx-auto max-w-lg px-4 py-6">
        <p className="flex items-center gap-2 text-sm font-semibold text-neutral-500">
          <Logo height={24} /> <span>setup</span>
        </p>
        <h1 className="my-4 text-xl font-semibold">
          {path === 'choose' ? 'Welcome to Noctiv' : 'Set up with the assistant'}
        </h1>
        {path === 'choose' ? (
          <ChoosePath onChoose={setPath} />
        ) : (
          <AssistantSetup
            onManual={() => {
              setStep(tenant ? (tenant.mailboxes === 0 ? 1 : 2) : 0);
              setPath('manual');
            }}
          />
        )}
      </main>
    );
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
            onTested={setTested}
            onSaved={() => {
              void refresh();
              setStep(2);
            }}
          />
          {/* After a passing test the only next step is "Save mailbox". */}
          {!tested && (
            <Button variant="ghost" className="w-full" onClick={() => setStep(2)}>
              {tenant.mailboxes > 0
                ? 'Continue with the connected mailbox'
                : 'Skip for now — connect it later in Settings'}
            </Button>
          )}
        </div>
      )}
      {step === 2 && tenant && (
        <KnowledgeStep
          tenantId={tenant.id}
          website={tenant.website_url ?? null}
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
