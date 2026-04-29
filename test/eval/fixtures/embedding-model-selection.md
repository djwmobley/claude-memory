---
name: embedding-model-selection
description: Comparing mxbai-embed-large, nomic-embed-text, OpenAI ada-002, and others -- dimensions, context length, tradeoffs
type: reference
---

# Embedding Model Selection

The embedding model is the most consequential infrastructure choice in a RAG or semantic
search system. It determines vector dimensions (and therefore index size), the maximum
context length per chunk, and how well semantic similarity maps to actual relevance for
your specific domain. Switching models after indexing requires re-embedding the entire corpus.

## Evaluation Dimensions

When choosing an embedding model, evaluate along:

- **MTEB score** -- Massive Text Embedding Benchmark measures performance across retrieval,
  clustering, classification, and semantic similarity tasks. Use the retrieval sub-scores,
  not the overall average, for RAG use cases.
- **Vector dimensions** -- Higher dimensions typically improve retrieval quality but increase
  storage and query latency. Standard tradeoff: 768 is the sweet spot; 1536+ shows diminishing
  returns for most corpora.
- **Max context length** -- The maximum tokens the model can embed in one pass. Content
  exceeding this limit must be truncated or chunked further.
- **Inference cost and latency** -- API-based models (OpenAI) charge per token; local models
  (Ollama) have compute cost and VRAM requirements.
- **License** -- MIT or Apache 2.0 for production use; check for non-commercial restrictions.

## Model Comparison

### OpenAI text-embedding-ada-002

- **Dimensions:** 1536
- **Context:** 8191 tokens
- **MTEB retrieval:** ~49 (competitive but not top-tier)
- **Notes:** The most widely deployed embedding model as of 2024. Reliable, well-tested,
  and consistent. High dimensionality increases storage cost but the model is strong
  on English general-domain text. Requires API call; not usable offline.
  Replaced by text-embedding-3-small and text-embedding-3-large in newer deployments.

### OpenAI text-embedding-3-small

- **Dimensions:** 1536 (can be truncated to 512 via `dimensions` parameter)
- **Context:** 8191 tokens
- **MTEB retrieval:** ~62
- **Notes:** Significantly stronger than ada-002 at lower cost. The truncation feature
  (Matryoshka embeddings) is useful: you can embed at 1536 and store 512 dimensions
  for index size savings with minimal quality loss.

### OpenAI text-embedding-3-large

- **Dimensions:** 3072
- **Context:** 8191 tokens
- **MTEB retrieval:** ~65
- **Notes:** Best-in-class OpenAI model. The 3072 dimensions are expensive to store and
  query. Reserve for high-value corpora where retrieval quality is more important than
  cost. Supports Matryoshka truncation to 256/512/1024/1536/3072.

### nomic-embed-text (v1.5)

- **Dimensions:** 768
- **Context:** 8192 tokens
- **MTEB retrieval:** ~62
- **License:** Apache 2.0
- **Notes:** Strong open-source model with competitive MTEB scores. Available via Ollama
  (`ollama pull nomic-embed-text`). 768 dimensions are storage-efficient. The v1.5 variant
  supports Matryoshka embeddings (truncate to 64, 128, 256, 512). Excellent choice for
  local/on-prem deployments.

### mxbai-embed-large (v1)

- **Dimensions:** 1024
- **Context:** 512 tokens
- **MTEB retrieval:** ~64
- **License:** Apache 2.0
- **Notes:** Top-performing open-source model on MTEB as of early 2024. The 512-token
  context limit is the main constraint: chunks must be kept short. If your chunking
  strategy produces chunks under 400 tokens, this is an excellent choice. Available
  via Ollama. Uses a different prompt template for queries vs. passages; you must
  prepend `"Represent this sentence for searching relevant passages: "` to query strings.

### all-minilm-l6-v2

- **Dimensions:** 384
- **Context:** 256 tokens
- **MTEB retrieval:** ~49
- **Notes:** Very fast, very small. Designed for CPU inference and latency-sensitive
  applications. The low dimension count and short context make it a poor choice for
  rich semantic retrieval, but it is effective for simple similarity tasks, deduplication,
  and classification where exact semantic fidelity is less critical.

## Choosing for a New Project

Decision tree:

1. **Local/offline required?** --> nomic-embed-text or mxbai-embed-large
2. **Chunks consistently under 400 tokens?** --> mxbai-embed-large
3. **Chunks up to 8K tokens?** --> nomic-embed-text v1.5 or OpenAI text-embedding-3-small
4. **Budget is primary constraint?** --> nomic-embed-text (free after GPU/CPU cost)
5. **Maximum retrieval quality, cost secondary?** --> OpenAI text-embedding-3-large

## Model Consistency Requirement

The same model that embeds the corpus at ingest time MUST be used to embed queries at
retrieval time. Different models produce vectors in different geometric spaces; cosine
similarity between vectors from different models is meaningless. This is not a soft
guideline -- mixing models produces retrieval that appears to work (no errors) but returns
random results relative to the user's intent.

Track the model name and version in the index metadata. If you need to upgrade the
embedding model, you must re-embed the entire corpus.

## Domain Adaptation

General-purpose embedding models perform well on general English text. Specialized corpora
(legal documents, biomedical literature, code) may benefit from domain-adapted models.
For code, consider models fine-tuned on code corpora (e.g., cohere-embed-code).

For most developer documentation, technical notes, and knowledge bases, a general-purpose
model like nomic-embed-text or text-embedding-3-small performs well without domain adaptation.

## Storage Math

Embeddings are stored as arrays of 32-bit floats. Storage per row:

```
dimensions * 4 bytes = storage per vector

768 dims  = 3,072  bytes (~3 KB) per chunk
1024 dims = 4,096  bytes (~4 KB) per chunk
1536 dims = 6,144  bytes (~6 KB) per chunk
3072 dims = 12,288 bytes (~12 KB) per chunk
```

A corpus of 1 million 768-dimension chunks requires ~3 GB of raw vector storage.
pgvector stores vectors uncompressed by default; HNSW index overhead adds 2-4x on top.
Plan for 10-20 GB of index data for a million-chunk corpus with 768 dimensions.
