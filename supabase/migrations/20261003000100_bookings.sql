-- Bookings (beta), PLAN.md §29 (founder request 2026-10-03). Off by default.
-- A public booking page per business, replies that offer free times, Google
-- Calendar (free/busy + the events Noctiv books) and intake forms.

set local search_path = public, extensions;

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Tenant switch and booking page address
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column bookings_enabled boolean not null default false,
  add column booking_slug text unique
    check (booking_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' and booking_slug !~ '--');

grant update (bookings_enabled, booking_slug) on public.tenants to noctiv_api;

-- The booking page finds its business by slug before any tenant context
-- exists; identifiers only, and only while Bookings is on.
create function app.booking_tenant(p_slug text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from public.tenants t
  where t.booking_slug = lower(p_slug) and t.bookings_enabled and t.status = 'active'
$$;
revoke all on function app.booking_tenant(text) from public;
grant execute on function app.booking_tenant(text) to noctiv_api;

-- Is a slug free (for any business but this one)? Used when the owner edits it.
create function app.booking_slug_taken(p_slug text, p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.tenants where booking_slug = p_slug and id <> p_tenant_id)
$$;
revoke all on function app.booking_slug_taken(text, uuid) from public;
grant execute on function app.booking_slug_taken(text, uuid) to noctiv_api;

-- ---------------------------------------------------------------------------
-- Settings (one row per business)
-- ---------------------------------------------------------------------------
create table public.booking_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  -- {"1": [{"from": "09:00", "to": "17:00"}], ...}; 1 = Monday, local time.
  hours jsonb not null default '{"1":[{"from":"09:00","to":"17:00"}],"2":[{"from":"09:00","to":"17:00"}],"3":[{"from":"09:00","to":"17:00"}],"4":[{"from":"09:00","to":"17:00"}],"5":[{"from":"09:00","to":"17:00"}]}'
    check (jsonb_typeof(hours) = 'object'),
  slot_minutes integer not null default 30 check (slot_minutes between 15 and 240),
  buffer_minutes integer not null default 15 check (buffer_minutes between 0 and 120),
  notice_hours integer not null default 12 check (notice_hours between 0 and 336),
  horizon_days integer not null default 30 check (horizon_days between 1 and 90),
  location_kind text not null default 'online_link'
    check (location_kind in ('in_person', 'phone', 'online_link', 'google_meet')),
  location_text text not null default '' check (char_length(location_text) <= 500),
  meeting_title text not null default '' check (char_length(meeting_title) <= 120),
  form_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Calendar connection (Google; Microsoft 365 later) and its busy times
-- ---------------------------------------------------------------------------
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('google')),
  account_email citext not null check (char_length(account_email) <= 320),
  -- The refresh token, sealed with the credentials public key (only the
  -- worker can open it); associated data noctiv:calendar_credentials:v1:<tenant>:<id>.
  credentials_ciphertext bytea not null,
  credentials_key_id text not null,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'error', 'revoking')),
  last_error text check (char_length(last_error) <= 500),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Busy intervals only: no titles, attendees or descriptions are stored.
create table public.calendar_busy (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index calendar_busy_idx on public.calendar_busy (tenant_id, starts_at);

-- ---------------------------------------------------------------------------
-- Intake forms
-- ---------------------------------------------------------------------------
create table public.intake_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  intro text not null default '' check (char_length(intro) <= 1000),
  -- Checked by @noctiv/bookings (formSchema): at most 10 fields.
  fields jsonb not null default '[]'
    check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 10),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

alter table public.booking_settings
  add foreign key (tenant_id, form_id) references public.intake_forms (tenant_id, id)
    on delete set null (form_id);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  lead_id uuid,
  thread_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  email citext not null check (char_length(email) <= 200),
  phone text check (char_length(phone) <= 25),
  note text check (char_length(note) <= 1000),
  answers jsonb not null default '[]' check (jsonb_typeof(answers) = 'array'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  language text not null default 'en' check (language ~ '^[a-z]{2}$'),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'taken', 'cancelled', 'rescheduled')),
  cancelled_by text check (cancelled_by in ('customer', 'owner')),
  rescheduled_from uuid,
  -- The calendar event and its version for the customer's .ics (SEQUENCE).
  google_event_id text check (char_length(google_event_id) <= 1024),
  meet_url text check (char_length(meet_url) <= 500),
  ics_sequence integer not null default 0,
  -- A moved booking keeps its calendar identity: the first booking's id.
  ics_uid uuid,
  source text not null default 'page' check (source in ('page', 'reply', 'assistant')),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (tenant_id, id),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete set null (lead_id),
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete set null (thread_id),
  foreign key (tenant_id, rescheduled_from) references public.bookings (tenant_id, id)
    on delete set null (rescheduled_from),
  -- Two people can never hold the same time.
  constraint bookings_no_overlap exclude using gist (
    tenant_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'confirmed'))
);
create index bookings_upcoming_idx on public.bookings (tenant_id, starts_at) where status in ('pending', 'confirmed');
create index bookings_lead_idx on public.bookings (tenant_id, lead_id);

