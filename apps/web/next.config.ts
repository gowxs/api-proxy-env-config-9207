import type { NextConfig } from 'next';

/** The browser only talks to this origin; /api/* is forwarded to the Noctiv API. */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // Netlify packages Next.js itself; standalone output is for our own Docker image.
  output: process.env.NETLIFY ? undefined : 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // The floating dev badge covers the mobile navigation.
  devIndicators: false,
  // Local review from a phone on the same network (pnpm dev:stack).
  allowedDevOrigins: ['*.local', '192.168.*.*', '10.*.*.*'],
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
