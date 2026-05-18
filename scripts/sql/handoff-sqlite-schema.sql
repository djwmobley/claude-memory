-- ============================================================================
-- handoff-sqlite-schema.sql
--
-- SQLite-compatible handoff-core schema.
--
-- Applied automatically by handoff.js init when STORAGE_BACKEND=sqlite.
-- Pure SQLite -- no extensions. Idempotent (IF NOT EXISTS / IF NOT EXISTS).
-- Requires SQLite >= 3.37.0 (Dec 2021, for ADD COLUMN IF NOT EXISTS).
-- All current Node.js LTS versions ship sqlite >= 3.45.
--
-- Corresponds to handoff-core-schema.sql (Postgres version) minus pgvector,
-- halfvec, and WITH RECURSIVE ARRAY[] path syntax.
--
-- Dialect notes (vs Postgres):
--   - SERIAL PRIMARY KEY -> INTEGER PRIMARY KEY  (SQLite autoincrement)
--   - TIMESTAMPTZ        -> TEXT  (stored as ISO 8601 strings by the driver)
--   - JSONB              -> TEXT  (serialized by db-seam.js on write/read)
--   - FLOAT              -> REAL
--   - BOOLEAN            -> INTEGER (0/1 -- SQLite has no native BOOLEAN)
--   - Partial unique indexes use WHERE clause (SQLite supports since 3.8.9)
--   - SERIAL counter resets on INSERT; the seam uses last_insert_rowid()
-- ============================================================================


-- ============================================================================
-- ENTITIES
-- ============================================================================
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,
  description TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  session_id  TEXT,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS entities_project_idx ON entities (project_id);
CREATE INDEX IF NOT EXISTS entities_name_idx    ON entities (project_id, name);


-- ============================================================================
-- ASSERTIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS assertions (
  id               INTEGER PRIMARY KEY,
  project_id       TEXT    NOT NULL,
  subject          TEXT    NOT NULL,
  predicate        TEXT    NOT NULL,
  object           TEXT    NOT NULL,
  confidence       REAL    NOT NULL
                     CHECK (confidence >= 1.0 AND confidence <= 10.0),
  last_reinforced  TEXT    NOT NULL DEFAULT (datetime('now')),
  last_retrieved   TEXT,
  decay_rate       REAL    NOT NULL DEFAULT 0.05,
  source           TEXT    NOT NULL
                     CHECK (source IN (
                       'user_stated',
                       'model_extracted',
                       'doc_quoted',
                       'retrieved_from_prior'
                     )),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  session_id       TEXT,
  suppressed       INTEGER NOT NULL DEFAULT 0,
  outcome_bias     REAL    NOT NULL DEFAULT 0,
  promoted         INTEGER NOT NULL DEFAULT 0,
  promoted_at      TEXT
);
CREATE INDEX IF NOT EXISTS assertions_project_idx    ON assertions (project_id);
CREATE INDEX IF NOT EXISTS assertions_subject_idx    ON assertions (project_id, subject);
CREATE INDEX IF NOT EXISTS assertions_confidence_idx ON assertions (project_id, confidence DESC);

-- 1:1 partial unique index (same predicate set as Postgres version)
CREATE UNIQUE INDEX IF NOT EXISTS assertions_1to1_unique
  ON assertions (project_id, subject, predicate)
  WHERE suppressed = 0
    AND predicate IN (
      'README_roadmap_scope',
      'added_via',
      'affirmed',
      'are_safe_outside_claude-memory',
      'chose',
      'cmdDrop_refactor',
      'converged',
      'created_by',
      'currently_at',
      'default',
      'defaults_to',
      'defined_as',
      'elevates_to',
      'evaluates_at',
      'false_positive',
      'fixed_in',
      'has_unpackaged_state',
      'is_at_commit',
      'is_authoritative_db',
      'is_cleared_by',
      'is_direction',
      'is_exactly',
      'is_model',
      'is_status',
      'is_value',
      'matching_algorithm',
      'moved_to',
      'must_mean',
      'now_uses',
      'orchestrates_only',
      'phase_ordering',
      'prefers',
      'schema_migration_is',
      'shipped_at',
      'skipped',
      'usage',
      'user_chose',
      'user_directed',
      'uses_db'
    );

