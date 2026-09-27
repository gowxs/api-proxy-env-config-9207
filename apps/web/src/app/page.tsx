import type { Metadata } from 'next';
import { HomeGate } from '@/components/home-gate';
import { LoginForm } from '@/components/login-form';
import { PUBLIC_ROBOTS, PublicFront } from '@/components/public-front';

export const metadata: Metadata = { robots: PUBLIC_ROBOTS, alternates: { canonical: '/' } };

/**
 * Before first paint: a visitor with a stored session gets data-session on
 * <html>, which hides the public page (globals.css) while the dashboard
 * loads. Keep the test in step with hasStoredSession (home-gate.tsx).
 */
const SESSION_CHECK = `try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i)||'';if(k==='noctiv.devToken'||/^sb-.+-auth-token$/.test(k)){document.documentElement.setAttribute('data-session','');break}}}catch(e){}`;

/**
 * app.noctiv.io/: the public page (server-rendered, works without
 * JavaScript) for visitors who are not signed in; the dashboard for owners.
 */
export default function HomePage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SESSION_CHECK }} />
      <div className="public-only">
        <PublicFront>
          <LoginForm />
        </PublicFront>
      </div>
      {/* Its text comes from CSS, so text-only readers never see "Loading…". */}
      <p className="session-only home-loading p-6 text-neutral-500" aria-hidden="true" />
      <HomeGate />
    </>
  );
}
