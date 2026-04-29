---
name: pgvector-setup-sql
description: pgvector extension setup SQL -- CREATE EXTENSION, vector columns, HNSW and IVFFlat DDL, idempotent patterns
type: reference
---

# pgvector Setup SQL

Idempotent DDL for bootstrapping a pgvector-enabled PostgreSQL schema. All statements
use `IF NOT EXISTS` or `DO $$ ... EXCEPTION ...` guards so they can be re-run safely
as part of a migration or init script.

## Enable Extension

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This installs the `vector` type and associated operator classes. Requires PostgreSQL 12+
and pgvector 0.4.0+. On managed Postgres (RDS, Supabase, Neon), pgvector is typically
pre-installed; just run `CREATE EXTENSION IF NOT EXISTS vector`.

## Table with Embedding Column

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL DEFAULT 'reference',
  body        TEXT NOT NULL,
  embedding   vector(768),
  content_hash CHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The `vector(768)` column stores a 768-dimensional float32 vector. The dimension count
must match the output of your embedding model. Dimension mismatches raise a cast error
at insert time.

## Full-Text Search Column

```sql
ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(body, ''))
  ) STORED;
```

`GENERATED ALWAYS AS ... STORED` computes the tsvector automatically on insert/update.
No application code needed to maintain it.

## HNSW Index (Recommended for Production)

```sql
CREATE INDEX IF NOT EXISTS memory_entries_embedding_hnsw_idx
  ON memory_entries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

`m = 16` and `ef_construction = 64` are the defaults. For higher recall:

```sql
CREATE INDEX IF NOT EXISTS memory_entries_embedding_hnsw_idx
  ON memory_entries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 128);
```

## IVFFlat Index (Alternative)

```sql
-- Build only after the table has data (run after bulk load)
CREATE INDEX IF NOT EXISTS memory_entries_embedding_ivf_idx
  ON memory_entries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

`lists = 100` is suitable for tables with ~100K rows. Adjust to `sqrt(row_count)` for
larger tables.

## GIN Index for Full-Text Search

```sql
CREATE INDEX IF NOT EXISTS memory_entries_fts_idx
  ON memory_entries
  USING gin (search_vector);
```

## Unique Constraint on content_hash

```sql
DO $$
BEGIN
  ALTER TABLE memory_entries
    ADD CONSTRAINT memory_entries_content_hash_unique UNIQUE (content_hash);
EXCEPTION
  WHEN duplicate_table THEN NULL;  -- already exists
END $$;
```

Note: re-applying a named UNIQUE constraint raises `duplicate_table` (SQLSTATE 42P07),
not `duplicate_object`. The exception clause must catch `duplicate_table`.

## Query: ANN Search

```sql
SELECT id, name, description,
       1 - (embedding <=> $1::vector) AS similarity
FROM memory_entries
ORDER BY embedding <=> $1::vector
LIMIT $2;
```

Pass the query embedding as a `::vector` cast from a text literal or bind parameter.
`<=>` is the cosine distance operator; `1 - distance` gives similarity in [0, 1].

## Query: Hybrid Search (RRF)

```sql
WITH
  vec AS (
    SELECT id,
           rank() OVER (ORDER BY embedding <=> $1::vector) AS r
    FROM memory_entries
    ORDER BY embedding <=> $1::vector
    LIMIT 60
  ),
  fts AS (
    SELECT id,
           rank() OVER (ORDER BY ts_rank(search_vector, q) DESC) AS r
    FROM memory_entries,
         plainto_tsquery('english', $2) q
    WHERE search_vector @@ q
    ORDER BY r
    LIMIT 60
  )
SELECT COALESCE(vec.id, fts.id) AS id,
       COALESCE(1.0/(60+vec.r), 0) + COALESCE(1.0/(60+fts.r), 0) AS score
FROM vec FULL OUTER JOIN fts ON vec.id = fts.id
ORDER BY score DESC
LIMIT $3;
```

## Set ef_search at Query Time

```sql
-- Higher ef_search = better recall, slower query
SET hnsw.ef_search = 100;

SELECT id, 1 - (embedding <=> $1::vector) AS similarity
FROM memory_entries
ORDER BY embedding <=> $1::vector
LIMIT 10;

-- Reset to default
RESET hnsw.ef_search;
```

`hnsw.ef_search` default is 40. Setting it to 100 improves recall at the cost of
query latency. Set it in the session for recall-sensitive queries.
