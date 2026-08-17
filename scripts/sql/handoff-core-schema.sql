-- handoff:dialect postgres
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
-- Writer: Claude (session-end extraction) and manual writes by the maintainer.
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
-- Add promoted / promoted_at columns if not present (mirrors SQLite schema; used by cmdPromote).
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

-- ── PR-B bi-temporal supersession + suppression_kind + pinned-exemption ───────
--
-- Additive, NULL-tolerant additions.  Existing rows are left untouched — any
-- missing value is NULL and is handled gracefully by all read paths.
-- No UPDATE or DELETE of existing data (§7 SKIP; honors no-backfill rule).
--
-- valid_at   — when the assertion became live (set = now() on INSERT going forward).
--              NULL for rows written before this migration.
-- invalid_at — when the assertion was superseded or invalidated (NULL = still valid).
--              Standard retrieval excludes rows where invalid_at IS NOT NULL.
-- suppression_kind — reason for suppression:
--              'superseded'          cardinality-driven (1:1 predicate replaced by newer row)
--              'downvoted_terminal'  C2 auto-downvote; not auto-revivable
--              'downvoted_probation' C2 auto-downvote soft-exclusion; revivable by positive feedback
--              'retired'             operator-retired via cmdRetire (L5); non-destructive; row
--                                    is excluded from retrieval but retained and recoverable
--              NULL when the row is live (not suppressed).
-- pinned     — if true, the assertion is NEVER auto-suppressed/auto-downvoted by the C2 path.
--              Explicit cardinality-driven supersession (user re-stating a 1:1 predicate) MAY
--              still supersede a pinned row — pinned blocks AUTO actions only, not explicit writes.
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS valid_at TIMESTAMPTZ;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS suppression_kind TEXT;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

-- ── Two-tier durability: probationary → consolidated ──────────────────────────
--
-- Additive, NULL-tolerant additions.  Existing rows are left untouched — any
-- missing value is NULL and is handled gracefully by all read/ranking paths.
-- No UPDATE or DELETE of existing data (§7 SKIP; honors no-backfill rule).
--
-- GRANDFATHER RULE (CRITICAL — §7 compliance):
--   tier IS NULL means the row predates this migration and MUST be treated as
--   'consolidated' by every read/ranking path. A NULL tier row is never penalized
--   in retrieval ordering. NEVER issue an UPDATE that sets tier on pre-existing rows.
--   New columns are added with ADD COLUMN IF NOT EXISTS exactly mirroring the
--   existing pinned precedent above.
--
-- tier          — 'probationary' | 'consolidated' | NULL (grandfathered = consolidated).
--                 New assertions enter 'probationary' by default unless the Hybrid
--                 consolidation trigger fires:
--                   (a) source='user_stated' AND confidence >= 9 → 'consolidated' immediately.
--                   (b) 1:N cross-session corroboration: same (subject, predicate, object)
--                       asserted from a DISTINCT non-null session_id → 'consolidated'.
--                 Explicit /handoff:promote also sets tier='consolidated'.
-- consolidated_at — timestamp when tier was set to 'consolidated'; NULL until graduation.
-- corroboration_count — starts at 1; incremented when cross-session corroboration fires
--                       (new count = max corroboration_count among matched priors + 1).
--                       Observability signal for multi-session fact convergence.
--
-- Retrieval behavior:
--   When tier_aware_retrieval='enabled' (default): consolidated/NULL rows rank above
--   probationary rows via CASE WHEN tier='probationary' THEN 1 ELSE 0 END ASC prefix
--   in ORDER BY. Probationary rows are NEVER filtered out — only re-ranked.
--   When tier_aware_retrieval is any other value: ORDER BY is byte-identical to pre-feature
--   SQL (no CASE WHEN tier term at all). Guaranteed by the gate design.
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS tier TEXT
  CHECK (tier IN ('probationary', 'consolidated'));
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ;
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS corroboration_count INTEGER NOT NULL DEFAULT 1;

