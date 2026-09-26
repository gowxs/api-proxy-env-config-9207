'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { signOut } from '@/lib/auth';
import { BillingProvider } from '@/lib/billing';
import { modeInfo } from '@/lib/modes';
import { NavProvider, useNav, type NavData } from '@/lib/nav';
import { SessionProvider, useSession } from '@/lib/session';
import { BillingBanner, PlanChip } from './billing';
import { Icon, type IconName } from './icons';
import { Logo } from './logo';
import { cx } from './ui';

interface Badge {
  n: number;
  tone: 'blue' | 'amber';
  label: string;
}
interface Item {
  href: string;
  label: string;
  icon: IconName;
  badges?: (c: NavData['counts']) => Badge[];
}

const INBOX: Item = {
  href: '/conversations',
  label: 'Inbox',
  icon: 'inbox',
  badges: (c) => [
    { n: c.drafts, tone: 'blue', label: 'drafts awaiting approval' },
    { n: c.escalations, tone: 'amber', label: 'escalations' },
  ],
};
const HOME: Item = { href: '/', label: 'Home', icon: 'home' };
const LEADS: Item = { href: '/leads', label: 'Leads', icon: 'leads' };
const QUOTES: Item = { href: '/quotes', label: 'Quotes', icon: 'quotes' };
const DOCUMENTS: Item = {
  href: '/documents',
  label: 'Documents',
  icon: 'documents',
  badges: (c) => [{ n: c.unpaid, tone: 'blue', label: 'unpaid invoices' }],
};
const PAYMENTS: Item = {
  href: '/payments',
  label: 'Payments',
  icon: 'payments',
  badges: (c) => [{ n: c.payments, tone: 'amber', label: 'payments to check' }],
};
const KNOWLEDGE: Item = { href: '/knowledge', label: 'Knowledge', icon: 'knowledge' };
const INTEGRATIONS: Item = { href: '/integrations', label: 'Integrations', icon: 'integrations' };
const SETTINGS: Item = { href: '/settings', label: 'Settings', icon: 'settings' };

const SECTIONS: { title: string; items: Item[] }[] = [
  { title: 'Work', items: [INBOX, LEADS, QUOTES, DOCUMENTS, PAYMENTS] },
  { title: 'Setup', items: [KNOWLEDGE, INTEGRATIONS, SETTINGS] },
];
/** Phone: four items and More. */
const BAR: Item[] = [HOME, INBOX, LEADS, QUOTES];
const MORE: Item[] = [DOCUMENTS, PAYMENTS, KNOWLEDGE, INTEGRATIONS, SETTINGS];

// Pages that belong to an item without sharing its path.
const ALIASES: Record<string, string> = {
  '/drafts': '/conversations',
  '/escalations': '/conversations',
};

