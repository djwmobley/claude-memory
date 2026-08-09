-- attribution-columns.sql
--
-- Schema-setup-only (no data migration): adds source_model/agent_id
-- attribution columns to the three engine-core tables.
--
-- Naming note: the origin document assigns this piece the filename
-- migrate-05-attribution-columns.sql, but "05" is already claimed by a
-- different artifact in this repo's migration phase numbering
-- (migrate-05-sync-file-memory.js). This file is named descriptively
-- instead of reusing "05" to avoid the collision. Apply ORDER is fixed by
-- migrate-schema-addenda.js's explicit file-list array, never by filename.
--
-- source_model and agent_id are free text on every table below — NO enum,
-- NO CHECK against a model list (model-agnosticism: no named model set
-- anywhere in this schema).

ALTER TABLE entities    ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE entities    ADD COLUMN IF NOT EXISTS agent_id     TEXT;
ALTER TABLE assertions  ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE assertions  ADD COLUMN IF NOT EXISTS agent_id     TEXT;
ALTER TABLE edges       ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE edges       ADD COLUMN IF NOT EXISTS agent_id     TEXT;
