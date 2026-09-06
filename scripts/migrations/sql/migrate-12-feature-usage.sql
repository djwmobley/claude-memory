-- migrate-12-feature-usage.sql
--
-- Schema-setup-only (no data migration -- see migrate-12-feature-usage.js
-- for the one-time backfill from pipeline_pipeline.feature_token_usage).
-- §18.3 owner decision item F, 2026-09-06.
--
-- feature_usage is a per-feature/per-PR token-and-cost provenance table,
-- distinct from turn_usage (per-turn, migrate-11-usage-telemetry.sql):
-- turn_usage measures a single agent turn inside a session; feature_usage
-- measures a whole feature/PR-shaped unit of work, optionally spanning many
-- sessions (session_ids TEXT[]) and many models (model_breakdown JSONB).
-- Provenance is keyed by (project_id, source_db, source_feature_token_usage_id)
-- so a source row can be re-migrated idempotently (insert-or-detect-conflict,
-- never blind re-insert) and unambiguously traced back to its origin row
-- across more than one source database. No audit trigger -- turn_usage and
-- session_usage (its siblings in this same file group) carry none either.

CREATE TABLE IF NOT EXISTS feature_usage (
  id                             SERIAL PRIMARY KEY,
  project_id                     TEXT NOT NULL,
  branch                         TEXT NOT NULL,
  pr_number                      INTEGER,
  github_issue                   INTEGER,
  started_at                     TIMESTAMPTZ NOT NULL,
  completed_at                   TIMESTAMPTZ,
  model_id                       TEXT,
  model_breakdown                JSONB,
  assistant_msgs                 INTEGER,
  tokens_in                      BIGINT,
  tokens_out                     BIGINT,
  cache_creation_5m_tokens       BIGINT,
  cache_creation_1h_tokens       BIGINT,
  cache_read_tokens              BIGINT,
  cache_hit_pct                  NUMERIC(5,2),
  cost_usd                       NUMERIC(12,6),
  tool_calls                     JSONB,
  session_ids                    TEXT[],
  notes                          TEXT,
  source_feature_token_usage_id  INTEGER,
  source_db                      TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, source_db, source_feature_token_usage_id)
);
CREATE INDEX IF NOT EXISTS feature_usage_project_idx ON feature_usage (project_id);
CREATE INDEX IF NOT EXISTS feature_usage_project_branch_idx ON feature_usage (project_id, branch);
CREATE INDEX IF NOT EXISTS feature_usage_project_pr_idx ON feature_usage (project_id, pr_number);
CREATE INDEX IF NOT EXISTS feature_usage_session_ids_gin_idx ON feature_usage USING GIN (session_ids);