-- ── suppression_kind CHECK — single authoritative block ──────────────────────
--
-- DESIGN PRINCIPLE — MONOTONIC WIDENING:
--   The CHECK constraint on suppression_kind must NEVER be re-added with a value
--   set narrower than values already present in the table.  On any DB that has an
--   assertions row with suppression_kind='reality_reconciled', installing a 4-value
--   CHECK (omitting that value) fails with "check constraint ... is violated by some
--   row", aborting the entire Phase A transaction before the widening step can run.
--
--   The fix: define the constraint in EXACTLY ONE PLACE — this DO block — with the
--   full canonical 5-value set.  The ADD COLUMN IF NOT EXISTS above adds the column
--   with no inline CHECK so that fresh-DB and existing-DB paths both reach this block
--   without any intermediate narrow constraint in flight.
--
-- IDEMPOTENCY:
--   The block first drops any existing CHECK constraint that references
--   suppression_kind (by any name — catches auto-generated names from older schema
--   revisions).  It then re-adds the constraint with the canonical name and the full
--   5-value set.  A duplicate_object error (constraint already exists with identical
--   definition) is caught and silently ignored.
--
-- CANONICAL VALUE SET (authoritative — edit here when adding new values):
--   superseded            cardinality-driven (1:1 predicate replaced by newer row)
--   downvoted_terminal    C2 auto-downvote; not auto-revivable
--   downvoted_probation   C2 auto-downvote soft-exclusion; revivable by positive feedback
--   retired               operator-retired via cmdRetire (L5); non-destructive
--   reality_reconciled    close-time mismatch reconciliation; audit trail distinct from supersession
--
-- Constraint name: assertions_suppression_kind_check  (Postgres auto-name for a
-- column-level CHECK on the assertions table).
DO $$
DECLARE
  r RECORD;
  current_def TEXT;
BEGIN
  -- Fast no-op path (R-7 lock-budget guard): if the constraint already exists
  -- under its canonical name with the exact canonical 5-value definition, skip
  -- the drop+recreate entirely -- the steady-state case (already-current DB)
  -- takes zero row locks and does not touch pg_constraint at all.
  --
  -- cm#185 review N6: this fast path checks ONLY the canonically-named
  -- constraint (assertions_suppression_kind_check). If some OTHER, narrower
  -- CHECK constraint on suppression_kind coexists under a different name
  -- (e.g. hand-added out-of-band, or left over from a schema revision this
  -- comment predates), the fast path returns without dropping that other
  -- constraint, and a canonically-widened definition still applies alongside
  -- it -- the narrower one would still reject a value it excludes even though
  -- the canonical one accepts it. This is believed unreachable via any path
  -- this engine itself takes (the DROP loop below is the only other writer
  -- of a suppression_kind CHECK, and it always targets the canonical name),
  -- but is flagged here given this exact constraint's history (#124,
  -- test-schema-suppression-kind.js) of ordering/narrowing bugs.
  SELECT pg_get_constraintdef(con.oid) INTO current_def
  FROM   pg_constraint con
  JOIN   pg_class      rel ON rel.oid = con.conrelid
  JOIN   pg_namespace  ns  ON ns.oid  = rel.relnamespace
  WHERE  con.contype   = 'c'
    AND  rel.relname   = 'assertions'
    AND  ns.nspname    = current_schema()
    AND  con.conname   = 'assertions_suppression_kind_check';

  IF current_def IS NOT NULL
     AND current_def LIKE '%superseded%'
     AND current_def LIKE '%downvoted_terminal%'
     AND current_def LIKE '%downvoted_probation%'
     AND current_def LIKE '%retired%'
     AND current_def LIKE '%reality_reconciled%' THEN
    RETURN;
  END IF;

  -- Drop any existing CHECK constraint that references suppression_kind.
  FOR r IN
    SELECT con.conname
    FROM   pg_constraint con
    JOIN   pg_class      rel ON rel.oid = con.conrelid
    JOIN   pg_namespace  ns  ON ns.oid  = rel.relnamespace
    WHERE  con.contype   = 'c'
      AND  rel.relname   = 'assertions'
      AND  ns.nspname    = current_schema()
      AND  pg_get_constraintdef(con.oid) LIKE '%suppression_kind%'
  LOOP
    EXECUTE 'ALTER TABLE assertions DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
  END LOOP;

  -- Add the full canonical CHECK (idempotent: catch duplicate-constraint error).
  BEGIN
    ALTER TABLE assertions
      ADD CONSTRAINT assertions_suppression_kind_check
        CHECK (suppression_kind IN ('superseded','downvoted_terminal','downvoted_probation','retired','reality_reconciled'));
  EXCEPTION
    WHEN duplicate_object THEN NULL;  -- constraint already present with identical definition
  END;
END $$;

