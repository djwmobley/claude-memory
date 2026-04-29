---
name: error-handling-retry-jitter
description: Exponential backoff math, jitter strategies for thundering herd prevention, with JavaScript implementation
type: reference
---

# Error Handling with Retry and Jitter

Network calls to databases, embedding APIs, and external services fail transiently. The
right response is retry with exponential backoff and jitter -- not immediate retry (which
retries into the same failure) and not fixed-delay retry (which causes thundering herd).

## The Problem with Naive Retry

Immediate retry: if 100 clients all hit a rate limit at the same time, all 100 immediately
retry, all hit the rate limit again, and the cycle repeats until the server recovers --
or crashes under the retry storm.

Fixed delay: all 100 clients sleep 1 second and retry simultaneously. Same problem, shifted
by 1 second.

## Exponential Backoff

Each retry waits exponentially longer than the last:

```
delay(attempt) = base * 2^attempt
```

With `base = 1s`:
- attempt 0 (first retry): 1s
- attempt 1: 2s
- attempt 2: 4s
- attempt 3: 8s
- attempt 4: 16s

Cap the maximum delay to prevent indefinite waiting:

```
delay(attempt) = min(base * 2^attempt, max_delay)
```

## Jitter

Backoff spreads retries across time, but without jitter, all clients that started at the
same moment still retry at the same moments (just further apart). Jitter randomizes the
delay within a range to desynchronize clients.

**Full jitter (recommended):**
```
delay = random(0, base * 2^attempt)
```

Each retry is a uniform random sample from [0, capped_delay]. Maximum desynchronization.
The tradeoff: some retries happen very quickly (near zero); most clients are fine with this.

**Equal jitter:**
```
delay = (base * 2^attempt) / 2 + random(0, (base * 2^attempt) / 2)
```

Guarantees at least half the exponential delay while still randomizing the second half.
Preferred when you need a minimum wait (e.g., a rate limit has a known reset window).

**Decorrelated jitter (AWS recommendation):**
```
delay = random(base, previous_delay * 3)
```

The delay is uncorrelated with the attempt number, which produces more even distribution
across the retry space.

## JavaScript Implementation

```js
/**
 * Retry a function with exponential backoff and full jitter.
 *
 * @param {Function} fn           - Async function to retry
 * @param {Object}   opts
 * @param {number}   opts.maxRetries   - Maximum number of retries (default: 4)
 * @param {number}   opts.baseDelay    - Base delay in ms (default: 500)
 * @param {number}   opts.maxDelay     - Cap on delay in ms (default: 30000)
 * @param {Function} opts.shouldRetry  - Return true if error is retryable (default: all errors)
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries  = 4,
    baseDelay   = 500,
    maxDelay    = 30_000,
    shouldRetry = () => true,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries || !shouldRetry(err)) {
        throw err;
      }

      const cap   = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const delay = Math.random() * cap;  // full jitter

      console.warn(
        `Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}. ` +
        `Retrying in ${delay.toFixed(0)}ms.`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

## Retryable vs Non-Retryable Errors

Not all errors should be retried. Retry only transient failures:

```js
function isRetryable(err) {
  // Network-level transient errors
  if (err.code === 'ECONNRESET')    return true;
  if (err.code === 'ETIMEDOUT')     return true;
  if (err.code === 'ECONNREFUSED')  return true;

  // HTTP: retry on 429 (rate limit) and 5xx (server errors)
  if (err.status === 429)           return true;
  if (err.status >= 500)            return true;

  // PostgreSQL: retry on serialization failures and deadlocks
  if (err.code === '40001')         return true;  // serialization_failure
  if (err.code === '40P01')         return true;  // deadlock_detected

  // Never retry client errors (4xx, constraint violations, auth errors)
  return false;
}

// Usage
await withRetry(() => pool.query(sql, params), { shouldRetry: isRetryable });
```

## Retry-After Header

When the server returns a `Retry-After` header (common in rate-limited APIs), use that
value instead of computing your own delay:

```js
async function withRetryAfter(fn, opts = {}) {
  const { maxRetries = 4 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;

      // Honor Retry-After if present (value is seconds)
      const retryAfter = err.response?.headers?.['retry-after'];
      const delay = retryAfter
        ? parseFloat(retryAfter) * 1000
        : Math.random() * Math.min(500 * Math.pow(2, attempt), 30_000);

      await sleep(delay);
    }
  }
}
```

## Budgeted Total Wait

If you need to cap the total time spent across all retries rather than cap per-attempt:

```js
async function withBudget(fn, budgetMs = 30_000, baseDelay = 500) {
  const start = Date.now();
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - start;
      const cap     = Math.min(baseDelay * Math.pow(2, attempt), 10_000);
      const delay   = Math.random() * cap;

      if (elapsed + delay > budgetMs) throw err;

      await sleep(delay);
      attempt++;
    }
  }
}
```
