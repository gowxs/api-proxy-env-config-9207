#!/bin/sh
# Noctiv nightly backup: dump → encrypt (age) → upload (R2) → prune (30 days).
# Nothing unencrypted leaves the container; the private key never enters it.
#
# Environment (Northflank job secrets):
#   BACKUP_DATABASE_URL   postgres://noctiv_backup.<ref>:<pw>@<pooler>:5432/postgres?sslmode=require
#   BACKUP_AGE_RECIPIENT  age public key (age1…); the private key is kept offline
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#   R2_JURISDICTION       "eu" for an EU-jurisdiction bucket (default), "" otherwise
#   BACKUP_RETENTION_DAYS default 30
set -eu

for v in BACKUP_DATABASE_URL BACKUP_AGE_RECIPIENT R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "backup: $v is not set" >&2; exit 2; }
done
case "$BACKUP_AGE_RECIPIENT" in age1*) ;; *) echo "backup: BACKUP_AGE_RECIPIENT is not an age public key" >&2; exit 2 ;; esac

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
JURISDICTION="${R2_JURISDICTION-eu}"
if [ -n "${R2_ENDPOINT:-}" ]; then
  ENDPOINT="$R2_ENDPOINT" # tests (a local S3)
elif [ -n "$JURISDICTION" ]; then
  ENDPOINT="https://${R2_ACCOUNT_ID}.${JURISDICTION}.r2.cloudflarestorage.com"
else
  ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
s3() { aws --endpoint-url "$ENDPOINT" "$@"; }

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
KEY="postgres/noctiv-${STAMP}.tar.age"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
umask 077

echo "backup: dumping"
# 1. The application: its schemas with data, ownership and grants.
pg_dump "$BACKUP_DATABASE_URL" --format=custom --compress=9 \
  --schema=public --schema=app --schema=marketing --schema=supabase_migrations \
  --file="$WORK/noctiv.dump"
# 2. Sign-in accounts (Supabase Auth): data only, restored into a project's own auth schema.
pg_dump "$BACKUP_DATABASE_URL" --format=custom --compress=9 --data-only \
  --table=auth.users --table=auth.identities \
  --file="$WORK/auth.dump"
pg_restore --list "$WORK/noctiv.dump" > /dev/null
pg_restore --list "$WORK/auth.dump" > /dev/null
{
  echo "created_at=$STAMP"
  echo "pg_dump=$(pg_dump --version)"
  echo "server=$(psql "$BACKUP_DATABASE_URL" -Atc 'show server_version')"
  echo "migration=$(psql "$BACKUP_DATABASE_URL" -Atc 'select max(version) from supabase_migrations.schema_migrations')"
  sha256sum "$WORK/noctiv.dump" "$WORK/auth.dump" | sed "s#$WORK/##"
} > "$WORK/MANIFEST"

echo "backup: encrypting and uploading $KEY"
tar -C "$WORK" -cf - MANIFEST noctiv.dump auth.dump \
  | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" \
  > "$WORK/backup.tar.age"
rm -f "$WORK/noctiv.dump" "$WORK/auth.dump"
s3 s3 cp "$WORK/backup.tar.age" "s3://${R2_BUCKET}/${KEY}" --only-show-errors
SIZE="$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$KEY" --query ContentLength --output text)"
[ "$SIZE" = "$(wc -c < "$WORK/backup.tar.age" | tr -d ' ')" ] || { echo "backup: size check failed" >&2; exit 1; }
echo "backup: uploaded ${SIZE} bytes"

# Retention: the bucket's lifecycle rule deletes after 30 days; this is the
# same rule in case the lifecycle rule is missing.
CUTOFF="$(date -u -d "@$(( $(date +%s) - RETENTION_DAYS * 86400 ))" +%Y-%m-%dT%H%M%SZ)"
s3 s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix postgres/ --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | while read -r old; do
    case "$old" in postgres/noctiv-*.tar.age) ;; *) continue ;; esac
    t="${old#postgres/noctiv-}"; t="${t%.tar.age}"
    if [ "$t" \< "$CUTOFF" ]; then
      s3 s3 rm "s3://${R2_BUCKET}/${old}" --only-show-errors && echo "backup: pruned $old"
    fi
  done
echo "backup: done"
