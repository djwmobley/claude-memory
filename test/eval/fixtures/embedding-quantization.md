---
name: embedding-quantization
description: Product quantization, scalar quantization, and binary quantization tradeoffs for compressed embedding indexes
type: reference
---

# Embedding Quantization

Embedding indexes for large corpora impose two constraints: memory and search latency.
An index of one million 1536-dimensional float32 vectors occupies 6GB of RAM before
accounting for HNSW graph edges or IVF cluster structures. Quantization reduces vector
storage by representing each dimension (or group of dimensions) with fewer bits, trading
a controlled amount of retrieval quality for substantial reductions in memory and
distance-computation time.

Three quantization families are relevant to production embedding systems: scalar
quantization (SQ), product quantization (PQ), and binary quantization (BQ). They differ
in compression ratio, quality loss, and implementation complexity.

## Scalar Quantization

Scalar quantization maps each float32 dimension independently to an integer with fewer
bits. INT8 scalar quantization (SQ8) is the most common variant: it maps the range
[min, max] of each dimension's values, observed over a training sample of the corpus,
to the range [0, 255], using a linear transform. The stored value is one byte per
dimension rather than four.

SQ8 achieves 4x storage compression with typical quality loss of 1-3% Recall@10 on
most embedding models. The quality loss is low because embedding dimensions are
approximately normally distributed and map well to a linear 8-bit scale without severe
clipping. INT4 quantization (SQ4) achieves 8x compression but incurs 5-10% recall loss,
which is acceptable for some applications but not for precision-critical retrieval.

Distance computation with INT8 vectors uses integer arithmetic (dot products over byte
arrays) which is substantially faster than float32 operations on CPUs and modern GPUs,
providing a secondary speedup beyond the memory savings.

## Product Quantization

Product quantization (PQ) divides each embedding vector into M equal sub-vectors and
quantizes each sub-vector independently using a small codebook of K centroids learned
from the training corpus. For a 128-dimensional vector with M=8 sub-vectors and K=256
centroids per sub-codebook, each sub-vector is stored as a single byte (the index of
its nearest centroid), giving 8 bytes per vector regardless of original dimensionality.

The compression ratio is substantial: a 1536-dimensional float32 vector (6144 bytes)
compressed to M=16 sub-vectors with 256 centroids requires only 16 bytes -- a 384x
reduction. The quality loss from this extreme compression is significant: Recall@10
may drop 15-30 percentage points depending on the corpus and embedding model.

The key parameter tradeoffs for PQ are: more sub-vectors (higher M) improves quality
but increases storage; more centroids per sub-codebook (higher K) improves quality but
increases the codebook size and lookup table construction time at query time. The product
structure allows fast approximate distance computation via precomputed lookup tables:
for each query sub-vector, you precompute distances to all K centroids in that sub-space
once, then the distance to any stored vector is the sum of K table lookups.

## OPQ and Binary Quantization

Optimized Product Quantization (OPQ) applies a learned rotation to the embedding space
before partitioning into sub-vectors, making sub-vector distributions more uniform and
less correlated. OPQ consistently outperforms standard PQ by 2-5% Recall@10 at
equivalent compression ratios, at the cost of an additional matrix-multiply at index
and query time.

Binary quantization converts each dimension to a single bit (positive values become 1,
non-positive values become 0), achieving 32x compression and enabling distance
computation via Hamming distance (XOR + popcount). Several modern embedding models
(Cohere Embed v3, Mistral Embed, Nomic Embed) are trained with binary quantization in
mind using a Matryoshka loss that aligns dimension signs with semantic relevance --
these models achieve less than 5% Recall@10 loss under binary quantization. For models
not trained for binary quantization, quality loss is typically 20-40%, making binary
quantization viable only as first-stage candidate retrieval followed by float32 re-scoring
(the binary-rescore pattern implemented in Qdrant and pgvector halfvec paths).
