-- The assistant's quote card (create_quote): a quote to a customer from the
-- price list, sent as a new conversation once the owner confirms.
alter table public.assistant_proposals drop constraint assistant_proposals_type_check;
alter table public.assistant_proposals add constraint assistant_proposals_type_check
  check (type in ('settings', 'knowledge_note', 'price_items', 'create_document', 'send_email',
                  'mark_paid', 'connect_mailbox', 'create_quote'));

-- The API creates that quote (POST /v1/tenants/:id/quotes/new): the number,
-- the conversation and the 'quote' draft in one transaction, like Compose.
grant insert on public.quotes to noctiv_api;
grant update (draft_id) on public.quotes to noctiv_api;
