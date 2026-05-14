---
name: splade-sparse-encoders
description: SPLADE learned sparse representations, vocabulary expansion over BERT's token set, and hybrid retrieval with BM25 inverted indexes
type: reference
---

# SPLADE: Sparse Learned Representations

BM25 and its variants retrieve based on exact token overlap between query and document.
Dense bi-encoders retrieve based on semantic similarity in continuous vector space.
Each has a known failure mode: BM25 misses synonyms and paraphrases; dense retrieval
misses exact lexical matches on rare terms. Learned sparse representations attempt to
combine the speed of inverted-index lookup with the vocabulary expansion of neural models.

SPLADE (Sparse Lexical and Expansion model) is the dominant approach in this family.
A SPLADE model takes a text input, processes it through a BERT-style encoder, and
projects the output onto a vector of size equal to the BERT vocabulary (typically
30,522 for bert-base-uncased). The projection produces a weight for each vocabulary
token, and a RELU activation ensures non-negative weights. Tokens with weight above a
threshold become entries in the sparse representation.

## Vocabulary Expansion Mechanism

The key property that distinguishes SPLADE from older sparse neural models is vocabulary
expansion: the sparse representation for a document can contain non-zero weights for
tokens that do not appear in the original document text. The BERT encoder attends across
the full input sequence and can activate vocabulary entries for semantically related
terms that the document implies but does not state.

For example, a document that mentions "automobile" and "fuel efficiency" may receive
non-zero weights for "car", "vehicle", "mpg", and "gasoline" in its SPLADE representation,
even though none of these tokens appear in the text. This expansion is learned during
training, where the model is trained on query-document pairs and must learn which
vocabulary expansions improve recall of the training positives.

The expansion is not unlimited: the L1 regularization term in the SPLADE training loss
penalizes the total weight magnitude, forcing the model to assign non-zero weights
selectively. Models trained with stronger L1 regularization produce sparser
representations (fewer non-zero tokens, more similar to BM25), while weaker L1
produces denser representations with better recall but slower index lookup.

## Retrieval Mechanics Over an Inverted Index

SPLADE representations are stored in a standard inverted index using the same data
structure as BM25: for each vocabulary token, a posting list of (document_id, weight)
pairs sorted by document_id. At query time, the query text is encoded into a sparse
vector, the non-zero query token IDs are used to look up their posting lists, and
document scores are accumulated as the dot product of query weights and document weights.

This retrieval is algorithmically equivalent to BM25 lookup and runs in sub-millisecond
time for typical query representations with 50-200 non-zero tokens. The key difference
from BM25 is that both query and document representations are expanded beyond their
literal tokens, so a query for "sedan" can match documents about "car" through their
shared SPLADE-expanded representations.

## SPLADE-PP Variants and Hybrid Pipeline Integration

The original SPLADE used separate query and document BERT encoders. SPLADE-v2 introduced
shared weights. SPLADE-PP replaced BERT with DistilBERT and applied knowledge distillation,
achieving 3x faster inference with less than 2% recall loss versus full SPLADE-v2 on
BEIR benchmarks. For document-length inputs, encoding is slower than dense embedding
because the full 30K-dimensional vocabulary projection must be computed; the standard
mitigation is offline document encoding with cached sparse vectors.

SPLADE is most commonly the sparse component in a hybrid pipeline alongside dense vector
retrieval, with result sets merged via RRF or score normalization. The empirical benefit
over BM25-plus-dense hybrid is consistent but modest: 1-3% NDCG@10 improvement above
BM25, concentrated on queries using technical terminology with strong semantic neighbors
that the dense retrieval alone does not surface.
