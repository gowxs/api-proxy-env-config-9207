'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two ways to sign in:
 *  - Supabase Auth (production): email + password or a magic link.
 *  - Dev login (local stack only; the API refuses it in production).
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
export const DEV_LOGIN = process.env.NEXT_PUBLIC_DEV_LOGIN === '1';
export const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);

const DEV_TOKEN_KEY = 'noctiv.devToken';

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient | null {
  if (!SUPABASE_ENABLED) return null;
  client ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

function readDevToken(): string | null {
  try {
    return localStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function getAccessToken(): Promise<string | null> {
  const dev = readDevToken();
  if (dev) return dev;
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function devLogin(): Promise<void> {
  const res = await fetch('/api/dev/login', { method: 'POST' });
  if (!res.ok) throw new Error('Dev login is not enabled on the API.');
  const { accessToken } = (await res.json()) as { accessToken: string };
  localStorage.setItem(DEV_TOKEN_KEY, accessToken);
}

export async function signOut(): Promise<void> {
  try {
    localStorage.removeItem(DEV_TOKEN_KEY);
  } catch {
    // ignore
  }
  await supabase()?.auth.signOut();
}
