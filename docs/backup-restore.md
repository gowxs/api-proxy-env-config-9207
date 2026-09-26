# Database backups and restore

Noctiv's database (Supabase project `bdbztonmdfnqqlonvywn`, Frankfurt) is dumped every night, encrypted, and kept for 30 days in Cloudflare R2.

- **What:** `pg_dump` of the Noctiv schemas `public`, `app`, `marketing` and `supabase_migrations`, with data, grants and row-level security policies. Also the sign-in accounts (`auth.users`, `auth.identities`), as data only.
- **When:** 01:30 UTC every night (03:30 Riga in winter, 04:30 in summer). This is the Northflank cron job `db-backup`, built from `docker/backup/`.
- **Encryption:** [age](https://age-encryption.org), to the operator's public key. The private key never goes to Northflank, R2 or the repository. Without it, a backup cannot be read. That also means **lose the key and every backup is lost with it.**
- **Where:** R2 bucket `noctiv-db-backups` (EU jurisdiction), at `postgres/noctiv-<UTC timestamp>.tar.age`.
- **Retention:** 30 days. The bucket's lifecycle rule deletes older backups, and the job also prunes them itself.
- **Inside the file:** a tar archive holding `MANIFEST` (time, versions, latest migration, checksums), `noctiv.dump` and `auth.dump`.

Mailbox passwords are in the dump only in sealed form. The key that opens them (`CREDENTIALS_PRIVATE_KEY`) is kept only in Northflank and is not part of the backup. Keep a copy of it next to the age key. Without it, every customer has to reconnect their mailbox after a restore.

## One-time setup (operator)

1. **Enable R2.** In the Cloudflare dashboard, open _R2 Object Storage_ and enable it. The free tier covers this: 10 GB-month of storage, and each backup is currently well under 1 MB.
2. **Create the bucket.** Choose _Create bucket_, name it `noctiv-db-backups`, and under _Location_ set _Specify jurisdiction_ to **European Union (EU)**.
   - Then open _Settings → Object lifecycle rules → Add rule_: prefix `postgres/`, "Delete objects 30 days after upload".
3. **Create an R2 API token.** Go to _R2 → Manage API tokens → Create API token_ and set:
   - Permission: **Object Read & Write**.
   - Scope: **Apply to specific buckets only**, with `noctiv-db-backups` selected.
   - TTL: forever.

   Put the values in the local `.env` (never in the repository):

   ```
   R2_ACCOUNT_ID=<the account id shown on the R2 page>
   R2_ACCESS_KEY_ID=<Access Key ID>
   R2_SECRET_ACCESS_KEY=<Secret Access Key>
   R2_BUCKET=noctiv-db-backups
   ```

4. **Create the encryption key on your own computer**, not on a server.
   1. Install age: `brew install age`, `apt install age`, or the Windows release from GitHub.
   2. Run `age-keygen -o noctiv-backup-key.txt`.
   3. Store `noctiv-backup-key.txt` in your password manager, and keep a second copy offline (for example a USB stick in a drawer).
   4. Put only the public key (the line starting with `age1…`, also printed by `age-keygen -y noctiv-backup-key.txt`) in `.env`:

   ```
   BACKUP_AGE_RECIPIENT=age1…
   ```

5. **Create the read-only backup role.** In the Supabase SQL editor for the project, choose a long random password and run:

   ```sql
   create role noctiv_backup with login bypassrls password '<long random password>';
   grant pg_read_all_data to noctiv_backup;
   ```

   `pg_read_all_data` makes the role read-only. It needs `bypassrls` because every Noctiv table forces row-level security, and a dump must see every tenant's rows.

   Then add the connection string to `.env` (session pooler, port 5432):

   ```
   BACKUP_DATABASE_URL=postgres://noctiv_backup.bdbztonmdfnqqlonvywn:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```

6. **Create the job.** Run `node --env-file=.env scripts/northflank-backup-job.ts`. It creates or updates the Northflank cron job `db-backup` with these secrets.
7. **Check the first run.** Start one run from the job's page in Northflank ("Run job"). The log ends with `backup: uploaded … bytes` and `backup: done`, and the object appears in the bucket.
8. **Get told about failures.** In Northflank's team settings, add a notification integration (e-mail to the admin address) for failed job runs, so a failed backup doesn't go unnoticed.

## Restore

Restore into an **empty** Supabase project. Never restore over a database that is still in use: recover rows from a restored copy instead (see the last section).

1. **Stop writes.** In Northflank, scale the `api` and `worker` services to 0 instances. Customers see the app as unavailable; incoming e-mails wait in their mailboxes and are fetched later.
2. **Pick a backup.** With the R2 values from `.env`:

   ```sh
   export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
   R2="--endpoint-url https://$R2_ACCOUNT_ID.eu.r2.cloudflarestorage.com"
   aws $R2 s3 ls s3://noctiv-db-backups/postgres/
   aws $R2 s3 cp s3://noctiv-db-backups/postgres/noctiv-<timestamp>.tar.age .
   ```

3. **Create a new Supabase project** in Frankfurt (`eu-central-1`) and note its database password.
4. **Restore.** This needs `pg_restore`/`psql` 17, `age` and `tar`, for example inside `docker run -it --rm -v "$PWD:/w" -w /w supabase/postgres:17.6.1.175 bash` with `age` added.

   ```sh
   scripts/restore-backup.sh noctiv-<timestamp>.tar.age noctiv-backup-key.txt \
     "postgres://postgres.<new-ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
   ```

   The script does the following, in order:
   1. Decrypts the file and checks the checksums in `MANIFEST`.
   2. Refuses a database that already has Noctiv tables.
   3. Creates the extensions and the missing runtime roles (without login).
   4. Restores the schemas and data, then the sign-in accounts, then the indexes, constraints, policies and grants.
   5. Prints the number of tenants and messages and the latest migration.

5. **Bring the code level with the backup.** Run `MIGRATION_DATABASE_URL=<same URL> node packages/db/scripts/migrate.ts`. It applies any migration newer than the backup, and prints "Database is up to date" otherwise.
6. **Reconnect the services.**
   1. Give the runtime roles logins:
      ```sql
      alter role noctiv_api with login password '<new>';
      alter role noctiv_worker with login password '<new>';
      ```
      Then create `noctiv_backup` again, as in setup step 5.
   2. In Northflank, update `API_DATABASE_URL` (api) and `WORKER_DATABASE_URL` (worker). Update the Supabase URL and keys on the API and in the web app's Cloudflare settings.
   3. In the new project's Auth settings, set the site URL and redirect URLs (`https://app.noctiv.io`) and SMTP (Brevo). Then run `node --env-file=.env scripts/brand-auth-emails.ts` with the new `SUPABASE_PROJECT_REF`.
   4. Customers sign in again: the new project signs sessions with a new key.
7. **Start again.** Scale `api` and `worker` back to 1, then check the following:
   - `https://app.noctiv.io/api/healthz/worker` returns `"status":"ok"` within a few minutes.
   - The mailbox health checks run.
   - A test e-mail to a test mailbox gets a draft.

**Tested.** On 2026-09-26 the full cycle ran locally against `supabase/postgres:17.6.1.175`: seeded data, backup, encrypted upload to a local S3, download, restore into a fresh instance. It gave the same row counts, forced RLS on every table, all 56 policies, and the runtime role seeing only its tenant's rows.

## Monthly restore drill (10 minutes, no customer impact)

Download the newest backup and restore it into a local `supabase/postgres:17.6.1.175` container (`docker compose -f docker/compose.dev.yml up -d db` on a fresh volume), using the same script and your age key. Compare the tenant and message counts with production. Then delete the container volume (`down -v`) and the decrypted files.

## Getting rows back without a full restore

To recover rows deleted by mistake:

1. Restore the backup from before the mistake into a scratch Supabase project, or the local container.
2. Copy the affected rows back with `psql` (`\copy … to` from the scratch database, `\copy … from` into production), as the `postgres` role, inside a transaction.
3. Delete the scratch project afterwards: it holds customer data.
