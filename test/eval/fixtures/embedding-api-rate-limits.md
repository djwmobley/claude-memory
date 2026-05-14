---
name: embedding-api-rate-limits
description: Rate limit structures, retry strategies, and throughput patterns for Cohere, Voyage, Jina, and OpenAI embedding APIs
type: reference
---

# Embedding API Rate Limits Across Providers

Embedding API providers impose rate limits to prevent abuse and ensure fair allocation
of compute resources. The limit structures differ significantly across providers in
ways that affect how you design batch embedding pipelines. Using the wrong retry or
batching strategy for a given provider's limit model results in either throttling errors
that reduce effective throughput, or unnecessarily conservative batching that wastes
available capacity.

The four major embedding API providers (OpenAI, Cohere, Voyage AI, Jina AI) each have
distinct limit dimensions, reset intervals, and enforcement behaviors that must be
accounted for in a production pipeline.

## OpenAI Embedding API Limits

OpenAI imposes limits on two dimensions simultaneously: requests per minute (RPM) and
tokens per minute (TPM). For text-embedding-3-small at the Tier 2 usage level, limits
are 3,000 RPM and 1,000,000 TPM. Both limits are enforced independently; hitting either
triggers a 429 response with a Retry-After header.

The token-based limit means that the effective request rate depends on batch size.
A batch of 100 documents averaging 200 tokens each consumes 20,000 TPM per request.
At 1,000,000 TPM, you can submit at most 50 such batches per minute -- far below the
3,000 RPM limit. For large documents, TPM is the binding constraint; for short queries,
RPM is the binding constraint.

OpenAI's 429 responses include headers: `x-ratelimit-remaining-requests`, `x-ratelimit-
remaining-tokens`, and `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`. These
headers allow a client to compute the exact wait time before the next request will succeed,
enabling a precise sleep rather than exponential backoff from a generic starting point.

## Cohere and Voyage AI Limits

Cohere's limit model uses a monthly-quota system in addition to per-minute limits: 10
calls/second for paid accounts, with monthly character quotas that scale with plan tier.
The character-per-month quota makes Cohere harder to model in a real-time pipeline
because the quota accumulates over a calendar month and cuts off hard when exhausted.
Cohere's API returns HTTP 429 without a Retry-After header in some rate-limit scenarios,
requiring exponential backoff with jitter rather than a precise sleep from header
inspection.

Voyage AI (used via Anthropic for some deployments) limits are 300 RPM and 1,000,000
TPM for standard Voyage-2 accounts. The lower RPM limit versus OpenAI requires larger
batch sizes: Voyage's API accepts batches of up to 128 documents per request, which is
the maximum needed for efficient TPM utilization within the 300 RPM budget. Using
smaller batches (10-20 documents) consumes only 12-20% of the TPM allowance.

## Jina AI Limits and Cross-Provider Adaptive Rate Limiting

Jina's embedding API (jina-embeddings-v3) uses a credit-based system rather than
RPM/TPM. API credits are consumed per token; the credit model makes cost more predictable
but requires monitoring credit balance rather than request/token rates. Jina's API
supports context lengths up to 8192 tokens per document, reducing the need to pre-chunk
documents before embedding.

A pipeline supporting multiple providers should implement a provider-specific rate limit
adapter behind a common interface exposing a method `waitIfNeeded(provider, tokenCount)`
that sleeps for the required interval before submitting the next batch. The implementation
for OpenAI uses Retry-After header values directly; for Cohere it uses exponential
backoff with jitter (Cohere's 429 responses sometimes omit Retry-After); for Voyage it
computes the exact interval from the RPM budget and the elapsed time since the last
request. Centralizing this logic prevents rate limit errors from propagating as
unhandled exceptions through the embedding pipeline.
