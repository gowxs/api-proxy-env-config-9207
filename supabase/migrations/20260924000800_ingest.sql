-- Step 7: IMAP ingest.
--  * messages.html_hidden_text: HTML is not stored (plain text only), so the
--    hidden-text injection signal is computed at fetch time and kept here.
--  * Housekeeping for the job queue and staged uploads.

alter table public.messages add column html_hidden_text boolean not null default false;

-- Finished jobs are deleted: connection tests after an hour (their payload
-- holds a sealed password), everything else after seven days. Dead jobs are
-- kept for 30 days for diagnosis. Staged uploads older than a day are dropped.
create function app.housekeeping()
returns table (jobs_deleted integer, uploads_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  j integer;
  u integer;
begin
  delete from public.jobs
  where (queue = 'connection.test' and status in ('done', 'dead', 'failed') and updated_at < now() - interval '1 hour')
     or (status = 'done' and updated_at < now() - interval '7 days')
     or (status = 'dead' and updated_at < now() - interval '30 days');
  get diagnostics j = row_count;
  delete from public.kb_uploads where created_at < now() - interval '1 day';
  get diagnostics u = row_count;
  return query select j, u;
end
$$;
revoke all on function app.housekeeping() from public;
grant execute on function app.housekeeping() to noctiv_worker;
