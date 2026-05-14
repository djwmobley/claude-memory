---
name: late-chunking-technique
description: How late chunking embeds document-level context into chunk vectors to repair cross-chunk retrieval failures
type: reference
---

# Late Chunking Technique

Traditional retrieval-augmented generation pipelines embed each chunk in isolation. The
embedding model sees only the text of the chunk, with no knowledge of what surrounds it.
This design choice is operationally convenient but produces a measurable precision gap:
when a document's conceptual framing lives in an early section and the concrete answer
lives in a later section, neither chunk alone retrieves well for a query that spans both.

Late chunking is the name given to a family of techniques that address this gap by
computing chunk embeddings with access to the full document's token representations,
rather than re-encoding each chunk independently.

## The Embedding Architecture That Makes It Possible

Standard dense embedding models (E5, BGE, GTE, Nomic) process input through a transformer
encoder and pool the final hidden states into a single fixed-size vector. When you embed
a chunk in isolation, the attention mechanism inside the transformer can only attend to
tokens within that chunk. Cross-document context is structurally impossible at inference
time under this design.

Late chunking exploits the fact that transformer attention is not inherently limited to
chunk boundaries -- it is limited by the model's context window. If the full document fits
within the context window, you can pass the entire document through the encoder and then
extract chunk-level vectors by mean-pooling the token embeddings that correspond to each
chunk's character span, rather than pooling the entire document into one vector.

The result is a set of chunk vectors where each chunk's representation has been influenced
by attention heads that saw the full surrounding document. A sentence in section 4 that
refers back to a concept defined in section 1 will have that section 1 context encoded
in its attention-weighted representations before pooling.

## Why Naive Chunk Embedding Fails Cross-Chunk Queries

Consider a technical document structured as: (A) abstract definition of a protocol,
(B) step-by-step configuration instructions, (C) a table of specific numeric parameters
with no prose context. A user query asks about the numeric threshold for one of those
parameters. The query vocabulary matches chunk C. But chunk C in isolation contains only
numbers and parameter names, with no prose to anchor what those numbers mean. The embedding
for chunk C, computed in isolation, is dominated by numeric tokens and parameter-name
subwords that may not align well with the query's semantic direction.

Under late chunking, chunk C's embedding is computed after the encoder has attended to
chunk A's definition and chunk B's contextual prose. The pooled vector for chunk C now
carries the semantic weight of the surrounding explanation, making it retrievable against
a conceptual query even though the query's exact keywords are sparse in chunk C's text.

## Span Extraction, Pooling, and Evaluation

Late chunking requires the full document to fit in the model's context window at embedding
time. For most embedding models this is 512 tokens (BERT-style) or 8192 tokens (modern
long-context models like Jina v3, E5-mistral-7b, or Nomic Embed v1.5). Documents that
exceed the window must be split into overlapping sub-documents first, which reintroduces
the context boundary problem at a coarser granularity. The computational cost is higher
than naive chunking because each document must be encoded as one unit before per-chunk
vectors are extracted from the token-level hidden states. Chunk spans are tracked by their
byte or character offsets mapped to token offsets via the tokenizer's offset mapping
(`return_offsets_mapping=True`). Mean pooling over each span produces a vector of the
model's hidden-size dimensionality; attention-mask weighting ensures padding tokens do
not contaminate the pool. Empirical results in the JinaAI late-chunking paper show
Recall@1 improvements of 8-15 percentage points on cross-chunk subsets of BEIR benchmarks,
with near-zero regression on single-chunk subsets -- the gain is largest on documents with
strong topic continuity and smallest on documents that are already self-contained per section.
