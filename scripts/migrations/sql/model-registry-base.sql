-- model-registry-base.sql
--
-- Schema-setup-only (no data migration).
--
-- Naming note: the origin document assigns no filename to this piece that
-- collides with existing migration-phase numbering, so it is named
-- descriptively rather than numbered (see attribution-columns.sql's header
-- for the numbering-collision background).
--
-- Populated lazily (upsert-on-write); NOT pre-seeded with any model names.
-- label is free text, no CHECK (model-agnosticism: no named model set
-- anywhere in this schema).

CREATE TABLE IF NOT EXISTS model_registry (
  id           SERIAL PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE,
  kind         TEXT,
  first_seen   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  notes        TEXT,
  configured_by TEXT,
  configured_at TIMESTAMPTZ
);
