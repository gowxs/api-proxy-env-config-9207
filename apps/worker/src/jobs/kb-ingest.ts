import { JobError, type Job } from '@noctiv/db';
import { ingestSource, type IngestDeps, type IngestOutcome } from '@noctiv/kb';

/**
 * Seconds until the Gemini free tier's daily quota resets (midnight Pacific
 * time), plus a margin. Retrying earlier only spends an attempt.
 */
export function secondsUntilDailyQuotaReset(now = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  ) as { hour: number; minute: number; second: number };
  const sinceMidnight = parts.hour * 3_600 + parts.minute * 60 + parts.second;
  return 86_400 - sinceMidnight + 600;
}

/** How long to wait before the next attempt, by cause. */
export function ingestRetryDelaySeconds(
  outcome: Extract<IngestOutcome, { status: 'failed' }>,
  now = new Date(),
) {
  if (outcome.detail === 'quota_exhausted') return secondsUntilDailyQuotaReset(now);
  if (outcome.reason === 'budget_halted') return 3_600;
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
      const why = outcome.diagnostic ? ` [${outcome.diagnostic}]` : '';
      throw new JobError(`ingest failed: ${cause}${why}`, {
        retryable: true,
        retryInSeconds: ingestRetryDelaySeconds(outcome),
      });
    }
    return outcome;
  };
}
