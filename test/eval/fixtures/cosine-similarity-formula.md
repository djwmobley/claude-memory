---
name: cosine-similarity-formula
description: Cosine similarity definition, why normalized vectors reduce it to dot product, and distance vs similarity conventions
type: reference
---

# Cosine Similarity Formula

Cosine similarity measures the angle between two vectors, ignoring their magnitude. It
is the standard similarity metric for text embeddings.

## Definition

For vectors **a** and **b** in R^n:

```
cos_sim(a, b) = (a . b) / (||a|| * ||b||)
```

Where:
- `a . b` is the dot product: sum of a[i] * b[i] for i in 0..n
- `||a||` is the L2 norm (Euclidean length): sqrt(sum of a[i]^2)

The result is in [-1, 1]:
- `1.0` -- identical direction (same meaning)
- `0.0` -- orthogonal (unrelated)
- `-1.0` -- opposite direction (antonymous, rare in practice for text)

## Why Normalized Vectors Make It a Dot Product

If both vectors are L2-normalized (||a|| = ||b|| = 1):

```
cos_sim(a, b) = a . b / (1 * 1) = a . b
```

The dot product of two unit vectors equals their cosine similarity. Most embedding
models (OpenAI, nomic-embed-text, mxbai-embed-large) produce L2-normalized outputs.
For these models, cosine similarity and inner product are equivalent, but inner product
(`<#>` in pgvector) is computationally cheaper to compute than cosine distance (`<=>`).

## Distance vs Similarity

pgvector's `<=>` operator returns cosine **distance**, not similarity:

```
cosine_distance = 1 - cosine_similarity
```

Ranges from 0 (identical) to 2 (exactly opposite). In practice, distances between
semantically related documents are in [0, 0.3]; unrelated documents score 0.6-1.0.

To convert to similarity in SQL:

```sql
SELECT 1 - (embedding <=> query_vec) AS similarity
FROM documents
ORDER BY embedding <=> query_vec
LIMIT 10;
```

## Common Gotchas

- Do not compare cosine similarities from different models. The scale is
  model-specific; `0.85 similarity` from nomic-embed-text is not comparable to `0.85`
  from text-embedding-ada-002.
- Zero vectors have undefined cosine similarity (division by zero). Guard against
  them: a zero embedding indicates a failed or empty input.
- Cosine similarity is insensitive to vector magnitude, which is usually desirable for
  text. If magnitude carries meaning (e.g., frequency-weighted embeddings), use
  dot-product similarity or L2 distance instead.
