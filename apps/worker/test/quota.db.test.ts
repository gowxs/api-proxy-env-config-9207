import { seedTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { scanQuotaWaits } from '../src/ops/quota.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const QUOTA = 'model call failed: quota_exhausted';

async function waitingJob(tenantId: string, minutesAgo: number, attempts = 1) {
  const [j] = await owner<{ id: string }[]>`
    insert into public.jobs (tenant_id, queue, payload, status, attempts, max_attempts, last_error, created_at)
    values (${tenantId}, 'mail.process', '{}'::jsonb, 'queued', ${attempts}, 5, ${QUOTA},
            now() - make_interval(mins => ${minutesAgo}))
    returning id`;
  return j!.id;
}
const notes = (tenantId: string) =>
  owner<{ channel: string; kind: string; payload: Record<string, unknown> }[]>`
    select channel, kind, payload from public.notifications
    where tenant_id = ${tenantId} and kind in ('quota_wait', 'replies_delayed') order by channel`;

describe('replies waiting on the AI quota (D5)', () => {
  it('nothing before 30 minutes', async () => {
    const t = await seedTenant(owner, 'quota-fresh', { embeddingAxis: 171 });
    await waitingJob(t.tenantId, 10);
    await scanQuotaWaits(worker);
    expect(await notes(t.tenantId)).toEqual([]);
  });

  it('after 30 minutes the admin is told once; the owner only after 4 hours', async () => {
    const t = await seedTenant(owner, 'quota-wait', { embeddingAxis: 172 });
    await waitingJob(t.tenantId, 45);
    await waitingJob(t.tenantId, 5);
    await scanQuotaWaits(worker);
    await scanQuotaWaits(worker);
    const n = await notes(t.tenantId);
    expect(n.map((x) => `${x.channel}:${x.kind}`)).toEqual(['email_admin:quota_wait']);
    expect(n[0]!.payload).toMatchObject({ waiting: 2 });

    await waitingJob(t.tenantId, 5 * 60);
    await scanQuotaWaits(worker);
    expect((await notes(t.tenantId)).map((x) => `${x.channel}:${x.kind}`)).toEqual([
      'email_admin:quota_wait',
      'email_owner:replies_delayed',
    ]);
  });

  it('a quota wait does not use up the retries (up to 26 hours)', async () => {
    const t = await seedTenant(owner, 'quota-retries', { embeddingAxis: 173 });
    const fresh = await waitingJob(t.tenantId, 60 * 5, 5);
    const old = await waitingJob(t.tenantId, 60 * 27, 5);
    const other = await waitingJob(t.tenantId, 10, 5);
    const fail = async (id: string, error: string) =>
      (await worker<{ s: string }[]>`select app.fail_job(${id}, ${error}, 3600, true) as s`)[0]!.s;
    expect(await fail(fresh, QUOTA)).toBe('queued');
    expect(await fail(old, QUOTA)).toBe('dead');
    expect(await fail(other, 'model call failed: unavailable')).toBe('dead');
  });
});
