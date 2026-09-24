import { JobError, type Job } from '@noctiv/db';
import { ingestSource, type IngestDeps } from '@noctiv/kb';

export function kbIngestHandler(deps: IngestDeps) {
  return async (job: Job) => {
    const outcome = await ingestSource(deps, job.tenantId, String(job.payload.sourceId));
    if (outcome.status === 'failed' && outcome.retryable)
      throw new JobError(`ingest failed: ${outcome.reason}`, { retryable: true });
    return outcome;
  };
}
