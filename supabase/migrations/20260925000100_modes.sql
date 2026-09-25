-- Three sending modes, all in one plan (founder decision 2026-09-25):
--   draft_only  (1) approve everything; the default for every new account
--   auto_send   (2) grounded replies go out on their own; everything else waits for approval
--   full_auto   (3) as 2, and a message that cannot be answered from the knowledge base
--                   gets a fixed acknowledgement ("I'll check and get back to you") while
--                   the owner is notified. Hard-list cases always go to the owner.
-- The acknowledgement is stored as its own draft kind so the send job can apply
-- its own rule (sent only while the tenant is still in full_auto).

alter table public.tenants drop constraint tenants_mode_check;
alter table public.tenants add constraint tenants_mode_check
  check (mode in ('draft_only', 'auto_send', 'full_auto'));

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('reply', 'followup', 'acknowledgement'));
