-- Full thread view: replies the owner sends from their own mail client are
-- read from the Sent folder (read-only) and kept only when they belong to a
-- conversation Noctiv already knows. Read state is mirrored from the
-- provider (never written back).
alter table public.email_connections
  add column sent_uidvalidity bigint,
  add column sent_last_uid bigint,
  -- When Sent syncing began: older Sent mail is never imported (no backfill).
  add column sent_sync_started_at timestamptz,
  add column sent_sync_error text;

alter table public.messages
  add column seen boolean,
  add column mailbox_folder text check (mailbox_folder in ('inbox', 'sent')),
  add column sent_by text check (sent_by in ('noctiv', 'owner'));

update public.messages set sent_by = 'noctiv', mailbox_folder = 'sent' where direction = 'outbound';

grant select (sent_sync_error) on public.email_connections to authenticated, noctiv_api;
-- The owner may enter the Sent folder once when the provider has no \Sent marker.
grant update (sent_folder_path, sent_append_mode, sent_uidvalidity, sent_last_uid,
              sent_sync_started_at, sent_sync_error) on public.email_connections to noctiv_api;
