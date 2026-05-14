-- ============================================================================
-- Bundle A — Phase 2 schema DDL.
--
-- Source: BUNDLE-A-SPEC.md v5 Section 4 ("Phase 2 DDL — retrieval_events +
-- knowledge graph + retrieval infrastructure"). Verbatim apart from this header.
--
-- All tables carry `project_id TEXT NOT NULL` with no DEFAULT. The writer must
-- set project_id explicitly to the encoded_cwd value (see scripts/lib/encoded-cwd.js).
-- For the claude-memory project: project_id = 'C--Users-djwmo-dev-claude-memory'.
--
-- All statements are IF NOT EXISTS — safe to re-apply.
-- ============================================================================

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
-- ENTITIES — typed named entities extracted at /handoff:close.
-- Writer: Claude (session-end extraction) and manual writes by the Principal.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS entities (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- e.g. 'person', 'system', 'concept', 'decision', 'file'
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id  TEXT,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS entities_project_idx
  ON entities (project_id);
CREATE INDEX IF NOT EXISTS entities_name_idx
  ON entities (project_id, name);


-- ============================================================================
-- ASSERTIONS — typed subject/predicate/object triples with 1-10 confidence.
--
-- Confidence scoring (1-10):
--   9-10  user_stated durable facts ("the DB is on localhost", "we chose vLLM")
--   7-8   strongly inferred from multiple user statements in session
--   5-6   model-extracted from context with moderate support
--   3-4   tentative inference; contradicting signals present
--   1-2   speculative; should be revisited
--
-- Decay formula (read-time, computed by the loader — column stores raw confidence):
--   effective_confidence = confidence * exp(-decay_rate * EXTRACT(EPOCH FROM
--     (now() - last_reinforced)) / 86400)
--
-- Suppression threshold: effective_confidence < 1.0 → excluded from retrieval.
-- Example: confidence=10, decay_rate=0.05 → survives ~46 days before suppression.
--          confidence=5, decay_rate=0.05  → survives ~32 days before suppression.
--
-- Reinforcement: every retrieval bumps last_reinforced = now() (live "used" event,
-- option a — coarser but simpler than retrieve-and-reference signal).
--
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS assertions (
  id               SERIAL PRIMARY KEY,
  project_id       TEXT NOT NULL,
  subject          TEXT NOT NULL,   -- entity name or topic string
  predicate        TEXT NOT NULL,   -- e.g. 'depends_on', 'is_status', 'prefers', 'chose'
  object           TEXT NOT NULL,   -- asserted value or referenced entity name
  confidence       FLOAT NOT NULL
                     CHECK (confidence >= 1.0 AND confidence <= 10.0),
  last_reinforced  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_retrieved   TIMESTAMPTZ,     -- informational; reinforcement is the binding signal
  decay_rate       FLOAT NOT NULL DEFAULT 0.05,  -- per-day decay rate
  source           TEXT NOT NULL
                     CHECK (source IN (
                       'user_stated',
                       'model_extracted',
                       'doc_quoted',
                       'retrieved_from_prior'
                     )),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id       TEXT
);
CREATE INDEX IF NOT EXISTS assertions_project_idx
  ON assertions (project_id);
CREATE INDEX IF NOT EXISTS assertions_subject_idx
  ON assertions (project_id, subject);
CREATE INDEX IF NOT EXISTS assertions_confidence_idx
  ON assertions (project_id, confidence DESC);


-- ============================================================================
-- EDGES — typed relationships between entities, extracted at /handoff:close.
-- Writer: Claude (session-end extraction) and manual writes by the Principal.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS edges (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  from_entity  TEXT NOT NULL,   -- entities.name (source)
  edge_type    TEXT NOT NULL,   -- e.g. 'depends_on', 'implements', 'blocks', 'owns'
  to_entity    TEXT NOT NULL,   -- entities.name (target)
  weight       FLOAT DEFAULT 1.0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id   TEXT
);
CREATE INDEX IF NOT EXISTS edges_project_idx
  ON edges (project_id);
CREATE INDEX IF NOT EXISTS edges_from_idx
  ON edges (project_id, from_entity);
CREATE INDEX IF NOT EXISTS edges_to_idx
  ON edges (project_id, to_entity);


-- ============================================================================
-- RETRIEVAL_CONTRACT — named retrieval plans executed by the SessionStart loader.
-- Each contract is a JSONB array of structured query objects. The loader walks
-- the array in order, executing each query against the appropriate table and
-- respecting the per-query token_budget.
--
-- Query object shape:
--   {
--     "kind": "entity" | "assertion" | "vector" | "recency",
--     "filter": { ... kind-specific filter fields ... },
--     "token_budget": <int>
--   }
--
-- /handoff:init inserts a default contract row for the project.
-- /handoff:close updates (or inserts) the default contract based on session state.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_contract (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,    -- e.g. 'default', 'deep_load', 'minimal'
  queries     JSONB NOT NULL,   -- array of query objects (see shape above)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS retrieval_contract_project_idx
  ON retrieval_contract (project_id);


-- ============================================================================
-- PROJECT_SETTINGS — per-project key/value configuration store.
-- Used by the SessionStart loader and /handoff subcommands to read tunable
-- settings such as staleness_days, decay_rate_default, implicit_close, and
-- loader_token_budget. Falls back to hardcoded defaults if a key is absent.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_settings (
  project_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- Known settings keys and their hardcoded defaults (used when row is absent):
--   staleness_days      default: '7'    (days before loader triggers staleness prompt)
--   decay_rate_default  default: '0.05' (per-day decay for new assertions lacking row-level override)
--   implicit_close      default: 'enabled' ('enabled'|'disabled' — Stop-hook behavior)
--   loader_token_budget default: '4000' (total tokens the SessionStart loader may inject)
