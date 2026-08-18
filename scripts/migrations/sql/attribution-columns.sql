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
--
-- CANON NOTE (columns-canon fix): these same six columns are now ALSO defined in
-- scripts/sql/handoff-core-schema.sql and scripts/sql/handoff-sqlite-schema.sql
-- (the cm#185 bring-forward canon, auto-applied to every live project DB by
-- ensureSchemaCurrent in scripts/handoff.js). That move was necessary because
-- migrate-schema-addenda.js (this file's applier) reuses migrate-01's
-- classifyTarget, which structurally refuses live project DBs (allow-set:
-- memory_manager / *_staging only) — so this file alone could never reach a
-- live DB, yet entity-graph-crud.js writes both columns unconditionally on
-- every entities/assertions/edges write against ANY target, live included.
-- This file is UNCHANGED and STAYS in migrate-schema-addenda.js's SQL_FILES
-- list — it remains the applier for staging targets and is idempotent
-- (ADD COLUMN IF NOT EXISTS) against a DB that already has the columns via
-- canon. Future columns added to entities/assertions/edges (or any other
-- engine-core table) go to the canon files FIRST, never here first.

ALTER TABLE entities    ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE entities    ADD COLUMN IF NOT EXISTS agent_id     TEXT;
ALTER TABLE assertions  ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE assertions  ADD COLUMN IF NOT EXISTS agent_id     TEXT;
ALTER TABLE edges       ADD COLUMN IF NOT EXISTS source_model TEXT;
ALTER TABLE edges       ADD COLUMN IF NOT EXISTS agent_id     TEXT;
