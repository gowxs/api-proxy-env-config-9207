'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Logo } from '@/components/logo';
import { Button, ErrorText, Field, inputClass, Notice } from '@/components/ui';
import { DEV_LOGIN, devLogin, SUPABASE_ENABLED, supabase } from '@/lib/auth';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const go = () => router.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');

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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1>
        <Logo height={40} />
      </h1>
      <p className="mt-3 mb-6 text-sm text-neutral-600">Your AI employee for email.</p>
      {params.get('deleted') && (
        <div className="mb-6">
          <Notice>
            Your account and all its data are being deleted. Thank you for trying Noctiv.
          </Notice>
        </div>
      )}

      {SUPABASE_ENABLED && (
        <form onSubmit={submit} className="space-y-4">
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
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
