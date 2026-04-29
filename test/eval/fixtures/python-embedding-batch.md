---
name: python-embedding-batch
description: Batched embedding generation in Python with retry logic, error handling, and async patterns
type: reference
---

# Python Embedding Batch Processing

Efficient patterns for generating embeddings at scale in Python. Covers synchronous
and async approaches, batch sizing, retry with jitter, and error recovery.

## Synchronous Batch with requests

```python
import time
import random
import hashlib
import requests
from typing import List, Optional

EMBED_URL = "http://localhost:11434/api/embeddings"
MODEL     = "nomic-embed-text"
BATCH_SIZE = 32

def embed_batch(texts: List[str], model: str = MODEL) -> List[List[float]]:
    """Embed a batch of texts. Returns list of embedding vectors."""
    results = []
    for text in texts:
        resp = requests.post(EMBED_URL, json={"model": model, "prompt": text}, timeout=30)
        resp.raise_for_status()
        results.append(resp.json()["embedding"])
    return results


def embed_with_retry(
    texts: List[str],
    max_retries: int = 3,
    base_delay: float = 1.0,
) -> Optional[List[List[float]]]:
    """Embed with exponential backoff on transient errors."""
    for attempt in range(max_retries):
        try:
            return embed_batch(texts)
        except requests.exceptions.ConnectionError as e:
            if attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
            print(f"Connection error, retry {attempt+1}/{max_retries} in {delay:.1f}s: {e}")
            time.sleep(delay)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code < 500:
                raise  # client error -- don't retry
            if attempt == max_retries - 1:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
            time.sleep(delay)
    return None
```

## Chunked Processing with Progress

```python
def process_documents(docs: List[dict], batch_size: int = BATCH_SIZE) -> List[dict]:
    """Process documents in batches, returning each doc with its embedding."""
    enriched = []
    total = len(docs)

    for i in range(0, total, batch_size):
        batch = docs[i:i + batch_size]
        texts = [d["body"] for d in batch]

        print(f"Embedding batch {i//batch_size + 1}/{(total + batch_size - 1)//batch_size}")
        vectors = embed_with_retry(texts)

        for doc, vec in zip(batch, vectors):
            enriched.append({**doc, "embedding": vec})

    return enriched
```

## Async Batch with aiohttp

For high-throughput pipelines, run requests concurrently:

```python
import asyncio
import aiohttp
from typing import List

async def embed_one(
    session: aiohttp.ClientSession,
    text: str,
    semaphore: asyncio.Semaphore,
    model: str = MODEL,
) -> List[float]:
    """Embed a single text with concurrency control."""
    async with semaphore:
        payload = {"model": model, "prompt": text}
        async with session.post(EMBED_URL, json=payload, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            resp.raise_for_status()
            data = await resp.json()
            return data["embedding"]


async def embed_batch_async(
    texts: List[str],
    concurrency: int = 8,
) -> List[List[float]]:
    """Embed texts concurrently, up to `concurrency` requests at once."""
    semaphore = asyncio.Semaphore(concurrency)
    async with aiohttp.ClientSession() as session:
        tasks = [embed_one(session, t, semaphore) for t in texts]
        return await asyncio.gather(*tasks)
```

## Content-Hash Deduplication

Skip re-embedding documents that haven't changed:

```python
def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def filter_new_docs(docs: List[dict], existing_hashes: set) -> List[dict]:
    """Return only docs whose content_hash is not in existing_hashes."""
    return [
        d for d in docs
        if content_hash(d["body"]) not in existing_hashes
    ]
```

## Error Tracking

```python
from dataclasses import dataclass, field

@dataclass
class EmbedResult:
    successes: List[dict] = field(default_factory=list)
    failures:  List[dict] = field(default_factory=list)


def embed_with_tracking(docs: List[dict], batch_size: int = BATCH_SIZE) -> EmbedResult:
    result = EmbedResult()

    for i in range(0, len(docs), batch_size):
        batch = docs[i:i + batch_size]
        try:
            vectors = embed_with_retry([d["body"] for d in batch])
            for doc, vec in zip(batch, vectors):
                result.successes.append({**doc, "embedding": vec})
        except Exception as e:
            print(f"Batch {i//batch_size} failed: {e}")
            for doc in batch:
                result.failures.append({**doc, "error": str(e)})

    return result
```

## Notes

- Ollama's `/api/embeddings` endpoint processes one text per request. For OpenAI-compatible
  APIs that accept batch arrays, pass all texts in one request to minimize round-trips.
- Set concurrency based on the server's capacity. For local Ollama, 4-8 concurrent requests
  is typical; reduce if you see OOM errors or timeouts.
- Always persist embeddings to a database immediately after generation. Re-generating a
  large corpus after a crash is expensive.
