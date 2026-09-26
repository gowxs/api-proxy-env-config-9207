'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useNav } from '@/lib/nav';
import { Badge, Button, cx, ErrorText, useAction } from './ui';

/** Turns a module on or off (PATCH tenant), then refreshes the page's data and the navigation. */
export function useModuleToggle(
  tenantId: string,
  field: 'quotesEnabled' | 'documentsEnabled',
  reload: () => Promise<void>,
) {
  const { reload: reloadNav } = useNav();
  const a = useAction();
  const set = (on: boolean) =>
    void a.run(async () => {
      await api(`/v1/tenants/${tenantId}`, { method: 'PATCH', body: { [field]: on } });
      await Promise.all([reload(), reloadNav()]);
    });
  return { set, busy: a.busy, error: a.error };
}

/** A module that is off: one screen on what it does, and the button to turn it on. */
export function ModuleOff({
  name,
  lead,
  points,
  note,
  onEnable,
  busy,
  error,
}: {
  name: string;
  lead: string;
  points: { title: string; text: string }[];
  note?: ReactNode;
  onEnable: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 sm:p-8">
      <div className="flex items-center gap-2">
        <Badge>Off</Badge>
        <Badge tone="blue">Beta</Badge>
      </div>
      <p className="mt-3 max-w-xl text-lg font-semibold text-neutral-900">{lead}</p>
      <ul className="mt-5 grid gap-4 sm:grid-cols-3">
        {points.map((p, i) => (
          <li key={p.title} className="flex gap-3 sm:block">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-semibold text-indigo-800 sm:mb-2">
              {i + 1}
            </span>
            <span className="text-sm">
              <span className="block font-medium">{p.title}</span>
              <span className="block text-neutral-600">{p.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={onEnable} className="w-full sm:w-auto">
          Turn on {name.toLowerCase()}
        </Button>
        {note && <p className="text-sm text-neutral-500">{note}</p>}
      </div>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/** The top of an enabled module page: its state and the switch to turn it off. */
export function ModuleBar({
  name,
  line,
  onDisable,
  busy,
  error,
}: {
  name: string;
  line: string;
  onDisable: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="mb-4 rounded-xl border border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {name} <Badge tone="green">On</Badge> <Badge tone="blue">Beta</Badge>
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">{line}</p>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-neutral-600">
          <span className="sr-only sm:not-sr-only">On</span>
          <input
            type="checkbox"
            role="switch"
            className="h-5 w-5 accent-indigo-700"
            checked
            disabled={busy}
            aria-label={`${name} on`}
            onChange={() => {
              if (window.confirm(`Turn ${name.toLowerCase()} off? Nothing is deleted.`))
                onDisable();
            }}
          />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Tabs kept in the URL (?tab=), so links can open the setup directly. */
export function useTab<T extends string>(tabs: readonly T[]): [T, (t: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const cur = params.get('tab') as T | null;
  const tab = cur && tabs.includes(cur) ? cur : tabs[0]!;
  return [
    tab,
    (t) => router.replace(t === tabs[0] ? pathname : `${pathname}?tab=${t}`, { scroll: false }),
  ];
}

export function Tabs<T extends string>({
  tabs,
  labels,
  tab,
  onChange,
}: {
  tabs: readonly T[];
  labels: Record<T, string>;
  tab: T;
  onChange: (t: T) => void;
}) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-neutral-200">
      {tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => onChange(t)}
          className={cx(
            '-mb-px min-h-11 border-b-2 px-3 text-sm',
            tab === t
              ? 'border-indigo-700 font-medium text-indigo-800'
              : 'border-transparent text-neutral-600 hover:text-neutral-900',
          )}
        >
          {labels[t]}
        </button>
      ))}
    </div>
  );
}
