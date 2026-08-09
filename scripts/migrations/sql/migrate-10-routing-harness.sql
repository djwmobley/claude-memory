-- migrate-10-routing-harness.sql
--
-- Schema-setup-only (no data migration).
--
-- provider is an OPEN set (free text, no CHECK) on every table below.
-- session_id in routing_session_overrides is a free-text join key, NOT an
-- FK (no sessions table exists in this schema).
--
-- model_registry stays EMPTY of any named model until real registration
-- happens -- no seed rows here.

ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS provider          TEXT;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS model_id          TEXT;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS capability_tier   TEXT CHECK (capability_tier IN ('high','mid','low'));
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS cost_in_per_mtok  NUMERIC(10,4);
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS cost_out_per_mtok NUMERIC(10,4);
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS context_window    INTEGER;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS headless_cli_cmd  TEXT;
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS available         BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS routing_profiles (
  id                  SERIAL PRIMARY KEY,
  project_id          TEXT NOT NULL,
  role                TEXT NOT NULL,
  capability_tier     TEXT NOT NULL CHECK (capability_tier IN ('high','mid','low')),
  preferred_model     TEXT,
  preferred_provider  TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  active              BOOLEAN NOT NULL DEFAULT true,
  source_model        TEXT,
  agent_id            TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  notes               TEXT,
  UNIQUE (project_id, role, version)
);
CREATE INDEX IF NOT EXISTS routing_profiles_project_idx ON routing_profiles (project_id, role) WHERE active = true;

CREATE TABLE IF NOT EXISTS routing_session_overrides (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  provider     TEXT,
  set_by       TEXT,
  set_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, session_id, role)
);
