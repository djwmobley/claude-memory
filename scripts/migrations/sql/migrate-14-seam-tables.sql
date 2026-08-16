-- migrate-14-seam-tables.sql
--
-- Schema-setup-only (no data migration). Idempotent, re-runnable, no DROP
-- TABLE anywhere in this file. Ships CONSOLIDATION-RUNBOOK.md §5.3's 13
-- absorbed-seam tables (decisions, gotchas, findings, research, incidents,
-- code_index, tasks, checklist_items, corpus_files, workflow_discovery,
-- agent_rewrites, policy_sections, session_chunks), §5.9's
-- v_handoff_card_inputs view, and one narrow attribution fix to the
-- pre-existing audit_log table (see ROW_ID WIDENING below).
--
-- DOLLAR-QUOTE-FREE BY DESIGN (§7.9/S-16, claude-memory#159): this file is
-- the ONE passed to migrate-schema-addenda.js's exported verifyAddenda for
-- generic derived verification (tables, columns, CHECK constraints, plain
-- indexes, UNIQUE constraints). Its splitter (deriveSchemaAddenda) is NOT
-- dollar-quote-aware, so nothing in this file uses `DO $$ ... $$;`. The
-- embedding halfvec(4000) columns + their HNSW indexes (which DO need the
-- DO-block graceful-degradation pattern for a pgvector-absent target, per
-- §5.3's own closing note) are split into the SIBLING file
-- migrate-14-seam-tables-embeddings.sql, which is applied but NEVER passed
-- to verifyAddenda -- migrate-14-seam-tables.js verifies those objects with
-- its own targeted checks instead (mirroring migrate-13-agent-exchange.js's
-- D-3/D-4 pattern for agent_exchange.embedding).
--
-- TWO DEVIATIONS FROM §5.3's VERBATIM TEXT (both additive, both documented
-- here and in the authoring PR body -- see also migrate-14-seam-tables.js's
-- header comment):
--
--   1. code_index gains an `id SERIAL NOT NULL` column not present in §5.3's
--      text. §5.3 gives code_index a composite PRIMARY KEY (project_id,
--      path) and NO surrogate id column at all. §5.8.1's amendment (S-13)
--      requires the audit-trigger wiring set to land at EXACTLY 16 tables
--      (13 seam + assertions + edges + agent_exchange), and the SHARED
--      log_guarded_change() trigger function (migrate-13-agent-exchange.sql,
--      reused by reference, never forked) reads OLD.id/NEW.id -- a table
--      with no `id` column is structurally incompatible with that function
--      and migrate-13-agent-exchange.sql's own wiring DO-block already
--      refuses to wire a trigger onto any table lacking one (RAISE NOTICE
--      'deferred-incompatible', not a silent skip). Adding a plain,
--      non-primary-key SERIAL id column resolves the conflict without
--      touching the declared composite PRIMARY KEY or any other §5.3 column
--      -- every column §5.3 names is still present, unchanged, verbatim.
--
--   2. audit_log.row_id (originally BIGINT, PR #158) is widened to TEXT
--      here ("ROW_ID WIDENING" below). findings.id is TEXT by design (§5.3:
--      source-prefixed ids like "RT-INJ-001", composite PK (project_id,
--      id)) -- log_guarded_change()'s `VALUES (..., OLD.id, ...)` would
--      raise "column row_id is of type bigint but expression is of type
--      text" the first time findings is ever UPDATEd or DELETEd once wired
--      (empirically confirmed against a live Postgres instance while
--      authoring this file). TEXT is a strict widening: every existing
--      integer-shaped row_id value round-trips through `::text` losslessly,
--      and every OTHER wired table's id (all SERIAL/INTEGER) inserts into a
--      TEXT column via ordinary assignment coercion with no cast needed on
--      the trigger-function side (also empirically confirmed). No existing
--      audit_log consumer is known to depend on row_id's SQL type rather
--      than its textual value.
--
--      POST-REVIEW UPDATE (memory-manager#17): migrate-13-agent-exchange.sql
--      now declares row_id TEXT directly AND carries this exact same
--      idempotent ALTER itself (so its own generic self-verification
--      converges instead of permanently reporting a wrong-type-column FAIL
--      on every re-apply -- a genuine future drift on this column now
--      surfaces as a real FAIL again, as intended). This file's own copy of
--      the ALTER below is therefore harmless, redundant belt-and-suspenders
--      -- kept so this file's prerequisite ordering never silently depends
--      on migrate-13 having already run the widening.
--
-- PREREQUISITE: migrate-schema-addenda.js's addendum AND
-- migrate-13-agent-exchange.js's audit_log/log_guarded_change() must already
-- be applied to the target (migrate-14-seam-tables.js checks this before
-- applying anything -- see its header comment).

-- ============================================================================
-- ROW_ID WIDENING -- see deviation (2) above. Redundant with migrate-13-
-- agent-exchange.sql's own copy of this statement (post-review update) --
-- kept here too; a repeated idempotent ALTER is a proven no-op either way.
-- ============================================================================
ALTER TABLE audit_log ALTER COLUMN row_id TYPE TEXT USING row_id::text;

-- ============================================================================
-- §5.3 SEAM TABLES (embedding columns deliberately omitted here -- see
-- migrate-14-seam-tables-embeddings.sql).
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

CREATE TABLE IF NOT EXISTS gotchas (
  id             SERIAL PRIMARY KEY,
  project_id     TEXT NOT NULL,
  issue          TEXT NOT NULL,
  rule           TEXT NOT NULL,
  active         BOOLEAN DEFAULT TRUE,
  source_model   TEXT,
  agent_id       TEXT,
  authoring_mode TEXT NOT NULL DEFAULT 'caveman' CHECK (authoring_mode IN ('caveman','verbose')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gotchas_project_idx ON gotchas (project_id);
ALTER TABLE gotchas ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(issue,'') || ' ' || coalesce(rule,''))) STORED;
CREATE INDEX IF NOT EXISTS gotchas_fts_idx ON gotchas USING gin(fts_vec);

CREATE TABLE IF NOT EXISTS findings (
  id                  TEXT NOT NULL,       -- source-prefixed id, e.g. RT-INJ-001; NOT globally unique once cross-project
  project_id          TEXT NOT NULL,
  source              TEXT NOT NULL,
  severity            TEXT NOT NULL,
  confidence          TEXT NOT NULL,
  location            TEXT NOT NULL,
  category            TEXT NOT NULL,
  description         TEXT NOT NULL,
  impact              TEXT NOT NULL,
  remediation         TEXT NOT NULL,
  effort              TEXT NOT NULL,
  verification_domain TEXT,
  status              TEXT DEFAULT 'triaged',
  github_issue        INTEGER,
  commit_sha          TEXT,
  task_id             INTEGER,             -- FK to tasks.id, same DB now -- see tasks table below
  report_path         TEXT,
  source_model        TEXT,
  agent_id            TEXT,
  authoring_mode      TEXT NOT NULL DEFAULT 'caveman' CHECK (authoring_mode IN ('caveman','verbose')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, id)             -- composite PK: id is only unique WITHIN a project
);
CREATE INDEX IF NOT EXISTS findings_project_idx ON findings (project_id);
CREATE INDEX IF NOT EXISTS findings_status_idx  ON findings (project_id, status);
CREATE INDEX IF NOT EXISTS findings_source_idx  ON findings (project_id, source);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', description || ' ' || impact || ' ' || remediation)) STORED;
CREATE INDEX IF NOT EXISTS findings_fts_idx ON findings USING gin(fts_vec);

CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT DEFAULT 'pending',
  phase         TEXT DEFAULT 'backlog',
  priority      TEXT DEFAULT 'medium',
  github_issue  INTEGER,
  readme_label  TEXT,
  category      TEXT DEFAULT 'internal',
  source_model  TEXT,
  agent_id      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id);

CREATE TABLE IF NOT EXISTS research (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  task_id      INTEGER REFERENCES tasks(id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  source_model TEXT,
  agent_id     TEXT,
  authoring_mode TEXT NOT NULL DEFAULT 'verbose' CHECK (authoring_mode IN ('caveman','verbose')),  -- default VERBOSE: research is long-form by nature (§3.3)
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_project_idx ON research (project_id);

CREATE TABLE IF NOT EXISTS incidents (
  id             SERIAL PRIMARY KEY,
  project_id     TEXT NOT NULL,
  incident_code  TEXT,
  title          TEXT NOT NULL,
  what_happened  TEXT,
  what_we_did    TEXT,
  watch_for      TEXT,
  source_model   TEXT,
  agent_id       TEXT,
  authoring_mode TEXT NOT NULL DEFAULT 'caveman' CHECK (authoring_mode IN ('caveman','verbose')),
  occurred_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, incident_code)
);
CREATE INDEX IF NOT EXISTS incidents_project_idx ON incidents (project_id);

-- Deviation (1) -- see file header. `id SERIAL NOT NULL` added; the declared
-- composite PRIMARY KEY (project_id, path) is unchanged.
CREATE TABLE IF NOT EXISTS code_index (
  id          SERIAL NOT NULL,
  project_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  description TEXT NOT NULL,
  source_model TEXT,
  agent_id    TEXT,
  PRIMARY KEY (project_id, path)
);
ALTER TABLE code_index ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', description)) STORED;
CREATE INDEX IF NOT EXISTS code_index_fts_idx ON code_index USING gin(fts_vec);

CREATE TABLE IF NOT EXISTS checklist_items (
  id                SERIAL PRIMARY KEY,
  project_id        TEXT NOT NULL,
  checklist_name    TEXT NOT NULL,
  cadence           TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  verification_step TEXT,
  source_model      TEXT,
  agent_id          TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checklist_items_project_idx ON checklist_items (project_id);

CREATE TABLE IF NOT EXISTS corpus_files (
  id            SERIAL PRIMARY KEY,
  project_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  file_type     TEXT,
  source_domain TEXT,
  summary       TEXT,
  bytes         BIGINT,
  source_model  TEXT,
  agent_id      TEXT,
  ingested_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS corpus_files_project_idx ON corpus_files (project_id);

CREATE TABLE IF NOT EXISTS workflow_discovery (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  step         TEXT,
  item_type    TEXT,
  number       INTEGER,
  title        TEXT NOT NULL,
  detail       TEXT,
  status       TEXT DEFAULT 'open',
  persona      TEXT,
  source_model TEXT,
  agent_id     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workflow_discovery_project_idx ON workflow_discovery (project_id);

CREATE TABLE IF NOT EXISTS agent_rewrites (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  agent_name   TEXT NOT NULL,
  skill_path   TEXT,
  as_is        TEXT,
  to_be        TEXT,
  gap          TEXT,
  effort       TEXT,
  depends_on   TEXT,
  status       TEXT DEFAULT 'pending',
  source_model TEXT,
  agent_id     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_rewrites_project_idx ON agent_rewrites (project_id);

CREATE TABLE IF NOT EXISTS policy_sections (
  id            SERIAL PRIMARY KEY,
  project_id    TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  section_num   TEXT,
  section_title TEXT,
  content       TEXT NOT NULL,
  source_path   TEXT,
  chunk_idx     INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT,
  source_model  TEXT,
  agent_id      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, doc_id, section_num, chunk_idx)
);
CREATE INDEX IF NOT EXISTS policy_sections_project_idx ON policy_sections (project_id);

CREATE TABLE IF NOT EXISTS session_chunks (
  id             SERIAL PRIMARY KEY,
  project_id     TEXT NOT NULL,
  session_num    INTEGER,
  session_id     TEXT,
  chunk_idx      INTEGER NOT NULL,
  chunk_kind     TEXT,
  content        TEXT NOT NULL,
  source_jsonl   TEXT,
  source_model   TEXT,
  agent_id       TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, session_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS session_chunks_project_idx ON session_chunks (project_id);

-- ============================================================================
-- §5.9 Fat-card render view -- S-14 defense-in-depth predicate included.
-- Plain CREATE OR REPLACE VIEW, no dollar quoting.
-- ============================================================================
CREATE OR REPLACE VIEW v_handoff_card_inputs AS
  SELECT project_id, predicate, subject, object, carryover_status, pinned, created_at, confidence
  FROM assertions
  WHERE suppressed = false
    AND invalid_at IS NULL
    AND predicate IN ('open_thread','next_step','session_tldr','quick_reference',
                       'run_commands','critical_operational_notes','key_paths')
    AND (carryover_status IS NULL OR carryover_status <> 'resolved')
  ORDER BY project_id, predicate, created_at DESC;
