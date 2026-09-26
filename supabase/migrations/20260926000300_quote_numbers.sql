-- Quote numbers restart every calendar year (founder decision 2026-09-26):
-- Q-2026-0001 … Q-2027-0001, unique per tenant. The next number is taken
-- from the tenant's quotes of the current year (tenant row locked), so the
-- running counter is no longer needed.
alter table public.tenants drop column quotes_next_number;
