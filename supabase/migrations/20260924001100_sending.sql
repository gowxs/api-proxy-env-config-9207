-- Steps 9–10: sending and email notifications.
--  * last Telegram leftovers: drafts/escalations.telegram_message_id, audit actor 'telegram'
--  * notifications: next_attempt_at for retry backoff of the email delivery loop

alter table public.drafts drop column telegram_message_id;
alter table public.escalations drop column telegram_message_id;

alter table public.audit_log drop constraint audit_log_actor_check;
update public.audit_log set actor = 'owner' where actor = 'telegram';
alter table public.audit_log add constraint audit_log_actor_check check (actor in ('owner', 'system'));

alter table public.notifications add column next_attempt_at timestamptz not null default now();
drop index public.notifications_pending_idx;
create index notifications_pending_idx on public.notifications (next_attempt_at) where status = 'pending';

create or replace function app.tenants_with_pending_notifications(p_limit integer)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct n.tenant_id from public.notifications n
  where n.status = 'pending' and n.next_attempt_at <= now()
  limit least(greatest(p_limit, 1), 500)
$$;
