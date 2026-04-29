---
name: api-rate-limit-strategies
description: Token bucket vs leaky bucket algorithms, distributed rate limiting patterns, with pseudocode
type: reference
---

# API Rate Limit Strategies

Rate limiting protects services from overload and enforces fair usage. Understanding the
tradeoffs between algorithms matters when you are both a rate-limit consumer (handling
429s from upstream APIs) and a rate-limit enforcer (protecting your own endpoints).

## Token Bucket

The token bucket algorithm allows bursting up to a capacity `C`, then refills at rate `R`
tokens per second. Each request consumes one (or more) tokens.

**Properties:**
- Allows short bursts up to capacity
- Steady-state throughput is bounded by R
- Excess requests are rejected (or queued with a deadline)

**Pseudocode:**

```
state:
  tokens     = capacity      # starts full
  last_refill = now()

on_request(cost = 1):
  now = current_time()
  elapsed = now - last_refill
  tokens = min(capacity, tokens + elapsed * rate)
  last_refill = now

  if tokens >= cost:
    tokens -= cost
    return ALLOW
  else:
    return DENY(retry_after = (cost - tokens) / rate)
```

**Distributed token bucket (Redis):**

```lua
-- Lua script (atomic in Redis)
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])  -- tokens per second
local cost     = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])  -- Unix timestamp in ms

local data     = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens   = tonumber(data[1]) or capacity
local last     = tonumber(data[2]) or now

local elapsed  = (now - last) / 1000.0
tokens = math.min(capacity, tokens + elapsed * rate)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
  redis.call('PEXPIRE', key, 10000)  -- expire after 10s of inactivity
  return {1, math.floor(tokens)}     -- {allowed, remaining}
else
  local retry_after = math.ceil((cost - tokens) / rate * 1000)
  return {0, retry_after}            -- {denied, retry_after_ms}
end
```

## Leaky Bucket

The leaky bucket processes requests at a constant rate, queuing bursts up to a capacity.
Unlike token bucket, the output rate is constant even when the input is bursty.

**Properties:**
- Smooth output -- no bursting from the service's perspective
- Arrivals are queued, not dropped (unless queue is full)
- Natural for rate-limiting egress (e.g., outbound API calls at a fixed rate)

**Pseudocode:**

```
state:
  queue      = []
  last_drain = now()

on_request(req):
  if len(queue) >= capacity:
    return REJECT  # queue full
  queue.append(req)

drain():
  # called at 1/rate seconds
  if queue is not empty:
    req = queue.pop(0)
    process(req)
```

Token bucket is more common for enforcement at API gateways because it allows legitimate
bursts (a client makes several requests in quick succession, which is normal). Leaky bucket
is preferred for outbound rate control (e.g., sending N emails/second).

## Sliding Window Log

Logs each request timestamp. Counts requests in the window `[now - window, now]`.
More precise than fixed-window but memory-intensive for high-throughput APIs.

**Pseudocode:**

```
state:
  log = sorted list of timestamps

on_request():
  now = current_time()
  # Remove expired entries
  evict from log where timestamp < now - window_size

  if len(log) < limit:
    log.append(now)
    return ALLOW
  else:
    oldest = log[0]
    retry_after = oldest + window_size - now
    return DENY(retry_after)
```

**Redis sorted set implementation:**

```
ZREMRANGEBYSCORE key 0 (now - window_ms)
count = ZCARD key
if count < limit:
    ZADD key now now
    EXPIRE key window_ms
    ALLOW
else:
    oldest = ZRANGE key 0 0 WITHSCORES [1].score
    retry_after = oldest + window_ms - now
    DENY
```

## Fixed Window (Simple, Imprecise)

Count requests in the current window `[floor(now/window), ceil(now/window)]`. Reset
the counter at window boundaries.

**The double-spend problem:** A client can send `limit` requests at 23:59:59 and
another `limit` requests at 00:00:01, effectively sending `2 * limit` in a 2-second
window. This is rarely a real concern for coarse-grained limits but fails for strict
enforcement.

**Redis pattern:**

```
key = "ratelimit:{client}:{floor(now/window_seconds)}"
count = INCR key
if count == 1: EXPIRE key window_seconds
if count <= limit: ALLOW else: DENY
```

## Handling 429 Responses as a Consumer

```js
async function callWithRateLimit(url, options = {}) {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) return res;

    // Honor Retry-After if present
    const retryAfter = res.headers.get('retry-after');
    const delayMs = retryAfter
      ? parseFloat(retryAfter) * 1000
      : Math.min(1000 * Math.pow(2, attempt), 60_000) * (0.5 + Math.random() * 0.5);

    console.warn(`Rate limited. Retrying in ${delayMs.toFixed(0)}ms.`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Rate limit exceeded after maximum retries');
}
```

## Which Algorithm to Use

| Scenario                           | Recommended algorithm         |
|------------------------------------|-------------------------------|
| Public API endpoint enforcement    | Token bucket (allows bursts)  |
| Outbound email / SMS sending       | Leaky bucket (smooth output)  |
| High-precision per-user limits     | Sliding window log            |
| Simple per-IP abuse prevention     | Fixed window (good enough)    |
| Distributed (multi-node, Redis)    | Token bucket via Lua script   |
| In-memory single-process           | Token bucket or sliding log   |
