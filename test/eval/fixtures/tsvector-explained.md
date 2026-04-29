---
name: tsvector-explained
description: What tsvector is, how lexemes are produced, and the weight system (A/B/C/D)
type: reference
---

# tsvector Explained

`tsvector` is PostgreSQL's internal representation of a document for full-text search. It
stores a sorted list of lexemes (normalized word forms) with their positions and optional
weights.

## What a tsvector Looks Like

```sql
SELECT to_tsvector('english', 'The quick brown fox jumps over the lazy dog');
-- 'brown':3 'dog':9 'fox':4 'jump':5 'lazi':8 'quick':2
```

Notice:
- Stop words ("the", "over") are removed
- "jumps" is stemmed to "jump" (Porter stemmer for English)
- "lazy" becomes "lazi" (same stemmer)
- Each lexeme carries its position(s) in the original text
- The result is sorted lexicographically

## Weight System

Each lexeme position can carry a weight: `A`, `B`, `C`, or `D` (default).
Weights are assigned with `setweight`:

```sql
SELECT
  setweight(to_tsvector('english', 'Connection Pools'), 'A') ||
  setweight(to_tsvector('english', 'Managing database connections efficiently'), 'B');

-- 'connect':1A,4B 'databas':3B 'effici':5B 'manag':2B 'pool':2A
```

The `A` weight on "connection" and "pool" (from the title) means a query matching those
terms will rank this document higher than one where the same terms appear only in the body
(default weight `D`).

`ts_rank_cd` uses the weights; `ts_rank` ignores them. For weight-aware ranking you must
use `ts_rank_cd`.

## Text Search Configurations

The first argument to `to_tsvector` and `plainto_tsquery` is a text search configuration.
It determines the dictionary (stemmer + stop words) applied:

- `english` -- English stemming, English stop words
- `simple` -- no stemming, no stop words (every word kept as-is)
- `french`, `german`, etc. -- language-specific stemming

Use `simple` for identifiers, product names, and technical tokens where stemming would
be harmful (e.g., "redis" must not become "redi").

## Concatenating Multiple Fields

```sql
to_tsvector('english', coalesce(title, '')) ||
to_tsvector('english', coalesce(body, ''))
```

Positions are renumbered automatically on concatenation, so phrase searches (`<->` operator)
work correctly across the combined vector.
