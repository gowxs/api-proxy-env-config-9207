-- Documents (beta), founder decisions 2026-09-26:
--  * each business sets its own number prefix per document type (default
--    INV / DN / CMR): letters and digits, distinct per type, fixed for the
--    year once a document of that type has been issued (checked by the API);
--  * a delivery note may carry prices and totals (pavadzīme-rēķins); that
--    option lives in the document's own fields.

alter table public.tenants
  add column doc_prefix_invoice text not null default 'INV'
    check (doc_prefix_invoice ~ '^[A-Z0-9]{1,10}$'),
  add column doc_prefix_delivery_note text not null default 'DN'
    check (doc_prefix_delivery_note ~ '^[A-Z0-9]{1,10}$'),
  add column doc_prefix_cmr text not null default 'CMR'
    check (doc_prefix_cmr ~ '^[A-Z0-9]{1,10}$'),
  add constraint tenants_doc_prefixes_distinct check (
    doc_prefix_invoice <> doc_prefix_delivery_note
    and doc_prefix_invoice <> doc_prefix_cmr
    and doc_prefix_delivery_note <> doc_prefix_cmr
  );

grant update (doc_prefix_invoice, doc_prefix_delivery_note, doc_prefix_cmr)
  on public.tenants to noctiv_api;

alter table public.documents drop constraint documents_number_check;
alter table public.documents add constraint documents_number_check
  check (number ~ '^[A-Z0-9]{1,10}-[0-9]{4}-[0-9]{4,}$');
