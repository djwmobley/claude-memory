---
name: database-design-handbook
description: Comprehensive schema design guide -- normalization, indexing strategy, query patterns, and migration discipline
type: project
---

# Database Design Handbook

This handbook covers the decisions that matter most when designing a PostgreSQL schema that
will live in production for years. Topics: normalization and denormalization tradeoffs,
primary key strategy, indexing, query pattern alignment, and safe migration discipline.

---

## Part 1: Normalization

### First Normal Form (1NF)

Every column holds atomic values -- no arrays of values packed into a single column.

**Violation example:**

```sql
-- Anti-pattern: tags packed into a comma-separated string
CREATE TABLE posts (
  id   BIGSERIAL PRIMARY KEY,
  tags TEXT  -- "python,database,performance"
);
```

Consequences: no index on individual tags, queries require pattern matching (`LIKE '%python%'`),
inserts and updates require string manipulation in application code.

**Correct form:**

```sql
CREATE TABLE posts (id BIGSERIAL PRIMARY KEY, title TEXT);
CREATE TABLE post_tags (post_id BIGINT REFERENCES posts(id), tag TEXT,
                        PRIMARY KEY (post_id, tag));
```

PostgreSQL's native array type (`TEXT[]`) is an exception: for simple lookups and GIN-indexed
searches, arrays are practical. Do not use them as a substitute for a join table when you
need to filter, sort, or aggregate on the values.

### Second and Third Normal Form

2NF and 3NF are primarily relevant for composite primary keys (common in join tables).
The rule: every non-key attribute must depend on the entire key, not just part of it (2NF),
and must depend on the key directly rather than through another non-key attribute (3NF).

In practice: if you are adding columns to a join table that "belong to" one of the joined
entities rather than the relationship, that data should move to the entity's own table.

### Denormalization for Performance

Denormalization is a deliberate tradeoff: you violate normalization to reduce JOIN cost
at query time, at the cost of update complexity.

Common denormalization patterns:
- **Cached counts:** `posts.comment_count` stored and maintained via trigger, avoiding
  `SELECT COUNT(*) FROM comments WHERE post_id = ?` on every render.
- **Derived columns:** `orders.total_amount` stored as a computed sum of `order_items`,
  updated on insert/update/delete of items.
- **Redundant FK columns:** Copying `user.email` into `events.user_email` to avoid a JOIN
  in high-read tables.

Each denormalized column is a consistency risk. Use triggers or application-level write
paths to maintain it. Document explicitly that the column is derived.

---

## Part 2: Primary Key Strategy

### Surrogate vs Natural Keys

**Surrogate keys** (BIGSERIAL, UUID): system-generated, stable, no business meaning.
**Natural keys**: email address, username, ISBN, country code.

Prefer surrogate keys in most cases:
- Natural keys change (email addresses change; legal names change).
- Natural keys may need to be kept private (SSN should not appear in URLs or logs).
- Natural keys are often not globally unique without additional context.

Use natural keys as UNIQUE constraints on top of surrogate primary keys:

```sql
CREATE TABLE users (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email)
);
```

### BIGSERIAL vs UUID

**BIGSERIAL:**
- Sequential: B-tree indexes are cache-friendly; inserts go to the rightmost page.
- Compact: 8 bytes vs 16 bytes for UUID.
- Leak row count: predictable IDs expose business information (order count, user count).
- Awkward for distributed systems: no cross-node coordination.

**UUID v4 (random):**
- No leakage of business volume.
- Natural for distributed inserts.
- Random inserts cause B-tree page splits -- index bloat, slower inserts at scale.

**UUID v7 (time-ordered, recommended if you must use UUID):**
- Monotonically increasing with millisecond precision.
- Cache-friendly inserts like BIGSERIAL.
- No business-volume leakage.

