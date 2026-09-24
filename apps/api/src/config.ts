import { loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_DATABASE_URL: z.url(),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const loadApiConfig = (source?: Record<string, string | undefined>): ApiConfig =>
  loadEnv(apiEnvSchema, source);
