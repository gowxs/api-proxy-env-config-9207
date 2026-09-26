/**
 * Creates or updates the Northflank cron job `db-backup` (PLAN.md §25,
 * docs/backup-restore.md): the image from docker/backup/Dockerfile on this
 * branch, nightly at 01:30 UTC (03:30/04:30 Riga), one run at a time.
 *   node --env-file=.env scripts/northflank-backup-job.ts
 * Needs NORTHFLANK_API_TOKEN and the job's secrets: BACKUP_DATABASE_URL,
 * BACKUP_AGE_RECIPIENT, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET (optionally R2_JURISDICTION, default "eu"). The secrets go to
 * Northflank's runtime environment only; nothing is printed.
 */
const PROJECT = 'noctiv';
const env = process.env;
const REQUIRED = [
  'NORTHFLANK_API_TOKEN',
  'BACKUP_DATABASE_URL',
  'BACKUP_AGE_RECIPIENT',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
] as const;
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
if (!env.BACKUP_AGE_RECIPIENT!.startsWith('age1'))
  throw new Error('BACKUP_AGE_RECIPIENT must be an age public key (age1…), never the private key');

const body = {
  name: 'db-backup',
  description: 'Nightly encrypted pg_dump to Cloudflare R2 (docs/backup-restore.md)',
  billing: { buildPlan: 'nf-compute-400-16', deploymentPlan: 'nf-compute-20' },
  deployment: {
    vcs: {
      projectUrl: 'https://github.com/gowxs/api-proxy-env-config-9207',
      projectType: 'github',
      accountLogin: 'gowxs',
      projectBranch: 'claude/noctiv-phase-1-plan-09rtlv',
    },
    docker: { configType: 'default' },
  },
  buildSettings: {
    dockerfile: {
      buildEngine: 'kaniko',
      dockerFilePath: '/docker/backup/Dockerfile',
      dockerWorkDir: '/',
    },
  },
  // Rebuild only when the backup image changes.
  buildConfiguration: { pathIgnoreRules: ['docker/backup/**'], isAllowList: true },
  runtimeEnvironment: {
    BACKUP_DATABASE_URL: env.BACKUP_DATABASE_URL,
    BACKUP_AGE_RECIPIENT: env.BACKUP_AGE_RECIPIENT,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET,
    R2_JURISDICTION: env.R2_JURISDICTION ?? 'eu',
    BACKUP_RETENTION_DAYS: '30',
  },
  schedule: '30 1 * * *',
  concurrencyPolicy: 'forbid',
  suspended: false,
  backoffLimit: 1,
  activeDeadlineSeconds: 3600,
  runOnSourceChange: 'never',
};

const res = await fetch(`https://api.northflank.com/v1/projects/${PROJECT}/jobs/cron`, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${env.NORTHFLANK_API_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});
const json = (await res.json()) as { data?: { id?: string }; error?: { message?: string } };
if (!res.ok) throw new Error(`Northflank ${res.status}: ${json.error?.message ?? 'error'}`);
console.log(`db-backup job ready (${json.data?.id ?? 'db-backup'}); next run 01:30 UTC.`);
console.log('Start one run now from the Northflank job page ("Run job") and check its log.');