```sql
-- UUID v7 in PostgreSQL 17+ (native gen_random_uuid() is v4)
-- Use the pg_uuidv7 extension or generate in application code
CREATE TABLE events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- v4 today; upgrade to v7 later
  event_type TEXT NOT NULL,
  payload    JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Part 3: Indexing Strategy

### B-Tree (Default)

B-tree is the default index type. Use it for:
- Equality filters: `WHERE status = 'active'`
- Range filters: `WHERE created_at > NOW() - INTERVAL '7 days'`
- Sorting: `ORDER BY created_at DESC`
- Prefix matches: `WHERE name LIKE 'Alice%'`

A B-tree on column `(a)` can also satisfy sorts on `a DESC` and range scans. It cannot
satisfy `LIKE '%middle%'` (leading wildcard) or full-text search.

### Composite Indexes

Index multiple columns when queries filter on multiple conditions together:

```sql
-- For: WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC
CREATE INDEX events_user_status_created_idx
  ON events (user_id, status, created_at DESC);
```

Column order matters: the index supports filters on `(user_id)`, `(user_id, status)`,
and `(user_id, status, created_at)`, but not `(status)` alone. Put equality columns
first, range/sort columns last.

### Partial Indexes

Index only the rows that match a condition -- much smaller and faster than a full index
when only a subset of rows is queried frequently:

```sql
-- Index only unprocessed jobs (the hot subset of the jobs table)
CREATE INDEX jobs_unprocessed_idx
  ON jobs (created_at)
  WHERE status = 'pending';
```

The query must include the same WHERE clause for the planner to use the partial index:
`WHERE status = 'pending' ORDER BY created_at`.

### Index Bloat and Maintenance

Deleted rows leave dead tuples in indexes. VACUUM cleans dead tuples from the table;
`VACUUM` followed by the index cleanup phase reclaims index space. In high-churn tables
(frequent deletes/updates), autovacuum may not keep up. Monitor with:

```sql
SELECT relname, n_dead_tup, n_live_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('events', 'jobs', 'memory_entries')
ORDER BY dead_pct DESC NULLS LAST;
```

Alert when `dead_pct > 10%` for high-traffic tables.

### Index-Only Scans

If all columns needed by a query are in the index, PostgreSQL can answer the query
without touching the table pages (index-only scan). Design covering indexes for
your hottest queries:

```sql
-- Query: SELECT id, status FROM jobs WHERE user_id = $1
-- Covering index: includes status so no table fetch is needed
CREATE INDEX jobs_user_id_covering_idx
  ON jobs (user_id) INCLUDE (status);
