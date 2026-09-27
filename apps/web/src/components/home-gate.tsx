'use client';

import { useEffect, useState } from 'react';
import { HomeDashboard } from './home-dashboard';

/** Same test as the inline script in app/page.tsx: a stored session (Supabase or dev login). */
export function hasStoredSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      if (k === 'noctiv.devToken' || /^sb-.+-auth-token$/.test(k)) return true;
    }
  } catch {
    // Storage blocked: treat as signed out.
  }
  return false;
}

/** Mounts the dashboard for a signed-in visitor; everyone else keeps the public page. */
export function HomeGate() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (hasStoredSession()) {
      setSignedIn(true);
      // The dashboard shows its own loading state from here on.
      document.documentElement.setAttribute('data-home', '');
    } else document.documentElement.removeAttribute('data-session');
  }, []);
  return signedIn ? <HomeDashboard /> : null;
}
