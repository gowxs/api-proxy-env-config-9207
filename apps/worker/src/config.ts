import { loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  WORKER_DATABASE_URL: z.url(),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export const loadWorkerConfig = (source?: Record<string, string | undefined>): WorkerConfig =>
  loadEnv(workerEnvSchema, source);
