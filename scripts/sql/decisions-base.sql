-- handoff:dialect postgres
-- ============================================================================
-- decisions-base.sql
--
-- CANON NOTE (cm#224, this file's own authoring issue -- "init leaves per-
-- project DB without decisions table"): canonizes the `decisions` table plus
-- its full write-surface prerequisites into scripts/sql/, applied to EVERY
-- live project DB by ensureSchemaCurrent in scripts/handoff.js. Follows the
-- exact canon-class pattern documented in scripts/migrations/sql/
-- embedding-providers-base.sql's header (same structural reasoning PR #204
-- used for embedding_providers/source_model/agent_id/suppressed): the
-- content below is defined VERBATIM elsewhere (migrate-14-seam-tables.sql,
-- migrate-15-mcp-addenda.sql, migrate-13-agent-exchange.sql,
-- migrate-14-seam-tables-embeddings.sql, migrate-07-reembed-corpus.js), but
-- every one of those appliers is structurally staging-only
-- (migrate-schema-addenda.js / migrate-14-seam-tables.js / migrate-13-
-- agent-exchange.js all reuse migrate-01's classifyTarget, which refuses any
-- target outside memory_manager / *_staging) -- so none of them can ever
-- reach a live per-project DB. Yet memory-upsert.js's upsertDecisionRow and
-- persist_decisions (the MCP tool) both write to `decisions` unconditionally
-- against ANY target, live included. A fresh `handoff.js init` therefore
-- left a live project DB with no `decisions` table at all until this file.
--
-- This file is UNCHANGED-CONTENT relative to its four source-of-truth
-- files above (same table/column/index/function/trigger definitions,
-- copied verbatim) -- it is a NEW aggregation point, not a fork. Those four
-- source files are themselves left UNCHANGED and stay the staging-target
-- appliers; every statement below is idempotent (IF NOT EXISTS / DO NOTHING
-- / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE) against a DB that
-- already carries these objects via an earlier staging-side apply of those
-- four files, so canon and staging can never diverge into "two different
-- definitions of the same object."
--
-- Ordered AFTER handoff-core-schema.sql (order 10) — this file's
-- embedded_by_provider_id column is a real FK to embedding_providers(id),
-- which handoff-core-schema.sql creates. Ordered AFTER app-retrieval-events-
-- schema.sql (order 20) purely for changelog-append cleanliness — there is
-- no functional dependency on that file.
--
-- Pieces, in apply order:
--   1. `decisions` table (id/project_id/session_num/topic/decision/reason/
--      source_project_hint/source_model/agent_id/authoring_mode/created_at),
--      its two plain indexes, and its generated fts_vec tsvector + GIN index
--      -- migrate-14-seam-tables.sql's exact definition.
--   2. decisions_project_topic_unique -- migrate-15-mcp-addenda.sql's exact
--      statement. memory-upsert.js:upsertDecisionRow's
--      `ON CONFLICT (project_id, topic) DO UPDATE` requires this exact
--      index to exist (42P10 without it).
--   3. embedded_by_provider_id INTEGER REFERENCES embedding_providers(id)
--      -- migrate-07-reembed-corpus.js's ensureProvenanceColumn() adds this
--      programmatically to every embeddable table; canonized here so the
--      column exists on a fresh live DB without that script ever running.
--   4. embedding halfvec(4000) + its HNSW index -- migrate-14-seam-tables-
--      embeddings.sql's exact DO-block-guarded definition (degrades
--      gracefully, same pattern as handoff-core-schema.sql's
--      assertions.embedding block, when pgvector/halfvec is absent).
--   5. audit_log table + log_guarded_change() -- migrate-13-agent-
--      exchange.sql's exact generic tamper-evidence infrastructure, plus a
--      FIXED-NAME (not migrate-13's dynamic %I-driven) AFTER UPDATE OR
--      DELETE trigger wiring decisions_audit onto `decisions` specifically
--      -- this file only ever wires decisions; the other 15 guarded tables
--      (assertions, edges, entities, the other 12 seam tables, agent_
--      exchange) are out of scope here and stay staging-only until they too
--      get a canon-class fix.
-- ============================================================================


-- ============================================================================
-- 1. DECISIONS TABLE (migrate-14-seam-tables.sql, verbatim)
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
  id               SERIAL PRIMARY KEY,
  project_id       TEXT NOT NULL,
  session_num      INTEGER,
  topic            TEXT NOT NULL,
  decision         TEXT NOT NULL,
  reason           TEXT,
  source_project_hint TEXT,              -- pre-migration topic-prefix convention, audit trail only
  source_model     TEXT,
  agent_id         TEXT,
  authoring_mode   TEXT NOT NULL DEFAULT 'caveman' CHECK (authoring_mode IN ('caveman','verbose')),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS decisions_project_idx ON decisions (project_id);
CREATE INDEX IF NOT EXISTS decisions_topic_idx   ON decisions (project_id, topic);
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(topic,'') || ' ' || coalesce(decision,'') || ' ' || coalesce(reason,''))) STORED;
CREATE INDEX IF NOT EXISTS decisions_fts_idx ON decisions USING gin(fts_vec);

