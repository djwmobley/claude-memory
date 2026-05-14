---
name: contextual-retrieval-blurbs
description: Generating per-chunk contextual blurbs using an LLM to prepend document-level context before embedding, improving cross-section retrieval
type: reference
---

# Contextual Retrieval Blurbs

Anthropic's "contextual retrieval" technique, published in September 2024, addresses
the same cross-chunk recall problem that late chunking targets, but through a different
mechanism. Rather than changing the embedding architecture, it changes the content
that is embedded: a short LLM-generated blurb that situates each chunk within its
source document is prepended to the chunk text before embedding and before indexing
in a BM25 inverted index.

The result is that each chunk's embedding carries document-level context as explicit
text, not as attention-layer influence from a long-context encoder. Any embedding model
benefits, including BERT-based models with 512-token windows that cannot fit an entire
document in their context window.

## The Blurb Generation Prompt

The blurb generation call passes the full document and the specific chunk to a language
model with a prompt asking for a concise context summary. Anthropic's published prompt
is approximately:

    <document>
    {full_document_text}
    </document>

    Here is the chunk we want to situate within the whole document:
    <chunk>
    {chunk_text}
    </chunk>

    Please give a short succinct context to situate this chunk within the overall
    document for the purposes of improving search retrieval of the chunk. Answer
    only with the succinct context and nothing else.

The model output is typically one or two sentences identifying the document's topic,
the section the chunk belongs to, and any key entities or concepts established in
earlier sections that the chunk references without re-introducing. This blurb is then
prepended to the chunk text before embedding.

## Cost Analysis and Batching Strategy

Blurb generation requires one LLM call per chunk with the full document in context.
For a document of N chunks, this is N calls, each with the full document as input.
With prompt caching (Anthropic's cache_control mechanism or similar), the document
portion of the prompt can be cached after the first call, and subsequent chunks in the
same document only pay the incremental cost of the chunk-specific portion.

For a 10,000-character document split into 8 chunks, without caching: 8 calls each
processing approximately 10,000 input tokens, totaling 80,000 input tokens. With
caching: the first call pays 10,000 tokens, and the subsequent 7 calls each pay the
cache read rate on 10,000 tokens plus full price on the chunk-specific portion
(approximately 200 tokens per chunk). Total effective input cost with caching is
roughly 10,000 + 7 * (10,000 * 0.1 + 200) ≈ 17,400 token-equivalents, a 78% reduction.

This makes blurb generation feasible for corpora where re-indexing is infrequent
(documents do not change often) but impractical for highly dynamic corpora where every
document version requires regenerating all blurbs.

## BM25 Benefits and Comparison to Late Chunking

Because the blurb is plain text, it contributes to BM25 keyword matching as well as
dense retrieval. If an early section establishes that the document is about "distributed
consensus in Raft-based systems" and a later chunk discusses only "log replication" and
"term numbers," the blurb prepended to that chunk will contain "Raft" and "distributed
consensus," enabling a keyword query to match it. Anthropic's published evaluation showed
contextual retrieval reduced failed retrievals by 49%, with BM25 explaining roughly 40%
of the improvement and dense retrieval explaining the remaining 60%.

Late chunking and contextual blurbs have different profiles. Late chunking requires a
long-context embedding model, processes each document as a unit, adds no storage overhead,
and has no per-chunk LLM cost. Contextual blurbs require one LLM call per chunk per
document version, add blurb storage, but work with any embedding model including short-
context BERT-based models. For corpora that change frequently, late chunking has lower
ongoing cost. The two are not mutually exclusive; combining contextual blurbs with a
long-context embedder is the highest-quality but highest-cost configuration.
