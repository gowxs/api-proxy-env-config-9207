import { loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_DATABASE_URL: z.url(),
    /** Supabase project URL: access tokens are verified against its JWKS. */
    SUPABASE_URL: z.url(),
    /** Local development only: a JSON Web Key Set used instead of the project's. */
    AUTH_JWKS_JSON: z.string().optional(),
    /** Worker's public sealing key (packages/core/scripts/generate-sealing-keys.ts). */
    CREDENTIALS_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url X25519 public key'),
    CONNECTION_TEST_WAIT_MS: z.coerce.number().int().min(1_000).max(60_000).default(25_000),
    /** Shared with the worker: verifies Approve / Reject links in owner emails. */
    ACTION_LINK_SECRET: z.string().min(32).optional(),
    PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.AUTH_JWKS_JSON), {
    path: ['AUTH_JWKS_JSON'],
    message: 'must not be set in production',
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.ACTION_LINK_SECRET, {
    path: ['ACTION_LINK_SECRET'],
    message: 'is required in production',
  });

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const loadApiConfig = (source?: Record<string, string | undefined>): ApiConfig =>
  loadEnv(apiEnvSchema, source);
