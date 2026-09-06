-- embedding-providers-base.sql
--
-- Schema-setup-only, EXCEPT for one seed row that is DATA, not schema (see
-- below) — deliberately specified alongside the table by the origin
-- document.
--
-- Naming note: the origin document assigns no filename to this piece that
-- collides with existing migration-phase numbering, so it is named
-- descriptively rather than numbered (see attribution-columns.sql's header
-- for the numbering-collision background).
--
-- model_label here is EMBEDDING model identity, deliberately not FK'd to
-- model_registry (agent identity is a separate concern from embedding
-- provider identity).
--
-- CANON NOTE (cm#201 S-A.2, PR #204 canon-class pattern): this table's
-- CREATE TABLE + the is_default unique index below are now ALSO defined in
-- scripts/sql/handoff-core-schema.sql and scripts/sql/handoff-sqlite-schema.sql
-- (the cm#185 bring-forward canon, auto-applied to every live project DB by
-- ensureSchemaCurrent in scripts/handoff.js). That move was necessary for
-- the SAME reason PR #204 moved source_model/agent_id/suppressed to canon:
-- this file's applier (migrate-schema-addenda.js) reuses migrate-01's
-- classifyTarget, which structurally refuses live project DBs (allow-set:
-- memory_manager / *_staging only) — so this file alone could never reach a
-- live DB, yet exchange-log.js's resolveDefaultEmbedder and write-time-
-- embed.js's embedForWrite both query embedding_providers unconditionally
-- against ANY target, live included, via handoff-mcp.mjs's live MCP tool
-- surface. This file is UNCHANGED (aside from this note) and STAYS the
-- staging-target applier — it is idempotent (IF NOT EXISTS / DO NOTHING)
-- against a DB that already has the table via canon. The SEED ROW below
-- stays HERE ONLY (never in canon) — canon carries SCHEMA, never per-
-- deployment operator data; a live project DB with no seeded default
-- provider correctly gets resolveDefaultProvider's FATAL "no
-- embedding_providers row has is_default = true" until an operator seeds
-- one, exactly as designed (L6 "vLLM or stop" — never a silent hardcoded
-- fallback).

CREATE TABLE IF NOT EXISTS embedding_providers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  model_label  TEXT NOT NULL,
  native_dims  INTEGER NOT NULL,
  stored_dims  INTEGER NOT NULL,
  endpoint     TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  data_egress_approved    BOOLEAN NOT NULL DEFAULT false,
  data_egress_approved_by TEXT,
  data_egress_approved_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- cm#201 S-A.2: at most one row may be is_default=true. Previously
-- enforced by convention only (resolveDefaultProvider's own
-- 0-or-more-than-1 FATAL check ran AFTER the fact, at read time); this
-- index makes the invariant a write-time DB guarantee — a second
-- concurrent "make me the default" write is a clean 23505, never a silent
-- two-defaults window resolveDefaultProvider would otherwise have to
-- detect after the fact.
CREATE UNIQUE INDEX IF NOT EXISTS embedding_providers_is_default_unique_idx
  ON embedding_providers (is_default) WHERE is_default;

-- Seed row (data, not schema): the local embedding provider this repo's
-- retrieval path uses by default. ON CONFLICT (name) DO NOTHING never heals
-- a divergent pre-existing row with this name — a divergent row is a loud
-- verification FAIL in migrate-schema-addenda.js, the operator's signal to
-- reconcile manually.
--
-- SEED VALUES CORRECTED (2026-09-06, init-seed-local-provider AUTHOR task):
-- the cm#202 S-B.6 note below previously left this seed's literal VALUES at
-- 'http://localhost:8000'/'Qwen3-Embedding-8B' while documenting, in the
-- very same comment, that the known-good values are 8800 / the vLLM-prefixed
-- 'Qwen/Qwen3-Embedding-8B' -- a self-contradictory file. The literals below
-- now match the documented known-good values; the documentation itself is
-- otherwise unchanged.
--
-- What follows is comment-only, UNVERIFIED BY ANY GATE, documentation of the
-- known-good values for THIS repo's own local vLLM deployment convention,
-- added so reconciliation after a divergence is copy-paste rather than
-- rediscovery through a failed migrate-07-reembed-corpus.js apply (as
-- happened live, 2026-08-18, phase (g)):
--   port:              8800   (not 8000 — scripts/lib/shared.js's own
--                               vllmEmbed() defaults VLLM_EMBED_URL to
--                               'http://localhost:8800'; ~/start-vllm-*.sh
--                               conventions serve on 8800)
--   served-model id:   'Qwen/Qwen3-Embedding-8B'  (vLLM-prefixed form — the
--                               unprefixed 'Qwen3-Embedding-8B' 404s:
--                               "The model 'Qwen3-Embedding-8B' does not
--                               exist"; scripts/lib/shared.js's own
--                               VLLM_MODEL constant is the in-repo source
--                               of truth for this exact string)
-- If your deployment's port/served-model id diverge from the seed values
-- below, reconcile with an UPDATE against this row (or the values above,
-- whichever is your actual deployment) rather than editing this seed.
INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default)
VALUES ('vllm-local', 'Qwen/Qwen3-Embedding-8B', 4096, 4000, 'http://localhost:8800', true)
ON CONFLICT (name) DO NOTHING;
