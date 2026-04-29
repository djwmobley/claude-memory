---
name: building-rag-tutorial
description: End-to-end tutorial for building a RAG system -- ingest, chunk, embed, index, retrieve, and rerank
type: project
---

# Building a RAG System from Scratch

This tutorial walks through building a complete retrieval-augmented generation (RAG) pipeline
using PostgreSQL + pgvector for storage, a local Ollama model for embeddings, and a Node.js
application layer. Each step builds on the previous.

## Prerequisites

- PostgreSQL 15+ with pgvector extension
- Ollama running locally with `nomic-embed-text` pulled
- Node.js 18+ with `pg` and `gray-matter` packages
- A directory of Markdown files to index

```bash
# Install packages (in scripts/ directory or your project root)
pnpm add pg gray-matter
# or: npm install pg gray-matter

# Pull the embedding model
ollama pull nomic-embed-text
```

---

## Step 1: Bootstrap the Database Schema

Create the tables and indexes. This script is idempotent -- safe to re-run.

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Main entries table
CREATE TABLE IF NOT EXISTS memory_entries (
  id           BIGSERIAL PRIMARY KEY,
  source_path  TEXT NOT NULL,
  name         TEXT,
  description  TEXT,
  type         TEXT NOT NULL DEFAULT 'reference',
  body         TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  embedding    vector(768),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(body, ''))
  ) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on content_hash (for upsert-by-content)
DO $$
BEGIN
  ALTER TABLE memory_entries
    ADD CONSTRAINT memory_entries_content_hash_unique UNIQUE (content_hash);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- HNSW index for ANN search
CREATE INDEX IF NOT EXISTS memory_entries_hnsw_idx
  ON memory_entries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS memory_entries_fts_idx
  ON memory_entries
  USING gin (search_vector);
```

Save this as `schema.sql` and run it:

```bash
psql "$DATABASE_URL" < schema.sql
```

---

## Step 2: Ingest and Chunk Markdown Files

The ingestion step reads each Markdown file, parses the frontmatter, and prepares
the body for embedding.

```js
// ingest.js
const fs      = require('fs');
const path    = require('path');
const matter  = require('gray-matter');
const crypto  = require('crypto');

/**
 * Load and parse all .md files from a directory.
 * Returns an array of document objects ready for embedding.
 */
function loadDocuments(dir) {
  const docs = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw      = fs.readFileSync(filePath, 'utf8');
    const { data, content } = matter(raw);

    if (!data.name || !data.type) {
      console.warn(`Skipping ${file}: missing required frontmatter fields`);
      continue;
    }

    const body = content.trim();
    const hashInput = [data.name, data.description, body].join('\x00');
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    docs.push({
      source_path:  filePath,
      name:         data.name,
      description:  data.description || null,
      type:         data.type,
      body,
      content_hash: hash,
    });
  }

  return docs;
}
```

### Chunking Strategy

For short memory entries (under 1000 tokens), the entire body is a single chunk.
For longer documents, split on heading boundaries:

```js
/**
 * Split a document body on markdown headings (## or deeper).
 * Returns an array of { heading, body } chunks.
 */
