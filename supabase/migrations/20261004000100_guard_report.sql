-- What the guards found for a message (production case 2026-09-28): the
-- excerpts shown to the model with their sources, the claim check, the price
-- check and source conflicts. Written by the worker with the rest of
-- message_processing; readable wherever message_processing is. No e-mail
-- text beyond short figures ("€490", "10 business days") and chunk ids.
alter table public.message_processing add column guard_report jsonb;
