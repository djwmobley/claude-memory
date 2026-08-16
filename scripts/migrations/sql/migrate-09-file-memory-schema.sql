-- migrate-09-file-memory-schema.sql
--
-- Schema-setup-only (no data migration) prerequisite for
-- migrate-09-file-memory-markdown.js (CONSOLIDATION-RUNBOOK.md §6.1(i)).
-- Two additive, idempotent pieces:
--
--   1. edges_project_from_type_to_unique -- confirmed ABSENT on the live
--      engine-core `edges` table (§6.1(i) point 4 / the runbook's §1.1
--      ground-truth note: "Whether `edges` carries a UNIQUE (project_id,
--      from_entity, edge_type, to_entity) constraint was not confirmed").
--      Without it, migrate-09-file-memory-markdown.js's edges upsert keyed
--      on (project_id, from_entity, edge_type, to_entity) would silently
--      duplicate rows on every re-run instead of upserting -- this index is
--      what makes that upsert actually safe rather than merely intended to
--      be.
--
--   2. entities.entity_type DROP NOT NULL -- handoff-core-schema.sql
--      declares `entity_type TEXT NOT NULL`. migrate-09-file-memory-
--      markdown.js's I-8 requirement writes an entities row with
--      entity_type = NULL when a topic file's frontmatter carries no
--      `type`/`metadata.type` AND filename-prefix inference also fails
--      (the "unmatched-type" branch) -- the row itself must still be
--      written (never dropped, never silently defaulted to a fabricated
--      type), so the column must accept NULL. `DROP NOT NULL` is
--      idempotent: re-running it against an already-nullable column is a
--      no-op, not an error.
--
-- REGISTRATION: applied the SAME way every other migration script's OWN
-- sql/*.sql file is (migrate-13-agent-exchange.js, migrate-14-seam-
-- tables.js) -- migrate-09-file-memory-markdown.js applies this file
-- DIRECTLY via migrate-01-canonical-db.js's own exported applySqlFile, NOT
-- by being appended to migrate-schema-addenda.js's shared SQL_FILES array.
-- A new, separate file + a script-owned apply step avoids any collision
-- with a concurrent sibling PR that also edits that shared array (the same
-- "own SQL_FILE, own PREREQUISITE_TABLES check" pattern migrate-13/
-- migrate-14 already established, rather than migrate-02-decisions.js's
-- alternative of inlining a single bare CREATE UNIQUE INDEX statement as a
-- JS string constant -- this PR ships two statements, so a checked-in .sql
-- file (with its own header comment, consistent with every sibling
-- addendum) is the better fit of the two house patterns already in this
-- repo).

CREATE UNIQUE INDEX IF NOT EXISTS edges_project_from_type_to_unique
  ON edges (project_id, from_entity, edge_type, to_entity);

ALTER TABLE entities ALTER COLUMN entity_type DROP NOT NULL;
