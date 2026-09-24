import { readFileSync } from 'node:fs';
import { loadEnv } from '@noctiv/core';
import { z } from 'zod';

export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    WORKER_DATABASE_URL: z.url(),
    CREDENTIALS_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url X25519 public key'),
    /** File holding the private sealing key (0600, outside the repository and the database). */
    CREDENTIALS_PRIVATE_KEY_FILE: z.string().min(1),
    /** Development/tests only (GreenMail): plaintext, private hosts, self-signed certs. */
    MAIL_ALLOW_INSECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MAIL_ALLOW_INSECURE), {
    path: ['MAIL_ALLOW_INSECURE'],
    message: 'must not be true in production',
  });

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export const loadWorkerConfig = (source?: Record<string, string | undefined>): WorkerConfig =>
  loadEnv(workerEnvSchema, source);

export function loadSealingKeys(config: WorkerConfig): { publicKey: string; privateKey: string } {
  const privateKey = readFileSync(config.CREDENTIALS_PRIVATE_KEY_FILE, 'utf8').trim();
  return { publicKey: config.CREDENTIALS_PUBLIC_KEY, privateKey };
}
