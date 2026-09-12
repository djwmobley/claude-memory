-- handoff:dialect postgres
-- usage-telemetry-schema.sql (formerly scripts/migrations/sql/migrate-11-
-- usage-telemetry.sql -- moved to scripts/sql/ so ensureSchemaCurrent's
-- init/heal-on-touch applies it to EVERY live project engine DB, not only
-- memory_manager_staging via migrate-schema-addenda.js. Registered in
-- scripts/sql/schema-manifest.json (order 40, schema_epoch 5). Same content,
-- same file basename convention as this file group's sibling
-- feature-usage-schema.sql (formerly migrate-12-feature-usage.sql).
--
-- Schema-setup-only (no data migration).
--
-- model_id conventionally matches model_registry.label but has NO hard FK
-- (lazy-upsert pattern -- a model may be used before it is registered).
-- session_usage is a rollup, recomputed (upsert), not written turn-by-turn.

CREATE TABLE IF NOT EXISTS turn_usage (
  id                  SERIAL PRIMARY KEY,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  turn_idx            INTEGER NOT NULL,
  agent_role          TEXT NOT NULL,
  model_id            TEXT,
  provider            TEXT,
  tokens_in           BIGINT,
  tokens_out          BIGINT,
  cache_read_tokens   BIGINT,
  cache_write_tokens  BIGINT,
  cost_usd            NUMERIC(12,6),
  resolved_via        TEXT CHECK (resolved_via IN ('directive','recommendation')),
  recommended_model   TEXT,
  cost_delta_usd      NUMERIC(12,6),
  outcome             TEXT CHECK (outcome IN ('success','failure','downgraded','unknown')) DEFAULT 'unknown',
  source_model        TEXT,
  agent_id            TEXT,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, session_id, turn_idx, agent_role)
);
CREATE INDEX IF NOT EXISTS turn_usage_project_idx ON turn_usage (project_id);
CREATE INDEX IF NOT EXISTS turn_usage_session_idx ON turn_usage (project_id, session_id);
CREATE INDEX IF NOT EXISTS turn_usage_model_idx   ON turn_usage (project_id, model_id);

CREATE TABLE IF NOT EXISTS session_usage (
  id                 SERIAL PRIMARY KEY,
  project_id         TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  model_breakdown    JSONB,
  total_tokens_in    BIGINT,
  total_tokens_out   BIGINT,
  total_cost_usd     NUMERIC(12,6),
  turn_count         INTEGER,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, session_id)
);
CREATE INDEX IF NOT EXISTS session_usage_project_idx ON session_usage (project_id);
