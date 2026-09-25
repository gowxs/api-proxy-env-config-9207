import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://app.noctiv.io'),
  title: 'Noctiv',
  description: 'The e-mail assistant that works while you sleep.',
  robots: { index: false, follow: false },
  // Icons: app/icon.svg, app/apple-icon.png and public/favicon.ico (packages/brand).
  openGraph: {
    type: 'website',
    siteName: 'Noctiv',
    title: 'Noctiv',
    description: 'The e-mail assistant that works while you sleep.',
    images: [
      {
        url: 'https://noctiv.io/og.jpg',
        width: 1200,
        height: 630,
        alt: 'Noctiv: your inbox, answered while you sleep.',
      },
    ],
  },
  twitter: { card: 'summary_large_image', images: ['https://noctiv.io/og.jpg'] },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B1026',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
