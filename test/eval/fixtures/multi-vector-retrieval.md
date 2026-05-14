---
name: multi-vector-retrieval
description: Representing documents with multiple vectors per document for better coverage of long or multi-topic content in retrieval
type: reference
---

# Multi-Vector Retrieval

Standard dense retrieval maps each document to exactly one embedding vector. This
works well for short, topically coherent passages but degrades for long documents or
documents that cover multiple distinct topics: the single vector averages the semantics
of all content, making it a weak representative for any individual topic within the
document.

Multi-vector retrieval addresses this by representing each document with a set of
vectors rather than one, where each vector represents a different aspect, section, or
perspective of the document. A query matches a document if it is similar to ANY of the
document's vectors, not just to the single average vector.

## Dense-Passage Retrieval with Multiple Representations

The earliest multi-vector approach in the neural retrieval literature is Dense Passage
Retrieval (DPR) extended to multi-passage documents. Rather than embedding the full
document, the document is split into passages of approximately 100 words each, and each
passage is embedded independently. The document is represented by the set of all its
passage embeddings.

At retrieval time, the query vector is compared against all passage vectors in the
index. The score assigned to a document is typically the maximum similarity between the
query and any of the document's passage vectors (MaxDoc scoring), though sum or average
are also used for different precision-recall tradeoffs.

MaxDoc scoring produces high recall because a single highly-relevant passage is
sufficient to surface the document, even if the rest of the document is irrelevant.
This is the right tradeoff for answer-in-passage scenarios. Average scoring is more
conservative and better reflects overall document relevance when the task is ranking
documents rather than retrieving specific answer passages.

## Parent-Child Index Structure

A practical production pattern for multi-vector retrieval is the parent-child index.
Each child chunk is a short passage (100-300 tokens) that is independently embedded
and indexed. Each chunk stores a reference to its parent document ID. At retrieval
time, the query matches child chunks, but the result returned to the LLM is the parent
document (or a larger parent chunk of 500-1000 tokens) rather than the child chunk
itself.

This decouples retrieval precision (achieved by the small child chunks) from context
quality (provided by the larger parent). A small chunk embeds with a focused, topically
coherent vector that retrieves precisely. The parent provides the surrounding context
that makes the answer intelligible without requiring the LLM to infer missing context.

The index structure requires two storage layers: a vector index over child chunk
embeddings with a parent_id foreign key, and a document store (relational or key-value)
keyed by parent_id. The retrieval pipeline fetches top-K child chunks by vector
similarity, deduplicates by parent_id (taking the highest-scoring child per parent),
and returns the parent content for each unique parent.

## RAPTOR Hierarchy and Storage Complexity

RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval) extends the
parent-child idea to multiple abstraction levels. Raw leaf passages are embedded at
level 1; semantically similar clusters are summarized by an LLM and embedded at level 2;
the process repeats to a single top-level summary. At retrieval time, the query can
match at any level, with matched nodes from all levels merged before context injection.
RAPTOR's main cost is LLM summarization during indexing; it is most appropriate for
static knowledge bases where indexing cost is amortized over many queries.

Multi-vector indexing multiplies index size by the average vectors per document. A
corpus of 100,000 documents with 10 passage vectors each requires a 1-million-entry
HNSW index instead of 100,000. Query-time post-processing (deduplicating by parent ID
and fetching parent content) adds overhead proportional to the retrieval window K. For
K=50 with 10 vectors per document, up to 50 parent-content lookups are needed per
query; batched fetches from a document store or covering index keep this manageable.
