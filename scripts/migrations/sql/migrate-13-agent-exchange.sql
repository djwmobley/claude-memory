-- migrate-13-agent-exchange.sql
--
-- Schema-setup-only (no data migration). Idempotent, re-runnable, no
-- DROP TABLE anywhere in this file.
--
-- Two pieces:
--   1. agent_exchange -- an append-only, project-scoped exchange log for
--      multi-agent-to-agent (A2A) communication: proposals, responses,
--      threaded replies, and broadcasts. "Append-only" means a read/ack is
--      a NEW row (kind='observation', parent_id set to the row being
--      acknowledged), never an UPDATE of the original row. A watermark poll
--      (see the WATERMARK CONTRACT note below) replaces any unread/read_at
--      flag -- there is deliberately no status column on this table (see
--      the append-only-convention sanity check in verify-13-exchange-smoke.js).
--   2. audit_log + log_guarded_change() -- generic, reusable tamper-evidence
--      infrastructure: an AFTER UPDATE OR DELETE trigger that mirrors every
--      mutation of a guarded row into audit_log (table_name, operation,
--      row_id, db_user, old_row, new_row). This is DETECTION, not
--      PREVENTION -- a shared, credential-diverse localhost Postgres
--      instance has no per-agent role layer, so no REVOKE can stop a
--      misbehaving writer from mutating an append-only table. What this
--      infrastructure guarantees instead is that every such mutation is
--      captured forensically, including sanctioned ones (see the note by
--      the trigger-wiring block below).
--
-- WATERMARK CONTRACT (documented here, exercised in verify-13-exchange-
-- smoke.js check 1, restated in docs/agent-interop.md): polling clients
-- MUST use the compound cursor (created_at, id), not created_at alone.
-- Every row inside a single Postgres transaction shares one created_at
-- value (NOW() = transaction_timestamp()), so created_at alone cannot
-- distinguish same-transaction rows. id is a SERIAL column that strictly
-- advances even within one transaction, so the compound cursor
--   WHERE (created_at, id) > ($1, $2) ORDER BY created_at, id
-- is exercisable inside a single-transaction smoke test AND immune to
-- same-timestamp ties in production, where genuinely concurrent writers can
-- also land on the same millisecond.

