import { dataRegionEnv, dataRegionProblem, loadEnv } from '@noctiv/core';
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
    /** Public base URL of this API; defaults to PUBLIC_APP_URL + /api (the dashboard proxies it). */
    PUBLIC_API_URL: z.url().optional(),
    /** The public site (https://noctiv.io): waitlist pages link back to it. */
    PUBLIC_SITE_URL: z.url().default('https://noctiv.io'),
    /** Founder's bearer token for GET /admin/waitlist.csv; unset = export off. */
    WAITLIST_EXPORT_TOKEN: z.string().min(32).optional(),
    /** Comma-separated invite codes; signup is gated while set (required in production, Q12). */
    SIGNUP_INVITE_CODES: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    /** Local development only: enables POST /dev/login for this (seeded) user. */
    DEV_LOGIN_USER_ID: z.uuid().optional(),
    DEV_LOGIN_EMAIL: z.email().default('owner@noctiv.local'),
    ...dataRegionEnv,
    /** Paddle Billing (subscriptions). Sandbox until live keys are set. */
    PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
    PADDLE_API_KEY: z.string().min(1).optional(),
    PADDLE_WEBHOOK_SECRET: z.string().min(1).optional(),
    PADDLE_CLIENT_TOKEN: z.string().min(1).optional(),
    PADDLE_PRICE_ID: z
      .string()
      .regex(/^pri_[a-z0-9]+$/, 'a Paddle price id (pri_…)')
      .optional(),
    /** true behind the Caddy reverse proxy (client IP from X-Forwarded-For). */
    API_TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.AUTH_JWKS_JSON), {
    path: ['AUTH_JWKS_JSON'],
    message: 'must not be set in production',
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.DEV_LOGIN_USER_ID), {
    path: ['DEV_LOGIN_USER_ID'],
    message: 'must not be set in production',
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.SIGNUP_INVITE_CODES.length > 0, {
    path: ['SIGNUP_INVITE_CODES'],
    message: 'is required in production (invite-only signup)',
  })
  .refine((e) => dataRegionProblem(e) === null, {
    path: ['DATA_REGION_IN_EU'],
    message: 'must be set (true/false) in production',
  })
  .refine(
    (e) =>
      !e.PADDLE_CLIENT_TOKEN ||
      e.PADDLE_CLIENT_TOKEN.startsWith(e.PADDLE_ENV === 'sandbox' ? 'test_' : 'live_'),
    { path: ['PADDLE_CLIENT_TOKEN'], message: 'does not match PADDLE_ENV (test_… or live_…)' },
  )
  .refine((e) => e.NODE_ENV !== 'production' || e.ACTION_LINK_SECRET, {
    path: ['ACTION_LINK_SECRET'],
    message: 'is required in production',
  });

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const loadApiConfig = (source?: Record<string, string | undefined>): ApiConfig =>
  loadEnv(apiEnvSchema, source);
