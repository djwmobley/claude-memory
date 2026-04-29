---
name: sql-fts-tsvector-recipes
description: PostgreSQL full-text search recipes -- GIN indexes, tsvector columns, tsquery variants, ts_rank tuning
type: reference
---

# SQL Full-Text Search Recipes

PostgreSQL full-text search uses the `tsvector` type (pre-processed document) and the
`tsquery` type (query expression). This entry covers index creation, tsquery variants,
and ranking tuning.

## GIN Index on a Generated tsvector Column

```sql
-- Add a generated tsvector column to an existing table
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '')       || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(body, '')
    )
  ) STORED;

-- Create GIN index on the generated column
CREATE INDEX IF NOT EXISTS documents_fts_idx
  ON documents USING gin (search_vector);
```

GIN (Generalized Inverted Index) is the right index type for `tsvector`. GiST is
an alternative with faster updates but slower queries; prefer GIN unless you have
extremely high write throughput.

## tsvector with Per-Field Weights

Different fields can carry different relevance weight (A > B > C > D):

```sql
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')       ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED;
```

`ts_rank_cd` uses these weights when scoring: a match in the title (weight A) scores
higher than the same match in the body (weight C).

## tsquery Variants

```sql
-- plainto_tsquery: space-separated words joined by AND, no operators
SELECT * FROM documents
WHERE search_vector @@ plainto_tsquery('english', 'connection pool timeout');
-- equivalent to: 'connection' & 'pool' & 'timeout'

-- phraseto_tsquery: words must appear in sequence
SELECT * FROM documents
WHERE search_vector @@ phraseto_tsquery('english', 'exponential backoff');
-- equivalent to: 'exponential' <-> 'backoff'

-- websearch_to_tsquery: Google-style operators (quotes for phrase, - for exclude)
SELECT * FROM documents
WHERE search_vector @@ websearch_to_tsquery('english', '"retry logic" -socket');

-- to_tsquery: full operator syntax (& | ! <->), strict input (tokens must be valid)
SELECT * FROM documents
WHERE search_vector @@ to_tsquery('english', 'retry & (backoff | jitter)');
```

`websearch_to_tsquery` is the safest for user-supplied input: it handles arbitrary
text without syntax errors (unlike `to_tsquery` which throws on malformed input).

## ts_rank and ts_rank_cd

```sql
-- Basic ranking by term frequency
SELECT id, title,
       ts_rank(search_vector, q) AS rank
FROM documents,
     plainto_tsquery('english', 'connection pool') q
WHERE search_vector @@ q
ORDER BY rank DESC
LIMIT 20;

-- Cover density ranking (boosts when query terms cluster together)
SELECT id, title,
       ts_rank_cd(search_vector, q, 1) AS rank
FROM documents,
     plainto_tsquery('english', 'connection pool') q
WHERE search_vector @@ q
ORDER BY rank DESC
LIMIT 20;
```

The third argument to `ts_rank_cd` is a normalization bitmask:
- `0` -- no normalization (score grows with document length)
- `1` -- divide by 1 + log(doc_length)
- `2` -- divide by doc_length
- `4` -- divide by mean harmonic distance between extents
- `8` -- divide by number of unique words in document
- `32` -- divide by rank + 1 (self-dampening)

For most knowledge-base search, `1` (log normalization) works well. Without normalization,
very long documents dominate rankings simply because they have more tokens.

## Highlighting Matched Terms

```sql
SELECT id, title,
       ts_headline('english', body, q,
         'StartSel=<b>, StopSel=</b>, MaxWords=50, MinWords=20, ShortWord=3'
       ) AS excerpt
FROM documents,
     plainto_tsquery('english', 'connection pool') q
WHERE search_vector @@ q
ORDER BY ts_rank(search_vector, q) DESC
LIMIT 10;
```

`ts_headline` is expensive -- it re-processes the body text. Only call it on the final
result set (after limiting), never in a WHERE clause or subquery.

## Multilingual Setup

For corpora with mixed languages, use a per-row language column:

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language REGCONFIG DEFAULT 'english';

-- Update tsvector to use per-row language
ALTER TABLE documents DROP COLUMN search_vector;
ALTER TABLE documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(language, coalesce(title,'') || ' ' || coalesce(body,''))
  ) STORED;
```

Supported language configurations: `english`, `french`, `german`, `spanish`, `portuguese`,
`italian`, `dutch`, `russian`, `simple` (no stemming, use for identifiers).

## Checking Available Text Search Configurations

```sql
SELECT cfgname FROM pg_ts_config ORDER BY cfgname;
```

## Keeping tsvector in Sync (Trigger-Based, Legacy Pattern)

The `GENERATED ALWAYS AS ... STORED` approach above is preferred for PostgreSQL 12+.
For older versions, a trigger was required:

```sql
CREATE OR REPLACE FUNCTION documents_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.body,''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_search_vector_trigger
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_search_vector_update();
```

The trigger pattern works but is harder to reason about than generated columns.
Use generated columns where available.
