import type { Job } from '@noctiv/db';
import { generateFollowup } from '../followups/followup.ts';
import type { PipelineDeps } from '../pipeline/process.ts';
import { toLlmJobError } from './mail-process.ts';

/** followup.generate */
export function followupHandler(deps: PipelineDeps) {
  return async (job: Job) => {
    try {
      return await generateFollowup(deps, job.tenantId, String(job.payload.threadId));
    } catch (e) {
      throw toLlmJobError(e);
    }
  };
}
