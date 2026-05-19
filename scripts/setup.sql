-- claude-memory schema setup
-- Role: create the Postgres schema for claude-memory, a hybrid FTS + vector memory
--       store for AI agents. Forked from pipeline (https://github.com/djwmobley/pipeline).
-- Usage: psql -d <your_db> -f scripts/setup.sql
-- Pre-reqs: Postgres 14+, pgvector extension installed in the target database.
--           Script degrades gracefully (FTS only) if pgvector is absent.
--           Ollama with mxbai-embed-large is required only for embedding; FTS
--           works without it.

-- ═══════════════════════════════════════════════════════════════════════════════
-- EXTENSIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- pgvector enables vector similarity search. Optional -- FTS still works without
-- it. If the extension is not installed, all vector column additions below are
-- silently skipped via DO blocks; the tables and indexes remain functional for
-- full-text search.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not installed -- semantic search disabled. Install: https://github.com/pgvector/pgvector';
END $$;

-- pg_trgm enables trigram-based fuzzy text matching used by the resurrect query
-- type (buildFuzzyMatch seam method). Gracefully no-ops if already installed.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm not installed -- resurrect fuzzy fallback will degrade to SQL LIKE';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MEMORY ENTRIES
-- One row per atomic memory file (frontmatter: name, description, type).
-- The body column holds the full markdown content after frontmatter is stripped.
-- source_file is the relative path to the .md file; UNIQUE enforces one row per
-- file and is the key for incremental sync (content_hash detects changes).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_entries (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,              -- frontmatter: name
  description  TEXT,                       -- frontmatter: description
  mem_type     TEXT,                       -- frontmatter: type (user, feedback, project, reference)
  body         TEXT NOT NULL,             -- full markdown content (post-frontmatter)
  source_file  TEXT UNIQUE,               -- relative path to memory/<file>.md
  content_hash TEXT,                      -- SHA-256 of body for incremental sync
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Vector column for semantic search. Wrapped in DO block because ALTER TABLE
-- ADD COLUMN ... vector(...) raises undefined_object if pgvector is not present.
DO $$ BEGIN
  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS embedding vector(1024);
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Skipping vector column on memory_entries -- pgvector not installed.';
END $$;

-- FTS via STORED generated column. Concatenates name + description + body so
-- searches hit all three fields. GIN index enables fast @@ operator queries.
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(body, ''))
  ) STORED;

-- GIN is the standard index type for tsvector. It supports containment queries
-- (@@) efficiently; GiST trades slightly smaller size for slower builds and is
-- not preferred here.
CREATE INDEX IF NOT EXISTS memory_entries_fts_idx  ON memory_entries USING gin(fts_vec);
CREATE INDEX IF NOT EXISTS memory_entries_type_idx ON memory_entries (mem_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MEMORY ENTRY CHUNKS
-- Sibling table: one row per semantic chunk of a memory_entries row.
-- Why a separate table rather than storing chunks in memory_entries directly?
-- Embedding models have a fixed context window (~512 tokens for mxbai). Long
-- memory files must be split before embedding. Keeping chunks as siblings lets
-- the parent row stay intact for display/sync purposes while the chunk table
-- holds the searchable units. CASCADE delete keeps referential integrity clean.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memory_entry_chunks (
  id           SERIAL PRIMARY KEY,
  entry_id     INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  chunk_idx    INTEGER NOT NULL,           -- 0-based position within the entry
  content      TEXT NOT NULL,
  content_hash TEXT,                       -- SHA-256 for incremental re-embed
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entry_id, chunk_idx)
);

-- Unique constraint idempotency: re-applying a named UNIQUE on an existing table
-- raises 42P07 (duplicate_table), NOT 42710 (duplicate_object). Use
-- EXCEPTION WHEN duplicate_table in any future ALTER ADD CONSTRAINT blocks.
-- The UNIQUE above is inline and handled by CREATE TABLE IF NOT EXISTS, so no
-- separate DO block is needed here.

DO $$ BEGIN
  ALTER TABLE memory_entry_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Skipping vector column on memory_entry_chunks -- pgvector not installed.';
END $$;

ALTER TABLE memory_entry_chunks ADD COLUMN IF NOT EXISTS fts_vec TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS mem_chunks_fts_idx   ON memory_entry_chunks USING gin(fts_vec);
CREATE INDEX IF NOT EXISTS mem_chunks_entry_idx ON memory_entry_chunks (entry_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- HNSW VECTOR INDEXES
-- HNSW (Hierarchical Navigable Small World) is the preferred index type for
-- pgvector when query latency matters. It builds a navigable graph structure
-- that supports approximate nearest-neighbor search in O(log n) per query,
-- versus IVFFlat's O(sqrt(n)). The tradeoff is higher build time and memory.
-- For a memory store that is read far more often than it is written, HNSW is
-- the right default. Falls back to IVFFlat on older pgvector builds that
-- predate HNSW support (pgvector < 0.5.0).
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS memory_entries_vec_idx
    ON memory_entries USING hnsw (embedding vector_cosine_ops);
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'Skipping HNSW index on memory_entries -- pgvector not installed.';
  WHEN feature_not_supported THEN
    RAISE NOTICE 'HNSW not supported (pgvector < 0.5.0) -- falling back to ivfflat on memory_entries.';
    EXECUTE 'CREATE INDEX IF NOT EXISTS memory_entries_vec_idx ON memory_entries USING ivfflat (embedding vector_cosine_ops)';
END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS mem_chunks_vec_idx
    ON memory_entry_chunks USING hnsw (embedding vector_cosine_ops);
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'Skipping HNSW index on memory_entry_chunks -- pgvector not installed.';
  WHEN feature_not_supported THEN
    RAISE NOTICE 'HNSW not supported (pgvector < 0.5.0) -- falling back to ivfflat on memory_entry_chunks.';
    EXECUTE 'CREATE INDEX IF NOT EXISTS mem_chunks_vec_idx ON memory_entry_chunks USING ivfflat (embedding vector_cosine_ops)';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v_memory_hits VIEW
-- v_memory_hits is defined in sql/v_memory_hits.sql so migrations that need to
-- DROP it for ALTER COLUMN TYPE can re-apply via \ir sql/v_memory_hits.sql.
-- See BUNDLE-A-SPEC.md Phase 1 step 5 for the canonical migration pattern.
-- ═══════════════════════════════════════════════════════════════════════════════

\ir sql/v_memory_hits.sql
