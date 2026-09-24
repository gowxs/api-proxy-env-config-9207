import { withTenant, type Job } from '@noctiv/db';
import type { Sql } from 'postgres';

/**
 * A job that used up its retries alerts the admin (PLAN.md §4.7). At most
 * one alert per tenant, queue and day; the payload names the job but never
 * carries its error text (which could quote customer data) — the details
 * stay in public.jobs.last_error.
 */
export async function alertDeadJob(sql: Sql, job: Job, error: unknown): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const kind = error instanceof Error ? error.name : 'Error';
  await withTenant(
    sql,
    job.tenantId,
    (tx) => tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${job.tenantId}, 'email_admin', 'job_dead', ${`job_dead:${job.queue}:${day}`},
              ${tx.json({ queue: job.queue, jobId: job.id, attempts: job.attempts, errorKind: kind })})
      on conflict (tenant_id, dedupe_key) do nothing`,
  );
}
