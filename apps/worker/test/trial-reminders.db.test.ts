import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 2, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const queue = async () =>
  (await worker<{ n: number }[]>`select app.queue_trial_reminders() as n`)[0]!.n;
const reminders = (t: SeededTenant) =>
  owner<{ dedupe_key: string; channel: string; payload: Record<string, unknown> }[]>`
    select dedupe_key, channel, payload from public.notifications
    where tenant_id = ${t.tenantId} and kind = 'trial_ending' order by created_at, dedupe_key`;
const endsIn = (t: SeededTenant, interval: string) =>
  owner`update public.tenants set trial_ends_at = now() + ${interval}::interval where id = ${t.tenantId}`;

describe('trial reminder e-mails', () => {
  let A: SeededTenant;
  let B: SeededTenant;
  let C: SeededTenant;
  beforeAll(async () => {
    // Other tests' tenants must not interfere: park them outside every window.
    await owner`update public.tenants set trial_ends_at = now() + interval '30 days'`;
    A = await seedTenant(owner, 'trial-a', { embeddingAxis: 120 });
    B = await seedTenant(owner, 'trial-b', { embeddingAxis: 121 });
    C = await seedTenant(owner, 'trial-c', { embeddingAxis: 122 });
    await owner`update public.tenants set timezone = 'Europe/Riga' where id = ${A.tenantId}`;
  });

  it('nothing is queued while more than 7 days are left', async () => {
    expect(await queue()).toBe(0);
    expect(await reminders(A)).toHaveLength(0);
  });

  it('queues one owner e-mail 7 days before the end, only once', async () => {
    await endsIn(A, '6 days 23 hours');
    expect(await queue()).toBe(1);
    expect(await queue()).toBe(0);
    const [r] = await reminders(A);
    expect(r).toMatchObject({
      channel: 'email_owner',
      payload: { stage: 7, daysLeft: 7, timezone: 'Europe/Riga' },
    });
    expect(r!.dedupe_key).toMatch(/^trial_ending_7:/);
  });

  it('queues the last-day e-mail 1 day before the end', async () => {
    const [row] = await owner<{ ends: Date }[]>`
      update public.tenants set trial_ends_at = trial_ends_at - interval '6 days'
      where id = ${A.tenantId} returning trial_ends_at as ends`;
    expect(row!.ends.getTime() - Date.now()).toBeLessThan(86_400_000);
    // The end date moved, so a new 1-day reminder; no second 7-day one.
    expect(await queue()).toBe(1);
    const keys = (await reminders(A)).map((r) => r.dedupe_key.split(':')[0]);
    expect(keys.sort()).toEqual(['trial_ending_1', 'trial_ending_7']);
    expect(await queue()).toBe(0);
  });

  it('a trial first seen inside its last day only gets the 1-day e-mail', async () => {
    await endsIn(B, '5 hours');
    await queue();
    expect((await reminders(B)).map((r) => r.payload.stage)).toEqual([1]);
  });

  it('no reminders after the end, or for subscribed and comped businesses', async () => {
    await endsIn(C, '-1 hour');
    expect(await queue()).toBe(0);
    await endsIn(C, '3 days');
    await owner`update public.tenants set billing_status = 'active' where id = ${C.tenantId}`;
    expect(await queue()).toBe(0);
    await owner`update public.tenants set billing_status = 'comped' where id = ${C.tenantId}`;
    expect(await queue()).toBe(0);
    expect(await reminders(C)).toHaveLength(0);
  });
});
