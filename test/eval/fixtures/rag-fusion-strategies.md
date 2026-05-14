---
name: rag-fusion-strategies
description: RAG-Fusion multi-query generation, parallel retrieval, and RRF merging to improve recall over single-query retrieval
type: reference
---

# RAG-Fusion Strategies

A single query passed to a retrieval system explores one region of the embedding space.
If the user's phrasing does not align with the vocabulary or framing of the relevant
documents, that region may be distant from the documents that would actually answer the
question. RAG-Fusion is a technique that addresses this limitation by generating
multiple semantically distinct restatements of the original query, running retrieval
for each, and merging the result sets.

The name "RAG-Fusion" was popularized by a 2023 community implementation but the
underlying idea -- multiple query formulations merged via rank fusion -- predates neural
retrieval and appears in the information retrieval literature as query expansion and
query diversification.

## Multi-Query Generation

The first step is generating K alternative query formulations from the original user
query. These are not paraphrases (which would retrieve the same documents) but
semantically related reformulations that might use different vocabulary or approach the
information need from a different angle.

A prompt for generating alternative queries:

    You are a helpful assistant. Generate {K} different search queries related to
    the following question. Each query should explore a different aspect or use
    different terminology. Output one query per line.

    Original question: {user_query}

For K=4, a question about "how does connection pooling affect database performance"
might generate: "PgBouncer transaction mode throughput benchmarks", "Postgres max_connections
overhead per idle connection", "connection setup latency TCP handshake database", and
"idle connection memory consumption PostgreSQL shared memory". Each hits a different
topical cluster in the corpus, expanding the coverage of the retrieval phase.

The quality of generated queries depends strongly on the LLM's domain knowledge. For
general-purpose corpora, GPT-4 or Claude level models generate high-quality alternatives.
For specialized technical domains, a model with domain-specific training or few-shot
examples from the domain produces better alternatives.

## Parallel Retrieval and Score Collection

Each generated query is embedded and used for an independent ANN search against the
same index. The results from each search are collected as ranked lists: {query_i: [(doc_id,
score), ...]}. The document IDs across all K result sets form the candidate pool for
fusion.

Parallel execution is important for latency: running K sequential ANN searches multiplies
retrieval latency by K. Concurrent execution via async/await (Python asyncio, Node.js
Promise.all) keeps latency close to the single-query baseline because ANN searches are
typically I/O-bound (database network round trips) rather than CPU-bound.

For a self-hosted HNSW index (in-process, no network), parallel execution via
multi-threading is bounded by the CPU cores available for concurrent HNSW graph
traversal. Most HNSW libraries (hnswlib, FAISS, pgvector) support concurrent read
operations, so K parallel queries scale linearly up to the CPU core count.

## RRF Merging and When RAG-Fusion Helps

The K ranked lists are merged using RRF with the standard k=60 smoothing constant.
The merged ranking rewards documents that appear consistently across multiple query
formulations -- multiple semantic framings agreeing on relevance is a strong signal
the document addresses the underlying information need. A document that ranks moderately
in all K lists usually ranks higher in the fused list than a single-framing specialist
that ranks first in only one list.

RAG-Fusion provides the most benefit when the original query is ambiguous, underspecified,
or phrased very differently from the indexed documents, with Recall@5 improvements of
5-15% common. For precise technical queries whose vocabulary already matches the corpus,
RAG-Fusion adds latency and cost without improving recall. The practical deployment
pattern is to attempt retrieval with the original query first; only if the top result's
confidence score falls below a threshold is multi-query generation and fusion triggered.
RAG-Fusion also interacts beneficially with cross-encoder reranking: the larger,
more diverse candidate pool gives the reranker more material to evaluate.
