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

-- Seed row (data, not schema): the local embedding provider this repo's
-- retrieval path uses by default. ON CONFLICT (name) DO NOTHING never heals
-- a divergent pre-existing row with this name — a divergent row is a loud
-- verification FAIL in migrate-schema-addenda.js, the operator's signal to
-- reconcile manually.
INSERT INTO embedding_providers (name, model_label, native_dims, stored_dims, endpoint, is_default)
VALUES ('vllm-local', 'Qwen3-Embedding-8B', 4096, 4000, 'http://localhost:8000', true)
ON CONFLICT (name) DO NOTHING;
