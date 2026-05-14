---
name: embedding-drift-monitoring
description: Detecting and responding to embedding distribution shift when model versions change or corpus characteristics evolve
type: reference
---

# Embedding Drift Monitoring

An embedding index is a snapshot of your corpus's semantics as understood by a specific
model at a specific point in time. When that model changes -- whether due to a provider
updating their API model, a self-hosted model being re-finetuned, or a migration to a
higher-quality model -- the new model may place the same text in a different region of
the embedding space. Queries and documents that were well-aligned under the old model
may no longer be aligned under the new one, causing retrieval quality to degrade silently.

Embedding drift monitoring is the practice of detecting when this misalignment is growing,
diagnosing its source, and triggering re-indexing or recalibration before it affects
end-user retrieval quality at a scale that is visible in product metrics.

## Sources of Embedding Drift

The most common source is provider-side model updates. OpenAI, Cohere, Voyage, and other
embedding API providers periodically update the models behind their API endpoints without
always requiring clients to change their model identifier. A "text-embedding-3-small" call
in January may return vectors from a different model than the same call in September if the
provider silently swapped the underlying weights. Providers vary in how explicitly they
communicate these changes, and the differences are often small enough that no individual
retrieval result looks wrong -- the degradation is statistical and only visible in bulk
evaluation.

Self-hosted models are affected by a different source: finetuning updates to improve
domain-specific performance. A model finetuned on a new batch of in-domain data will
shift its embedding space, particularly for domain-specific terminology. Chunks indexed
before the finetune and queries evaluated after it will exhibit measurable cosine distance
increases between semantically equivalent pairs.

## Detection Approach: Anchor-Set Monitoring

The practical monitoring strategy is to maintain a small set of anchor pairs -- known
semantically similar pairs drawn from your actual corpus -- and continuously track the
cosine similarity between each pair's current embeddings. The anchor set should include:

Representative high-similarity pairs (same document, adjacent chunks) that should
consistently score above 0.85. Representative moderate-similarity pairs (different
documents on the same topic) that should score in the 0.65-0.80 range. Representative
low-similarity pairs (different topics) that should score below 0.3.

A monitoring job re-embeds the anchor set (not the full corpus) daily or weekly and
computes the mean and standard deviation of each similarity group. A Z-score alert
fires when the mean of a group moves more than 1.5 standard deviations from its
historical baseline. This is sensitive enough to catch meaningful model changes while
tolerating minor numerical variation.

The anchor set size needed for reliable detection depends on within-group variance. For
most embedding models, a set of 100-200 pairs (30-60 per group) provides sufficient
statistical power to detect a 0.03-cosine shift with 90% probability at a 5% false
positive rate.

## Severity Quantification and Version Pinning

When drift is detected, the decision to re-index should be based on measured Recall@K
degradation on a golden evaluation set, not on raw cosine shift. The cosine-to-recall
translation depends on score-margin distribution: in a corpus where relevant and
irrelevant documents are well-separated (mean similarity gap > 0.15), a 0.03 cosine
shift rarely swaps ranks; near the decision boundary (gap < 0.06), the same shift
causes substantial degradation.

The safest operational pattern is to pin every embedding to a model version identifier
stored alongside the vector in the database. When a model is updated, new documents are
indexed with the new model while old documents retain their old-model vectors. A query
can be routed to a version-specific index shard, or the query vector can be computed
with both model versions and results merged via RRF before serving. This allows
incremental re-indexing over hours or days without a degradation window, at the cost of
maintaining two sets of vectors per document during the migration period.
