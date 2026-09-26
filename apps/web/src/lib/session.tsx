'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface TenantSummary {
  id: string;
  name: string;
  onboarding_completed_at: string | null;
  /** The business website from onboarding (prefills Knowledge → Website). */
  website_url?: string | null;
  mailboxes: number;
  kb_sources: number;
}
export interface Me {
  userId: string;
  email: string | null;
  inviteRequired: boolean;
  tenants: TenantSummary[];
}

interface SessionValue {
  me: Me;
  tenant: TenantSummary | null;
  refresh: () => Promise<void>;
}
const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
/** For pages that need a business (everything after onboarding step 1). */
export function useTenantId(): string {
  const { tenant } = useSession();
  if (!tenant) throw new Error('no tenant');
  return tenant.id;
}

/**
 * Loads who is signed in and routes them: no session → /login, no business
 * or unfinished onboarding → /onboarding.
 */
export function SessionProvider({
  children,
  allowIncompleteOnboarding = false,
}: {
  children: ReactNode;
  allowIncompleteOnboarding?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/v1/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }, [router, pathname]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tenant = me?.tenants[0] ?? null;
  const needsOnboarding = me && (!tenant || !tenant.onboarding_completed_at);
  useEffect(() => {
    if (needsOnboarding && !allowIncompleteOnboarding) router.replace('/onboarding');
  }, [needsOnboarding, allowIncompleteOnboarding, router]);

  if (error) return <p className="p-6 text-red-700">{error}</p>;
  if (!me || (needsOnboarding && !allowIncompleteOnboarding)) {
    return <p className="p-6 text-neutral-500">Loading…</p>;
  }
  return (
    <SessionContext.Provider value={{ me, tenant, refresh }}>{children}</SessionContext.Provider>
  );
}
