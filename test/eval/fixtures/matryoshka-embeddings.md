---
name: matryoshka-embeddings
description: Matryoshka Representation Learning trains embeddings where any prefix of dimensions is a valid lower-dimensional embedding
type: reference
---

# Matryoshka Representation Learning

Standard embedding models produce fixed-size output vectors. A 1536-dimensional model
always outputs 1536 dimensions, regardless of whether the downstream task requires that
precision or whether storage and compute constraints would favor a smaller representation.
This rigidity forces a static tradeoff: you must choose the embedding dimension at
training time and live with that choice for the entire lifecycle of the index.

Matryoshka Representation Learning (MRL), introduced by Kusupati et al. at the
University of Washington in 2022, trains embedding models so that the first D dimensions
of the full embedding constitute a useful embedding on their own for any D in a set of
predetermined sizes. The name refers to Russian nesting dolls: each size is nested
inside the next larger size, and each is complete and functional at its own scale.

## Training Objective

A standard embedding model is trained to maximize the similarity between positive
pairs and minimize it between negative pairs, producing a loss function applied to the
full output vector. MRL modifies this by evaluating the same contrastive loss at
multiple prefix lengths simultaneously and summing the losses with equal or learned
weights.

For a model trained with MRL at prefix sizes {64, 128, 256, 512, 1024, 2048}, the
training gradient updates the weights to simultaneously satisfy six different objectives:
the 64-dimensional prefix must be a good 64-d embedding, the 128-dimensional prefix
must be a good 128-d embedding, and so on. Because the 64-d prefix is a subset of the
128-d prefix, the model learns to pack the most discriminative information into the
lowest dimensions and use higher dimensions for finer-grained distinctions.

## Retrieval Quality vs Dimension Tradeoff

The practical payoff of MRL is a smooth retrieval-quality vs. storage-cost curve with
no retraining required. A single MRL-trained model can serve multiple use cases at
different dimension budgets. For a mobile application where storage is limited to 2MB
for a local semantic search index of 10,000 passages, you use 64-dimensional truncated
vectors. For a server-side index where quality is paramount, you use the full 2048-d
vectors. The same model weights serve both.

Empirical benchmarks from the original MRL paper show that MRL-trained models at 512d
match or exceed independently-trained 512d models in Recall@10 on BEIR benchmarks,
while also matching full-dimension MRL models at 2048d. The quality loss from dimension
reduction is approximately 3-5% Recall@10 per halving of dimensions in the 256-2048
range, and steeper below 128d.

## API Adoption and Multi-Resolution Index Design

OpenAI's text-embedding-3-small and text-embedding-3-large are trained with Matryoshka
loss. The API exposes a dimensions parameter that truncates the output to the requested
size, allowing dimensions=256 for high-throughput applications and dimensions=3072 for
high-precision search without re-indexing. Cohere's Embed v3 uses a related adaptive
embedding technique with the same practical behavior via an output_dimensions parameter.

A two-stage retrieval design exploiting MRL uses truncated low-dimensional vectors for
first-stage candidate retrieval and full-dimensional vectors for second-stage reranking.
For a corpus of 10 million passages with a 1536-d MRL model, the first-stage index uses
128-dimensional vectors (12x smaller), while the full vectors are stored separately and
loaded on demand. This achieves much of the latency benefit of product quantization with
less quality loss because dimension truncation is aligned with the model's information
packing structure. Storage overhead is approximately 1.08x -- a negligible cost that
buys substantial first-stage speed improvement.
