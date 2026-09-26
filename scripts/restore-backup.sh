#!/bin/sh
# Restores a Noctiv backup (docker/backup/backup.sh) into an EMPTY Supabase
# project. See docs/backup-restore.md before running it.
#
#   scripts/restore-backup.sh <backup.tar.age> <age identity file> <target database URL>
#
# The target URL is the new project's `postgres` role (session pooler, port
# 5432). Needs pg_restore/psql 17, age and tar. It refuses a database that
# already has Noctiv tables.
set -eu

[ $# -eq 3 ] || { echo "usage: $0 <backup.tar.age> <age identity file> <target database URL>" >&2; exit 2; }
BACKUP="$1"; IDENTITY="$2"; TARGET="$3"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
umask 077

echo "restore: decrypting"
age --decrypt --identity "$IDENTITY" "$BACKUP" | tar -C "$WORK" -xf -
cat "$WORK/MANIFEST"
(cd "$WORK" && grep -E '^[0-9a-f]{64}  ' MANIFEST | sha256sum -c -)

if [ "$(psql "$TARGET" -Atc "select to_regclass('public.tenants') is not null")" = "t" ]; then
  echo "restore: the target already has Noctiv tables; use an empty project" >&2
  exit 1
fi

echo "restore: extensions and roles"
psql "$TARGET" -v ON_ERROR_STOP=1 -q <<'SQL'
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists vector with schema extensions;
SQL
# Roles the dump refers to that the project lacks (the runtime roles): created
# without login; give them passwords afterwards (docs/backup-restore.md, step 6).
pg_restore -f - "$WORK/noctiv.dump" | grep -oE '(TO|OWNER TO|FROM) "?[a-z_][a-z0-9_]*"?' \
  | awk '{print $NF}' | tr -d '"' | grep -v '^stdin$' | sort -u > "$WORK/roles"
psql "$TARGET" -Atc "select rolname from pg_roles" | sort > "$WORK/have"
for r in $(comm -23 "$WORK/roles" "$WORK/have"); do
  echo "restore: creating role $r (no login)"
  psql "$TARGET" -v ON_ERROR_STOP=1 -qc "create role \"$r\" nologin"
done

# The restore order: everything as dumped, except that
#  - the public schema and Supabase's own default privileges already exist
#    in a Supabase project;
#  - functions that set a pgvector option are created after the table data
#    (the option exists only once pgvector is loaded).
pg_restore -l "$WORK/noctiv.dump" \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' \
  | grep -vE ' DEFAULT ACL .* supabase_admin$' > "$WORK/all.list"
VECTOR_FNS="$(pg_restore -f - --schema-only "$WORK/noctiv.dump" \
  | awk '/^CREATE FUNCTION /{name=$3; sub(/\(.*/, "", name)} /SET "hnsw\./{print name}' | sort -u)"
: > "$WORK/late.list"
for f in $VECTOR_FNS; do
  schema="${f%%.*}"; fn="${f#*.}"
  grep -E "^[0-9]+; [0-9]+ [0-9]+ FUNCTION ${schema} ${fn}\(" "$WORK/all.list" >> "$WORK/late.list" || true
done
if [ -s "$WORK/late.list" ]; then
  grep -vxF -f "$WORK/late.list" "$WORK/all.list" > "$WORK/rest.list"
else
  cp "$WORK/all.list" "$WORK/rest.list"
fi
# Insert the late functions right after the last TABLE DATA entry.
awk -v late="$WORK/late.list" '
  NR == FNR { lines[NR] = $0; if ($0 ~ / TABLE DATA /) last = NR; n = NR; next }
  END {
    for (i = 1; i <= n; i++) {
      print lines[i]
      if (i == last) while ((getline l < late) > 0) print l
    }
  }' "$WORK/rest.list" > "$WORK/order.list"

# Sign-in accounts go in between the data and the constraints: tenant
# members refer to auth.users.
echo "restore: schemas and data"
pg_restore --single-transaction --exit-on-error --no-comments -L "$WORK/order.list" \
  --section=pre-data --section=data -d "$TARGET" "$WORK/noctiv.dump"
echo "restore: sign-in accounts"
pg_restore --single-transaction --exit-on-error --data-only -d "$TARGET" "$WORK/auth.dump"
echo "restore: indexes, constraints, policies, grants"
pg_restore --single-transaction --exit-on-error --no-comments -L "$WORK/order.list" \
  --section=post-data -d "$TARGET" "$WORK/noctiv.dump"

psql "$TARGET" -Atc "select 'restore: ' || count(*) || ' tenants, ' ||
  (select count(*) from public.messages) || ' messages, latest migration ' ||
  (select max(version) from supabase_migrations.schema_migrations) from public.tenants"
echo "restore: done — continue with docs/backup-restore.md step 6"
