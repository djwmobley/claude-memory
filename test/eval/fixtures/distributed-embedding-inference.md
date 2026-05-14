---
name: distributed-embedding-inference
description: Batching, sharding, and throughput optimization for distributed embedding inference at scale across multiple GPUs or nodes
type: reference
---

# Distributed Embedding Inference

Embedding a large corpus is a throughput-bound problem. A single BERT-base encoder
running on a single A10 GPU processes approximately 500-800 text sequences per second
at batch size 64 for sequences of 128 tokens. At this rate, embedding a million-document
corpus takes 20-30 minutes -- acceptable for a one-time indexing job but too slow for
near-real-time re-indexing after significant corpus updates.

Distributed inference spreads the encoding work across multiple GPUs, multiple nodes,
or both, with coordination overhead that must remain small relative to the encoding work
itself.

## Data Parallelism vs Model Parallelism

For embedding models, data parallelism is almost always the right choice. Data parallelism
replicates the model weights on each GPU and assigns disjoint shards of the input corpus
to each GPU. Each GPU processes its shard independently, and the results are written to
a shared output store (a database or object storage). There is no inter-GPU communication
during inference, so coordination overhead is negligible.

Model parallelism (splitting the model's transformer layers across GPUs) is appropriate
for very large models (Llama 70B, E5-mistral-7b) where the model weights do not fit on
a single GPU. For BERT-base (110M parameters, ~440MB in float32) and even BERT-large
(340M parameters, ~1.3GB), model parallelism is unnecessary and its communication
overhead (all-reduce operations between layers) reduces throughput compared to pure
data parallelism.

## Batch Size Optimization

GPU memory constrains the maximum batch size. For BERT-base with max sequence length
512, a single A10 (24GB) can hold batch sizes up to 512 sequences without OOM, but
the optimal batch size for throughput is typically 64-128: smaller batches under-utilize
the GPU's parallel execution units, while larger batches increase memory transfer
overhead and reduce the effective throughput per unit of allocated memory.

Empirically, the throughput-vs-batch-size curve is concave with a maximum in the 64-128
range for most GPU/model combinations. The maximum can be found by binary search or by
using a framework profiler (PyTorch Profiler, NVIDIA Nsight Systems) to measure GPU
utilization at different batch sizes.

For variable-length sequences, padding short sequences to the maximum length in a batch
wastes compute on padding tokens. Dynamic padding pads each batch only to the length of
the longest sequence in that batch, reducing compute waste by 20-40% for typical corpus
length distributions. The sentence-transformers library implements dynamic padding by
default when using its encode() method.

## Queue-Based Dispatch and Hardware Throughput

A simple distributed pipeline uses a work queue pattern: a coordinator process produces
(document_id, text) items into a message queue (Redis Streams, RabbitMQ, or a Postgres
advisory lock pattern), and N worker processes consume items, batch them, encode them,
and write the resulting vectors to the vector store. The coordinator handles checkpointing
via a status column (pending / embedding / embedded / failed) so worker crashes don't
cause re-embedding of already-processed documents.

Throughput benchmarks using BERT-base, sequence length 128, batch size 64: T4 GPU
(16GB, common in spot instances) ~600 sequences/sec; A10 GPU (24GB) ~1,800/sec; A100
(80GB) ~4,500/sec; H100 (80GB) ~9,000/sec. INT8-quantized ONNX Runtime on a 32-core
CPU delivers 300-500 sequences/sec per process, scalable to 8+ processes per server.
Cost efficiency (sequences per dollar) on spot instances typically favors T4 or A10
over A100/H100 because embedding models are memory-bandwidth-bound, and higher-tier
GPUs don't proportionally improve memory bandwidth for these model sizes.
