-- migrate-14-seam-tables-embeddings.sql
--
-- Sidecar to migrate-14-seam-tables.sql, applied immediately after it (see
-- migrate-14-seam-tables.js's SQL_FILES order). Adds the embedding
-- halfvec(4000) column + HNSW index to each of the 13 §5.3 seam tables, one
-- DO $$ ... $$ graceful-degradation block per column/index -- the SAME
-- pattern already used by handoff-core-schema.sql's assertions.embedding
-- block and migrate-13-agent-exchange.sql's agent_exchange.embedding block.
--
-- DELIBERATELY KEPT OUT OF migrate-14-seam-tables.sql (§7.9/S-16,
-- claude-memory#159): migrate-schema-addenda.js's exported verifyAddenda is
-- used for that file's generic derived verification, and its splitter is
-- not dollar-quote-aware. This file is applied via migrateOne.applySqlFile
-- (which has no such limitation -- see migrate-13-agent-exchange.sql, which
-- already relies on the same applier for its own DO blocks) but is NEVER
-- passed to verifyAddenda. migrate-14-seam-tables.js verifies the columns
-- and indexes shipped here with its own targeted per-table checks instead,
-- mirroring migrate-13-agent-exchange.js's checkEmbeddingColumn/
-- checkHnswIndex (D-3/D-4), generalized into a loop over all 13 tables.
--
-- Each DO block independently EXCEPTION WHEN OTHERS -> RAISE NOTICE, so a
-- pgvector-absent target degrades every single one of these 26 statements
-- gracefully rather than aborting the whole file on the first failure.

DO $$ BEGIN
  ALTER TABLE decisions ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'decisions.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS decisions_embedding_idx
    ON decisions USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'decisions_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE gotchas ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'gotchas.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS gotchas_embedding_idx
    ON gotchas USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'gotchas_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE findings ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'findings.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS findings_embedding_idx
    ON findings USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'findings_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'tasks.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS tasks_embedding_idx
    ON tasks USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'tasks_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE research ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'research.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS research_embedding_idx
    ON research USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'research_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'incidents.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS incidents_embedding_idx
    ON incidents USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'incidents_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE code_index ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_index.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS code_index_embedding_idx
    ON code_index USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'code_index_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'checklist_items.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS checklist_items_embedding_idx
    ON checklist_items USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'checklist_items_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE corpus_files ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'corpus_files.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS corpus_files_embedding_idx
    ON corpus_files USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'corpus_files_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE workflow_discovery ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'workflow_discovery.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS workflow_discovery_embedding_idx
    ON workflow_discovery USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'workflow_discovery_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE agent_rewrites ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agent_rewrites.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS agent_rewrites_embedding_idx
    ON agent_rewrites USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agent_rewrites_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE policy_sections ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'policy_sections.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS policy_sections_embedding_idx
    ON policy_sections USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'policy_sections_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;

DO $$ BEGIN
  ALTER TABLE session_chunks ADD COLUMN IF NOT EXISTS embedding halfvec(4000);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'session_chunks.embedding halfvec(4000) skipped -- pgvector not installed';
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS session_chunks_embedding_idx
    ON session_chunks USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'session_chunks_embedding_idx skipped -- pgvector not installed or halfvec_cosine_ops unavailable';
END $$;
