import type { NextConfig } from 'next';

/** The browser only talks to this origin; /api/* is forwarded to the Noctiv API. */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // Standalone output serves our Docker image and the Cloudflare Workers build (OpenNext).
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // The floating dev badge covers the mobile navigation.
  devIndicators: false,
  // Local review from a phone on the same network (pnpm dev:stack).
  allowedDevOrigins: ['*.local', '192.168.*.*', '10.*.*.*'],
  // Module setup moved from Settings to each module's own page.
  async redirects() {
    return [
      { source: '/settings/quotes', destination: '/quotes?tab=setup', permanent: false },
      { source: '/settings/documents', destination: '/documents?tab=setup', permanent: false },
      { source: '/settings/integrations', destination: '/integrations', permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default config;
