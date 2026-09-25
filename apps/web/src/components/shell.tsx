'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { signOut } from '@/lib/auth';
import { BillingProvider } from '@/lib/billing';
import { SessionProvider, useSession } from '@/lib/session';
import { BillingBanner } from './billing';
import { cx } from './ui';

const NAV = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/conversations', label: 'Inbox', icon: '✉' },
  { href: '/leads', label: 'Leads', icon: '☰' },
  { href: '/knowledge', label: 'Knowledge', icon: '✎' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

function Chrome({ title, children }: { title: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { tenant } = useSession();
  return (
    <BillingProvider tenantId={tenant?.id ?? null}>
      <div className="min-h-screen bg-neutral-50 pb-20 md:pb-0">
        <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
            <Link href="/" className="font-semibold text-indigo-800">
              Noctiv
            </Link>
            <span className="truncate text-sm text-neutral-500">{tenant?.name}</span>
            <nav className="ml-auto hidden gap-1 md:flex">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cx(
                    'rounded-lg px-3 py-2 text-sm',
                    isActive(pathname, n.href)
                      ? 'bg-indigo-50 font-medium text-indigo-800'
                      : 'text-neutral-600 hover:bg-neutral-100',
                  )}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <button
              className="ml-auto text-sm text-neutral-500 md:ml-2"
              onClick={() => void signOut().then(() => router.replace('/login'))}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-5">
          <BillingBanner />
          <h1 className="mb-4 text-xl font-semibold">{title}</h1>
          {children}
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t border-neutral-200 bg-white md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                'flex min-h-14 flex-col items-center justify-center text-xs',
                isActive(pathname, n.href) ? 'font-medium text-indigo-800' : 'text-neutral-500',
              )}
            >
              <span aria-hidden className="text-lg leading-none">
                {n.icon}
              </span>
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </BillingProvider>
  );
}

/** Signed-in page frame: header, mobile bottom navigation, session. */
export function AppPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SessionProvider>
      <Chrome title={title}>{children}</Chrome>
    </SessionProvider>
  );
}
