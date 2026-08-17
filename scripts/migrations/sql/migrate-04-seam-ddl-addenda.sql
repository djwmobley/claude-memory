-- migrate-04-seam-ddl-addenda.sql
--
-- Bundled DDL preamble for migrate-04-absorb-pipeline-tables.js (§6.1(e) +
-- its E-1..E-15 spec-adversary amendment, mm#11(e)). Idempotent,
-- re-runnable, no DROP TABLE anywhere in this file (§6.0's preservation
-- guarantee). Applied via migrateOne.applySqlFile, mirroring migrate-08's
-- "bundle this DDL as this script's preamble" precedent rather than a
-- separate migration file (migrate-04's own header comment documents this
-- choice).
--
-- FOUR THINGS THIS FILE DOES:
--
--   1. (E-2, RESOLVED owner 2026-08-16) Creates `sessions` as the 14th
--      absorbed-seam table — a total scope hole in the base runbook (136
--      live rows across 5 source DBs, zero covering migration phase). Mirrors
--      §1.2's source shape (id, num, date, tests, summary, project, embedding
--      vector(1024), fts_vec) plus the standard project_id/source_model/
--      agent_id additions AND an authoring_mode column (owner directive:
--      "following the gotchas/findings pattern so grandfathering works from
--      day one" — session summaries are long-form by nature, so
--      default_authoring_mode='verbose', the SAME reasoning §5.3 already
--      gives `research`). `num`/`date` are renamed `session_num`/
--      `session_date` at the target (matches `session_chunks.session_num`'s
--      existing naming convention; avoids `date` as a bare column name).
--      `project` (a pipeline-side free-text hint, present in 2 of 3 source
--      DBs, absent in `claude_context` per the live E-pass census) is kept as
--      `source_project_hint`, mirroring `decisions.source_project_hint`'s
--      audit-trail pattern exactly.
--
--   2. (E-9, RESOLVED owner 2026-08-16) `migrated_legacy BOOLEAN NOT NULL
--      DEFAULT false` escape column on the 5 §5.3 seam tables that have NO
--      `authoring_mode` column at all (tasks, code_index, checklist_items,
--      workflow_discovery, agent_rewrites) — the grandfather clause §6.1(e)
--      step 3 specifies ("authoring_mode='verbose' for pre-existing rows")
--      is a hard SQL error against these 5 (column does not exist), and 5 of
--      them (see caveman-columns.json) are ALSO classified
--      mandatory-caveman-no-column with zero other escape hatch. This column
--      is set true on every row THIS migration inserts;
--      verify-15-t7-caveman-economy.js's store-wide gate is taught to skip
--      migrated_legacy=true rows (see test-caveman-economy-store-wide.js's
--      diff in this same PR). Byte-preservation (T3) is untouched — this is
--      an attribution flag, never a content rewrite.
--
--   3. (E-4/E-7, RESOLVED per the amendment) Supersedes the UNIQUE/PRIMARY
--      KEY constraints on `incidents`, `corpus_files`, `code_index`,
--      `policy_sections`, `session_chunks` — live-verified collision
--      (`policy_sections`, 34 doc_id groups, worst case 16 REAL DISTINCT rows
--      sharing one natural key; same defect class as PR #179's I-10) proves
--      the natural-key upsert §6.1(e) step 4 specifies is fatal-by-
--      construction for at least one table and structurally exposed for the
--      other four. Fixed via the SAME I-10 -> PR #179 pattern: plain
--      non-unique index for query performance, idempotency enforced at the
--      application layer via pipeline_migration_row_ids lineage (E-6)
--      instead of the DB constraint. `code_index` specifically: its
--      composite PRIMARY KEY (project_id, path) is replaced with its
--      EXISTING (migrate-14 deviation 1) plain `id SERIAL NOT NULL` column
--      promoted to a real PRIMARY KEY, since a PK cannot be dropped without
--      breaking row identity and that column already exists for the
--      audit-trigger's OLD.id/NEW.id requirement — no new column needed.
--
--   4. LOSSLESS-FIDELITY ADDITIVE COLUMNS — a finding this PR's author made
--      by diffing LIVE information_schema.columns across all three REAL-
--      MIGRATE source DBs (claude_policy_framework / pipeline_pipeline /
--      claude_context) against §5.3's declared target shapes, beyond what
--      the E-pass adversary's row-count-only census checked. §5.3's own
--      comment claims each seam table "carries forward its pipeline column
--      shape verbatim... so field-mapping in §6 is a straight copy, not a
--      reshape" — live-verified FALSE at the column level: `incidents`,
--      `checklist_items`, `corpus_files`, `policy_sections`, `session_chunks`,
--      and `tasks` each carry at least one column in at least one source DB
--      that has NO corresponding §5.3 target column at all. §6.0's
--      preservation guarantee ("nothing is deleted, ever") forbids silently
--      dropping that data on migration. Every column below is NULLABLE and
--      ADDITIVE (never touches an existing column), and every one is
--      classified in caveman-columns.json in the SAME PR (K-8 same-change
--      rule) — see migrate-04-absorb-pipeline-tables.js's COLUMN_MAPS
--      constant for the exact per-(source_db,table) provenance of each:
--        incidents:        + status TEXT, memory_refs TEXT[], playbook_refs TEXT[]
--                             (claude_policy_framework only; occurred_at
--                             already covers claude_policy_framework's
--                             incident_date via a rename, not an extra column)
--        checklist_items:  + item_num TEXT, owner_name TEXT, source_file TEXT,
--                             content_hash TEXT (claude_policy_framework only)
--        corpus_files:     + sha256 TEXT (claude_policy_framework only;
--                             size_bytes/last_indexed are RENAMES onto the
--                             existing bytes/ingested_at columns, not extras)
--        policy_sections:  + last_modified TIMESTAMPTZ (claude_policy_framework
--                             only; source_file is a RENAME onto the existing
--                             source_path column, not an extra)
--        session_chunks:   + content_hash TEXT, section_idx INTEGER (BOTH
--                             source DBs carry content_hash; section_idx is
--                             claude_policy_framework-only, a genuinely
--                             distinct concept from session_num/chunk_idx —
--                             see migrate-04's header comment)
--        tasks:            + notes TEXT, blocker TEXT (claude_context only)
--      A precondition check in migrate-04-absorb-pipeline-tables.js (never
--      trust this list alone) diffs EVERY in-scope (source_db, table)'s live
--      columns against this file's declared shape at run time and refuses
--      loud on any column neither of us accounted for — never a silent drop
--      of a column shape that drifts after this PR merges.

-- ── (1) sessions: 14th absorbed-seam table (E-2) ──────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                   SERIAL PRIMARY KEY,
  project_id           TEXT NOT NULL,
  session_num          INTEGER,
  session_date         DATE,
  tests                INTEGER,
  summary              TEXT,
  source_project_hint  TEXT,
  source_model         TEXT,
  agent_id             TEXT,
  authoring_mode       TEXT NOT NULL DEFAULT 'verbose' CHECK (authoring_mode IN ('caveman','verbose')),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  embedding            halfvec(4000)
);
CREATE INDEX IF NOT EXISTS sessions_project_idx     ON sessions (project_id);
CREATE INDEX IF NOT EXISTS sessions_project_num_idx ON sessions (project_id, session_num);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(summary,''))) STORED;
CREATE INDEX IF NOT EXISTS sessions_fts_idx ON sessions USING gin(fts_vec);

