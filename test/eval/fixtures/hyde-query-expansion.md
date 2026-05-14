---
name: hyde-query-expansion
description: HyDE generates a hypothetical document from the query to bridge vocabulary gaps between questions and indexed passages
type: reference
---

# HyDE: Hypothetical Document Embeddings

Query expansion in retrieval systems attempts to close the vocabulary mismatch between
how users phrase questions and how relevant documents are written. Classical query
expansion techniques (pseudo-relevance feedback, synonym expansion from WordNet) work
at the token level. HyDE -- Hypothetical Document Embeddings, introduced by Gao et al.
in 2022 -- works at the semantic level by generating a full hypothetical answer to the
query and embedding that answer rather than the raw query.

The insight is that a dense embedding model trained on document pairs produces vectors
that are better aligned with other documents than with questions. Questions and their
answers occupy different regions of the embedding space even when they are semantically
equivalent in information content. Generating a plausible answer and embedding it shifts
the query vector into the document distribution.

## The HyDE Generation Step

The first step in HyDE is to pass the user's query to a generative language model with
a prompt that instructs it to write a short passage that would answer the question. The
generated passage does not need to be factually correct -- it only needs to be
plausible. The embedding model's job is to find real documents that are similar to the
hypothetical passage in style, vocabulary, and structural form, not to verify facts.

A typical HyDE prompt for a question-answering task:

    Please write a passage that directly answers the following question.
    The passage should be 2-3 sentences. Focus on accuracy but do not
    worry if you are uncertain -- write your best answer.
    Question: {query}
    Passage:

The generated passage is then embedded using the same encoder used to embed the
indexed corpus. The resulting vector is used as the query vector for ANN search.

## Why Vocabulary Alignment Matters at Retrieval Time

Consider a user who asks: "what is the activation threshold for the safety relay?"
The indexed corpus contains a technical manual section that reads: "The contactor opens
when the pilot circuit voltage drops below 18V." The word "threshold" does not appear
in the manual. The word "activation" does not appear. "Safety relay" and "contactor"
overlap only under domain knowledge.

A standard dense query embedding will represent "activation threshold safety relay" as
a vector in a region of the embedding space populated by electrical safety concepts.
The manual section's vector is nearby but not adjacent -- the bi-encoder never saw both
texts simultaneously, so the alignment depends entirely on training-time co-occurrence.

HyDE generates: "The safety relay activates when the input voltage exceeds 18V, at
which point the contactor closes and the circuit is energized." Now the embedding is
over a passage with near-identical vocabulary to the manual section. The ANN search
finds the relevant passage more reliably because both the generated passage and the
manual passage occupy the same dense region of the embedding space.

## Latency, Cost, and Failure Modes

HyDE adds one LLM generation step per query at retrieval time. For a 2-3 sentence
hypothetical document at temperature 0, this adds approximately 100-300ms of latency.
Common mitigations: run HyDE only for queries below a first-pass confidence threshold;
cache HyDE results for frequent queries; generate multiple hypothetical documents in
parallel and average their embeddings.

HyDE underperforms naive embedding in at least three documented scenarios. First, when
the generative model hallucinates a confident but topically wrong hypothetical, the
resulting vector searches in an incorrect region of the corpus. Second, for queries
already in document-like form, the generation step adds noise rather than signal. Third,
for highly technical queries where the generative model lacks domain knowledge, the
hypothetical is generic and fails to carry the specialized vocabulary that distinguishes
the target document from general-domain results.

The practical recommendation is to evaluate HyDE specifically on the tail of your query
distribution -- the queries where baseline retrieval Recall@5 is below 0.6 -- rather
than on the overall distribution where the benefit may be diluted by the many queries
that already retrieve correctly without expansion.
