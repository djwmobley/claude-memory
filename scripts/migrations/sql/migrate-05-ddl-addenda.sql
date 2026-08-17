-- migrate-05-ddl-addenda.sql
--
-- Bundled DDL preamble for migrate-05-sync-file-memory.js (CONSOLIDATION-
-- RUNBOOK.md §6.1(f) + its F5-1..F5-12 spec-adversary amendment, 2026-08-16,
-- memory-manager#11(f)). Idempotent, re-runnable, no DROP TABLE anywhere in
-- this file (§6.0's preservation guarantee). Applied via migrateOne.
-- applySqlFile, mirroring migrate-04/migrate-09's "bundle this DDL as this
-- script's own preamble" precedent.
--
-- (F5-2) `memory_entries_source_file_key` -- the implicit UNIQUE constraint
-- Postgres auto-names for the inline `source_file TEXT UNIQUE` column
-- declared in scripts/setup.sql -- is SUPERSEDED to a plain non-unique
-- index (the I-10 -> PR #179 pattern, same one migrate-04's seam-DDL-
-- addenda and migrate-09's edges index both already applied). `MEMORY.md`
-- exists in every memory dir by construction (a cross-project collision on
-- ANY path-shaped identity), and live claude_policy_framework already holds
-- two rows ("memory.md" and "memory\MEMORY.md") that fold onto ONE
-- normalized comparison key within a single DB -- no path-shaped UNIQUE
-- constraint can losslessly hold the DB-absorbed legacy rows this
-- migration's Step A carries forward verbatim. Sync identity becomes
-- (project_id, source_file) enforced at the APPLICATION layer (this
-- script's own lineage-first lookup + explicit content-hash gating), never
-- a DB constraint; absorbed rows are identified by lineage ONLY, never path
-- equality.
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_source_file_key;
CREATE INDEX IF NOT EXISTS memory_entries_source_file_idx ON memory_entries (source_file);

-- Query-performance companion index for the app-layer (project_id,
-- source_file) identity lookups this script's Step C performs (not a
-- uniqueness constraint -- see above).
CREATE INDEX IF NOT EXISTS memory_entries_project_source_file_idx ON memory_entries (project_id, source_file);

-- LOSSLESS-FIDELITY ADDITIVE COLUMN (field-found, first real staging run,
-- 2026-08-16): live-verified that claude_policy_framework.memory_entries
-- carries a `last_modified TIMESTAMPTZ` column with NO §setup.sql target
-- counterpart at all (pipeline_pipeline.memory_entries has no such column
-- either -- this is a claude_policy_framework-only divergence). Nullable,
-- additive, never touches an existing column -- the same E-pass pattern
-- migrate-04-seam-ddl-addenda.sql already established for `incidents`/
-- `checklist_items`/`corpus_files`/`policy_sections`/`session_chunks`/
-- `tasks`. migrate-05-sync-file-memory.js's own column-shape precondition
-- check refuses loud, never silently drops, if either source's live column
-- set drifts again after this PR merges.
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS last_modified TIMESTAMPTZ;
