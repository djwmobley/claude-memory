---
name: semantic-cache-invalidation
description: Caching RAG query results by semantic similarity and invalidating cached entries when source documents change
type: reference
---

# Semantic Cache Invalidation

A semantic cache for RAG systems stores query-answer pairs and retrieves cached answers
for new queries that are semantically similar to a previously answered query, bypassing
the retrieval and generation pipeline entirely. The cache lookup is itself a vector
similarity search: the new query is embedded and compared against cached query embeddings,
and a match is declared if the cosine similarity exceeds a threshold, typically 0.92-0.97
depending on how conservatively you want to reuse cached answers.

Semantic caches dramatically reduce latency and API cost for query distributions where
many users ask semantically equivalent questions with different wording. The problem
that makes them operationally complex is invalidation: a cached answer may become wrong
if the source documents it was generated from are updated. Unlike a key-based cache
where invalidation is a simple key delete, a semantic cache stores answers keyed by
query embeddings with no direct link to the source documents that produced them.

## Invalidation Strategies by Corpus Update Pattern

For corpora that change in batches (daily rebuild, nightly sync), a simple invalidation
strategy is to set a cache TTL equal to the update interval and expire all entries on
each rebuild. This is correct but wasteful: if 90% of documents are unchanged between
rebuilds, 90% of cache entries are invalidated unnecessarily.

Document-linked invalidation improves on this by tracking which document chunk IDs
contributed to each cached answer. When a chunk is re-indexed (because its content
hash changed), all cached answers that cite that chunk are marked stale. This requires
the generation pipeline to log the source chunk IDs used for each answer, which most
RAG pipelines already do for citation purposes.

The implementation stores a bidirectional mapping: cache_entry_id → [chunk_id, ...] and
chunk_id → [cache_entry_id, ...]. When a chunk is updated, the second mapping gives the
list of affected cache entries in O(1) time. The total metadata overhead is proportional
to the product of average cache size and average context window size (number of chunks
cited per answer), typically 10-50 chunk IDs per cached answer.

## Similarity Threshold and False Positive Rate

The cache lookup threshold is the most sensitive operational parameter. Too low a
threshold (0.80-0.88) produces false positives: a query about "connection timeout
settings" matches a cached answer about "query timeout configuration," and the user
receives a subtly wrong answer. Too high a threshold (above 0.98) produces cache misses
on clearly equivalent queries: "how do I configure the connection pool size?" and
"what is the default connection pool size?" may score below 0.98 cosine similarity
despite requiring the same answer.

The threshold should be calibrated on a validation set of query pairs annotated as
same-intent or different-intent. The optimal threshold minimizes the sum of false
positive rate (wrong answer served) and false negative rate (cache miss that could
have been a hit). In practice, 0.93-0.95 is a reasonable starting range, and the
optimal value varies substantially with the vocabulary breadth of your query distribution.

## Namespace Scoping and Cache Warming

For multi-tenant RAG systems, semantic caches must be namespace-scoped: a cached answer
generated from documents visible to user A must not be served to user B. The standard
implementation maintains separate caches per access-control namespace, or stores the
namespace identifier as a filter field in the shared vector index and enforces it at
query time. The shared-index approach allows faster lookup while maintaining isolation,
but requires that the namespace field cannot be spoofed by the client.

For read-heavy applications with predictable query distributions, a proactive cache
warming strategy generates answers for the most frequent query clusters before they are
requested. Query clusters are identified by running k-means over historical query
embeddings, with one representative per cluster used for pre-generation. Pre-generated
answers must be regenerated after each corpus update; the cost is proportional to the
number of pre-warmed cluster representatives, typically 100-1000 for most applications.
