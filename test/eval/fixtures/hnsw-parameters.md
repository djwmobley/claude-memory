---
name: hnsw-parameters
description: HNSW index parameters m, ef_construction, and ef_search -- the recall vs speed tradeoff knobs
type: reference
---

# HNSW Parameters

HNSW (Hierarchical Navigable Small World) has three tuning parameters that directly
control the recall-versus-speed tradeoff. Two are set at index creation time; one is
set per query.

## m -- Connections per Node

`m` is the number of bidirectional links each node maintains to its nearest neighbors
at each layer of the HNSW graph. Default in pgvector: `16`.

**Effect:** Higher `m` improves recall (more paths through the graph for the search
to explore) at the cost of larger index size and longer build time.

**Practical range:** 8-64. Values above 48 show diminishing recall returns for most
corpora. Values below 8 produce poor recall.

**Rule of thumb:**
- `m = 16` -- good default, appropriate for most workloads
- `m = 24-32` -- for recall-sensitive applications (deduplication, recommendation)
- `m = 48-64` -- for very high-recall requirements, accepting larger index

## ef_construction -- Build-Time Candidate List

`ef_construction` is the size of the dynamic candidate list during index construction.
Default in pgvector: `64`.

**Effect:** Higher `ef_construction` improves the quality of the graph (better neighbor
connections), which translates to higher recall at query time. Cost: longer build time.
Does not affect index size significantly.

**Practical range:** 64-512. Values above 256 yield diminishing returns.

**Rule of thumb:**
- `ef_construction = 64` -- default, fine for most cases
- `ef_construction = 128` -- moderate boost to recall quality
- `ef_construction = 256` -- high-quality graph for maximum recall potential

Changing `ef_construction` requires `REINDEX` to take effect.

## ef_search -- Query-Time Candidate List

`ef_search` is the size of the dynamic candidate list during search. Default: `40`.
Set per query session: `SET hnsw.ef_search = 100`.

**Effect:** Higher `ef_search` explores more of the graph per query, improving recall
at the cost of query latency. This is the primary runtime recall knob.

**Recall guidance:**
- `ef_search = 40` -- default; ~90% recall for well-tuned m/ef_construction
- `ef_search = 100` -- ~95-98% recall for most datasets
- `ef_search = 200+` -- approaches brute-force recall; latency grows significantly

**Quick calibration:**

```sql
SET hnsw.ef_search = 40;
EXPLAIN (ANALYZE, TIMING) SELECT id FROM docs ORDER BY emb <=> $1 LIMIT 10;
-- measure execution time and compare results to exact brute-force
```

Run the same query with and without the index (`SET enable_indexscan = off` disables
it) and compare result sets to measure recall empirically.

## Combining the Parameters

The recall curve is primarily determined by `ef_search` at query time. The graph quality
(controlled by `m` and `ef_construction`) sets the ceiling -- a poorly built graph cannot
be compensated for by a high `ef_search`.

A balanced setup for production:
```sql
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

SET hnsw.ef_search = 80;
```

For maximum recall with acceptable latency overhead:
```sql
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 256);

SET hnsw.ef_search = 150;
```
