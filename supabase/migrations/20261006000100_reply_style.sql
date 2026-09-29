-- Reply style: "short" (2-5 sentences, plain text; the default) or "detailed".
alter table public.tenants
  add column reply_style text not null default 'short' check (reply_style in ('short', 'detailed'));
grant update (reply_style) on public.tenants to noctiv_api;