-- ── (2) migrated_legacy escape column on the 5 no-authoring_mode tables (E-9) ─
ALTER TABLE tasks              ADD COLUMN IF NOT EXISTS migrated_legacy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE code_index         ADD COLUMN IF NOT EXISTS migrated_legacy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE checklist_items    ADD COLUMN IF NOT EXISTS migrated_legacy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workflow_discovery ADD COLUMN IF NOT EXISTS migrated_legacy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_rewrites     ADD COLUMN IF NOT EXISTS migrated_legacy BOOLEAN NOT NULL DEFAULT false;

-- ── (3) supersede UNIQUE/PK on 5 tables to plain indexes (E-4/E-7) ────────
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_project_id_incident_code_key;
CREATE INDEX IF NOT EXISTS incidents_project_id_incident_code_idx ON incidents (project_id, incident_code);

ALTER TABLE corpus_files DROP CONSTRAINT IF EXISTS corpus_files_project_id_path_key;
CREATE INDEX IF NOT EXISTS corpus_files_project_id_path_idx ON corpus_files (project_id, path);

ALTER TABLE policy_sections DROP CONSTRAINT IF EXISTS policy_sections_project_id_doc_id_section_num_chunk_idx_key;
CREATE INDEX IF NOT EXISTS policy_sections_project_id_doc_id_section_num_chunk_idx_idx
  ON policy_sections (project_id, doc_id, section_num, chunk_idx);

ALTER TABLE session_chunks DROP CONSTRAINT IF EXISTS session_chunks_project_id_session_id_chunk_idx_key;
CREATE INDEX IF NOT EXISTS session_chunks_project_id_session_id_chunk_idx_idx
  ON session_chunks (project_id, session_id, chunk_idx);

-- code_index: composite PK -> its EXISTING plain `id` column (migrate-14
-- deviation 1) promoted to the real PRIMARY KEY; declared composite PK
-- dropped; plain (non-unique) index added for query performance.
ALTER TABLE code_index DROP CONSTRAINT IF EXISTS code_index_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'code_index'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE code_index ADD CONSTRAINT code_index_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS code_index_project_id_path_idx ON code_index (project_id, path);

-- ── (4) lossless-fidelity additive columns (live schema-diff finding) ─────
ALTER TABLE incidents        ADD COLUMN IF NOT EXISTS status         TEXT;
ALTER TABLE incidents        ADD COLUMN IF NOT EXISTS memory_refs    TEXT[];
ALTER TABLE incidents        ADD COLUMN IF NOT EXISTS playbook_refs  TEXT[];
ALTER TABLE checklist_items  ADD COLUMN IF NOT EXISTS item_num       TEXT;
ALTER TABLE checklist_items  ADD COLUMN IF NOT EXISTS owner_name     TEXT;
ALTER TABLE checklist_items  ADD COLUMN IF NOT EXISTS source_file    TEXT;
ALTER TABLE checklist_items  ADD COLUMN IF NOT EXISTS content_hash   TEXT;
ALTER TABLE corpus_files     ADD COLUMN IF NOT EXISTS sha256         TEXT;
ALTER TABLE policy_sections  ADD COLUMN IF NOT EXISTS last_modified  TIMESTAMPTZ;
ALTER TABLE session_chunks   ADD COLUMN IF NOT EXISTS content_hash   TEXT;
ALTER TABLE session_chunks   ADD COLUMN IF NOT EXISTS section_idx    INTEGER;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS notes          TEXT;
ALTER TABLE tasks            ADD COLUMN IF NOT EXISTS blocker        TEXT;
