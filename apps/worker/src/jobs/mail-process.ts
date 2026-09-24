import { TrainingDataPolicyError } from '@noctiv/core';
import { JobError, type Job } from '@noctiv/db';
import { LlmError } from '@noctiv/llm';
import { processMessage, type PipelineDeps } from '../pipeline/process.ts';

/** Provider errors are retried by the queue; policy refusals are not. */
export function toLlmJobError(e: unknown): unknown {
  if (e instanceof TrainingDataPolicyError)
    return new JobError('free-tier provider refused customer data', { retryable: false });
  if (e instanceof LlmError) {
    // A daily quota comes back tomorrow; rate limits and outages in minutes.
    const retryInSeconds =
      e.kind === 'quota_exhausted'
        ? 3_600
        : e.retryAfterMs
          ? Math.ceil(e.retryAfterMs / 1000)
          : undefined;
    return new JobError(`model call failed: ${e.kind}`, {
      retryable: e.retryable || e.kind === 'quota_exhausted',
      retryInSeconds,
    });
  }
  return e;
}

/** mail.process */
export function mailProcessHandler(deps: PipelineDeps) {
  return async (job: Job) => {
    try {
      return await processMessage(deps, job.tenantId, String(job.payload.messageId));
    } catch (e) {
      throw toLlmJobError(e);
    }
  };
}
