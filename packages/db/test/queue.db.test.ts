import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  backoffSeconds,
  enqueue,
  enqueueFor,
  getJob,
  JobError,
  JobRunner,
  withTenant,
} from '../src/index.ts';
import { seedTenant, type SeededTenant } from '../src/testing.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
const api = postgres(inject('apiDatabaseUrl'), { max: 1, onnotice: () => {} });
let T: SeededTenant;

beforeAll(async () => {
  T = await seedTenant(owner, 'queue', { embeddingAxis: 20 });
});
afterAll(() => Promise.all([owner.end(), worker.end(), api.end()]));

const q = () => `test.${randomUUID().slice(0, 8)}`;

describe('job queue', () => {
  it('a slow job does not hold up others; a queue limit caps its share', async () => {
    const slow = q();
    const fast = q();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slowStarted = 0;
    const done: string[] = [];
    const runner = new JobRunner({
      sql: worker,
      pollMs: 50,
      batchSize: 4,
      queueLimits: { [slow]: 1 },
      handlers: {
        [slow]: async () => {
          slowStarted++;
          await gate;
          done.push('slow');
        },
        [fast]: async () => void done.push('fast'),
      },
    });
    await enqueueFor(worker, { tenantId: T.tenantId, queue: slow });
    await enqueueFor(worker, { tenantId: T.tenantId, queue: slow });
    runner.start();
    await new Promise((r) => setTimeout(r, 300));
    // The crawl-like job is still running; a new fast job runs anyway.
    await enqueueFor(worker, { tenantId: T.tenantId, queue: fast });
    for (let i = 0; i < 40 && !done.includes('fast'); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(done).toEqual(['fast']);
    expect(slowStarted).toBe(1);
    release();
    for (let i = 0; i < 40 && done.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    await runner.stop();
    expect(done).toEqual(['fast', 'slow', 'slow']);
  });

  it('runs a job once and stores its result', async () => {
    const queue = q();
    const id = await enqueueFor(worker, { tenantId: T.tenantId, queue, payload: { n: 2 } });
    const seen: unknown[] = [];
    const runner = new JobRunner({
      sql: worker,
      handlers: { [queue]: async (job) => (seen.push(job.payload), { doubled: 4 }) },
    });
    expect(await runner.runOnce()).toBe(1);
    expect(await runner.runOnce()).toBe(0);
    expect(seen).toEqual([{ n: 2 }]);
    expect(await withTenant(worker, T.tenantId, (tx) => getJob(tx, id!))).toEqual({
      status: 'done',
      result: { doubled: 4 },
      lastError: null,
    });
  });

  it('keeps one queued job per singleton key', async () => {
    const queue = q();
    const a = await enqueueFor(worker, { tenantId: T.tenantId, queue, singletonKey: 'mailbox-1' });
    const b = await enqueueFor(worker, { tenantId: T.tenantId, queue, singletonKey: 'mailbox-1' });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it('retries with backoff, then marks the job dead', async () => {
    const queue = q();
    const id = (await enqueueFor(worker, { tenantId: T.tenantId, queue, maxAttempts: 2 }))!;
    const failing = new JobRunner({
      sql: worker,
      handlers: {
        [queue]: async () => {
          throw new JobError('upstream unavailable', { retryable: true, retryInSeconds: 0 });
        },
      },
    });
    await failing.runOnce();
    expect((await withTenant(worker, T.tenantId, (tx) => getJob(tx, id)))!.status).toBe('queued');
    await failing.runOnce();
    expect(await withTenant(worker, T.tenantId, (tx) => getJob(tx, id))).toMatchObject({
      status: 'dead',
      lastError: 'JobError: upstream unavailable',
    });
  });

  it('non-retryable errors are dead immediately', async () => {
    const queue = q();
    const id = (await enqueueFor(worker, { tenantId: T.tenantId, queue }))!;
    await new JobRunner({
      sql: worker,
      handlers: {
        [queue]: async () => {
          throw new JobError('bad input', { retryable: false });
        },
      },
    }).runOnce();
    expect((await withTenant(worker, T.tenantId, (tx) => getJob(tx, id)))!.status).toBe('dead');
  });

  it("a crashed worker's job is claimed again after its lease expires", async () => {
    const queue = q();
    await enqueueFor(worker, { tenantId: T.tenantId, queue });
    const claimed = await worker`select * from app.claim_jobs(${[queue]}::text[], 1, 5)`;
    expect(claimed).toHaveLength(1);
    expect(await worker`select * from app.claim_jobs(${[queue]}::text[], 1, 5)`).toHaveLength(0);
    await owner`update public.jobs set locked_until = now() - interval '1 second' where queue = ${queue}`;
    const again = await worker<
      { attempts: number }[]
    >`select * from app.claim_jobs(${[queue]}::text[], 1, 5)`;
    expect(again.map((j) => j.attempts)).toEqual([2]);
  });

  it('jobs in the future wait', async () => {
    const queue = q();
    await enqueueFor(worker, { tenantId: T.tenantId, queue, runAt: new Date(Date.now() + 60_000) });
    expect(
      await new JobRunner({ sql: worker, handlers: { [queue]: async () => null } }).runOnce(),
    ).toBe(0);
  });

  it('the API can enqueue and read its tenant’s jobs but cannot claim or run them', async () => {
    const queue = q();
    const id = await withTenant(api, T.tenantId, (tx) =>
      enqueue(tx, { tenantId: T.tenantId, queue }),
    );
    expect(await withTenant(api, T.tenantId, (tx) => getJob(tx, id!))).toMatchObject({
      status: 'queued',
    });
    await expect(api`select * from app.claim_jobs(${[queue]}::text[], 1, 5)`).rejects.toMatchObject(
      { code: '42501' },
    );
  });

  it('backoff doubles and is capped at one hour', () => {
    expect([1, 2, 3, 10, 20].map(backoffSeconds)).toEqual([30, 60, 120, 3_600, 3_600]);
  });
});
