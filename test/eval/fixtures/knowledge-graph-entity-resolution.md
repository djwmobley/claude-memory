---
name: knowledge-graph-entity-resolution
description: Entity resolution and coreference linking for knowledge graph construction from unstructured text, including blocking and matching strategies
type: reference
---

# Knowledge Graph Entity Resolution

Building a knowledge graph from unstructured text requires identifying when two text
spans refer to the same real-world entity. "Apple Inc.", "Apple", "AAPL", and "the
Cupertino company" in different documents may all refer to the same entity. Without
entity resolution, the graph treats each mention as a separate node, fragmenting the
entity's relationships across disconnected subgraphs and making traversal queries
unreliable.

Entity resolution (also called record linkage, entity matching, or deduplication
depending on the literature's origin) is the process of grouping these mentions into
canonical entities. It operates in two phases: blocking (candidate generation) reduces
the quadratic all-pairs comparison problem to a tractable set of candidates, and
matching (comparison) scores each candidate pair and assigns it to the same or different
entity.

## Blocking Strategies

Naively comparing every mention against every other mention is O(n^2) in the number of
mentions. For a corpus with 10 million entity mentions, this is 10^14 comparisons --
infeasible. Blocking reduces this by generating only the pairs that share at least one
blocking key.

Common blocking keys for named entities: normalized token prefix (first N characters of
the canonical name, lowercased and stripped of punctuation), soundex code for person
names, Wikipedia entity ID if an NLP linker has already resolved some mentions, domain-
specific codes (ticker symbols for companies, ISBN for books, DOI for papers).

Locality-sensitive hashing (LSH) over n-gram shingles of the mention text produces
blocking keys automatically without requiring domain-specific rules. Two mentions with
Jaccard similarity above a threshold map to the same LSH bucket with high probability.
MinHash is the standard LSH family for Jaccard; a hash band width of 3 and 20 bands
produces a threshold near 0.5 at a false negative rate below 5%.

## Matching with Embedding Similarity

After blocking, each candidate pair must be scored. Simple rule-based matchers (exact
match, lowercase match, abbreviation expansion) handle the easy cases but fail on
paraphrase mentions that don't share surface tokens.

Embedding-based matching encodes each entity mention into a dense vector and uses
cosine similarity as the match score. For named entities, a span encoder fine-tuned on
entity linking tasks (BLINK, REL, Refined from Amazon) produces much better embeddings
than a general-purpose sentence encoder because it is trained to represent entity spans
in the context of their surrounding text, not just the span text in isolation.

The contextual encoding of the mention's surrounding sentence is critical: "Washington"
in a sentence about US presidents encodes differently from "Washington" in a sentence
about Pacific Northwest geography, and a well-trained entity encoder exploits this to
resolve the ambiguity. This disambiguation at the mention level is called within-document
coreference resolution and is typically handled by a separate model (SpanBERT, s2e-coref)
before cross-document entity linking.

## Canonical Representation and Incremental Resolution

After clustering, each entity cluster needs a canonical node name. Knowledge base
anchoring (Wikipedia title, Wikidata QID) is strongly preferred over surface-form
canonicalization because it resolves cross-corpus inconsistencies: a corpus of SEC
filings uses "Alphabet Inc." while tech news uses "Google" -- surface-form produces
two nodes that should be one; KB anchoring via Wikidata Q1333 merges them correctly.

For streaming corpora, incremental resolution uses an entity vector index: after the
initial batch pass, the canonical embedding for each cluster is stored in the index.
New mentions are encoded and searched; if the nearest neighbor exceeds the match
threshold, the mention joins that entity; otherwise a new node is created. The threshold
calibration is more conservative than for batch resolution because false-positive merges
are hard to undo -- a 5% false-negative rate acceptable in batch mode may need to drop
to 1% in incremental mode, accepting more provisional nodes for periodic consolidation.
