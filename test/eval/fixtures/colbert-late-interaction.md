---
name: colbert-late-interaction
description: ColBERT multi-vector late interaction model, MaxSim scoring, and storage/retrieval tradeoffs versus bi-encoders
type: reference
---

# ColBERT: Late Interaction Retrieval

Bi-encoder retrieval compresses a document into one vector. Cross-encoder reranking
concatenates query and document and runs a joint forward pass. ColBERT (Contextualized
Late Interaction over BERT), introduced by Khattab and Zaharia at Stanford, occupies the
middle ground: it encodes query and document into sequences of token-level vectors rather
than a single pooled vector, and defers the interaction to a lightweight scoring function
applied after encoding.

This design allows the document's token vectors to be precomputed and stored, while the
query-document interaction -- which requires both to be present -- happens at retrieval
time over the stored token vectors. The interaction is cheap enough to run over thousands
of candidates in milliseconds, yet richer than a single dot product.

## Token-Level Encoding Architecture

ColBERT processes a query of Q tokens through a transformer encoder to produce Q vectors,
one per input token, each of dimension d (128 in the original model after linear
projection). A document of D tokens is processed similarly to produce D vectors.

Both query and document encodings undergo L2 normalization per vector, so each token
vector lies on the unit hypersphere. The query encoder prepends a special [Q] token
before the query text, and the document encoder prepends a [D] token. These marker
tokens serve as context cues during fine-tuning to condition the attention patterns for
their respective roles.

## MaxSim Scoring and Its Properties

The relevance score between a query and a document is computed as the sum of maximum
similarities: for each query token vector q_i, find the document token vector d_j that
maximizes cosine similarity with q_i, and sum these maxima over all query tokens.

    Score(q, d) = sum over i in [1..Q] of: max over j in [1..D] of: q_i · d_j

This is the MaxSim operator. Its behavior differs meaningfully from a single dot product.
A document that contains highly relevant text in one paragraph contributes strongly to
MaxSim even if the rest of the document is off-topic, because each query token only
claims the best-matching document token. A single pooled vector averages away these
concentrated relevance signals.

MaxSim also handles multi-aspect queries naturally. If a query contains two distinct
concepts, each concept's query tokens find their best-matching document tokens
independently. A document that covers both concepts scores higher than one that covers
only one, even if the single-concept document is a better match for that concept.

## PLAID Compression and Two-Stage Retrieval Workflow

ColBERT's storage cost is 100-200x higher than a bi-encoder for typical passage lengths
because every token requires a stored vector. The PLAID (Performant Late Interaction
Approximate Document search) compression scheme, introduced in ColBERT v2, addresses
this: document token vectors are quantized to 2 bits per dimension via centroids-based
residual compression, dropping per-token storage from 512 bytes (float32) to approximately
18 bytes -- a 28x compression with less than 2% quality loss on most benchmarks.

In the two-stage PLAID retrieval workflow, the first stage identifies candidate documents
via an inverted index over quantized centroids: each query token is assigned to its
nearest centroids, and the union of associated documents forms the candidate set. The
second stage computes exact MaxSim scores over decompressed token vectors for the
candidate set (typically 500-2000 documents) and re-ranks them. Stanford's RAGatouille
library wraps ColBERT v2 behind a single Python API that handles index construction,
compression, and this two-stage search without requiring a from-scratch PLAID implementation.