function chunkByHeadings(body) {
  const lines   = body.split('\n');
  const chunks  = [];
  let current   = { heading: null, lines: [] };

  for (const line of lines) {
    if (/^#{2,}\s/.test(line)) {
      if (current.lines.length > 0) {
        chunks.push({
          heading: current.heading,
          body:    current.lines.join('\n').trim(),
        });
      }
      current = { heading: line.replace(/^#+\s/, ''), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.lines.length > 0) {
    chunks.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  }

  return chunks.filter(c => c.body.length > 50);  // drop near-empty chunks
}
```

---

## Step 3: Generate Embeddings

Call the local Ollama embedding endpoint. Process in batches to avoid memory pressure.

```js
// embed.js
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL      = 'nomic-embed-text';
const BATCH_SIZE = 32;

async function embedText(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: MODEL, prompt: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.embedding;  // float[]
}

async function embedBatch(docs) {
  const results = [];

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    console.log(`Embedding batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(docs.length/BATCH_SIZE)}`);

    for (const doc of batch) {
      // Prepend name + description to give the embedding model context
      const input = [doc.name, doc.description, doc.body]
        .filter(Boolean)
        .join('\n\n');
      doc.embedding = await embedText(input);
      results.push(doc);
    }
  }

  return results;
}
```

---

## Step 4: Store in PostgreSQL

Upsert each document. Use `ON CONFLICT (content_hash) DO NOTHING` for
insert-only semantics (unchanged documents are skipped efficiently).

```js
// store.js
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function storeDocs(docs) {
  let inserted = 0, skipped = 0;

  for (const doc of docs) {
    const vectorLiteral = `[${doc.embedding.join(',')}]`;

    const result = await pool.query(`
      INSERT INTO memory_entries
        (source_path, name, description, type, body, content_hash, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING id
    `, [
      doc.source_path, doc.name, doc.description,
      doc.type, doc.body, doc.content_hash, vectorLiteral
    ]);

    if (result.rows.length > 0) inserted++;
    else skipped++;
  }

  console.log(`Stored: ${inserted} new, ${skipped} unchanged`);
  await pool.end();
}
```

---

## Step 5: Retrieve -- Hybrid Search

At query time, run both vector search and FTS, then merge with RRF:

```js
// retrieve.js
async function retrieve(pool, queryText, queryEmbedding, limit = 10) {
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  const { rows } = await pool.query(`
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
    SELECT
      COALESCE(vec.id, fts.id) AS id,
      COALESCE(1.0/(60+vec.r), 0) + COALESCE(1.0/(60+fts.r), 0) AS score
    FROM vec FULL OUTER JOIN fts ON vec.id = fts.id
    ORDER BY score DESC
    LIMIT $3
  `, [vectorLiteral, queryText, limit]);

  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const scoreMap = Object.fromEntries(rows.map(r => [r.id, r.score]));

  const { rows: docs } = await pool.query(
    'SELECT id, name, description, body FROM memory_entries WHERE id = ANY($1)',
    [ids]
  );

  return docs
    .map(d => ({ ...d, score: scoreMap[d.id] }))
    .sort((a, b) => b.score - a.score);
}
```

---

## Step 6: Rerank (Optional)

After retrieval, a cross-encoder reranker re-scores the candidates using the full
query-document pair for better precision:

```js
// rerank.js -- using Cohere Rerank API
async function cohere_rerank(query, candidates, topN = 5) {
  const res = await fetch('https://api.cohere.ai/v1/rerank', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:     'rerank-english-v3.0',
      query,
      documents: candidates.map(c => c.body),
      top_n:     topN,
    }),
  });

  const data = await res.json();
  return data.results.map(r => ({
    ...candidates[r.index],
    rerank_score: r.relevance_score,
  }));
}
```

Reranking is optional but meaningfully improves precision for ambiguous queries.
Run it on the top-20 retrieved results and return the top-5.

---

## Step 7: Generate an Answer

Compose the retrieved passages into a prompt and call the LLM:

```js
// generate.js
async function generate(query, passages, anthropicClient) {
  const context = passages
    .map((p, i) => `[${i+1}] ${p.name}\n${p.body}`)
    .join('\n\n---\n\n');

  const message = await anthropicClient.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 1024,
    system: `You are a helpful assistant. Answer the user's question using ONLY
the provided context passages. Cite passages by number like [1], [2].
If the answer is not in the context, say so -- do not speculate.`,
    messages: [{
      role:    'user',
      content: `Context:\n\n${context}\n\nQuestion: ${query}`,
    }],
  });

  return message.content[0].text;
}
```

---

## Complete Pipeline

```js
// pipeline.js
async function run(query) {
  const queryEmbedding = await embedText(query);
  const candidates     = await retrieve(pool, query, queryEmbedding, 20);
  const reranked       = await cohere_rerank(query, candidates, 5);
  const answer         = await generate(query, reranked, anthropic);

  console.log('Answer:', answer);
  console.log('Sources:', reranked.map(p => p.name));
}

run('How does HNSW handle concurrent inserts?').catch(console.error);
```

## Troubleshooting

**No results from vector search:** Check that the embedding model used at ingest time
matches the one used at query time. Run `SELECT COUNT(*) FROM memory_entries WHERE embedding IS NULL`
to check for rows with missing embeddings.

**High latency:** Run `EXPLAIN (ANALYZE, BUFFERS)` on the retrieval query. If it shows
a `Seq Scan` instead of an index scan, the HNSW index may not be built yet, or `enable_indexscan`
is off for the session.

**Poor retrieval quality:** Add more documents (ANN quality improves with corpus size),
tune `ef_search` upward, or switch to a higher-dimension embedding model.
