import { TrainingDataPolicyError } from '@noctiv/core';
import { JobError, type Job } from '@noctiv/db';
import { LlmError } from '@noctiv/llm';
import { processMessage, type PipelineDeps } from '../pipeline/process.ts';

/** mail.process: provider errors are retried by the queue; policy refusals are not. */
export function mailProcessHandler(deps: PipelineDeps) {
  return async (job: Job) => {
    try {
      return await processMessage(deps, job.tenantId, String(job.payload.messageId));
    } catch (e) {
      if (e instanceof TrainingDataPolicyError)
        throw new JobError('free-tier provider refused customer data', { retryable: false });
      if (e instanceof LlmError) {
        // A daily quota comes back tomorrow; rate limits and outages in minutes.
        const retryInSeconds =
          e.kind === 'quota_exhausted'
            ? 3_600
            : e.retryAfterMs
              ? Math.ceil(e.retryAfterMs / 1000)
              : undefined;
        throw new JobError(`model call failed: ${e.kind}`, {
          retryable: e.retryable || e.kind === 'quota_exhausted',
          retryInSeconds,
        });
      }
      throw e;
    }
  };
}
