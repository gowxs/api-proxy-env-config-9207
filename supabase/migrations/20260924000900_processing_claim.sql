-- Step 8: a message being processed is claimed ('processing') so a finished
-- message can never be processed again; a crashed run is resumed by its retry.
alter table public.message_processing drop constraint message_processing_status_check;
alter table public.message_processing add constraint message_processing_status_check
  check (status in ('queued', 'processing', 'skipped', 'escalated', 'drafted', 'auto_sent', 'failed'));
