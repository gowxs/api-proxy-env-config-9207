import type { Sql, TransactionSql } from 'postgres';
import { withTenant } from './tenant.ts';

export interface EnqueueArgs {
  tenantId: string;
  queue: string;
  payload?: Record<string, unknown>;
  /** At most one queued/running job per (queue, singletonKey). */
  singletonKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Adds a job inside the caller's withTenant() transaction, so the job exists
 * if and only if the surrounding work commits. Returns null when a job with
 * the same singleton key is already queued or running.
 */
export async function enqueue(tx: TransactionSql, args: EnqueueArgs): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    insert into public.jobs (tenant_id, queue, payload, singleton_key, run_at, max_attempts)
    values (${args.tenantId}, ${args.queue}, ${tx.json((args.payload ?? {}) as never)}, ${args.singletonKey ?? null},
            ${args.runAt ?? new Date()}, ${args.maxAttempts ?? 5})
    on conflict (queue, singleton_key) where singleton_key is not null and status in ('queued', 'running')
    do nothing
    returning id`;
  return rows[0]?.id ?? null;
}

export interface JobState {
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead';
  result: unknown;
  lastError: string | null;
}

export async function getJob(tx: TransactionSql, id: string): Promise<JobState | undefined> {
  const [row] = await tx<
    { status: JobState['status']; result: unknown; last_error: string | null }[]
  >`
    select status, result, last_error from public.jobs where id = ${id}`;
  return row ? { status: row.status, result: row.result, lastError: row.last_error } : undefined;
}

export interface Job {
  id: string;
  tenantId: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Throw from a handler to control retrying. Messages must not contain customer data. */
export class JobError extends Error {
  readonly retryable: boolean;
  readonly retryInSeconds: number | undefined;

  constructor(message: string, opts: { retryable: boolean; retryInSeconds?: number }) {
    super(message);
    this.name = 'JobError';
    this.retryable = opts.retryable;
    this.retryInSeconds = opts.retryInSeconds;
  }
}

export type JobHandler = (job: Job) => Promise<unknown>;

export interface JobRunnerOptions {
  sql: Sql;
  handlers: Record<string, JobHandler>;
  /** Jobs run at the same time (runOnce: jobs claimed per call). */
  batchSize?: number;
  /**
   * At most this many jobs of a queue at once, so slow work (a website
   * crawl) never takes every slot from mail fetching and sending.
   */
  queueLimits?: Record<string, number>;
  pollMs?: number;
  leaseSeconds?: number;
  onError?: (job: Job, error: unknown, outcome: string) => void;
}

/** Exponential backoff: 30 s, 60 s, 120 s … capped at one hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3_600);
}

/**
 * Polls the queue and runs handlers. A crashed worker's jobs become
 * claimable again when their lease expires; handlers must be idempotent.
 */
type ClaimedRow = {
  id: string;
  tenant_id: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

export class JobRunner {
  private readonly opts: Required<Omit<JobRunnerOptions, 'onError'>> &
    Pick<JobRunnerOptions, 'onError'>;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Jobs running now (job id → queue); start() keeps up to batchSize of them. */
  private readonly inFlight = new Map<string, { queue: string; done: Promise<void> }>();
  private claiming = false;

  constructor(opts: JobRunnerOptions) {
    this.opts = { batchSize: 5, pollMs: 1_000, leaseSeconds: 300, queueLimits: {}, ...opts };
  }

  private claim(queues: string[], limit: number) {
    return this.opts.sql<ClaimedRow[]>`
      select * from app.claim_jobs(${queues}::text[], ${limit}, ${this.opts.leaseSeconds})`;
  }

  private async run(row: ClaimedRow): Promise<void> {
    const job: Job = {
      id: row.id,
      tenantId: row.tenant_id,
      queue: row.queue,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
    try {
      const result = await this.opts.handlers[job.queue]!(job);
      await this.opts
        .sql`select app.finish_job(${job.id}, ${this.opts.sql.json((result ?? null) as never)})`;
    } catch (e) {
      const retryable = e instanceof JobError ? e.retryable : true;
      const delay =
        e instanceof JobError && e.retryInSeconds !== undefined
          ? e.retryInSeconds
          : backoffSeconds(job.attempts);
      const message = e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
      const [r] = await this.opts.sql<
        { fail_job: string }[]
      >`select app.fail_job(${job.id}, ${message}, ${delay}, ${retryable})`;
      this.opts.onError?.(job, e, r?.fail_job ?? 'unknown');
    }
  }

  /** Claims and runs one batch to completion; returns how many jobs ran (tests, scripts). */
  async runOnce(): Promise<number> {
    const jobs = await this.claim(Object.keys(this.opts.handlers), this.opts.batchSize);
    await Promise.all(jobs.map((row) => this.run(row)));
    return jobs.length;
  }

  /**
   * Fills free slots: queues with a limit are claimed on their own (up to
   * their remaining allowance), the rest together. Returns jobs started.
   */
  private async fill(): Promise<number> {
    if (this.claiming || !this.running) return 0;
    this.claiming = true;
    try {
      let started = 0;
      const busy = new Map<string, number>();
      for (const j of this.inFlight.values()) busy.set(j.queue, (busy.get(j.queue) ?? 0) + 1);
      const free = () => this.opts.batchSize - this.inFlight.size;
      const limited = Object.keys(this.opts.handlers).filter(
        (q) => this.opts.queueLimits[q] !== undefined,
      );
      const open = Object.keys(this.opts.handlers).filter(
        (q) => this.opts.queueLimits[q] === undefined,
      );
      const startAll = (rows: ClaimedRow[]) => {
        for (const row of rows) {
          const done = this.run(row).finally(() => {
            this.inFlight.delete(row.id);
            // A slot is free again: look for more work at once.
            if (this.running) void this.fill();
          });
          this.inFlight.set(row.id, { queue: row.queue, done });
          started++;
        }
      };
      if (free() > 0 && open.length) startAll(await this.claim(open, free()));
      for (const q of limited) {
        const n = Math.min(free(), this.opts.queueLimits[q]! - (busy.get(q) ?? 0));
        if (n > 0) startAll(await this.claim([q], n));
      }
      return started;
    } finally {
      this.claiming = false;
    }
  }

  start(): void {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      const n = await this.fill().catch(() => 0);
      // Keep draining without waiting while there is work and room.
      const again = n > 0 && this.inFlight.size < this.opts.batchSize;
      this.timer = setTimeout(() => void tick(), again ? 0 : this.opts.pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.inFlight.values()].map((j) => j.done));
  }
}

/** Convenience: enqueue in a fresh tenant transaction. */
export function enqueueFor(sql: Sql, args: EnqueueArgs): Promise<string | null> {
  return withTenant(sql, args.tenantId, (tx) => enqueue(tx, args));
}
