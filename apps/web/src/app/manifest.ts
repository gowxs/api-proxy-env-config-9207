import type { MetadataRoute } from 'next';

/** Installable app (icons from packages/brand, copied to public/brand). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Noctiv',
    short_name: 'Noctiv',
    description: 'The e-mail assistant that works while you sleep.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0B1026',
    theme_color: '#0B1026',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/brand/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/brand/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