-- 1:N exact-duplicate index
CREATE UNIQUE INDEX IF NOT EXISTS assertions_1ton_exact_unique
  ON assertions (project_id, subject, predicate, object)
  WHERE suppressed = 0;


-- ============================================================================
-- EDGES
-- ============================================================================
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT    NOT NULL,
  from_entity TEXT    NOT NULL,
  edge_type   TEXT    NOT NULL,
  to_entity   TEXT    NOT NULL,
  weight      REAL    DEFAULT 1.0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  session_id  TEXT
);
CREATE INDEX IF NOT EXISTS edges_project_idx ON edges (project_id);
CREATE INDEX IF NOT EXISTS edges_from_idx    ON edges (project_id, from_entity);
CREATE INDEX IF NOT EXISTS edges_to_idx      ON edges (project_id, to_entity);


-- ============================================================================
-- RETRIEVAL_CONTRACT
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_contract (
  id         INTEGER PRIMARY KEY,
  project_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  queries    TEXT    NOT NULL,  -- JSON (JSONB in Postgres)
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  version    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS retrieval_contract_project_idx ON retrieval_contract (project_id);


-- ============================================================================
-- RETRIEVAL_CONTRACT_HISTORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_contract_history (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  queries     TEXT    NOT NULL,  -- JSON
  change_note TEXT,
  changed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS retrieval_contract_history_idx
  ON retrieval_contract_history (project_id, name, version);


-- ============================================================================
-- PROJECT_SETTINGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);


-- ============================================================================
-- ENTITY_COMMUNITIES (W3)
-- ============================================================================
CREATE TABLE IF NOT EXISTS entity_communities (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT    NOT NULL,
  entity_name  TEXT    NOT NULL,
  community_id INTEGER NOT NULL,
  level        INTEGER NOT NULL DEFAULT 0,
  run_id       TEXT    NOT NULL,
  computed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS entity_communities_lookup_idx
  ON entity_communities (project_id, entity_name);
CREATE INDEX IF NOT EXISTS entity_communities_run_idx
  ON entity_communities (project_id, run_id);


-- ============================================================================
-- EXTRACTION_QUEUE
-- ============================================================================
CREATE TABLE IF NOT EXISTS extraction_queue (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT    NOT NULL,
  payload      TEXT    NOT NULL,  -- JSON
  source_ref   TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done', 'error')),
  enqueued_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  error_detail TEXT
);
CREATE INDEX IF NOT EXISTS extraction_queue_project_status_idx
  ON extraction_queue (project_id, status);


-- ============================================================================
-- RETRIEVAL_EVENTS  (no query_embedding column -- halfvec removed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_events (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT    NOT NULL,
  query_text     TEXT    NOT NULL,
  retrieved_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  outcome        TEXT    DEFAULT 'pending'
                   CHECK (outcome IN ('pending','success','failure','irrelevant')),
  outcome_at     TEXT,
  outcome_signal TEXT,
  session_id     TEXT,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS retrieval_events_project_idx ON retrieval_events (project_id);
CREATE INDEX IF NOT EXISTS retrieval_events_outcome_idx ON retrieval_events (outcome)
  WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS retrieval_events_time_idx    ON retrieval_events (retrieved_at DESC);


-- ============================================================================
-- RETRIEVAL_EVENT_ASSERTIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_event_assertions (
  event_id     INTEGER NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
  assertion_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rea_event_idx     ON retrieval_event_assertions (event_id);
CREATE INDEX IF NOT EXISTS rea_assertion_idx ON retrieval_event_assertions (assertion_id);