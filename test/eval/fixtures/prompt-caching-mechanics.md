---
name: prompt-caching-mechanics
description: Anthropic prompt caching -- prefix caching, breakpoint placement, TTL, and cache invalidation triggers
type: reference
---

# Prompt Caching Mechanics

Anthropic's prompt caching feature allows the API to reuse KV cache state across requests
that share a common prefix. This significantly reduces latency and token cost for workloads
where a large, stable context (system prompt, documents, conversation history) is sent with
every request.

## How It Works

When you annotate a content block with `"cache_control": {"type": "ephemeral"}`, the API
checkpoint the KV cache at that position. On subsequent requests, if the tokens up to that
checkpoint are byte-for-byte identical, the server reuses the cached KV state rather than
recomputing attention over those tokens.

The cached tokens are billed at a lower rate (cache read tokens) rather than the standard
input token rate. Cache writes are billed at a higher rate (typically 1.25x input) because
the server must compute and store the KV cache. Net savings require the cache to be hit at
least a few times before the write cost is amortized.

## Prefix Requirement

Caching is prefix-based, not content-based. The tokens before the cache breakpoint must
be byte-for-byte identical on every request that benefits from the cache. A single changed
token anywhere before the breakpoint invalidates the cache.

This means:
- Dynamic content (user query, current time, session-specific data) must appear AFTER the
  last cache breakpoint, not before it.
- System prompts should be placed first, before any dynamic content.
- Stable documents (context files, policy text, reference docs) should be placed after
  the system prompt but before the conversation history.
- Conversation history should appear after the last cache breakpoint (since it changes
  each turn).

## Breakpoint Placement

You can have up to 4 cache breakpoints per request. Optimal placement:

```
[system prompt]                    <-- cache breakpoint 1
[large static document A]
[large static document B]          <-- cache breakpoint 2
[conversation history]             <-- cache breakpoint 3 (optional)
[current user message]             (not cached -- changes every turn)
```

Place breakpoints at the boundary between stable and dynamic content. Adding a breakpoint
in the middle of a stable block wastes a slot without adding benefit.

The cache operates on token boundaries. If a block does not end on a token boundary, the
checkpoint is placed at the nearest token boundary below the annotation point.

## TTL and Expiry

Cache entries have a 5-minute TTL with no explicit API to extend or evict them. The TTL
resets each time the cache entry is successfully read (i.e., a request hits the cache).

Implications:
- High-traffic applications naturally maintain cache entries because frequent requests
  continuously reset the TTL.
- Low-traffic applications (fewer than one request per 5 minutes) will find the cache
  cold on most requests. The write cost is paid repeatedly without proportional savings.
  For these, caching is still beneficial if the context is large (hundreds of tokens),
  but the ROI is lower.
- Batch jobs that process many documents in sequence benefit from caching if they share
  a common system prompt, even if each request has different document content.

## Cache Invalidation Triggers

The cache is invalidated (dropped) when:
- Any token before the breakpoint changes -- including whitespace, punctuation, or a
  single character in the system prompt.
- The model version changes (cache is per-model, not cross-model).
- The cache TTL expires after 5 minutes of inactivity.
- The Anthropic server rotates cache storage (infrastructure event, infrequent).

Common accidental invalidation causes:
- Timestamp or session ID injected into the system prompt at the start of each request.
- Dynamic user name or greeting prepended before stable content.
- Trailing whitespace changes in the system prompt between deploys.

## Measuring Cache Effectiveness

The API response includes usage fields:
- `cache_creation_input_tokens` -- tokens written to cache this request
- `cache_read_input_tokens` -- tokens read from cache this request
- `input_tokens` -- tokens processed without cache benefit

A healthy caching setup shows most requests with `cache_read_input_tokens` approaching
the size of the stable prefix, and `cache_creation_input_tokens` near zero (the cache is
warm). If you consistently see high `cache_creation_input_tokens`, the cache is being
invalidated frequently.

## Streaming and Caching

Caching works identically with streaming responses. The cache checkpoint annotation is
on the input side; the streaming behavior is on the output side. They are independent.

## Multi-Turn Conversation Pattern

For a conversational assistant with a large system prompt:

1. Mark the system prompt with a cache breakpoint.
2. On each turn, include the full conversation history (unmarked) followed by the new
   user message.
3. The cache entry covers the system prompt; the conversation history is re-processed
   each turn.

If the conversation history grows large (many turns), add a second breakpoint after the
first N turns of history once they are stable. This requires truncating or summarizing
history before it exceeds the context window anyway, so the natural summarization point
is also the natural cache breakpoint.

## Token Minimum

Cache breakpoints require a minimum number of tokens to be useful. The API requires at
least 1024 tokens before a checkpoint on Claude 3 models, and at least 2048 tokens on
some model variants. Attempting to cache a prefix shorter than the minimum has no effect
(no error is raised; the tokens are simply processed normally).

For very short system prompts (under ~1000 tokens), caching may not be worth instrumenting.
The savings on 500 input tokens at reduced cache-read pricing are minimal.
