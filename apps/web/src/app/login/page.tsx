import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
import { PUBLIC_ROBOTS, PublicFront } from '@/components/public-front';

export const metadata: Metadata = {
  title: 'Sign in · Noctiv',
  robots: PUBLIC_ROBOTS,
  alternates: { canonical: '/login' },
};

export default function LoginPage() {
  return (
    <PublicFront>
      <LoginForm />
    </PublicFront>
  );
}
