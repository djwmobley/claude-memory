---
name: fts-vs-vector-search
description: When full-text search wins vs semantic search, and how hybrid scoring blends them
type: reference
---

# Full-Text Search vs Vector Search

Full-text search (FTS) and vector (semantic) search are complementary retrieval mechanisms.
Neither dominates the other across all query types. Understanding the failure modes of each
is essential for deciding when to run hybrid search and how to weight the blend.

## How Full-Text Search Works

FTS operates on lexical matching. Documents are preprocessed into `tsvector` tokens
(stemmed, lowercased, stop-word-filtered). Queries are parsed into `tsquery` expressions.
Matching is exact: a document matches if its token set contains the query tokens.

Ranking uses `ts_rank` (term frequency) or `ts_rank_cd` (cover density) -- both are
BM25 variants that weight results by how often and how tightly clustered the query terms
appear in the document.

**FTS wins when:**
- The query contains exact identifiers: product names, error codes, version strings, UUIDs,
  function names, command names. These are opaque tokens with no synonyms in embedding space.
- The user types in a "search box" mode with keywords rather than natural language.
- Precision matters more than recall: the user expects results that contain the literal
  query terms.
- The corpus vocabulary is specialized (domain jargon) and a general-purpose embedding
  model may not have seen enough training data on that vocabulary to generalize.
- Latency is extremely tight: BM25 over a GIN index is faster than ANN over HNSW for
  small result sets.

**FTS fails when:**
- The query and document use different words for the same concept ("car" vs "automobile",
  "fire someone" vs "terminate employment").
- The query is a question in natural language; FTS treats every word as a keyword and
  struggles with interrogative structure.
- The corpus contains paraphrases of the answer without the exact query terms.
- Multi-lingual corpora where stemming rules differ by language.

## How Vector Search Works

Vector search embeds both query and documents into a shared latent space. Retrieval finds
documents whose embeddings are closest to the query embedding by cosine similarity
(or inner product, or Euclidean distance). The model has encoded semantic relationships
during training: synonymous phrases map to nearby vectors.

**Vector search wins when:**
- Queries are phrased in natural language ("how do I handle connection timeouts?")
  but the document uses different vocabulary ("managing TCP keepalive settings").
- The corpus is large and diverse enough that exact-match is unlikely to capture
  all relevant documents.
- The user does not know the exact terminology used in the target documents.
- Cross-lingual retrieval: embed in one language, retrieve in another.
- Intent-based search: the query expresses a goal, not a keyword.

**Vector search fails when:**
- The query contains precise identifiers. An embedding of "error code 0x80070005" is a
  blurry concept somewhere in "permission denied" space; BM25 on the literal string is
  more reliable.
- The corpus is very small (under a few hundred documents). The ANN index does not improve
  over brute force at small scale, and the query embedding may generalize poorly to a
  sparse corpus.
- The embedding model has not been trained on the domain vocabulary. A model trained on
  web text may embed medical ICD codes or legal citations poorly.
- The query requires fine-grained ordering (e.g., "which version introduced this feature?").
  Temporal and ordinal reasoning are not encoded in static embeddings.

## Hybrid Search and Score Blending

Hybrid search runs both FTS and vector retrieval, then merges the ranked lists. The two
main merging strategies are:

### Reciprocal Rank Fusion (RRF)

RRF is rank-based, not score-based. Each document's merged score is:

```
score = sum(1 / (k + rank_i))
```

where `k` is a smoothing constant (typically 60) and `rank_i` is the document's rank
in result set `i`. RRF is insensitive to the absolute score magnitude of either system,
making it robust when FTS and vector scores are on different scales (which they always are).

RRF is the recommended default for hybrid search. It requires no tuning beyond `k`,
and the `k=60` default performs well across most datasets.

### Weighted Linear Combination

Normalize both score lists to [0, 1] and compute:

```
final_score = alpha * vector_score + (1 - alpha) * bm25_score
```

This is more expressive than RRF -- you can tune `alpha` to favor one system over the
other based on query type -- but it requires careful score normalization. Min-max
normalization is sensitive to outliers; use a clipped percentile normalization instead.

### When to Favor Each Side

| Query type              | Recommended alpha (vector weight) |
|-------------------------|-----------------------------------|
| Natural language question | 0.7 - 0.9                       |
| Keyword search            | 0.2 - 0.4                       |
| Mixed intent              | 0.5 (default)                    |
| Identifier lookup         | 0.0 - 0.1 (FTS only)            |

Query classification (simple classifier or heuristic based on query structure) can route
to the appropriate blending weight automatically.

## PostgreSQL Implementation

PostgreSQL supports both natively:

- **FTS:** `tsvector` + `tsquery` + GIN index + `ts_rank`
- **Vector:** `pgvector` extension + `vector` column + HNSW or IVFFlat index

RRF merge in PostgreSQL:

```sql
WITH
  fts AS (
    SELECT id, ts_rank(search_vector, query) AS score,
           rank() OVER (ORDER BY ts_rank(search_vector, query) DESC) AS r
    FROM documents, plainto_tsquery('english', $1) query
    WHERE search_vector @@ query
    ORDER BY score DESC LIMIT 60
  ),
  vec AS (
    SELECT id,
           1 - (embedding <=> $2::vector) AS score,
           rank() OVER (ORDER BY embedding <=> $2::vector) AS r
    FROM documents
    ORDER BY embedding <=> $2::vector LIMIT 60
  )
SELECT COALESCE(fts.id, vec.id) AS id,
       COALESCE(1.0/(60+fts.r), 0) + COALESCE(1.0/(60+vec.r), 0) AS rrf_score
FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
ORDER BY rrf_score DESC
LIMIT 20;
```

## Practical Default

For a new knowledge-base search system without detailed query analytics:

1. Implement hybrid with RRF from the start. The overhead is one extra query and a merge.
2. Default `k=60`.
3. If you observe that identifier lookups are returning wrong results, add a query
   classification step to boost FTS weight for token-heavy queries.
4. Measure retrieval recall on a 50-100 question golden set before tuning further.
