import { enqueue, getJob, withTenant } from '@noctiv/db';
import type { AppDeps } from '../app.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks the worker (only it can open sealed credentials) and waits briefly for the answer. */
export async function runJob(
  deps: Pick<AppDeps, 'sql' | 'connectionTestWaitMs'>,
  tenantId: string,
  queue: string,
): Promise<{ done: boolean; result?: unknown }> {
  const jobId = await withTenant(deps.sql, tenantId, (tx) =>
    enqueue(tx, { tenantId, queue, payload: {}, maxAttempts: 1 }),
  );
  const deadline = Date.now() + deps.connectionTestWaitMs;
  while (Date.now() < deadline) {
    const job = await withTenant(deps.sql, tenantId, (tx) => getJob(tx, jobId!));
    if (job?.status === 'done') return { done: true, result: job.result };
    if (job?.status === 'dead' || job?.status === 'failed')
      return { done: true, result: { ok: false, code: 'UNAVAILABLE' } };
    await sleep(250);
  }
  return { done: false };
}
