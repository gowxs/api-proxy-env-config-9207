-- Founder scope change (after step 8): Telegram is removed from Phase 1.
-- Owner notifications go by email (system mailer) + dashboard; the channel
-- stays behind an interface so a chat channel can be added later.
--  * drop telegram_link_tokens, tenants.telegram_chat_id / telegram_linked_at
--  * tenants.telegram_full_text -> notify_full_text (Q2 privacy toggle)
--  * notifications: email channels only; 'sending' state for delivery
--  * Yahoo joins the provider presets
--  * owner login emails for the worker's notification mailer

drop table public.telegram_link_tokens;
alter table public.tenants drop column telegram_chat_id, drop column telegram_linked_at;
alter table public.tenants rename column telegram_full_text to notify_full_text;

alter table public.notifications drop constraint notifications_channel_check;
update public.notifications set channel = replace(channel, 'telegram_', 'email_') where channel like 'telegram_%';
alter table public.notifications add constraint notifications_channel_check check (channel in ('email_owner', 'email_admin'));

alter table public.email_connections drop constraint email_connections_provider_check;
alter table public.email_connections add constraint email_connections_provider_check
  check (provider in ('gmail', 'google_workspace', 'yahoo', 'hostinger', 'outlook', 'generic'));

-- Login emails of a tenant's owners (auth.users is not visible to runtime roles).
create function app.tenant_owner_emails(p_tenant_id uuid)
returns table (email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from public.tenant_members m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id and m.role = 'owner' and u.email is not null
$$;
revoke all on function app.tenant_owner_emails(uuid) from public;
grant execute on function app.tenant_owner_emails(uuid) to noctiv_worker;

-- Tenants with notifications waiting (identifiers only), for the delivery loop.
create function app.tenants_with_pending_notifications(p_limit integer)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct n.tenant_id from public.notifications n
  where n.status = 'pending'
  limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function app.tenants_with_pending_notifications(integer) from public;
grant execute on function app.tenants_with_pending_notifications(integer) to noctiv_worker;
