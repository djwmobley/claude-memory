-- migrate-07-ddl-addenda.sql
--
-- Bundled DDL preamble for migrate-07-reembed-corpus.js (CONSOLIDATION-
-- RUNBOOK.md §6.1(g) + its G-1..G-14 spec-adversary amendment (G-R1..G-R14,
-- 2026-08-18, memory-manager#11(g)). Idempotent, re-runnable, no DROP TABLE
-- anywhere in this file (§6.0's preservation guarantee). Applied via
-- migrateOne.applySqlFile, mirroring migrate-04/migrate-13's "bundle this
-- DDL as this script's own preamble" precedent.
--
-- THIS FILE ONLY CREATES THE TWO NEW LINEAGE TABLES (G-R4). It deliberately
-- does NOT add `embedded_by_provider_id` to any embeddable table -- that
-- column is added PROGRAMMATICALLY by migrate-07-reembed-corpus.js itself,
-- once per table, against the table list its own DDL-derived enumeration
-- (G-R1: a pg_attribute/pg_type/pg_class scan for vector/halfvec columns)
-- discovers at run time. A static hand-listed ALTER TABLE per known
-- embeddable table here would silently drift the moment a future PR adds a
-- 19th embeddable table -- the exact "hand-maintained list that can go
-- stale" hazard this repo's canon forbids (mirrors getBatteryInfraTables()/
-- deriveExpectedObjects()'s own "derive, never hand-list" posture). See
-- migrate-07-reembed-corpus.js's ensureProvenanceColumn().
--
-- embedding_migration_batches / embedding_write_log: migrate-07's own
-- rollback-identity lineage (G-R4), mirroring pipeline_migration_row_ids'
-- shape and the SAME "register shared/battery infra tables in a DDL file,
-- never a private per-script block invisible to T0's live-table
-- classification" reasoning. Unlike pipeline_migration_row_ids these are
-- NOT registered in verify15-shared.js's DDL_SQL, because migrate-07 is not
-- part of the §15 T-battery scope -- they are registered here instead, and
-- given SOURCELESS roster entries (net-new:embedding-lineage, G-R12) so T0/
-- T5/T6 in the existing battery still recognize them without this script
-- needing to touch verify15-shared.js.

CREATE TABLE IF NOT EXISTS embedding_migration_batches (
  id              SERIAL PRIMARY KEY,
  table_name      TEXT NOT NULL,
  run_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id          UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS embedding_migration_batches_run_idx   ON embedding_migration_batches (run_id);
CREATE INDEX IF NOT EXISTS embedding_migration_batches_table_idx ON embedding_migration_batches (table_name);

-- row_pk_col / row_pk_value: TEXT, not a typed composite -- see this
-- script's getPkSpec()/encodePk()/decodePk() (JSON-array encoding of the PK
-- value(s), column-name list joined with ','). Every in-scope table's PK is
-- either a single SERIAL `id` or (for `findings`) the composite
-- (project_id, id) -- the SAME "no numeric surrogate for a composite/TEXT
-- PK" shape migrate-04's pipeline_migration_row_ids and migrate-verify-
-- own-graph.js's own_graph_migration_ids both already solved by storing the
-- source's own id as TEXT rather than adding a new INTEGER column; this
-- table generalizes that pattern to an explicit column-name list instead of
-- assuming a single `source_row_id` always suffices.
CREATE TABLE IF NOT EXISTS embedding_write_log (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES embedding_migration_batches(id),
  table_name    TEXT NOT NULL,
  row_pk_col    TEXT NOT NULL,
  row_pk_value  TEXT NOT NULL,
  written_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS embedding_write_log_batch_idx     ON embedding_write_log (batch_id);
CREATE INDEX IF NOT EXISTS embedding_write_log_table_pk_idx  ON embedding_write_log (table_name, row_pk_value);
