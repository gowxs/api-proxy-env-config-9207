-- Noctiv Assistant action cards, PLAN.md §27.2 (founder request 2026-09-30):
-- a document (created as Ready), an e-mail (sent through Compose after the
-- confirmation dialog) and "mark as paid". The card keeps what confirming it
-- produced (the document id and number, the conversation of the e-mail).
set local search_path = public, extensions;

alter table public.assistant_proposals drop constraint assistant_proposals_type_check;
alter table public.assistant_proposals add constraint assistant_proposals_type_check
  check (type in ('settings', 'knowledge_note', 'price_items', 'create_document', 'send_email', 'mark_paid'));

alter table public.assistant_proposals add column result jsonb;

grant update (result) on public.assistant_proposals to noctiv_api;
