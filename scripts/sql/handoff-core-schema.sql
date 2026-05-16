-- ============================================================================
-- handoff-core-schema.sql
--
-- Portable handoff-core schema for the /handoff skill.
--
-- Applied automatically by `/handoff:init` (node scripts/handoff.js init).
-- Pure stock Postgres — no extensions, no halfvec, no pgvector dependency.
-- Requires Postgres >= 13. Safe to re-apply (all statements use IF NOT EXISTS
-- or ADD COLUMN IF NOT EXISTS). Idempotent on both fresh and existing DBs.
--
-- Tables: entities, assertions, edges, retrieval_contract, project_settings.
-- These five tables are the handoff-core — they support the /handoff skill on
-- any Postgres instance without app-specific extensions.
--
-- App-specific tables (retrieval_events with halfvec(4000), memory_entry_chunks
-- blurb column) live in separate files and are NOT applied by this script.
-- ============================================================================


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
-- suppressed: explicit suppression flag set by /handoff:drop. Rows with
-- suppressed = true are excluded from retrieval without deletion (recoverable).
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
-- Add suppressed column if not present (idempotent — safe on both fresh and existing DBs).
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT false;
-- Add outcome_bias column if not present (Bundle C1 — unused by retrieval yet; observability placeholder).
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS outcome_bias FLOAT NOT NULL DEFAULT 0;

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

-- Add version column to retrieval_contract for change tracking (idempotent — safe on both fresh and existing DBs).
ALTER TABLE retrieval_contract ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- ============================================================================
-- RETRIEVAL_CONTRACT_HISTORY — audit log of every contract change.
-- One row per version bump. Populated by recordContractChange() in handoff.js.
-- Portable (no pgvector). Idempotent (CREATE TABLE IF NOT EXISTS).
-- project_id = encoded_cwd; name = retrieval_contract.name.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_contract_history (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  queries     JSONB NOT NULL,
  change_note TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retrieval_contract_history_idx
  ON retrieval_contract_history (project_id, name, version);


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
--   staleness_days             default: '7'         (days before loader triggers staleness prompt)
--   loader_token_budget        default: '4000'      (total tokens the SessionStart loader may inject)
--   implicit_close             default: 'enabled'   ('enabled'|'disabled' — Stop-hook behavior)
--   decay_rate_default         default: '0.05'      (per-day decay for new assertions lacking row-level override)
--   cluster_aware_retrieval    default: 'enabled'   ('enabled'|any other value — W3 cluster-aware expansion)
--   cluster_max_siblings       default: '10'        (max same-community sibling entities added per load)


-- ============================================================================
-- ENTITY_COMMUNITIES — community membership assignments produced by Leiden
-- community detection (Bundle B W3). One row per entity per detection run.
-- Populated by scripts/bundleb-w3-communities.js (gated, optional infra).
-- If this table has no rows for a project, the loader's cluster-aware expansion
-- is a guaranteed no-op — pre-W3 output is byte-identical (no regression).
--
-- Portable (no pgvector). Idempotent (CREATE TABLE IF NOT EXISTS).
-- project_id = encoded_cwd; entity_name = entities.name (TEXT, not FK).
-- ============================================================================
CREATE TABLE IF NOT EXISTS entity_communities (
  id            SERIAL PRIMARY KEY,
  project_id    TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  community_id  INTEGER NOT NULL,
  level         INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_communities_lookup_idx
  ON entity_communities (project_id, entity_name);
CREATE INDEX IF NOT EXISTS entity_communities_run_idx
  ON entity_communities (project_id, run_id);
