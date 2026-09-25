-- E-mail design per tenant (founder decision 2026-09-26): the visual frame
-- around every outgoing reply, follow-up and acknowledgement. The reply text
-- itself is unchanged; 'plain' (text only) stays the default.
alter table public.tenants
  add column email_template text not null default 'plain'
    check (email_template in ('plain', 'clean', 'logo', 'branded', 'card')),
  add column brand_company_name text check (char_length(brand_company_name) <= 120),
  -- https only; its host must be in the tenant's knowledge-base allowlist
  -- (checked by the API on save and again when sending).
  add column brand_logo_url text check (brand_logo_url ~ '^https://' and char_length(brand_logo_url) <= 500),
  add column brand_color text check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column brand_website text check (brand_website ~ '^https?://' and char_length(brand_website) <= 300),
  add column brand_phone text check (char_length(brand_phone) <= 40),
  add column brand_address text check (char_length(brand_address) <= 300),
  add column brand_social_links text[] not null default '{}'
    check (cardinality(brand_social_links) <= 3);

grant update (
  email_template, brand_company_name, brand_logo_url, brand_color, brand_website,
  brand_phone, brand_address, brand_social_links
) on public.tenants to noctiv_api;

-- The API checks the logo against the allowlist (within the tenant's RLS context).
grant select on public.kb_allowlist to noctiv_api;
