import type { ReactNode } from 'react';
import { Logo } from './logo';

const SITE = 'https://noctiv.io';

/**
 * The public face of app.noctiv.io (/, /login and /signup): rendered on the server,
 * readable without JavaScript — the wordmark, what Noctiv is, the sign-in
 * form and links to pricing and the legal pages (payment provider review).
 */
export function PublicFront({
  children,
  heading = 'Sign in',
}: {
  children: ReactNode;
  heading?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
        <h1>
          <Logo height={40} />
        </h1>
        <p className="mt-3 text-base text-neutral-800">
          Noctiv answers your business e-mail while you sleep: replies grounded in your own prices
          and policies, quotes and invoices, and follow-ups, with you in control.
        </p>
        <h2 className="mt-8 mb-4 text-lg font-semibold">{heading}</h2>
        {children}
        <noscript>
          <p className="mt-4 text-sm text-neutral-600">Signing in needs JavaScript switched on.</p>
        </noscript>
      </main>
      <footer className="border-t border-neutral-200 bg-white">
        <nav
          aria-label="Noctiv"
          className="mx-auto flex max-w-sm flex-wrap justify-center gap-x-5 gap-y-2 px-4 py-5 text-sm text-neutral-600"
        >
          <a href={SITE}>noctiv.io</a>
          <a href={`${SITE}/pricing/`}>Pricing</a>
          <a href={`${SITE}/terms/`}>Terms</a>
          <a href={`${SITE}/privacy/`}>Privacy</a>
          <a href={`${SITE}/refunds/`}>Refunds</a>
        </nav>
        <p className="pb-5 text-center text-xs text-neutral-500">© 2026 Noctiv</p>
      </footer>
    </div>
  );
}

/** Crawlers and payment-provider checks may index / and /login (the rest stays noindex). */
export const PUBLIC_ROBOTS = { index: true, follow: true } as const;