-- ── L3 reality-check tag (additive, NULL-tolerant) ────────────────────────────
--
-- Additive, NULL-tolerant addition.  Existing rows are left untouched — any
-- missing value is NULL and is handled gracefully by all read paths.
-- No UPDATE or DELETE of existing data (§7 SKIP; honors no-backfill rule).
--
-- reality_check — result of the non-mutating verify pass run at /handoff:close:
--   'verified'      probe ran and returned a value matching the asserted object
--   'mismatch'      probe ran and returned a value NOT matching the asserted object;
--                   conf/source/tier are NEVER modified on mismatch — only this tag
--   'unverifiable'  probe returned null (git unavailable, file path unclear, etc.)
--   NULL            row predates L3 or predicate has no registered verify probe
--
-- Authoritative-mode predicates (has_unpackaged_state) are always re-injected at
-- close time as fresh rows; old rows for that predicate are suppressed by the
-- normal supersession path, so they never need a reality_check tag.
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS reality_check TEXT
  CHECK (reality_check IN ('verified', 'mismatch', 'unverifiable'));

-- ── Semantic embedding for resurrect cosine seed (halfvec 4000) ──────────────
--
-- Additive, NULL-tolerant addition.  Existing rows have embedding = NULL until
-- an explicit embedding backfill is run (production backfill is a separate
-- follow-up; not done in this migration per the OQ-5 decision).
--
-- Wrapped in a DO block so that missing pgvector extension (no halfvec type)
-- degrades gracefully — the resurrect engine falls through to the pg_trgm fuzzy
-- path when this column is absent or all-NULL.
--
-- Dimension: 4000 (Qwen/Qwen3-Embedding-8B via vLLM, configured in pipeline.yml).
-- Query: `1 - (embedding <=> $2::halfvec) >= threshold` (cosine similarity).
DO $$ BEGIN
  ALTER TABLE assertions ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'assertions.embedding halfvec(4000) skipped -- pgvector not installed; resurrect will use fuzzy fallback';
END $$;

-- HNSW index for fast cosine ANN search on assertions.embedding.
-- Wrapped in a DO block so that missing pgvector (or NULL-only column) fails gracefully.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS assertions_embedding_hnsw_idx
    ON assertions USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'assertions_embedding_hnsw_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

-- anchor — pointer-staleness gate: stores derived anchor metadata for file:line
--          references found in the assertion's object field. NULL for rows that
--          predate this feature or have no code pointer in their object.
-- Schema: { "pointer": "path:N-M", "symbol": "funcName", "snippet": "...", "last_validated": "ISO" }
-- symbol and snippet are mutually exclusive: symbol is preferred for JS/TS files
-- (enclosing function/class/const name); snippet is the ≤80-char fallback for
-- other file types or when no enclosing symbol can be detected.
ALTER TABLE assertions ADD COLUMN IF NOT EXISTS anchor JSONB;

