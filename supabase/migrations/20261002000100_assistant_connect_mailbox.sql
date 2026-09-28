-- Noctiv Assistant: the "connect your mailbox" card (PLAN.md §27.3). It
-- opens the connect form prefilled (provider, address, servers found from the
-- address or the domain's MX records); the owner types only the App Password.
set local search_path = public, extensions;

alter table public.assistant_proposals drop constraint assistant_proposals_type_check;
alter table public.assistant_proposals add constraint assistant_proposals_type_check
  check (type in ('settings', 'knowledge_note', 'price_items', 'create_document', 'send_email',
                  'mark_paid', 'connect_mailbox'));