create table public.intake_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  form_id uuid,
  lead_id uuid,
  thread_id uuid,
  booking_id uuid,
  form_name text not null check (char_length(form_name) between 1 and 100),
  name text not null check (char_length(name) between 1 and 200),
  email citext not null check (char_length(email) <= 200),
  -- [{"key", "label", "type", "value"}]; labels copied at submission.
  answers jsonb not null check (jsonb_typeof(answers) = 'array'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, form_id) references public.intake_forms (tenant_id, id) on delete set null (form_id),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete set null (lead_id),
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete set null (thread_id),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete set null (booking_id)
);
create index intake_submissions_lead_idx on public.intake_submissions (tenant_id, lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Leads, drafts
-- ---------------------------------------------------------------------------
alter table public.leads drop constraint leads_stage_check;
alter table public.leads add constraint leads_stage_check check (stage in (
  'received', 'drafted', 'sent', 'followed_up', 'replied', 'quoted', 'accepted', 'booked',
  'converted', 'escalated'
));

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind in (
  'reply', 'followup', 'acknowledgement', 'quote', 'document', 'payment_reminder', 'compose',
  'booking', 'booking_offer'
));
-- A booking_offer draft's times: {"block", "language", "url", "starts": [iso]},
-- so the worker can refresh the block at send time when a time has gone.
alter table public.drafts
  add column booking_offer jsonb check (booking_offer is null or jsonb_typeof(booking_offer) = 'object'),
  add column booking_id uuid,
  add foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id)
    on delete set null (booking_id);

-- ---------------------------------------------------------------------------
-- RLS, grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['booking_settings', 'calendar_connections', 'intake_forms', 'bookings'] loop
    execute format('create trigger set_updated_at before update on public.%I
         for each row execute function app.set_updated_at()', t);
  end loop;
  foreach t in array array[
    'booking_settings', 'calendar_connections', 'calendar_busy', 'intake_forms', 'bookings',
    'intake_submissions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy runtime_tenant_isolation on public.%I
         as permissive for all to noctiv_api, noctiv_worker
         using (tenant_id = (select app.current_tenant_id()))
         with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format(
      'create policy member_tenant_access on public.%I
         as permissive for all to authenticated
         using (tenant_id in (select app.user_tenant_ids()))
         with check (tenant_id in (select app.user_tenant_ids()))', t);
  end loop;
end
$$;

revoke all on public.booking_settings, public.calendar_connections, public.calendar_busy,
  public.intake_forms, public.bookings, public.intake_submissions
  from anon, authenticated;

-- API: settings and forms (owner), bookings from the public page, the
-- calendar connection after OAuth (sealed token in, never out).
grant select, insert, update on public.booking_settings to noctiv_api;
grant select, insert, delete on public.calendar_connections to noctiv_api;
grant update (status, last_error) on public.calendar_connections to noctiv_api;
grant select, delete on public.calendar_busy to noctiv_api;
grant select, insert, update, delete on public.intake_forms to noctiv_api;
grant select, insert on public.bookings to noctiv_api;
grant update (status, cancelled_by, cancelled_at) on public.bookings to noctiv_api;
grant select, insert on public.intake_submissions to noctiv_api;

grant select on public.booking_settings, public.intake_forms to noctiv_worker;
grant select, update, delete on public.calendar_connections to noctiv_worker;
grant select, insert, delete on public.calendar_busy to noctiv_worker;
grant select, insert, update on public.bookings, public.intake_submissions to noctiv_worker;

-- Calendars to refresh: Bookings on, connected, not synced in the last
-- 10 minutes. Identifiers only; the worker does the rest in tenant context.
create function app.calendars_due_sync(p_limit integer)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.tenant_id
  from public.calendar_connections c
  join public.tenants t on t.id = c.tenant_id
  where c.status = 'connected' and t.bookings_enabled and t.status = 'active'
    and (c.synced_at is null or c.synced_at < now() - interval '10 minutes')
  order by c.synced_at nulls first
  limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function app.calendars_due_sync(integer) from public;
grant execute on function app.calendars_due_sync(integer) to noctiv_worker;
