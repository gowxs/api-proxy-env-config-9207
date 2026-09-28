'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

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

/**
 * "/" is the public page only. A signed-in owner who reaches it by an in-app
 * navigation (the inline script runs only on a full page load) goes to /home.
 */
export function SignedInToHome() {
  const router = useRouter();
  useEffect(() => {
    if (hasStoredSession()) router.replace('/home');
    else document.documentElement.removeAttribute('data-session');
  }, [router]);
  return null;
}
