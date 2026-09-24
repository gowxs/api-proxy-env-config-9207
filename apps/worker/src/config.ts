import { loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  WORKER_DATABASE_URL: z.url(),
  /** Supabase Storage REST base: local container or https://<ref>.supabase.co/storage/v1 */
  STORAGE_URL: z.url().default('http://localhost:54324'),
  /** Server-side Storage token (local: packages/kb/scripts/local-storage-token.ts). */
  STORAGE_TOKEN: z.string().default(''),
  /** Supabase gateway "apikey" header (cloud only): the publishable/anon key. */
  STORAGE_API_KEY: z.string().optional(),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export const loadWorkerConfig = (source?: Record<string, string | undefined>): WorkerConfig =>
  loadEnv(workerEnvSchema, source);
