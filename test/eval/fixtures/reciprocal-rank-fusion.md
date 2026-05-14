---
name: reciprocal-rank-fusion
description: RRF score formula, rank combination for hybrid retrieval, and parameter sensitivity analysis
type: reference
---

# Reciprocal Rank Fusion

Hybrid retrieval systems combine results from multiple ranked lists -- typically a dense
vector search list and a keyword search list -- into a single merged ranking. The naive
approach of averaging raw scores fails in practice because BM25 scores and cosine
similarity scores have completely different ranges, distributions, and sensitivities to
document length and collection statistics. Score normalization before averaging is
brittle and requires calibration per corpus.

Reciprocal Rank Fusion (RRF) sidesteps the score normalization problem entirely by
working with ranks rather than scores. The only information used from each source list
is the ordinal position of each document, not the numeric score that produced that
position.

## The RRF Formula

For a document d appearing in a set of ranked lists R, the RRF score is:

    RRF(d) = sum over r in R of: 1 / (k + rank_r(d))

where rank_r(d) is the 1-based position of document d in ranked list r, and k is a
smoothing constant. Documents that do not appear in a given list are treated as having
rank equal to infinity, contributing zero to the sum.

The smoothing constant k controls the sensitivity to top-rank positions. With k = 0, a
document ranked first receives a score of 1.0, and each subsequent rank receives a
rapidly decreasing score (1/2, 1/3, 1/4...). With k = 60 (the value originally proposed
by Cormack, Clarke, and Buettcher in 2009), a document ranked first receives 1/61 ≈ 0.016,
and the decay is much shallower: rank 10 receives 1/70 ≈ 0.014, only 14% less than rank
1. The k=60 value has become the default in most implementations, but it was originally
validated on TREC Legal Track data and may not be optimal for all corpora.

## Why Rank Matters More Than Score

Dense retrieval scores cluster in a narrow range for most queries because HNSW search
returns approximate nearest neighbors from a well-distributed embedding space. The score
difference between rank 1 and rank 50 might be 0.04 cosine units -- small enough that
any score normalization scheme will compress these differences into noise.

BM25 scores have the opposite problem: they are unbounded above and vary dramatically
with document length and term frequency. A document with a rare exact-match term can
score 40 points while typical results cluster around 5-15. Normalizing these scores to
[0, 1] by dividing by the maximum amplifies the bias toward the single highest-scoring
document.

RRF treats both lists symmetrically regardless of their score scales. A document that
ranks 3rd in the dense list and 3rd in the BM25 list receives a strong combined score
regardless of whether the dense score was 0.91 or 0.74, or whether the BM25 score was
12.4 or 34.7.

## Implementation and k Sensitivity

The implementation is straightforward. Given a dense results list and a BM25 results
list, each as arrays of document IDs ordered by descending score:

```javascript
function rrfMerge(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((docId, zeroBasedRank) => {
      const rank = zeroBasedRank + 1;
      const contribution = 1.0 / (k + rank);
      scores.set(docId, (scores.get(docId) || 0) + contribution);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([docId, score]) => ({ docId, score }));
}
```

The output is a merged list ordered by descending RRF score; absolute scores are not
meaningful across queries, only the ordering within a single query's result set.
Empirical analysis on BEIR benchmarks shows the optimal k varies by task: for QA tasks
(Natural Questions, TriviaQA), k values of 20-40 outperform k=60 because the correct
answer ranks very highly in at least one system; for recall-oriented tasks (argument
retrieval, news search), k values of 60-100 perform better. The standard practice is
to evaluate k ∈ {10, 20, 40, 60, 100} on a validation set and pick the value that
maximizes Recall@10 or NDCG@10.