CREATE TABLE IF NOT EXISTS agent_exchange (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  docket_id    INTEGER,            -- optional link to a work item; FK added conditionally below (C-1)
  parent_id    INTEGER REFERENCES agent_exchange(id),   -- self-FK thread linkage
  agent_id     TEXT NOT NULL,      -- same free-text identity as every other table's agent_id
  source_model TEXT,
  to_agent     TEXT,               -- NULL = broadcast to any listener scoped to project_id; not a status flag
  kind         TEXT NOT NULL,      -- extensible speech-act hint: 'proposal'|'response'|'opinion'|'ruling'|
                                    -- 'observation'|'research'|'handoff' -- free text, extend by convention.
                                    -- 'ruling'/'opinion' are ordinary shipped vocabulary values, not a
                                    -- reference to any external process.
  body_caveman TEXT NOT NULL,      -- caveman-English; no authoring_mode escape hatch on this table
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_exchange_project_idx ON agent_exchange (project_id);
CREATE INDEX IF NOT EXISTS agent_exchange_docket_idx  ON agent_exchange (docket_id);
CREATE INDEX IF NOT EXISTS agent_exchange_parent_idx  ON agent_exchange (parent_id);
CREATE INDEX IF NOT EXISTS agent_exchange_inbox_idx   ON agent_exchange (project_id, to_agent, created_at);

-- ── Embedding column, split out from the CREATE TABLE (ADVERSARY-PASS A-1) ──
--
-- agent_exchange is deliberately CREATEd WITHOUT the embedding column above.
-- The whole file runs as one implicit transaction on a plain pg-client apply
-- (no psql \set ON_ERROR_STOP semantics change that), so a hard failure in
-- one statement aborts unrelated statements too -- a pgvector-absent target
-- must degrade gracefully here, never abort the file. Exact pattern copied
-- from scripts/sql/handoff-core-schema.sql's assertions.embedding block.
DO $$ BEGIN
  ALTER TABLE agent_exchange ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agent_exchange.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;

-- HNSW index on agent_exchange.embedding -- same graceful-degradation
-- pattern as assertions_embedding_hnsw_idx in handoff-core-schema.sql.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS agent_exchange_embedding_idx
    ON agent_exchange USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agent_exchange_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;


-- ============================================================================
-- AUDIT_LOG + log_guarded_change() -- generic tamper-evidence infrastructure.
-- ============================================================================

-- ADVERSARY-PASS A-2 (superseded -- see ROW_ID TEXT WIDENING below): row_id
-- was originally BIGINT, not INTEGER, as a deliberate deviation from the
-- source design, strictly safer against any future wide-ID guarded table.
-- That numeric-safety property is now carried by row_id being TEXT instead
-- (a TEXT column has no width ceiling at all, a strict superset of what
-- BIGINT guarded against).
--
-- ROW_ID TEXT WIDENING (memory-manager#17 follow-up, post-review): row_id
-- is TEXT, not BIGINT/INTEGER. §5.3's `findings` table gives it a
-- caller-supplied TEXT primary-key id (source-prefixed, e.g.
-- "RT-INJ-001") -- inserting that value into a BIGINT row_id column throws
-- a type-cast error the first time findings is UPDATEd or DELETEd once its
-- audit trigger is wired (empirically confirmed against a live Postgres
-- instance). TEXT is a strict widening: every OTHER guarded table's id is
-- SERIAL/INTEGER, and an integer value inserts into a TEXT column cleanly
-- via ordinary assignment coercion, no cast needed on the trigger-function
-- side (also empirically confirmed) -- so this widening is safe for every
-- currently- and future-guarded table, not just findings.
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
-- Idempotent convergence ALTER for any target that already ran an EARLIER
-- version of this file (row_id BIGINT, PR #158) or was widened only via
-- migrate-14-seam-tables.sql's own copy of this same statement (that
-- file's copy is now harmless, redundant, intentionally left in place --
-- re-running this ALTER against an already-TEXT column is a proven no-op).
-- A fresh target (CREATE TABLE above just ran) already has row_id TEXT, so
-- this ALTER is a no-op there too -- unconditionally safe either way.
ALTER TABLE audit_log ALTER COLUMN row_id TYPE TEXT USING row_id::text;
CREATE INDEX IF NOT EXISTS audit_log_table_op_idx ON audit_log (table_name, operation);
CREATE INDEX IF NOT EXISTS audit_log_created_idx  ON audit_log (created_at DESC);

-- ADVERSARY-PASS A-3: old_row/new_row strip the 'embedding' key before
-- serialization. Rationale: assertions carries a halfvec(4000); serializing
-- it into every supersession-UPDATE audit row is an unbounded storage cost
-- on the engine's single most common write path, and embeddings are
-- derived, re-computable data with negligible forensic value. The trade-off
-- is accepted and stated here explicitly: embedding TAMPERING itself is not
-- captured in the audit diff for any guarded table that carries an
-- embedding column. The `-` (jsonb minus text) operator is a safe no-op on
-- rows/tables that have no 'embedding' key at all.
--
-- ADVERSARY-PASS D-2: pg_get_functiondef() of this function must contain
-- both INSERT INTO audit_log branches below -- verified by the runner and
-- by a dedicated test proof-of-firing case (stub replacement -> FAIL).
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

-- Docs note (ADVERSARY-PASS B-1, restated in docs/agent-interop.md):
-- ON CONFLICT ... DO UPDATE fires the UPDATE trigger like any other UPDATE,
-- so upserts onto a guarded table carry the same audit behavior/cost as an
-- explicit UPDATE statement.
--
-- Legitimate engine writes DO update assertions (supersession sets
-- invalid_at) -- those generate audit_log rows by design once assertions is
-- wired below. The audit trail records ALL mutations, sanctioned ones
-- included; this is deliberate (detection, not prevention) -- nobody should
-- "fix" this later by trying to exclude sanctioned writes from the trail.

-- ── agent_exchange's own trigger (unconditional -- the table is guaranteed
-- present by this point in this same file). ──────────────────────────────
DROP TRIGGER IF EXISTS agent_exchange_audit ON agent_exchange;
CREATE TRIGGER agent_exchange_audit
AFTER UPDATE OR DELETE ON agent_exchange
FOR EACH ROW EXECUTE FUNCTION log_guarded_change();

-- ── Conditional wiring onto every OTHER append-only table that EXISTS in
-- the target (Deliverable 1b + ADVERSARY-PASS A-4). ─────────────────────
--
-- Gate (A-4, total classification, never silent): a table is wired iff (a)
-- it exists (to_regclass) AND (b) it has an `id` column (information_schema
-- probe). A table present without an `id` column is reported as
-- deferred-incompatible via RAISE NOTICE -- never silently wired to a
-- trigger function that would fail at runtime on OLD.id/NEW.id. audit_log
-- itself is deliberately NOT in this list (ADVERSARY-PASS B-3: an
-- audit_log_audit trigger must never exist -- a self-wiring refactor bug
-- guarded by a dedicated negative test).
--
-- assertions/edges exist on any migrate-01 target -- effectively
-- unconditional but still run through the same guarded gate as everything
-- else (no special-cased unconditional path). The 13 seam tables (decisions,
-- gotchas, findings, research, incidents, code_index, tasks,
-- checklist_items, corpus_files, workflow_discovery, agent_rewrites,
-- policy_sections, session_chunks) are expected ABSENT today and ship in a
-- later migration wave (§5.3, out of scope for this file) -- they are wired
-- automatically, with zero further changes to this file, whenever it is
-- re-applied after they exist. SCOPE BOUNDARY: the full-checklist gate
-- (every listed table wired + row-count verification) belongs to the
-- migration-phase issue, not this file -- this file wires what exists today
-- and reports the deferred set loudly (see migrate-13-agent-exchange.js).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assertions', 'edges',
    'decisions', 'gotchas', 'findings', 'research', 'incidents',
    'code_index', 'tasks', 'checklist_items', 'corpus_files',
    'workflow_discovery', 'agent_rewrites', 'policy_sections', 'session_chunks'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = t AND column_name = 'id'
       )
    THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION log_guarded_change()',
        t || '_audit', t
      );
      RAISE NOTICE 'audit trigger wired on %', t;
    ELSIF to_regclass(t) IS NOT NULL THEN
      RAISE NOTICE 'audit trigger NOT wired on % -- table present but has no id column (deferred-incompatible)', t;
    ELSE
      RAISE NOTICE 'audit trigger NOT wired on % -- table absent (deferred until a later migration creates it)', t;
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- CONDITIONAL FK (ADVERSARY-PASS C-1) -- agent_exchange.docket_id -> tasks.id.
--
-- Runs AFTER all trigger wiring above (blast-radius ordering: a trigger
-- backfill on a wide table is contained before any FK-validation scan of
-- agent_exchange begins). Orphan-tolerant, total 4-state classification
-- (the runner reads pg_constraint to classify; see migrate-13-agent-
-- exchange.js): validated / added-not-validated (orphan docket_id rows
-- present) / deferred (tasks absent) / FAIL (tasks present, constraint
-- absent after apply). Idempotent: a duplicate_object error on the ADD
-- CONSTRAINT (constraint already present, e.g. a second apply) is caught
-- and ignored; VALIDATE CONSTRAINT on an already-valid constraint is a
-- cheap no-op in Postgres.
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('tasks') IS NOT NULL THEN
    BEGIN
      ALTER TABLE agent_exchange
        ADD CONSTRAINT agent_exchange_docket_fk
        FOREIGN KEY (docket_id) REFERENCES tasks(id) NOT VALID;
    EXCEPTION
      WHEN duplicate_object THEN NULL;  -- constraint already present (idempotent re-apply)
    END;

    BEGIN
      ALTER TABLE agent_exchange VALIDATE CONSTRAINT agent_exchange_docket_fk;
      RAISE NOTICE 'agent_exchange_docket_fk validated';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'agent_exchange_docket_fk added NOT VALID -- orphan docket_id rows present (or another validation error); runner reports orphan ids, capped at 20';
    END;
  ELSE
    RAISE NOTICE 'agent_exchange_docket_fk deferred -- tasks table absent (ships in a later migration wave)';
  END IF;
END $$;
