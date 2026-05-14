---
name: rag-eval-annotation
description: Ground-truth annotation methodology for RAG retrieval evaluation, including inter-annotator agreement and label schema design
type: reference
---

# Ground-Truth Annotation for RAG Evaluation

Evaluating a RAG retrieval system requires a golden dataset: a set of queries each
paired with the specific passage or passages from the corpus that correctly answer the
query. Constructing this dataset is expensive and methodologically fraught. The choices
made during annotation directly determine whether the resulting evaluation distinguishes
between good and bad retrieval systems or merely measures how well a system memorizes
the annotator's assumptions.

## Label Schema Design

The most consequential annotation decision is the label schema: how many relevance levels
to use and what each level means. Binary schemas (relevant / not-relevant) are
operationally simple but force annotators to collapse a continuous relevance dimension
into two bins, producing high disagreement at the boundary. Graded schemas (typically
0-3 or 0-4) reduce boundary disagreement at the cost of labeling complexity. The TREC
convention uses four levels: not relevant (0), slightly relevant (1), fairly relevant
(2), highly relevant (3); NDCG weights these grades by rank position and numeric value,
so exact numeric assignments affect metric computation. The practical recommendation for
RAG evaluation is a three-level schema: (0) not relevant, (1) partially relevant (useful
context but does not directly answer the query), (2) fully relevant (directly answers the
query and requires no inference). A top-3 result containing at least one label-2 passage
indicates retrieval succeeded; a top-3 with only label-1 passages indicates context
retrieval but not answer retrieval.

## Query Construction Strategy

Annotation quality depends on how queries are constructed. Queries written by the same
people who wrote the corpus documents tend to use the same vocabulary, which creates
an inflated recall estimate for keyword-matching systems and understates the vocabulary
gap problem. Queries written by people who have NOT seen the corpus, but who are given
only the question topic, produce a more realistic distribution.

For technical corpora, a hybrid strategy works well: subject-matter experts write
queries from memory (without consulting the corpus), then annotators retrieve the
relevant passages independently. This separates the query-writing cognitive load from
the annotation cognitive load and produces queries that reflect genuine information needs
rather than paraphrase lookups.

Generated queries (using an LLM to produce questions from each passage) are useful for
recall coverage but produce a biased distribution: generated queries are strongly
aligned with the vocabulary of the passage they were generated from, which makes
keyword matching appear more effective than it is on natural queries. Generated queries
should be used to supplement human queries, not to replace them.

## Agreement Measurement and Evaluation Metrics

A golden dataset is only as reliable as its label consistency. Standard practice is to
have at least two independent annotators label each query-passage pair. For binary
schemas, Cohen's Kappa above 0.6 is acceptable; for graded schemas, Krippendorff's
Alpha above 0.5 is acceptable. Below these thresholds, the golden dataset is as much
a measurement of annotator variance as of retrieval system quality. When agreement
falls below threshold, resolution via a third annotator (adjudication) produces higher-
quality labels, while majority vote is practical for large datasets.

The choice of evaluation metric should match the retrieval application. Recall@K is
appropriate when any relevant passage is sufficient. Precision@K is appropriate when
all top-K results are injected into the context window and irrelevant context is
penalized. MRR is appropriate for single-answer lookup scenarios. For cross-chunk
retrieval evaluation specifically, the most informative metric is Recall@1 stratified
by cross-chunk dependency: computed separately for queries requiring cross-chunk context
versus single-chunk answers. A system that improves cross-chunk Recall@1 without
degrading single-chunk Recall@1 is demonstrably better in a way that aggregate metrics
mask.
