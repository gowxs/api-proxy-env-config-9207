# Nightly database backup (PLAN.md §25, docs/backup-restore.md): pg_dump of
# the Noctiv schemas, encrypted with age to the operator's public key, then
# uploaded to Cloudflare R2. Runs as the Northflank cron job `db-backup`.
FROM public.ecr.aws/docker/library/alpine:3.22
RUN apk add --no-cache postgresql17-client age aws-cli tar ca-certificates
COPY docker/backup/backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh && adduser -D -u 10001 backup
USER backup
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/backup.sh"]
