'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Mode } from './modes';

export interface NavData {
  name: string;
  mode: Mode;
  modules: { quotes: boolean; documents: boolean };
  counts: { drafts: number; escalations: number; unpaid: number; payments: number };
}

interface NavValue {
  nav: NavData | null;
  reload: () => Promise<void>;
}
const NavContext = createContext<NavValue>({ nav: null, reload: async () => {} });

/** Badges and chips for the navigation; pages that change them call reload(). */
export const useNav = () => useContext(NavContext);

export function NavProvider({
  tenantId,
  children,
}: {
  tenantId: string | null;
  children: ReactNode;
}) {
  const [nav, setNav] = useState<NavData | null>(null);
  const reload = useCallback(async () => {
    if (!tenantId) return;
    try {
      setNav(await api<NavData>(`/v1/tenants/${tenantId}/nav`));
    } catch {
      // Badges are optional; pages show their own errors.
    }
  }, [tenantId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return <NavContext.Provider value={{ nav, reload }}>{children}</NavContext.Provider>;
}