function isActive(pathname: string, href: string) {
  const alias = Object.entries(ALIASES).find(([p]) => pathname.startsWith(p))?.[1];
  if (alias) return alias === href;
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

const badgesOf = (item: Item, nav: NavData | null) =>
  nav && item.badges ? item.badges(nav.counts).filter((b) => b.n > 0) : [];

function Count({ b, small = false }: { b: Badge; small?: boolean }) {
  return (
    <span
      title={`${b.n} ${b.label}`}
      className={cx(
        'inline-flex items-center justify-center rounded-full font-semibold tabular-nums',
        small ? 'h-4 min-w-4 px-1 text-[10px]' : 'h-5 min-w-5 px-1.5 text-xs',
        b.tone === 'amber' ? 'bg-amber-500 text-white' : 'bg-indigo-600 text-white',
      )}
    >
      <span className="sr-only">
        {b.n} {b.label}
      </span>
      <span aria-hidden>{b.n > 99 ? '99+' : b.n}</span>
    </span>
  );
}

function useSignOut() {
  const router = useRouter();
  return () => void signOut().then(() => router.replace('/login'));
}

// --------------------------------------------------------------- desktop
function UserMenu({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const out = useSignOut();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-neutral-600 hover:bg-neutral-100"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-800 uppercase">
          {email?.[0] ?? '?'}
        </span>
        <span className="min-w-0 flex-1 truncate">{email ?? 'Account'}</span>
        <Icon name="chevron" width={16} height={16} className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute inset-x-0 bottom-full mb-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg"
        >
          <Link
            role="menuitem"
            href="/settings#account"
            className="block rounded-md px-3 py-2 text-sm hover:bg-neutral-100"
          >
            Account
          </Link>
          <button
            role="menuitem"
            onClick={out}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-800 hover:bg-red-50"
          >
            <Icon name="logout" width={16} height={16} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const { me, tenant } = useSession();
  const { nav } = useNav();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-neutral-200 bg-white lg:flex">
      <Link href="/" className="flex h-16 shrink-0 items-center px-5" aria-label="Noctiv, home">
        <Logo height={24} />
      </Link>
      <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        {SECTIONS.map((s) => (
          <div key={s.title}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">
              {s.title}
            </p>
            <ul className="space-y-0.5">
              {s.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'flex h-9 items-center gap-3 rounded-lg px-3 text-sm',
                        active
                          ? 'bg-indigo-50 font-medium text-indigo-800'
                          : 'text-neutral-700 hover:bg-neutral-100',
                      )}
                    >
                      <Icon
                        name={item.icon}
                        className={active ? 'text-indigo-700' : 'text-neutral-400'}
                      />
                      <span className="flex-1">{item.label}</span>
                      {badgesOf(item, nav).map((b) => (
                        <Count key={b.label} b={b} />
                      ))}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="space-y-2 border-t border-neutral-200 p-3">
        <div className="px-2">
          <p className="truncate text-sm font-semibold">{nav?.name ?? tenant?.name}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {nav && (
              <Link
                href="/settings#reply-mode"
                title={modeInfo(nav.mode).title}
                className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700"
              >
                Mode {modeInfo(nav.mode).number}
              </Link>
            )}
            <PlanChip />
          </div>
        </div>
        <UserMenu email={me.email} />
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------- phone
function MoreSheet({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const { me, tenant } = useSession();
  const { nav } = useNav();
  const out = useSignOut();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More">
      <button
        aria-label="Close"
        className="absolute inset-0 h-full w-full bg-black/40"
        onClick={onClose}
      />
      <div
        ref={panel}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl outline-none"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{nav?.name ?? tenant?.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {nav && (
                <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                  Mode {modeInfo(nav.mode).number} · {modeInfo(nav.mode).title}
                </span>
              )}
              <PlanChip />
            </div>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
          >
            <Icon name="close" />
          </button>
        </div>
        <ul className="px-3 pb-2">
          {MORE.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onClose}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex min-h-12 items-center gap-3 rounded-xl px-3 text-base',
                    active ? 'bg-indigo-50 font-medium text-indigo-800' : 'text-neutral-800',
                  )}
                >
                  <Icon
                    name={item.icon}
                    width={22}
                    height={22}
                    className={active ? 'text-indigo-700' : 'text-neutral-400'}
                  />
                  <span className="flex-1">{item.label}</span>
                  {badgesOf(item, nav).map((b) => (
                    <Count key={b.label} b={b} />
                  ))}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-3 border-t border-neutral-100 px-5 py-3">
          <span className="min-w-0 flex-1 truncate text-sm text-neutral-500">{me.email}</span>
          <button
            onClick={out}
            className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-800 hover:bg-red-50"
          >
            <Icon name="logout" width={18} height={18} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function BottomBar() {
  const pathname = usePathname();
  const { nav } = useNav();
  const [more, setMore] = useState(false);
  const moreActive = MORE.some((i) => isActive(pathname, i.href));
  const moreCount = MORE.flatMap((i) => badgesOf(i, nav)).reduce((t, b) => t + b.n, 0);
  const tab = (active: boolean) =>
    cx(
      'relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]',
      active ? 'font-medium text-indigo-800' : 'text-neutral-500',
    );
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {BAR.map((item) => {
          const active = isActive(pathname, item.href);
          const n = badgesOf(item, nav).reduce((t, b) => t + b.n, 0);
          const amber = badgesOf(item, nav).some((b) => b.tone === 'amber');
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={tab(active)}
            >
              <span className="relative">
                <Icon name={item.icon} width={22} height={22} />
                {n > 0 && (
                  <span className="absolute -top-1.5 left-3.5">
                    <Count small b={{ n, tone: amber ? 'amber' : 'blue', label: 'waiting' }} />
                  </span>
                )}
              </span>
              {item.label}
            </Link>
          );
        })}
        <button
          className={tab(moreActive || more)}
          aria-haspopup="dialog"
          aria-expanded={more}
          onClick={() => setMore(true)}
        >
          <span className="relative">
            <Icon name="more" width={22} height={22} />
            {moreCount > 0 && (
              <span className="absolute -top-1.5 left-3.5">
                <Count small b={{ n: moreCount, tone: 'amber', label: 'waiting' }} />
              </span>
            )}
          </span>
          More
        </button>
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </>
  );
}

function Chrome({ title, children }: { title: string; children: ReactNode }) {
  const { tenant } = useSession();
  return (
    <BillingProvider tenantId={tenant?.id ?? null}>
      <NavProvider tenantId={tenant?.id ?? null}>
        <div className="min-h-screen bg-neutral-50">
          <Sidebar />
          <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur lg:hidden">
            <div className="flex h-14 items-center gap-3 px-4">
              <Link href="/" className="shrink-0" aria-label="Noctiv, home">
                <Logo height={24} />
              </Link>
              <PlanChip className="ml-auto" />
            </div>
          </header>
          <div className="pb-24 lg:pb-0 lg:pl-60">
            <main className="mx-auto max-w-5xl px-4 py-5 lg:px-8 lg:py-8">
              <BillingBanner />
              <h1 className="mb-4 text-xl font-semibold lg:text-2xl">{title}</h1>
              {children}
            </main>
          </div>
          <BottomBar />
        </div>
      </NavProvider>
    </BillingProvider>
  );
}

/** Signed-in page frame: sidebar (desktop), bottom bar and More sheet (phone), session. */
export function AppPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SessionProvider>
      <Chrome title={title}>{children}</Chrome>
    </SessionProvider>
  );
}
