---
name: cross-encoder-rerankers
description: Cross-encoder architecture for reranking retrieved candidates and how it differs from bi-encoder retrieval
type: reference
---

# Cross-Encoder Rerankers

A retrieval pipeline that uses only dense vector search produces a ranked list ordered by
approximate nearest-neighbor distance. This ordering is fast but imprecise: the bi-encoder
architecture that powers dense retrieval embeds query and document independently, then
computes similarity as a dot product or cosine score over fixed vectors. The two encoders
never see each other's tokens during inference, which limits the depth of query-document
interaction.

Cross-encoders solve the interaction problem by concatenating the query and candidate
document into a single input and passing the pair through a transformer encoder together.
Every attention head in every layer can attend from query tokens to document tokens and
back. The output is a scalar relevance score rather than a vector, which makes cross-encoders
unsuitable for first-stage retrieval but ideal for reranking a small candidate set.

## Typical Pipeline Position

In production systems, a cross-encoder reranker sits at the second stage of a two-stage
retrieval pipeline. The first stage uses a bi-encoder (dense ANN search, BM25, or hybrid)
to retrieve the top-N candidates, where N is typically 50-200. The second stage passes
each query-candidate pair through the cross-encoder and replaces the first-stage scores
with the cross-encoder's output. The reranked list is then truncated to top-K for context
injection, where K is typically 3-10.

The design trades latency for precision: the cross-encoder runs N forward passes per
query rather than one, and each pass processes the full concatenation of query plus
document. For a reranking window of 100 candidates with average document length of 300
tokens and a query of 20 tokens, each pass processes approximately 320 tokens. The total
is 32,000 token-equivalents per query, which is 10-50x the cost of the first-stage vector
lookup, depending on hardware.

## Score Calibration and Threshold Behavior

Raw cross-encoder outputs are uncalibrated logits. A model trained with binary
relevance labels (relevant / not-relevant) outputs a scalar that is monotonically ordered
but not interpretable as a probability without sigmoid normalization. Models trained with
listwise losses (LambdaMART-style pairwise comparisons) produce scores that are meaningful
only relative to the candidate set for a given query.

This matters for two operational reasons. First, you cannot use a fixed cross-encoder
score threshold to filter irrelevant candidates reliably across queries, because the score
distribution shifts with query difficulty and candidate quality. Second, ensembling
cross-encoder scores with first-stage BM25 or dense scores requires normalization: min-max
scaling or z-score normalization within the candidate set is the standard approach before
linear combination.

## Training Data and Latency Optimization

Cross-encoder performance is largely determined by training data quality. The standard
training set format is triples: (query, positive_passage, negative_passage), where the
model learns to score positives higher than negatives. Hard negatives -- passages
topically similar to the positive but that do not answer the query -- are substantially
more informative than random negatives. Hard negatives are mined from the first-stage
retriever's ranked output (typically positions 10-100) for each training query. The MS
MARCO passage dataset is the dominant training corpus for English rerankers; models like
ms-marco-MiniLM-L-6-v2 and the bge-reranker family use MS MARCO triples as their
primary training signal, supplemented by in-domain fine-tuning.

Several engineering techniques reduce cross-encoder latency while preserving most of the
precision gain. Truncating inputs to 256 tokens reduces per-pass latency by roughly 50%
with less than 2% Recall@1 degradation. The N candidates for a single query should be
processed as one batch: 32-64 pairs per batch is typical for MiniLM-class models on a
16GB GPU. For CPU-only deployments, INT8 quantization via ONNX Runtime reduces latency
by 3-4x with less than 1% quality degradation and is the recommended production path
when GPU is unavailable.
