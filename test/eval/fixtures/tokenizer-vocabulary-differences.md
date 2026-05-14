---
name: tokenizer-vocabulary-differences
description: How tokenizer vocabulary design affects embedding quality for rare terms, code, and multilingual content across model families
type: reference
---

# Tokenizer Vocabulary Differences Across Embedding Models

An embedding model's semantic quality is bounded by its tokenizer's vocabulary. The
tokenizer determines how raw text is converted to token IDs before being processed by
the transformer, and the granularity of that conversion affects how well the model can
represent rare words, technical terminology, code identifiers, and non-English text.

Two text passages that are semantically similar but tokenize into very different token
sequences may embed less similarly than they should, because the model's attention
patterns operate over token IDs, not over characters or semantic units. Understanding
tokenizer behavior is necessary for predicting where embedding models will fail on
specialized content.

## WordPiece vs Byte-Pair Encoding

BERT-family models (including BGE and E5 base/large) use WordPiece tokenization with
a 30,000-token vocabulary trained primarily on English Wikipedia and BookCorpus. WordPiece
segments unknown words into the longest known sub-word prefixes, marking non-initial
subwords with a "##" prefix. A word not in the vocabulary like "suboptimally" becomes
["sub", "##opt", "##imal", "##ly"] -- four tokens, each carrying partial meaning.

GPT-family models and models based on Llama/Mistral use Byte-Pair Encoding (BPE) with
much larger vocabularies (50,000-100,000+ tokens). BPE tokenizes by frequency of
character pair merges, which tends to produce more intuitive splits for English compound
words and better coverage of common technical terms. "suboptimally" in a 100K BPE
vocabulary is likely a single token, encoding its meaning more directly.

For code-heavy retrieval (function names, variable names, API identifiers), BPE
vocabularies substantially outperform WordPiece because they include common programming
tokens as single units. "argparse", "sklearn", "asyncio" are single BPE tokens in
code-trained vocabularies but are split into 3-5 subwords under WordPiece.

## Vocabulary Coverage for Specialized Domains

Medical, legal, and scientific terminology poses a challenge for both tokenizer families
because their training corpora underrepresent these domains. A term like "pembrolizumab"
(a cancer drug) fragments into 6-8 subwords under WordPiece and 4-5 under standard BPE.
Models trained on PubMed abstracts (BioASQ, PubMedBERT) include common drug names and
medical terms as single tokens and produce substantially better embeddings for biomedical
retrieval precisely because of vocabulary overlap, not architecture. For RAG systems
serving specialized domains, if your corpus contains heavy domain-specific terminology
and you use a general-purpose embedding model, retrieval quality for specialized queries
will underperform general-domain benchmarks. Fine-tuning a domain-specific tokenizer is
the highest-quality solution but expensive; a lighter-weight alternative is synonym
expansion at query time.

## Multilingual Coverage and Tokens-per-Word Diagnostic

For multilingual embedding models (mBERT, multilingual-e5), the tokenizer must cover
multiple scripts. mBERT uses a 119K-token multilingual WordPiece vocabulary trained on
104 languages; vocabulary allocation per language is roughly proportional to Wikipedia
size, meaning high-resource languages (English, German, French) receive good coverage
while low-resource languages fragment heavily. Byte-fallback BPE ensures any Unicode
character can be represented by falling back to byte-level tokens, eliminating unknown-
token errors but producing very long sequences for underrepresented languages.

A practical proxy for tokenizer coverage quality is the average tokens-per-word ratio
for your corpus. For English prose with general vocabulary, this ratio should be 1.1-1.4.
A ratio above 2.0 indicates heavy fragmentation, suggesting either a vocabulary-domain
mismatch or significant non-English content in a model trained primarily on English.
Measuring this ratio before committing to a model is a quick diagnostic: if the ratio
is high, benchmark a model trained on domain-similar data or a BPE model with a larger
vocabulary against your golden evaluation set before indexing the full corpus.
