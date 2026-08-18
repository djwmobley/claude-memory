-- migrate-15-mcp-addenda.sql
--
-- §8 schema-addenda prerequisites for the generalized MCP tool surface
-- (CONSOLIDATION-RUNBOOK.md §8, memory-manager#18). Schema-only, idempotent,
-- re-runnable, no DROP anywhere in this file. Dollar-quote-free by design
-- (§7.9/S-16, claude-memory#159) — every statement is a plain ALTER TABLE
-- ADD COLUMN IF NOT EXISTS or CREATE [UNIQUE] INDEX IF NOT EXISTS, so this
-- file is safe to hand to a naive statement splitter.
--
-- Ships as its OWN file/runner (migrate-15-mcp-addenda.js), deliberately
-- NOT folded into migrate-schema-addenda.js's own SQL_FILES array — a
-- concurrent migrate-02 PR bundles an IDENTICAL idempotent
-- decisions_project_topic_unique statement; keeping this addendum in a
-- separate file/runner avoids a merge collision on the shared
-- migrate-schema-addenda.js SQL_FILES list while still applying the exact
-- same statement (same name, same definition) either PR lands first.
--
-- (M-15) retrieval_contract.kind — memory_view_set/run's explicitly-named
-- DDL prerequisite, not a naming convention. DEFAULT 'contract' means every
-- existing next-session-contract row (written before this migration) is
-- classified 'contract' by the default, never silently reinterpreted as a
-- view.
ALTER TABLE retrieval_contract ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'contract'
  CHECK (kind IN ('contract', 'view'));

-- (M-4) entities.suppressed / edges.suppressed — entity-graph-crud.js's
-- suppress operations and entityCreate's revival semantics both require
-- this column. edges.suppressed additionally lets edgeSuppress mark an edge
-- retracted without a destructive DELETE.
--
-- CANON NOTE (columns-canon fix): these two columns are now ALSO defined in
-- scripts/sql/handoff-core-schema.sql and scripts/sql/handoff-sqlite-schema.sql
-- (the cm#185 bring-forward canon, auto-applied to every live project DB).
-- This file's applier (migrate-15-mcp-addenda.js) has no live-DB path either
-- — same structural gap as attribution-columns.sql (see that file's own
-- CANON NOTE for the full rationale). This file is UNCHANGED and stays as
-- the staging applier; idempotent against a DB that already has the columns
-- via canon. Future columns on engine-core tables go to the canon files
-- FIRST, never here first.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT false;

-- (M-12/M-13) entities.name trigram GIN index — supports entityCreate's
-- near-match fuzzy-similarity query (pg_trgm's similarity()/% operator) at
-- scale. pg_trgm extension itself is a prerequisite (already present on the
-- staging target; CREATE EXTENSION IF NOT EXISTS is intentionally NOT
-- issued here — extension creation is an operator/DBA-privilege action, out
-- of scope for a schema-addenda migration that otherwise only ALTERs/
-- CREATE INDEXes on already-owned tables).
CREATE INDEX IF NOT EXISTS entities_name_trgm_idx ON entities USING gin (name gin_trgm_ops);

-- (M-1) decisions_project_topic_unique — EXACT statement and name, per the
-- task description's explicit instruction not to diverge from the
-- concurrent migrate-02 PR's identical statement. Backs memory_upsert's
-- decisions ON CONFLICT (project_id, topic) DO UPDATE carve-out
-- (scripts/lib/memory-upsert.js:upsertDecisionRow).
CREATE UNIQUE INDEX IF NOT EXISTS decisions_project_topic_unique ON decisions(project_id, topic);
