import type { Metadata } from 'next';
import { SignedInToHome } from '@/components/home-gate';
import { LoginForm } from '@/components/login-form';
import { PUBLIC_ROBOTS, PublicFront } from '@/components/public-front';

export const metadata: Metadata = { robots: PUBLIC_ROBOTS, alternates: { canonical: '/' } };

/**
 * Full page load, before first paint: a visitor with a stored session goes to
 * /home (the public page stays hidden meanwhile). Keep the test in step with
 * hasStoredSession (home-gate.tsx).
 */
const SESSION_CHECK = `try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i)||'';if(k==='noctiv.devToken'||/^sb-.+-auth-token$/.test(k)){document.documentElement.setAttribute('data-session','');location.replace('/home');break}}}catch(e){}`;

/**
 * app.noctiv.io/: the public page only (server-rendered, works without
 * JavaScript, e.g. for Paddle's review). Signed-in owners use /home; the
 * dashboard is never rendered here, so the two can no longer appear together.
 */
export default function PublicHomePage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SESSION_CHECK }} />
      <div className="public-only">
        <PublicFront>
          <LoginForm />
        </PublicFront>
      </div>
      <SignedInToHome />
    </>
  );
}
