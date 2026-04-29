---
name: vector-indexes-postgres
description: HNSW vs IVFFlat index design tradeoffs in pgvector -- when to use each, build-time vs query-time costs
type: reference
---

# Vector Indexes in PostgreSQL (pgvector)

pgvector ships with two approximate nearest-neighbor index types: HNSW and IVFFlat. Choosing
between them is a permanent schema decision with significant operational consequences. This entry
covers the design tradeoffs so you can make the right call at schema-design time rather than
re-indexing under load.

## HNSW -- Hierarchical Navigable Small World

HNSW builds a multi-layer graph where each node links to its nearest neighbors at multiple
granularities. At query time, the search enters the top layer (sparsest) and greedily descends
toward the query vector, widening the candidate set at each level.

**Build-time characteristics:**
- Significantly more memory-hungry than IVFFlat during construction
- Build is single-threaded in pgvector 0.5.x; parallelism arrived in 0.6.0 via `max_parallel_maintenance_workers`
- Slower to build on large tables (millions of rows can take tens of minutes)
- Index size on disk is roughly 2-4x larger than IVFFlat for the same data

**Query-time characteristics:**
- Excellent recall at low `ef_search` values -- typically 95%+ recall at ef_search=40
- Query latency is sublinear in table size; scales well as the dataset grows
- No warm-up phase required: cold queries perform the same as warm queries
- Stable recall regardless of data distribution quirks

**When to choose HNSW:**
- Production workloads where query latency matters
- Tables that grow continuously (HNSW handles inserts gracefully; no rebuild required)
- When you can afford the longer initial build time and higher memory footprint
- Recall-sensitive applications (recommendation, semantic search, deduplication)

## IVFFlat -- Inverted File with Flat Quantization

IVFFlat partitions the vector space into `lists` Voronoi cells (clusters). At build time,
k-means assigns each vector to its nearest centroid. At query time, the search probes
`probes` cells and returns the best candidates from those cells.

**Build-time characteristics:**
- Much faster to build than HNSW -- practical even on tens of millions of rows
- Lower peak memory: only needs to materialize one partition at a time
- Requires the table to be pre-populated; building on an empty table produces a useless index
- Recommended to have at least `lists * 10` rows at build time for quality centroids

**Query-time characteristics:**
- Recall is sensitive to the `probes` setting: higher probes = better recall, more latency
- Recall degrades if data distribution shifts significantly after index creation
- Cold cache misses hurt more because partition pages may not be in shared_buffers
- Requires periodic VACUUM + REINDEX if the data distribution drifts substantially

**When to choose IVFFlat:**
- Batch analytics workloads where throughput matters more than p99 latency
- Tables that are largely static after an initial bulk load
- Memory-constrained environments where HNSW build overhead is prohibitive
- Early-stage projects where quick iteration matters more than peak recall

## Quantitative Comparison

| Dimension           | HNSW               | IVFFlat            |
|---------------------|--------------------|--------------------|
| Build memory        | High (2-10 GB+)    | Low-medium         |
| Build time (1M rows)| ~5-20 min          | ~1-3 min           |
| Index size          | 2-4x data          | ~1.3-1.8x data     |
| Query recall        | High, stable       | Variable by probes |
| Insert cost         | O(log n) per insert| No rebuild needed  |
| Supports empty build| Yes                | No (needs data)    |

## Dimension Size and Distance Function

Both index types require specifying the distance function at CREATE INDEX time. pgvector
supports three:

- `vector_l2_ops` -- Euclidean distance, good for coordinates and general-purpose embedding
- `vector_ip_ops` -- inner product (negated), fastest when embeddings are pre-normalized
- `vector_cosine_ops` -- cosine similarity, the standard for text embeddings

For text embeddings (OpenAI, nomic-embed-text, mxbai-embed-large), use `vector_cosine_ops`.
The vectors are typically L2-normalized by the model, so inner product and cosine distance
are mathematically equivalent -- but `vector_ip_ops` is slightly faster when you know the
vectors are normalized.

## Selecting `lists` for IVFFlat

The pgvector documentation recommends `lists = rows / 1000` for tables under 1 million rows,
and `sqrt(rows)` for larger tables. A starting point for a 500K-row table is `lists = 500`.

Probe count is typically set to `lists / 10` for a reasonable recall/latency balance. If
you measure recall below 90%, increase probes or rebuild with more lists.

## Selecting `m` and `ef_construction` for HNSW

`m` is the number of bidirectional links per node. Higher `m` improves recall at the cost
of larger index size and longer build time. Default is 16; values of 24-48 are common for
high-recall requirements.

`ef_construction` is the dynamic candidate list size during construction. Higher values
improve recall quality at the cost of build time. Default is 64; 128-256 are safe choices
for recall-sensitive workloads.

These are set at index creation and cannot be changed without a REINDEX.

## Monitoring Index Usage

```sql
-- Check if queries are using the vector index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, embedding <=> '[0.1, 0.2, ...]'::vector AS distance
FROM documents
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 10;

-- Check index size
SELECT pg_size_pretty(pg_relation_size('documents_embedding_idx'));
```

A sequential scan in EXPLAIN output means either: (a) the index has not been created,
(b) the result set is too large for the planner to prefer the index, or (c)
`enable_indexscan = off` in the session. For ANN queries with a LIMIT clause, the
planner should almost always choose the index.
