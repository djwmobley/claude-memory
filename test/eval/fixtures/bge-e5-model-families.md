---
name: bge-e5-model-families
description: BGE and E5 embedding model families, their training objectives, instruction prefixes, and benchmark characteristics
type: reference
---

# BGE and E5 Embedding Model Families

The open-source embedding model landscape is dominated by two closely related model
families: BGE (Beijing Academy of Artificial Intelligence General Embedding) and E5
(EmbEddings from bidirEctional Encoder rEpresentations). Both families are based on
BERT-style transformer encoders, both are trained on large contrastive datasets sourced
from web text, and both have become the default starting point for production RAG
systems that cannot afford proprietary API costs or need offline-capable inference.

Understanding the architectural and training differences between these families is
necessary for choosing the right model for a given retrieval task and for interpreting
benchmark numbers that may not reflect your actual query distribution.

## BGE Family: Architecture and Training

BGE models from BAAI are available in three sizes: bge-small-en-v1.5 (33M parameters,
384d output), bge-base-en-v1.5 (110M parameters, 768d output), and bge-large-en-v1.5
(335M parameters, 1024d output). All three use a BERT base architecture with a modified
pooling strategy: they pool the CLS token output rather than mean-pooling all tokens,
which is a deliberate choice that aligns with the contrastive pretraining objective.

BGE's training pipeline uses a three-stage approach: (1) general-purpose contrastive
pretraining on 200 million text pairs from web crawls, Wikipedia, and Stack Exchange;
(2) fine-tuning on a curated set of 500K hard-negative triples; (3) flag embedding fine-
tuning, which adds an instruction prefix system that allows the same model weights to
serve both retrieval and semantic similarity tasks by conditioning the CLS attention
on a task-specific prefix.

The flag-embedding system requires a specific prefix format for asymmetric retrieval:
queries should be prefixed with "Represent this sentence: " and documents should NOT
have a prefix. This is the most common source of quality degradation when BGE is
deployed without reading the usage instructions.

## E5 Family: Architecture and Training

E5 models from Microsoft Research share the same BERT backbone sizes as BGE but differ
in training objective and prefix format. E5 models are trained with a weakly supervised
pretraining phase on 1 billion text pairs from Common Crawl, followed by fine-tuning
on the BEIR training set with hard negatives mined from the weak model's retrieval output.

E5's instruction format is more explicit than BGE's: queries use the prefix "query: "
and documents use the prefix "passage: ". These prefixes are short but they are
non-optional -- the model's attention patterns were trained to expect them and performance
degrades 5-15% Recall@10 without them on asymmetric retrieval tasks.

The E5-mistral-7b-instruct variant replaces the BERT backbone with a Mistral 7B decoder
fine-tuned for embedding (using the last token's hidden state as the pooled representation
rather than a CLS token). This produces a much larger model (7B parameters, 4096d output)
with substantially better performance on long-document retrieval tasks where BERT's 512-
token context window is a limitation.

## Benchmark Limits and Selection Guidance

Both BGE-large and E5-large consistently score 48-52 on the BEIR aggregate (18 datasets
covering diverse domains). These numbers mask important distribution effects: performance
on BEIR's QA subsets (Natural Questions, HotpotQA) is 55-62 NDCG@10, while out-of-
domain subsets like BioASQ (medical, 40-45) and CQADupstack (community QA, 35-40) score
substantially lower. Choosing a model based on aggregate BEIR score will overestimate
performance by 10-15 NDCG points if your task resembles BioASQ more than NQ.

For symmetric semantic similarity, both families perform comparably and the CLS-pooling
vs mean-pooling distinction has minimal impact. For asymmetric retrieval, the instruction
prefixes are critical and must match the model family's expected format exactly. For
long-document retrieval exceeding 512 tokens, neither BERT-based family is appropriate;
E5-mistral-7b-instruct or Jina v3 are the recommended alternatives.
