import { readFileSync } from 'node:fs';
import { dataRegionEnv, dataRegionProblem, loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    WORKER_DATABASE_URL: z.url(),
    CREDENTIALS_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url X25519 public key'),
    /** File holding the private sealing key (0600, outside the repository and the database). */
    CREDENTIALS_PRIVATE_KEY_FILE: z.string().min(1).optional(),
    /** Or the key itself, from the host's secret store (container platforms without secret files). */
    CREDENTIALS_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    /**
     * Production without the system mailer (temporary, until Brevo credentials exist):
     * notifications stay queued and are sent once the mailer is configured.
     */
    SYSTEM_MAILER_PENDING: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    ...dataRegionEnv,
    /** Development/tests only (GreenMail): plaintext, private hosts, self-signed certs. */
    MAIL_ALLOW_INSECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** System mailer for owner/admin notifications (Brevo in production, GreenMail locally). */
    SYSTEM_SMTP_HOST: z.string().min(1).optional(),
    SYSTEM_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SYSTEM_SMTP_SECURITY: z.enum(['tls', 'starttls', 'none']).default('starttls'),
    SYSTEM_SMTP_USER: z.string().optional(),
    SYSTEM_SMTP_PASS: z.string().optional(),
    SYSTEM_MAIL_FROM: z.string().min(3).default('Noctiv <notify@noctiv.io>'),
    /** Admin alerts (disconnects, budget). Without it admin notifications fail as 'no_recipient'. */
    ADMIN_EMAIL: z.email().optional(),
    /** Public base URLs used in notification links. */
    PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    /** Shared with the API: signs Approve / Reject links. */
    ACTION_LINK_SECRET: z.string().min(32).optional(),
    NOTIFY_POLL_MS: z.coerce.number().int().min(1_000).default(15_000),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MAIL_ALLOW_INSECURE), {
    path: ['MAIL_ALLOW_INSECURE'],
    message: 'must not be true in production',
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.SYSTEM_SMTP_SECURITY === 'none'), {
    path: ['SYSTEM_SMTP_SECURITY'],
    message: 'must be tls or starttls in production',
  })
  .refine(
    (e) =>
      e.NODE_ENV !== 'production' ||
      ((e.SYSTEM_SMTP_HOST || e.SYSTEM_MAILER_PENDING) && e.ACTION_LINK_SECRET && e.ADMIN_EMAIL),
    {
      path: ['SYSTEM_SMTP_HOST'],
      message: 'SYSTEM_SMTP_HOST, ACTION_LINK_SECRET and ADMIN_EMAIL are required in production',
    },
  )
  .refine((e) => Boolean(e.CREDENTIALS_PRIVATE_KEY_FILE) !== Boolean(e.CREDENTIALS_PRIVATE_KEY), {
    path: ['CREDENTIALS_PRIVATE_KEY'],
    message: 'set exactly one of CREDENTIALS_PRIVATE_KEY_FILE or CREDENTIALS_PRIVATE_KEY',
  })
  .refine((e) => dataRegionProblem(e) === null, {
    path: ['DATA_REGION_IN_EU'],
    message: 'must be set (true/false) in production',
  });

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export const loadWorkerConfig = (source?: Record<string, string | undefined>): WorkerConfig =>
  loadEnv(workerEnvSchema, source);

export function loadSealingKeys(config: WorkerConfig): { publicKey: string; privateKey: string } {
  const privateKey =
    config.CREDENTIALS_PRIVATE_KEY ??
    readFileSync(config.CREDENTIALS_PRIVATE_KEY_FILE!, 'utf8').trim();
  return { publicKey: config.CREDENTIALS_PUBLIC_KEY, privateKey };
}