-- ============================================================================
-- 2. ARBITER INDEX (migrate-15-mcp-addenda.sql, verbatim) -- backs
--    memory-upsert.js:upsertDecisionRow's ON CONFLICT (project_id, topic).
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS decisions_project_topic_unique ON decisions(project_id, topic);

-- ============================================================================
-- 3. EMBEDDING PROVENANCE COLUMN (migrate-07-reembed-corpus.js's
--    ensureProvenanceColumn(), verbatim form). embedding_providers is
--    guaranteed present -- created by handoff-core-schema.sql, applied at a
--    lower manifest `order` (10) than this file.
-- ============================================================================
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS embedded_by_provider_id INTEGER REFERENCES embedding_providers(id);

-- ============================================================================
-- 4. EMBEDDING COLUMN + HNSW INDEX (migrate-14-seam-tables-embeddings.sql,
--    verbatim). Wrapped in DO blocks so a pgvector-absent target degrades
--    gracefully instead of aborting this file -- same pattern as handoff-
--    core-schema.sql's assertions.embedding block.
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE decisions ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'decisions.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS decisions_embedding_idx
    ON decisions USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'decisions_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

-- ============================================================================
-- 5. AUDIT_LOG + log_guarded_change() (migrate-13-agent-exchange.sql,
--    verbatim) + a FIXED-NAME trigger wiring decisions specifically.
--
-- audit_log/log_guarded_change() are generic, reusable tamper-evidence
-- infrastructure shared by every guarded table across the engine -- this
-- file is the first canon-class unit to need them, so they are defined
-- here in full (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION),
-- identically to migrate-13-agent-exchange.sql's copy. A target that later
-- also runs migrate-13-agent-exchange.sql (staging-only) sees an identical
-- table/function definition -- both converge, never diverge.
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL,
  operation   TEXT NOT NULL,       -- 'UPDATE' | 'DELETE'
  row_id      TEXT,
  db_user     TEXT,
  old_row     JSONB,
  new_row     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent convergence ALTER, identical rationale to migrate-13-agent-
-- exchange.sql's own copy of this statement -- a no-op on a fresh TEXT
-- column, a proven no-op re-running against an already-TEXT column either way.
ALTER TABLE audit_log ALTER COLUMN row_id TYPE TEXT USING row_id::text;
CREATE INDEX IF NOT EXISTS audit_log_table_op_idx ON audit_log (table_name, operation);
CREATE INDEX IF NOT EXISTS audit_log_created_idx  ON audit_log (created_at DESC);

-- Strips the 'embedding' key before serialization -- same rationale as
-- migrate-13-agent-exchange.sql's ADVERSARY-PASS A-3 note: embeddings are
-- derived, re-computable data with negligible forensic value, and an
-- unbounded halfvec(4000) in every audit row is an unbounded storage cost.
CREATE OR REPLACE FUNCTION log_guarded_change() RETURNS TRIGGER AS $trig$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (table_name, operation, row_id, db_user, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, OLD.id, current_user, to_jsonb(OLD) - 'embedding', NULL);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log (table_name, operation, row_id, db_user, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, NEW.id, current_user, to_jsonb(OLD) - 'embedding', to_jsonb(NEW) - 'embedding');
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$trig$ LANGUAGE plpgsql;

-- decisions' own trigger -- FIXED name (never migrate-13's dynamic %I-
-- driven wiring), so this statement is a plain, re-readable DROP+CREATE
-- pair rather than a DO-block EXECUTE format(...) loop. Safe to re-run: a
-- second apply drops and recreates the identically-defined trigger.
DROP TRIGGER IF EXISTS decisions_audit ON decisions;
CREATE TRIGGER decisions_audit
AFTER UPDATE OR DELETE ON decisions
FOR EACH ROW EXECUTE FUNCTION log_guarded_change();
