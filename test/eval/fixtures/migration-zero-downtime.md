---
name: migration-zero-downtime
description: Zero-downtime ALTER TABLE patterns, online index builds, and lock minimization strategies
type: reference
---

# Zero-Downtime Database Migrations

Schema changes on live PostgreSQL databases require careful sequencing to avoid table-level
locks that block reads and writes. Most destructive DDL takes an `ACCESS EXCLUSIVE` lock
that blocks all concurrent access until the statement completes.

## Why Locks Matter

PostgreSQL's lock hierarchy:
- `SELECT` takes a `ACCESS SHARE` lock -- compatible with almost everything
- `INSERT/UPDATE/DELETE` takes a `ROW EXCLUSIVE` lock -- compatible with reads
- `ALTER TABLE ADD COLUMN DEFAULT NULL` takes `ACCESS EXCLUSIVE` -- blocks reads AND writes
- `CREATE INDEX` takes `SHARE` lock -- blocks writes, allows reads
- `CREATE INDEX CONCURRENTLY` takes weaker locks -- allows both reads and writes

A migration that runs for 30 seconds on a table receiving 1000 writes/sec is a 30-second
outage. For tables with heavy traffic, even a 1-second lock can cause a cascading
queue of blocked requests.

## Adding a Column

```sql
-- Safe: NULL default, no lock escalation in Postgres 11+
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Also safe in Postgres 11+ with a non-volatile default
-- (stores the default in catalog, not in existing rows)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
```

In PostgreSQL 11+, adding a column with a non-volatile default (`NULL`, a literal, or
`NOW()` for the statement time -- NOT `clock_timestamp()`) is instant. The server stores
the default in the catalog and applies it on read for existing rows, without rewriting
the table.

Before PostgreSQL 11, adding a column with any default rewrote the entire table.
If you must support older versions, add the column with `DEFAULT NULL`, then backfill,
then add the `NOT NULL` constraint.

## Building Indexes Concurrently

```sql
-- Blocks writes during build (NOT safe for live tables):
CREATE INDEX documents_type_idx ON documents (type);

-- Non-blocking (safe for live tables):
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_type_idx ON documents (type);
```

`CREATE INDEX CONCURRENTLY` (CIC) scans the table twice and handles concurrent writes
between scans. It takes significantly longer to complete (2-5x) but does not block
reads or writes during construction.

Caveats:
- CIC cannot run inside a transaction block. If it fails mid-way, it leaves an `INVALID`
  index that must be dropped manually: `DROP INDEX CONCURRENTLY IF EXISTS`.
- `IF NOT EXISTS` is only available in PostgreSQL 9.5+. Without it, CIC raises an error
  if the index already exists, which your migration runner may interpret as a failure.

Example cleanup for a broken CIC:

```sql
-- Check for invalid indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'documents'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = pg_indexes.indexname
      AND i.indisvalid
  );

-- Drop the invalid index and retry
DROP INDEX CONCURRENTLY IF EXISTS documents_type_idx;
CREATE INDEX CONCURRENTLY documents_type_idx ON documents (type);
```

## Adding NOT NULL Constraints

The safe pattern avoids a full-table rewrite:

```sql
-- Step 1: add NOT VALID constraint (fast -- no table scan)
ALTER TABLE documents
  ADD CONSTRAINT documents_status_notnull
  CHECK (status IS NOT NULL)
  NOT VALID;

-- Step 2: validate the constraint in the background (does not block writes)
ALTER TABLE documents VALIDATE CONSTRAINT documents_status_notnull;
```

`NOT VALID` marks the constraint as applying only to new rows. `VALIDATE CONSTRAINT`
performs a sequential scan to check existing rows, taking only a `SHARE UPDATE EXCLUSIVE`
lock (compatible with writes).

## Backfilling Data Safely

When backfilling a new column on a large table, process in batches:

```sql
DO $$
DECLARE
  batch_size INT := 10000;
  last_id    BIGINT := 0;
  max_id     BIGINT;
  updated    INT;
BEGIN
  SELECT MAX(id) INTO max_id FROM documents;

  LOOP
    EXIT WHEN last_id >= max_id;

    UPDATE documents
    SET status = 'active'
    WHERE id > last_id
      AND id <= last_id + batch_size
      AND status IS NULL;

    GET DIAGNOSTICS updated = ROW_COUNT;
    last_id := last_id + batch_size;

    RAISE NOTICE 'Backfilled through id=%, updated=% rows', last_id, updated;
    PERFORM pg_sleep(0.05);  -- brief pause to let autovacuum catch up
  END LOOP;
END $$;
```

Batch size of 5,000-50,000 rows keeps each transaction short, reducing lock contention
and autovacuum lag. The `pg_sleep` pause prevents the migration from starving vacuuming
during long backfills.

## Drop Column

```sql
-- Mark logically deleted first (zero downtime)
ALTER TABLE documents RENAME COLUMN old_col TO _deprecated_old_col;

-- Deploy the application code that no longer references old_col, then:
ALTER TABLE documents DROP COLUMN IF EXISTS _deprecated_old_col;
```

The rename makes the column invisible to code using the old name, without yet reclaiming
space. The physical DROP can follow in a later deployment window.

## Expand-Contract Pattern (Multi-Phase Migration)

For changes that require both schema and application changes:

1. **Expand:** Add the new column/table (backward-compatible). Deploy.
2. **Migrate:** Backfill the new column from the old column. Deploy.
3. **Contract:** Remove the old column once all application paths use the new column. Deploy.

Each phase is a separate deployment. The application stays live throughout.
