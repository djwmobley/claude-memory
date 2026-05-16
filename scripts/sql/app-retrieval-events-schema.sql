-- ============================================================================
-- app-retrieval-events-schema.sql
--
-- claude-memory-specific schema: retrieval_events table with halfvec(4000)
-- query embedding column.
--
-- NOT applied by `/handoff:init`. This file requires the pgvector extension
-- and is intended only for the claude-memory application setup path.
--
-- Apply manually:
--   psql -d claude_memory_eval_test -f scripts/sql/app-retrieval-events-schema.sql
--
-- Or wire into your existing pipeline setup (e.g., scripts/run-migrations.js
-- if one exists). See BUNDLE-A-SPEC.md section 4 for context.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- RETRIEVAL_EVENTS — log of every retrieval call; outcome posted by Bundle B.
-- This table is created in Bundle A because the reranker (Phase 3) begins
-- writing to it. Outcome capture (the 'outcome' column) is Bundle B scope.
-- project_id = encoded_cwd value; no DEFAULT — must be set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_events (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  query_embedding halfvec(4000),  -- matches memory_entry_chunks.embedding type (halfvec(4000) after Phase 1 step 5)
  retrieved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome         TEXT DEFAULT 'pending'
                    CHECK (outcome IN ('pending','success','failure','irrelevant')),
  outcome_at      TIMESTAMPTZ,
  outcome_signal  TEXT,  -- 'user_explicit'|'user_correction'|'task_completion'|'auto_decay'|'agent_self_report'
  session_id      TEXT,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS retrieval_events_project_idx
  ON retrieval_events (project_id);
CREATE INDEX IF NOT EXISTS retrieval_events_outcome_idx
  ON retrieval_events (outcome) WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS retrieval_events_time_idx
  ON retrieval_events (retrieved_at DESC);


-- ============================================================================
-- RETRIEVAL_EVENT_ASSERTIONS — join table linking retrieval events to the
-- specific assertions that were returned in each retrieval. Populated by
-- the loader (Bundle C1); event_id references retrieval_events(id).
--
-- Observability-only: no query path reads this table yet. Failures writing
-- to this table must never propagate to the loader caller.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_event_assertions (
  event_id      INTEGER NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
  assertion_id  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rea_event_idx
  ON retrieval_event_assertions (event_id);
CREATE INDEX IF NOT EXISTS rea_assertion_idx
  ON retrieval_event_assertions (assertion_id);
