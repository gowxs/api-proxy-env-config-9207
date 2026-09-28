import type { Metadata } from 'next';
import { HomeDashboard } from '@/components/home-dashboard';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** The signed-in owner's home (app.noctiv.io/home). "/" is the public page only. */
export default function HomePage() {
  return <HomeDashboard />;
}
