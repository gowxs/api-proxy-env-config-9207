import { randomUUID } from 'node:crypto';
import { type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { alertDeadJob } from '../src/ops/alerts.ts';
import { healthCheckHandler, scanHealthChecks } from '../src/ops/health.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const check = healthCheckHandler({ sql: worker, keys, allowInsecure: true });
const job = (tenantId: string, connectionId: string): Job => ({
  id: randomUUID(),
  tenantId,
  queue: QUEUES.healthCheck,
  payload: { connectionId },
  attempts: 1,
  maxAttempts: 1,
});
const checks = (connectionId: string) =>
  owner<{ imap_ok: boolean; smtp_ok: boolean; error_code: string | null }[]>`
    select imap_ok, smtp_ok, error_code from public.connection_health_checks
    where connection_id = ${connectionId} order by checked_at`;

describe('hourly health checks', () => {
  it('a healthy mailbox: IMAP and SMTP login recorded, last_ok_at refreshed', async () => {
    const t = await seedTenant(owner, 'ops-ok', { embeddingAxis: 110 });
    const c = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: GREENMAIL_USERS.shopA.address,
      password: GREENMAIL_USERS.shopA.password,
    });
    await owner`update public.email_connections set last_ok_at = null where id = ${c}`;
    expect(await check(job(t.tenantId, c))).toMatchObject({ ok: true });
    expect(await checks(c)).toEqual([{ imap_ok: true, smtp_ok: true, error_code: null }]);
    const [row] = await owner<
      { last_ok_at: Date | null }[]
    >`select last_ok_at from public.email_connections where id = ${c}`;
    expect(row!.last_ok_at).not.toBeNull();
  });

  it('a rejected login disconnects the mailbox and notifies owner and admin', async () => {
    const t = await seedTenant(owner, 'ops-auth', { embeddingAxis: 111 });
    const c = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: GREENMAIL_USERS.shopB.address,
      password: 'revoked-app-password',
    });
    expect(await check(job(t.tenantId, c))).toMatchObject({
      ok: false,
      code: 'AUTH_FAILED',
      disconnected: true,
    });
    const [row] = await owner<
      { status: string }[]
    >`select status from public.email_connections where id = ${c}`;
    expect(row!.status).toBe('disconnected');
    const n =
      await owner`select channel from public.notifications where tenant_id = ${t.tenantId} and kind = 'mailbox_disconnected'`;
    expect(n).toHaveLength(2);
  });

  it('repeated network failures alert the admin once, without disconnecting', async () => {
    const t = await seedTenant(owner, 'ops-down', { embeddingAxis: 112 });
    const c = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: GREENMAIL_USERS.shopA.address,
      password: GREENMAIL_USERS.shopA.password,
    });
    // Nothing listens on port 1: connection refused.
    await owner`update public.email_connections set imap_port = 1 where id = ${c}`;
    for (let i = 0; i < 4; i++) {
      expect(await check(job(t.tenantId, c))).toMatchObject({ ok: false, code: 'WRONG_PORT' });
    }
    const [row] = await owner<{ status: string; last_error_code: string }[]>`
      select status, last_error_code from public.email_connections where id = ${c}`;
    expect(row).toEqual({ status: 'connected', last_error_code: 'WRONG_PORT' });
    const alerts = await owner<{ channel: string }[]>`
      select channel from public.notifications where tenant_id = ${t.tenantId} and kind = 'mailbox_unhealthy'`;
    expect(alerts).toEqual([{ channel: 'email_admin' }]);
  });

  it('the scan queues one check per connected mailbox (singleton)', async () => {
    const t = await seedTenant(owner, 'ops-scan', { embeddingAxis: 113 });
    await scanHealthChecks(worker);
    await scanHealthChecks(worker);
    const jobs = await owner<{ payload: { connectionId: string } }[]>`
      select payload from public.jobs where tenant_id = ${t.tenantId} and queue = ${QUEUES.healthCheck}`;
    expect(jobs.map((j) => j.payload.connectionId)).toEqual([t.connectionId]);
  });
});

describe('maintenance and alerts', () => {
  it('budget state returns to ok on a new day; old health checks are removed', async () => {
    const t = await seedTenant(owner, 'ops-budget', { embeddingAxis: 114 });
    await owner`update public.tenants set budget_state = 'halted' where id = ${t.tenantId}`;
    await owner`delete from public.usage_daily where tenant_id = ${t.tenantId}`;
    await owner`insert into public.usage_daily (tenant_id, day, tokens_in) values (${t.tenantId}, current_date - 1, 999999)`;
    await owner`insert into public.connection_health_checks (tenant_id, connection_id, checked_at, imap_ok, smtp_ok)
                values (${t.tenantId}, ${t.connectionId}, now() - interval '31 days', true, true)`;
    const [r] = await worker<
      { budgets_reset: number; health_checks_deleted: number }[]
    >`select * from app.hourly_maintenance()`;
    expect(r!.budgets_reset).toBeGreaterThanOrEqual(1);
    expect(r!.health_checks_deleted).toBeGreaterThanOrEqual(1);
    const [row] = await owner<
      { budget_state: string }[]
    >`select budget_state from public.tenants where id = ${t.tenantId}`;
    expect(row!.budget_state).toBe('ok');
  });

  it('a halted tenant that is still over budget today stays halted', async () => {
    const t = await seedTenant(owner, 'ops-budget2', { embeddingAxis: 115 });
    await owner`update public.tenants set budget_state = 'halted' where id = ${t.tenantId}`;
    await owner`update public.usage_daily set tokens_in = 999999, day = (now() at time zone 'utc')::date where tenant_id = ${t.tenantId}`;
    await worker`select * from app.hourly_maintenance()`;
    const [row] = await owner<
      { budget_state: string }[]
    >`select budget_state from public.tenants where id = ${t.tenantId}`;
    expect(row!.budget_state).toBe('halted');
  });

  it('a dead job alerts the admin once per queue and day, without error text', async () => {
    const t = await seedTenant(owner, 'ops-dead', { embeddingAxis: 116 });
    const j: Job = {
      id: randomUUID(),
      tenantId: t.tenantId,
      queue: 'mail.send',
      payload: {},
      attempts: 5,
      maxAttempts: 5,
    };
    await alertDeadJob(worker, j, new Error('customer anna@example.test said something'));
    await alertDeadJob(worker, { ...j, id: randomUUID() }, new Error('again'));
    const n = await owner<{ channel: string; payload: Record<string, unknown> }[]>`
      select channel, payload from public.notifications where tenant_id = ${t.tenantId} and kind = 'job_dead'`;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      channel: 'email_admin',
      payload: { queue: 'mail.send', jobId: j.id, errorKind: 'Error' },
    });
    expect(JSON.stringify(n)).not.toContain('anna@');
  });
});
