import { z } from 'zod';

/**
 * Where this process runs (it handles email content in memory). Production
 * must state it; a non-EU region is logged as a warning at every start and
 * the admin is emailed, so a temporary exception is not forgotten.
 */
export const dataRegionEnv = {
  /** Free text, e.g. "northflank europe-west (GCP europe-west2, London)". */
  DATA_REGION: z.string().min(1).default('unspecified'),
  DATA_REGION_IN_EU: z.enum(['true', 'false']).optional(),
};

export interface DataRegionConfig {
  NODE_ENV: string;
  DATA_REGION: string;
  DATA_REGION_IN_EU?: 'true' | 'false' | undefined;
}

export function dataRegionProblem(e: DataRegionConfig): string | null {
  if (e.NODE_ENV === 'production' && e.DATA_REGION_IN_EU === undefined) {
    return 'DATA_REGION_IN_EU must be set (true/false) in production';
  }
  return null;
}

/** Warning text when this process runs outside the EU, else null. */
export function nonEuWarning(e: DataRegionConfig, service: string): string | null {
  if (e.DATA_REGION_IN_EU !== 'false') return null;
  return (
    `NON-EU REGION: the ${service} runs in "${e.DATA_REGION}", outside the EU. ` +
    'Allowed only for the temporary test deployment (founder decision 2026-09-24); ' +
    'move to an EU region before any real customer mailbox is connected.'
  );
}
