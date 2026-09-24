-- Step 5: knowledge-base ingestion.
--  * Manual notes are stored as text on the source row (no file involved).
--  * Ingestion results: when, with which embedding model, how many chunks.
--  * A website source records how many pages were read.

alter table public.kb_sources
  add column note_text text check (note_text is null or length(note_text) <= 200000),
  add column ingested_at timestamptz,
  add column embedding_model text,
  add column chunk_count integer not null default 0,
  add column pages_fetched integer,
  add constraint kb_sources_note_text_only_for_notes check (type = 'note' or note_text is null),
  add constraint kb_sources_file_has_path check (type <> 'file' or storage_path is not null),
  add constraint kb_sources_website_has_url check (type <> 'website' or url is not null);

-- Owners edit note text through the API.
grant update (title, note_text) on public.kb_sources to noctiv_api;
