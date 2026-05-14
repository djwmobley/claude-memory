---
name: tsvector-weight-classes
description: PostgreSQL tsvector weight classes A through D, setweight usage, and ts_rank_cd coverage normalization behavior
type: reference
---

# PostgreSQL tsvector Weight Classes

Full-text search in PostgreSQL assigns lexemes to weight classes during index construction
to reflect the structural importance of the text they come from. Weight classes are
single letters A, B, C, or D, assigned in descending order of importance. A lexeme
tagged with weight A contributes more to the relevance score than the same lexeme
tagged with weight D when ts_rank or ts_rank_cd computes a query score.

This mechanism allows a search system to distinguish between a term appearing in a
document's title versus a term appearing in a footnote, even when both lexemes are
present in the same tsvector.

## Assigning Weights with setweight

The setweight function applies a weight class to all lexemes in a tsvector:

```sql
setweight(to_tsvector('english', title_column), 'A') ||
setweight(to_tsvector('english', body_column), 'C')
```

The concatenation operator || merges the two weighted tsvectors. Lexemes that appear
in both the title and body will have two entries, one with weight A and one with weight C.
The ranking functions use the highest weight class when a lexeme appears multiple times.

In practice, a four-field document (title, subtitle, abstract, body) maps naturally to
the four weight classes:

    A: title
    B: section headings or subtitle
    C: abstract or first paragraph
    D: body text (the default when no weight is specified)

The D weight is the default. A tsvector produced by to_tsvector without setweight has
all lexemes at weight D.

## ts_rank vs ts_rank_cd

Two ranking functions are available. ts_rank computes a score based on lexeme frequency
within the document (similar to TF in TF-IDF). ts_rank_cd (coverage density) computes
a score based on how tightly the query lexemes are clustered within the document, which
better reflects phrase proximity even without full phrase matching.

The normalization parameter controls how document length affects the score. This is the
parameter most commonly misunderstood in production deployments. The normalization
argument is a bitmask, and its bits select from a set of independent normalization
behaviors that can be combined:

    0  -- no normalization (score grows unboundedly with term frequency)
    1  -- divide by log(document_length + 1)
    2  -- divide by document_length
    4  -- divide by harmonic mean of extents between matching lexemes
    8  -- divide by number of unique words in document
    16 -- divide by ts_rank computed over the entire document
    32 -- divide by document length plus number of unique words

Normalization value 1 (log normalization) is appropriate for most applications because
it moderately penalizes very long documents without completely discounting them.
Normalization value 32 is rarely useful but appears in documentation examples where it
causes unexpected behavior on short documents when cargo-culted into production configs.

## GIN Storage, Heap Fetch, and Generated Column Patterns

Weighted tsvectors are stored in GIN indexes transparently, but the index size increases
when lexemes appear with multiple weights: each (lexeme, weight) pair occupies a separate
posting list entry. Documents with all four weight classes used densely may produce a
GIN index 20-30% larger than a weight-free index. More importantly, ts_rank reads weight
information from the stored tsvector retrieved from the heap -- not from the GIN index
itself -- so weight-sensitive ranking always requires a heap fetch. Index-only scans are
not possible for ts_rank when weight classes are involved.

When using a generated column to pre-compute tsvectors, all lexemes receive weight D by
default. To use multi-field weighting, the generated column expression must include
setweight concatenation referencing multiple columns:

```sql
ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'D')
  ) STORED;
```

Coalesce is required because to_tsvector returns NULL for NULL input, and concatenating
NULL with a valid tsvector produces NULL rather than the valid tsvector.
