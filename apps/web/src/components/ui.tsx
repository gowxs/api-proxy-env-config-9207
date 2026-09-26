'use client';

import { useCallback, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium transition disabled:opacity-50',
        variant === 'primary' && 'bg-indigo-700 text-white hover:bg-indigo-800',
        variant === 'secondary' &&
          'border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50',
        variant === 'danger' && 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
        variant === 'ghost' && 'text-indigo-700 hover:bg-indigo-50',
        className,
      )}
    />
  );
}

export function Card({
  title,
  children,
  action,
}: {
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-neutral-700">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-800">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-base outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100';

const TONES: Record<string, string> = {
  green: 'bg-green-50 text-green-800 ring-green-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  blue: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  gray: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
};
export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900">{children}</p>;
}

/** Loads data once (and on reload()); shows nothing fancy. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setError(null);
      setData(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Runs an action, tracking busy state and error text. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function Loading() {
  return <p className="py-6 text-sm text-neutral-500">Loading…</p>;
}

/** Calls reload every few seconds while `active` (e.g. something is still being processed). */
export function usePollWhile(active: boolean, reload: () => unknown, ms = 4000) {
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => void reload(), ms);
    return () => clearTimeout(t);
  });
}
