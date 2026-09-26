-- QA 2026-09-26: "Mark as done" on the last open escalation closes the
-- conversation (it stayed "Needs you" forever).
grant update (status) on public.threads to noctiv_api;
