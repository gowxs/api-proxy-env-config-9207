import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
import { PUBLIC_ROBOTS, PublicFront } from '@/components/public-front';

export const metadata: Metadata = {
  title: 'Create your account · Noctiv',
  robots: PUBLIC_ROBOTS,
  alternates: { canonical: '/signup' },
};

/** Self-serve sign-up (every "Start free trial" on noctiv.io links here); then onboarding. */
export default function SignupPage() {
  return (
    <PublicFront heading="Create your account">
      <LoginForm initialMode="signup" />
    </PublicFront>
  );
}
