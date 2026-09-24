import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/*.live.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Needs Docker: starts a throwaway Supabase Postgres container,
        // or uses TEST_DATABASE_URL when set.
        test: {
          name: 'db',
          include: ['{apps,packages}/*/test/**/*.db.test.ts', 'tests/**/*.db.test.ts'],
          globalSetup: ['packages/db/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // Calls the real model provider; opt-in, never in CI.
        test: {
          name: 'live',
          include: ['{apps,packages}/*/test/**/*.live.test.ts'],
          // Live pipeline tests also need the throwaway database and GreenMail.
          globalSetup: ['packages/db/test/global-setup.ts'],
          hookTimeout: 180_000,
          testTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
