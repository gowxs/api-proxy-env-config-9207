'use client';

import { useEffect, useState } from 'react';
import { Button, ErrorText, Field, inputClass, Notice } from '@/components/ui';
import { DEV_LOGIN, devLogin, SUPABASE_ENABLED, supabase } from '@/lib/auth';

/**
 * Sign in / create account. Rendered on the server as a plain form (visible
 * without JavaScript); the query string (?next, ?deleted) is read in the
 * browser so the page itself stays static.
 */
export function LoginForm() {
  const [next, setNext] = useState('/');
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setNext(q.get('next') || '/');
    setDeleted(q.has('deleted'));
  }, []);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // A full page load: / shows the public page or the dashboard depending on the stored session.
  const go = () => {
    window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sb = supabase();
    if (!sb) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const res =
      mode === 'signin'
        ? await sb.auth.signInWithPassword({ email, password })
        : await sb.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: `${location.origin}/onboarding` },
          });
    setBusy(false);
    if (res.error) return setError(res.error.message);
    if (mode === 'signup' && !res.data.session) {
      return setInfo('Check your inbox and confirm your email address, then sign in.');
    }
    go();
  }

  async function magicLink() {
    const sb = supabase();
    if (!sb || !email) return setError('Enter your email address first.');
    setBusy(true);
    const { error: err } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}${next}`, shouldCreateUser: false },
    });
    setBusy(false);
    if (err) setError(err.message);
    else setInfo('We sent you a sign-in link. Open it on this device.');
  }

  return (
    <div>
      {deleted && (
        <div className="mb-6">
          <Notice>
            Your account and all its data are being deleted. Thank you for trying Noctiv.
          </Notice>
        </div>
      )}

      {SUPABASE_ENABLED && (
        // method="post": without JavaScript nothing (least of all the password) goes into the URL.
        <form onSubmit={submit} method="post" className="space-y-4">
          <Field label="Email">
            <input
              className={inputClass}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          {info && <Notice>{info}</Notice>}
          <Button type="submit" disabled={busy} className="w-full">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
          <div className="flex justify-between text-sm">
            <button
              type="button"
              className="text-indigo-700"
              onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            >
              {mode === 'signin' ? 'Create an account' : 'I already have an account'}
            </button>
            {mode === 'signin' && (
              <button type="button" className="text-indigo-700" onClick={() => void magicLink()}>
                Forgot password? Email me a link
              </button>
            )}
          </div>
        </form>
      )}

      {DEV_LOGIN && (
        <div className="mt-8 space-y-2 border-t border-neutral-200 pt-6">
          <p className="text-xs text-neutral-500">Local development</p>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy}
            onClick={() =>
              void devLogin()
                .then(go)
                .catch((e: Error) => setError(e.message))
            }
          >
            Sign in as the demo owner
          </Button>
          {!SUPABASE_ENABLED && <ErrorText>{error}</ErrorText>}
        </div>
      )}
      {!SUPABASE_ENABLED && !DEV_LOGIN && <ErrorText>Sign-in is not configured.</ErrorText>}
    </div>
  );
}
