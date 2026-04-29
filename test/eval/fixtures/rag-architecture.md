---
name: rag-architecture
description: Retrieval-augmented generation pattern -- ingest, retrieve, generate, citation, and failure modes
type: reference
---

# RAG Architecture

Retrieval-Augmented Generation (RAG) is a pattern for grounding LLM responses in a private or
up-to-date corpus without fine-tuning. The model's weights stay fixed; at inference time, a
retrieval step fetches relevant passages and injects them into the prompt context. The model
generates its answer conditioned on both its pretraining knowledge and the retrieved evidence.

## Why RAG Instead of Fine-Tuning

Fine-tuning encodes knowledge into weights. That knowledge becomes stale as the corpus changes.
It also requires labeled data, compute, and a retraining cycle each time the corpus updates.

RAG keeps knowledge in a queryable store that can be updated incrementally. The retrieval step
is explicit and auditable -- you can log exactly what evidence was provided for any response.
This auditability is important in domains where the basis for an answer must be verifiable
(legal, compliance, medical, financial).

Fine-tuning is better suited to behavior modification (tone, format, task style). RAG is better
suited to knowledge injection. They are complementary, not mutually exclusive.

## Pipeline Stages

### 1. Ingest

Raw documents (PDF, Markdown, HTML, code, SQL) are loaded, cleaned, and split into chunks.
Each chunk is embedded into a dense vector and stored alongside the original text and metadata
in a vector store (or a hybrid store that also maintains a full-text index).

Ingest is typically a background job, not in the request path. The freshness of retrieved
context is bounded by how recently ingest ran.

### 2. Index

Two indexes serve complementary roles:

- **Vector index:** ANN search over embedding space. Captures semantic similarity -- a query
  about "exponential backoff" can retrieve a document that uses the phrase "retry with delay"
  if the embeddings are close.

- **Full-text index (FTS):** Keyword-based search using BM25 or `tsvector`/`tsquery`
  (PostgreSQL). Captures exact-match signals -- product names, identifiers, error codes,
  version numbers. FTS cannot generalize across synonyms; vector search cannot reliably match
  exact strings.

Hybrid search blends both: a reciprocal rank fusion (RRF) or weighted sum of the two ranked
lists produces a final ranking that beats either method alone on most benchmarks.

### 3. Retrieve

At query time:
1. Embed the user query with the same model used during ingest (model consistency is mandatory).
2. Run ANN search for the top-K vector candidates.
3. Run FTS for the top-K keyword candidates.
4. Merge the ranked lists (RRF is the most robust merging strategy; it is rank-based, not
   score-based, so it is insensitive to calibration differences between the two indexes).
5. Apply metadata filters if the query specifies scope (date range, source type, author).
6. Return the top-N merged candidates (typically N = 5-20 depending on context window budget).

### 4. Rerank (Optional)

A cross-encoder reranker reads the query and each retrieved passage together to produce a
relevance score. Cross-encoders are much more accurate than bi-encoder embedding similarity
but too slow to run over the full corpus -- they are used as a second stage over the top-K
retrieved candidates (e.g., rerank top-50, return top-10).

Cohere Rerank and local models (e.g., ms-marco cross-encoders) are common choices. The
performance uplift is significant for ambiguous queries.

### 5. Generate

The final context window contains: system prompt, retrieved passages (with citations), and
the user query. The LLM generates a response grounded in the retrieved evidence.

## Context Window Budget

Context windows are finite. Each retrieved chunk consumes tokens. Practical allocations for
a 128K context window:

| Component              | Tokens      |
|------------------------|-------------|
| System prompt          | 1,000-2,000 |
| Retrieved passages     | 8,000-32,000|
| Conversation history   | 2,000-8,000 |
| User query             | 200-500     |
| Output reserve         | 4,000-8,000 |

If retrieved passages exceed the budget, truncate from the lowest-ranked result upward. Never
truncate mid-sentence; snap to the nearest sentence boundary.

## Citations

Citations ground the response and make it auditable. Each retrieved passage should carry:
- Source identifier (file path, URL, or document ID)
- Chunk index or character range for locating the passage in the source

Instruct the model to cite by reference number in the generated text:
`"...as described in the onboarding guide [1]."` where `[1]` maps to the first retrieved chunk.

The citation mapping should be returned as structured data alongside the generated text,
not embedded as freetext, so the calling application can render links or tooltips.

## Retrieval Failure Modes

**Out-of-corpus queries:** The user asks about something not in the indexed corpus. The top
retrieved chunks are on adjacent topics. The model, conditioned on these passages, may
hallucinate an answer that sounds grounded. Mitigation: include a relevance threshold; if all
retrieved passages score below the threshold, decline to answer or indicate low confidence.

**Temporal drift:** The corpus is stale. The user asks about the current version of a library;
the index contains docs for an older version. Mitigation: include document dates in metadata
and surface them in citations so the user can assess freshness.

**Query-document mismatch:** The user query uses different vocabulary than the source document.
Example: the document says "idempotent operations"; the user asks about "safe retries". Pure FTS
fails; hybrid search with semantic embedding compensates. This is the primary justification for
vector search.

**Context poisoning:** Retrieved passages contain subtly incorrect or adversarially crafted
content. In a RAG system that indexes user-contributed content, this is a real attack surface.
Mitigation: rate-limit indexing of new sources, apply content filters, and prefer authoritative
sources in retrieval ranking.

**Long-chain reasoning failures:** The answer requires synthesizing information from N passages
spread across the corpus, not any single passage. RAG retrieves the top passages but cannot
guarantee they cover all sub-questions of a complex query. Mitigation: iterative retrieval
(retrieve, identify gaps, retrieve again) or query decomposition before retrieval.

## When RAG is Not the Right Tool

- The corpus fits in the model's context window: just include it directly.
- The information is stable and high-value: fine-tuning or in-context learning may be more
  reliable than retrieval.
- The query requires exact arithmetic, date calculations, or code execution: route to a tool
  call, not a retrieved passage.
- The corpus is structured (SQL, spreadsheet): use SQL or a dataframe query, not semantic
  search over natural-language summaries.
