import { JobError, type Job } from '@noctiv/db';
import { ingestSource, type IngestDeps, type IngestOutcome } from '@noctiv/kb';

/** How long to wait before the next attempt, by cause. */
export function ingestRetryDelaySeconds(outcome: Extract<IngestOutcome, { status: 'failed' }>) {
  if (outcome.reason === 'budget_halted' || outcome.detail === 'quota_exhausted') return 3_600;
  if (outcome.detail === 'rate_limited') return 120;
  return undefined; // default backoff
}

export function kbIngestHandler(deps: IngestDeps) {
  return async (job: Job) => {
    const outcome = await ingestSource(deps, job.tenantId, String(job.payload.sourceId), {
      finalAttempt: job.attempts >= job.maxAttempts,
    });
    if (outcome.status === 'failed' && outcome.retryable) {
      const cause = outcome.detail ? `${outcome.reason}:${outcome.detail}` : outcome.reason;
      throw new JobError(`ingest failed: ${cause}`, {
        retryable: true,
        retryInSeconds: ingestRetryDelaySeconds(outcome),
      });
    }
    return outcome;
  };
}
