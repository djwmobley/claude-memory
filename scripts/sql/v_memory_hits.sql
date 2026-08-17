-- handoff:excluded targets the canonical/pipeline DB provisioned by scripts/setup.sql; depends on memory_entries/memory_entry_chunks which no per-project schema defines
-- ═══════════════════════════════════════════════════════════════════════════════
-- v_memory_hits VIEW
-- Unified retrieval surface for hybrid search (FTS + vector).
-- In claude-memory there is only one chunk source (memory_entry_chunks), so this
-- view is a thin alias -- it projects chunks joined with their parent entry for
-- the label field. The view shape intentionally mirrors the pipeline v_memory_hits
-- column set so retrieval queries are portable between the two repos.
--
-- Columns:
--   source_table  -- always 'memory_entry_chunks' in this repo
--   chunk_id      -- PK of the chunk row
--   source_row_id -- FK to memory_entries.id (parent)
--   chunk_idx     -- 0-based position within the entry
--   total_chunks  -- how many chunks this entry has
--   label         -- memory_entries.name (display name for results)
--   snippet       -- first 300 chars of content (for result previews)
--   content       -- full chunk text
--   embedding     -- vector for cosine similarity scoring
--   fts_vec       -- tsvector for FTS rank scoring
--
-- Hybrid scoring (applied by pipeline-embed.js, not by the DB):
--   score = ts_rank(fts_vec, query) * 0.3 + (1 - embedding <=> query_vec) * 0.7
--
-- Canonical migration pattern for embedding column type changes:
-- pgvector rejects ALTER COLUMN TYPE on a column referenced by a view (a
-- Postgres-side constraint, not pgvector-specific). Future schema migrations on
-- memory_entries.embedding or memory_entry_chunks.embedding follow this pattern:
--
--   BEGIN;
--   DROP VIEW v_memory_hits;
--   ALTER TABLE <tbl> ALTER COLUMN embedding TYPE <new_type> USING <expr>;
--   \ir scripts/sql/v_memory_hits.sql
--   COMMIT;
--
-- This file is the single source of truth for the view DDL. scripts/setup.sql
-- sources it via \ir sql/v_memory_hits.sql.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_memory_hits AS
  SELECT
    'memory_entry_chunks'::text AS source_table,
    mc.id                       AS chunk_id,
    mc.entry_id                 AS source_row_id,
    mc.chunk_idx,
    (SELECT COUNT(*)::integer
       FROM memory_entry_chunks mc2
      WHERE mc2.entry_id = mc.entry_id) AS total_chunks,
    me.name                     AS label,
    substring(mc.content, 1, 300) AS snippet,
    mc.content,
    mc.embedding,
    mc.fts_vec
  FROM memory_entry_chunks mc
  JOIN memory_entries me ON me.id = mc.entry_id;

COMMENT ON VIEW v_memory_hits IS
  'Unified hybrid-search surface for claude-memory. Projects memory_entry_chunks '
  'joined with memory_entries.name as label. source_row_id is the parent entry FK. '
  'Hybrid scoring (FTS * 0.3 + cosine * 0.7) is computed by pipeline-embed.js, '
  'not by the DB. Forked from pipeline v_memory_hits; single-source variant.';
