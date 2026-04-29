---
name: bash-postgres-backup-script
description: pg_dump invocations, retention policy enforcement, and restoration commands for PostgreSQL backups
type: reference
---

# Bash PostgreSQL Backup Script

Practical shell patterns for PostgreSQL backup, rotation, and restoration. Uses `pg_dump`
(logical) and `pg_basebackup` (physical) depending on the use case.

## Logical Backup with pg_dump

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/postgres"
DB_NAME="${PGDATABASE:-mydb}"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

pg_dump \
  --host="${PGHOST:-localhost}" \
  --port="${PGPORT:-5432}" \
  --username="${PGUSER:-postgres}" \
  --no-password \
  --format=plain \
  --no-acl \
  --no-owner \
  "${DB_NAME}" \
| gzip -9 > "${BACKUP_FILE}"

echo "Backup written to: ${BACKUP_FILE}"
echo "Size: $(du -sh "${BACKUP_FILE}" | cut -f1)"
```

Use `--format=custom` instead of `--format=plain` for large databases. The custom
format is compressed, parallel-restoreable with `pg_restore -j N`, and supports
selective table restore. The tradeoff is that custom-format dumps are binary and
cannot be inspected with a text editor.

## Custom Format (Recommended for Large Databases)

```bash
pg_dump \
  --format=custom \
  --compress=9 \
  --jobs=4 \
  --no-acl \
  --no-owner \
  --file="${BACKUP_FILE%.sql.gz}.dump" \
  "${DB_NAME}"
```

`--jobs=4` parallelizes the dump across 4 threads. Requires `--format=directory` (not
`--format=custom`). Adjust job count to CPU cores available.

## Schema-Only Backup

```bash
pg_dump \
  --schema-only \
  --no-acl \
  --no-owner \
  "${DB_NAME}" > "${BACKUP_DIR}/${DB_NAME}_schema_${TIMESTAMP}.sql"
```

Useful for capturing the DDL state without data. Run after migrations to checkpoint
the schema separately from the data backup.

## Retention Policy (7-day rolling window)

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/postgres"
RETENTION_DAYS=7

# Delete backups older than RETENTION_DAYS
find "${BACKUP_DIR}" \
  -name "*.sql.gz" -o -name "*.dump" \
  | while read -r f; do
      age_days=$(( ( $(date +%s) - $(stat -c%Y "${f}") ) / 86400 ))
      if [[ ${age_days} -gt ${RETENTION_DAYS} ]]; then
        echo "Removing old backup: ${f} (${age_days} days old)"
        rm -f "${f}"
      fi
    done
```

Alternatively, using `find -mtime`:

```bash
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete
find "${BACKUP_DIR}" -name "*.dump"   -mtime +${RETENTION_DAYS} -delete
```

`-mtime +7` matches files with modification time more than 7 days ago.

## Backup Verification

After writing a backup, verify it is non-empty and structurally valid:

```bash
# Check file size > 0
if [[ ! -s "${BACKUP_FILE}" ]]; then
  echo "ERROR: backup file is empty" >&2
  exit 1
fi

# Verify the gzip archive is intact
if ! gzip --test "${BACKUP_FILE}"; then
  echo "ERROR: backup file is corrupt" >&2
  exit 1
fi

echo "Backup verified OK"
```

For custom-format dumps, use `pg_restore --list` to verify without restoring:

```bash
pg_restore --list "${BACKUP_FILE%.sql.gz}.dump" > /dev/null \
  && echo "Backup OK" \
  || echo "Backup CORRUPT"
```

## Restoration from Plain SQL Backup

```bash
# Restore to an existing (empty) database
psql \
  --host="${PGHOST:-localhost}" \
  --username="${PGUSER:-postgres}" \
  --dbname="${TARGET_DB}" \
  < <(gzip -d < "${BACKUP_FILE}")
```

## Restoration from Custom Format

```bash
pg_restore \
  --host="${PGHOST:-localhost}" \
  --username="${PGUSER:-postgres}" \
  --dbname="${TARGET_DB}" \
  --jobs=4 \
  --no-acl \
  --no-owner \
  --verbose \
  "${BACKUP_FILE%.sql.gz}.dump"
```

`--jobs=4` parallelizes table restoration. Requires the target database to already
exist and be empty. Create it first with `createdb "${TARGET_DB}"`.

## Cron Schedule

Add to crontab (`crontab -e`) for nightly backups at 2 AM:

```cron
0 2 * * * /usr/local/bin/backup-postgres.sh >> /var/log/postgres-backup.log 2>&1
```

Redirect both stdout and stderr to a log file. Include a monitoring check (e.g.,
healthchecks.io ping) at the end of the script to alert on missed executions.
