-- Founder request 2026-09-26 (PLAN.md §21.8): the quote's Accept page asks
-- for billing details, stored on the lead, so the automatic invoice
-- (§22.11) can be issued for a first-time customer.
alter table public.leads
  add column billing_name text check (char_length(billing_name) between 1 and 200),
  add column billing_address text check (char_length(billing_address) between 1 and 500),
  add column billing_reg_no text check (char_length(billing_reg_no) <= 40),
  add column billing_vat_no text check (char_length(billing_vat_no) <= 30),
  add column billing_updated_at timestamptz;

grant update (billing_name, billing_address, billing_reg_no, billing_vat_no, billing_updated_at)
  on public.leads to noctiv_api;
-- A quote without a lead gets one when it is accepted.
grant update (lead_id) on public.quotes to noctiv_api;