```

The `INCLUDE` clause adds non-searchable columns to the leaf pages of the index.

---

## Part 4: Query Pattern Alignment

Schema design and query design must be done together. A common failure mode: schema
is designed in isolation, then queries are written against it, and performance problems
appear because the schema does not support the query access pattern.

### Write Queries First

Before finalizing the schema, write the 10 most important queries the application will
run. For each:
1. Identify the table scan, filter, join, sort, and limit operations.
2. Verify the schema has the indexes to support them.
3. Run `EXPLAIN` to confirm the planner uses the right index.

### Pagination Patterns

**Offset pagination (simple, degrades at scale):**

```sql
SELECT id, title, created_at
FROM posts
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 200;
```

OFFSET 200 requires the database to scan and discard 200 rows. At page 1000 (offset
20000), this is expensive.

**Keyset pagination (efficient, production-grade):**

```sql
-- First page
SELECT id, title, created_at
FROM posts
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- Next page (using last row's values as cursor)
SELECT id, title, created_at
FROM posts
WHERE (created_at, id) < ($last_created_at, $last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Keyset pagination is O(1) regardless of page depth and is the correct approach for
production APIs with large result sets.

### Avoiding N+1 Queries

The N+1 pattern: fetch N parent rows, then issue one query per parent to fetch related
rows. Replace with a single JOIN or `WHERE id = ANY(array_of_ids)`:

```sql
-- Anti-pattern (N+1 in application code):
for (const post of posts) {
  const tags = await pool.query('SELECT tag FROM post_tags WHERE post_id = $1', [post.id]);
  post.tags = tags.rows.map(r => r.tag);
}

-- Correct (single query):
const ids = posts.map(p => p.id);
const { rows } = await pool.query(
  'SELECT post_id, tag FROM post_tags WHERE post_id = ANY($1::bigint[])',
  [ids]
);
const tagsByPost = groupBy(rows, r => r.post_id);
for (const post of posts) post.tags = (tagsByPost[post.id] || []).map(r => r.tag);
```

---

## Part 5: Migration Discipline

### Versioned Migrations

Every schema change is a numbered, append-only migration file. Never modify an existing
migration. Tools: Flyway, Liquibase, or a simple convention-based runner.

```
migrations/
  001_create_users.sql
  002_create_posts.sql
  003_add_posts_search_vector.sql
  004_add_post_tags.sql
```

The migration runner tracks which migrations have been applied in a `schema_migrations`
table and applies only the unapproved ones.

### Safe Migration Checklist

Before applying any migration to a production database:

1. **Estimate lock duration.** DDL that takes an `ACCESS EXCLUSIVE` lock will block all
   reads and writes for its duration. For large tables, run `\timing` on a production-size
   replica first.

2. **Use `IF NOT EXISTS` and `IF EXISTS`.** Makes migrations idempotent:
   `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`,
   `DROP INDEX IF EXISTS`.

3. **Use `CREATE INDEX CONCURRENTLY`.** For new indexes on live tables.
   Cannot run inside a transaction. If your migration runner wraps statements in a
   transaction, CIC must be in a separate migration.

4. **Backfill in batches.** Never `UPDATE table SET col = X` without a WHERE clause
   or explicit batch processing. On a 50M-row table, this locks and holds for minutes.

5. **Test rollback.** Write a down-migration for every up-migration. Test it on staging.
   Even if you never run it, writing it forces you to think about reversibility.

6. **Apply during low-traffic windows.** Even with `CONCURRENTLY`, long-running DDL
   increases replication lag and holds WAL. Schedule around traffic troughs.

### Rollback Strategy

The expand-contract pattern enables zero-downtime rollback:

- **Phase 1 (Expand):** Add the new structure. Both old and new application code work.
- **Phase 2 (Migrate):** Application writes to both old and new structure.
- **Phase 3 (Cut over):** Application reads only from new structure.
- **Phase 4 (Contract):** Remove old structure after confirming new path is stable.

If a bug is found after Phase 3, rolling back means reverting the application to Phase 2
(dual-write) without any DDL change. The schema supports both code versions simultaneously.

---

## Part 6: Operational Concerns

### Connection Management

Set `statement_timeout` and `lock_timeout` in your application's session setup:

```sql
SET statement_timeout = '30s';   -- abort queries running > 30s
SET lock_timeout      = '5s';    -- abort if waiting for a lock > 5s
```

`lock_timeout` is especially important during migrations. Without it, a long-running
query that holds a lock can block a migration indefinitely, and the migration waits,
holding its own lock on the table, blocking all application queries behind it.

### Monitoring Slow Queries

Enable `pg_stat_statements`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Find top slow queries by total time
SELECT query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

Alert when `mean_exec_time` on a critical query exceeds a threshold (e.g., 500ms for
a p99 query used in the main request path).

### Autovacuum Tuning

For high-churn tables, the default autovacuum thresholds may be too conservative:

```sql
-- Per-table autovacuum tuning for a high-update table
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor    = 0.01,  -- trigger after 1% dead tuples (default 20%)
  autovacuum_analyze_scale_factor   = 0.005, -- trigger analyze after 0.5% new rows
  autovacuum_vacuum_cost_delay      = 2      -- reduce vacuum throttle for this table (ms)
);
```

Monitor `pg_stat_user_tables.n_dead_tup` and alert when it consistently exceeds 10%
of live tuples.