-- ── pg_trgm GIN index for resurrect fuzzy-text matching ──────────────────────
--
-- Additive migration: creates a GIN trigram index on the concatenated
-- subject || ' ' || predicate || ' ' || object for the resurrect query type's
-- pg_trgm fallback (buildFuzzyMatch Postgres arm). Requires pg_trgm extension
-- (installed via setup.sql). CREATE INDEX IF NOT EXISTS is a no-op on fresh DBs
-- that already have it and on DBs where pg_trgm is not installed (error swallowed
-- below). The assertion text column is computed from existing columns; no schema
-- change to existing rows.
--
-- Wrapped in a DO block so that missing pg_trgm (no extension) degrades gracefully
-- rather than failing the entire schema migration.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS assertions_trgm_text_idx
    ON assertions USING GIN ((subject || ' ' || predicate || ' ' || object) gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm GIN index skipped -- pg_trgm not installed; resurrect will use fallback';
END $$;

CREATE INDEX IF NOT EXISTS assertions_project_idx
  ON assertions (project_id);
CREATE INDEX IF NOT EXISTS assertions_subject_idx
  ON assertions (project_id, subject);
CREATE INDEX IF NOT EXISTS assertions_confidence_idx
  ON assertions (project_id, confidence DESC);

-- ── 4A supersession indexes (defense-in-depth) ──────────────────────────────
--
-- These indexes enforce the cardinality-aware supersession contract as a
-- defense-in-depth layer.  The primary atomicity guarantee is the explicit
-- BEGIN/COMMIT transaction wrapping each suppress+INSERT pair in the write path
-- (mechanism-a per the spec).  These indexes catch any race that escapes the
-- transaction.
--
-- IMPORTANT — 1:1 index predicate list is registry-derived:
--   The IN(...) list below enumerates every predicate whose cardinality is '1:1'
--   in scripts/lib/predicate-registry.json at the time of this schema revision,
--   PLUS every predicate's grandfathered_aliases (renamed predicates whose old
--   name is kept permanently so historical rows written under the old name stay
--   covered by the uniqueness guarantee). A test in scripts/smoketest-handoff.js
--   (section "collision") asserts that this list is exactly the registry's
--   current 1:1 set UNION all grandfathered_aliases — any registry/index drift
--   will fail CI. When adding a 1:1 predicate to the registry, also update this
--   index (and the drift test will catch omissions automatically). When
--   renaming a predicate, add the OLD name to this list as a permanent
--   grandfathered alias (never remove it without first proving, across all live
--   databases, that zero rows remain under the old name) — see the
--   are_safe_outside_claude-memory / are_safe_outside_this_project rename below
--   (#135) for the worked example, including the collision-safe data migration
--   that must run whenever a rename introduces the risk of a live old-name row
--   and a live new-name row coexisting for the same subject.
--
-- 1:1 partial unique index: at most one live row per (project_id, subject, predicate)
-- for any predicate that the registry declares cardinality 1:1 (or its grandfathered alias).
DROP INDEX IF EXISTS assertions_1to1_unique;
CREATE UNIQUE INDEX assertions_1to1_unique
  ON assertions (project_id, subject, predicate)
  WHERE suppressed = false
    AND predicate IN (
      'README_roadmap_scope',
      'added_via',
      'affirmed',
      'are_safe_outside_claude-memory',
      'are_safe_outside_this_project',
      'branch_exists',
      'chose',
      'cmdDrop_refactor',
      'commit_merged',
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
      'open_thread',
      'orchestrates_only',
      'phase_ordering',
      'pr_state',
      'prefers',
      'quick_reference',
      'schema_migration_is',
      'session_tldr',
      'shipped_at',
      'skipped',
      'usage',
      'user_chose',
      'user_directed',
      'uses_db'
    );

-- ── Predicate rename: are_safe_outside_claude-memory → are_safe_outside_this_project ──
--
-- #135 (host-agnostic naming): the old predicate name embedded this project's
-- own name; renamed to a client/project-neutral name. Placed textually AFTER
-- assertions_1to1_unique above so a full raw apply of this file (fresh-DB init,
-- test harness applySchema) sees the widened index (both names already in the
-- IN(...) list) before this block runs. NOTE: applyAdditiveSchema() in
-- handoff.js extracts assertions_1to1_unique into a separate non-transactional
-- "Phase B" that runs AFTER this block commits (so the incremental drift-apply
-- path does NOT get that ordering) — the collision-safety below is therefore
-- deliberately NOT dependent on the index already being widened; it uses an
-- explicit EXISTS-based duplicate check instead, so it is correct under BOTH
-- apply paths regardless of index timing. Idempotent and safe to re-run
-- against a DB with a mix of old-name and new-name live rows (e.g.
-- mid-rolling-deploy, where a newly-deployed writer may already emit the new
-- name before this schema apply has run against a given DB):
--
--   1. For any (project_id, subject) that has BOTH a live old-name row and a
--      live new-name row, suppress the old-name row via the same
--      suppress-mechanism the write path already uses (never DELETE) — this
--      makes step 2 collision-free by construction, independent of whether
--      assertions_1to1_unique has been widened yet in this apply.
--   2. Rename the predicate on every remaining old-name row (live or already
--      suppressed). Because step 1 already eliminated every subject that
--      could collide, this UPDATE can never produce a live duplicate under
--      the new name (a bare UPDATE without step 1 first could silently create
--      one, or abort the transaction if the widened index is already active).
DO $$
BEGIN
  -- Fast no-op path (R-7 lock-budget guard): once every old-name row has been
  -- migrated (the steady-state case on every DB after the first apply), skip
  -- both UPDATEs entirely -- no table scan, no row locks.
  IF NOT EXISTS (SELECT 1 FROM assertions WHERE predicate = 'are_safe_outside_claude-memory') THEN
    RETURN;
  END IF;

  UPDATE assertions
    SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
    WHERE assertions.suppressed = false
      AND assertions.predicate = 'are_safe_outside_claude-memory'
      AND EXISTS (
        SELECT 1 FROM assertions AS new_rows
        WHERE new_rows.suppressed = false
          AND new_rows.predicate = 'are_safe_outside_this_project'
          AND new_rows.project_id = assertions.project_id
          AND new_rows.subject    = assertions.subject
      );

  UPDATE assertions
    SET predicate = 'are_safe_outside_this_project'
    WHERE predicate = 'are_safe_outside_claude-memory';
END $$;

-- 1:N exact-duplicate index: at most one live row per (project_id, subject, predicate, object).
-- Registry-independent: applies to all predicates equally, preventing exact-duplicate 1:N rows
-- regardless of cardinality class.
CREATE UNIQUE INDEX IF NOT EXISTS assertions_1ton_exact_unique
  ON assertions (project_id, subject, predicate, object)
  WHERE suppressed = false;


-- ============================================================================
-- EDGES — typed relationships between entities, extracted at /handoff:close.
-- Writer: Claude (session-end extraction) and manual writes by the maintainer.
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
--     "kind": "entity" | "assertion" | "vector" | "recency" | "history" | "graph",
--     "filter": { ... kind-specific filter fields ... },
--     "token_budget": <int>
--   }
--
-- Graph filter shape: { "seed": <string|string[]>, "direction": "out"|"in"|"both",
--                       "max_depth": <int 1-5> }
--   seed: entity names to start traversal from (falls back to retrieved entities if absent)
--   direction: edge traversal direction (default "out": from_entity → to_entity)
--   max_depth: max hop depth (hard-clamped to 5; default from graph_max_depth setting = 2)
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
--   feedback_loop_enabled              default: 'enabled'   ('enabled'|any other value — C2 outcome→ranking+probation feedback loop; byte-identical gate-OFF SQL when explicitly disabled)
--   feedback_success_delta             default: '0.5'       (outcome_bias nudge per success outcome in a session)
--   feedback_failure_delta             default: '-0.75'     (outcome_bias nudge per failure outcome in a session)
--   feedback_irrelevant_delta          default: '-0.25'     (outcome_bias nudge per irrelevant outcome in a session)
--   feedback_bias_clamp                default: '3.0'       (max absolute value of outcome_bias, i.e. bias ∈ [-clamp, +clamp])
--   contract_evolution_enabled         default: 'disabled'  ('enabled'|any other value — C3 auto-evolve contract from outcome patterns; byte-identical when disabled)
--   contract_evolution_window_days     default: '30'        (rolling window for outcome aggregation)
--   contract_evolution_min_events      default: '10'        (min events per kind before rules fire; thin-data guard)
--   contract_evolution_failure_threshold default: '0.5'     (failure+irrelevant rate that triggers budget reduction)
--   contract_evolution_budget_floor    default: '200'       (minimum token_budget for any kind; never reduced below this)
--   contract_evolution_budget_step     default: '200'       (max budget change per evolution pass; gradual and bounded)
--   extraction_async_enabled           default: 'false'     ('true'|'false' — async extraction queue; byte-identical to synchronous when 'false')
--   predicate_registry_mode            default: 'permissive' ('permissive'|'strict' — unrecognized-predicate enforcement)
--   tier_aware_retrieval               default: 'enabled'   ('enabled'|any other value — tier-aware retrieval ranking; probationary rows re-ranked below consolidated/NULL; byte-identical ORDER BY when disabled)
--   close_degraded_exit_mode           default: 'warn'      ('warn'|'strict' — L4: 'warn' exits 0 on degraded close (default, backward-compatible); 'strict' exits 3; degraded_close:* rows always written regardless)


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


-- ============================================================================
-- EXTRACTION_QUEUE — async extraction payload queue (opt-in, default OFF).
--
-- When extraction_async_enabled='true' in project_settings, cmdClose and
-- cmdCheckpoint INSERT one row here instead of writing assertions/entities/edges
-- synchronously. The deterministic background worker (queue-drain subcommand)
-- reads pending rows, calls writeExtraction() for each, and marks them done.
--
-- status lifecycle: 'pending' → 'done' (on success) | 'error' (on write failure).
-- error_detail records the write-path error message for 'error' rows.
-- source_ref is the session_id (or null) captured at enqueue time for traceability.
--
-- Portable (no pgvector). Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS
-- index). Applied automatically by `/handoff:init`.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS extraction_queue (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  source_ref   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'done', 'error')),
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error_detail TEXT
);
CREATE INDEX IF NOT EXISTS extraction_queue_project_status_idx
  ON extraction_queue (project_id, status);
