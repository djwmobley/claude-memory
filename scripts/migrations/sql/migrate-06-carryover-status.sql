-- migrate-06-carryover-status.sql
--
-- Schema-setup-only (no data migration).
--
-- NULL = not a carry-over row (default for all non-open_thread predicates);
-- 'open'/'resolved' only meaningful when predicate = 'open_thread'. A
-- 'resolved' row is superseded (invalid_at set) rather than deleted, same
-- non-destructive pattern as the rest of the assertions lifecycle.

ALTER TABLE assertions ADD COLUMN IF NOT EXISTS carryover_status TEXT
  CHECK (carryover_status IN ('open','resolved')) ;
