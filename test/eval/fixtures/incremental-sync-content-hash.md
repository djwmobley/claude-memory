---
name: incremental-sync-content-hash
description: Content-hash based incremental sync -- diff detection, INSERT ON CONFLICT patterns, and rebuild thresholds
type: reference
---

# Incremental Sync via Content Hash

For embedding pipelines and knowledge-base ingestion, re-embedding the entire corpus on
every run is expensive. Incremental sync uses a content hash to detect which documents
have changed and only re-processes those.

## The Core Pattern

Each document gets a `content_hash` -- a deterministic fingerprint of the content that
is being embedded. On each sync run:

1. Compute hashes for all source documents.
2. Compare against hashes stored in the database.
3. Insert new documents, update changed documents, delete removed documents (optional).
4. Re-embed only the inserted or updated documents.

## Computing Content Hash

```js
const crypto = require('crypto');

function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// For a document with multiple fields, hash the normalized concatenation
function documentHash(doc) {
  const normalized = [doc.name, doc.description, doc.body]
    .map(s => (s || '').trim())
    .join('\x00');  // null byte separator -- can't appear in text
  return contentHash(normalized);
}
```

Use SHA-256 (64 hex chars). MD5 is faster but has theoretical collision vulnerabilities;
SHA-256 is the safe default.

Include all fields that affect the embedding in the hash. If you only hash `body` but the
`name` field also goes into the tsvector, a name change will not trigger re-embedding.

## INSERT ON CONFLICT -- Upsert Pattern

```sql
INSERT INTO memory_entries (name, description, type, body, content_hash, embedding)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (content_hash) DO NOTHING;
```

`DO NOTHING` skips re-inserting unchanged documents. Use this when you never update
existing content -- new content always gets a new hash.

For updatable content (document body can change while keeping the same identifier):

```sql
INSERT INTO memory_entries (source_id, name, body, content_hash, embedding, updated_at)
VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (source_id) DO UPDATE
  SET name         = EXCLUDED.name,
      body         = EXCLUDED.body,
      content_hash = EXCLUDED.content_hash,
      embedding    = EXCLUDED.embedding,
      updated_at   = NOW()
  WHERE memory_entries.content_hash <> EXCLUDED.content_hash;
```

The `WHERE` clause on the DO UPDATE prevents a write if the content hash is the same --
the conflict happened because the `source_id` exists, but the content is unchanged.
Without this guard, every sync run touches every row even when nothing changed,
which can interfere with `updated_at` tracking and autovacuum.

## Detecting Deletions

For soft delete:

```js
async function syncDeletions(pool, currentSourceIds) {
  const idSet = currentSourceIds.map((_, i) => `$${i + 1}`).join(', ');

  await pool.query(
    `UPDATE memory_entries
     SET deleted_at = NOW()
     WHERE source_id NOT IN (${idSet})
       AND deleted_at IS NULL`,
    currentSourceIds
  );
}
```

For hard delete (use with caution -- permanent):

```sql
DELETE FROM memory_entries
WHERE source_id = ANY($1::text[])
  AND content_hash NOT IN (SELECT content_hash FROM staging_docs);
```

## Full Node.js Sync Loop

```js
async function incrementalSync(pool, sourceDocs) {
  // Step 1: load existing hashes
  const { rows } = await pool.query(
    'SELECT source_id, content_hash FROM memory_entries WHERE deleted_at IS NULL'
  );
  const existingHashes = new Map(rows.map(r => [r.source_id, r.content_hash]));

  // Step 2: partition into new, changed, unchanged
  const toProcess = [];
  for (const doc of sourceDocs) {
    const hash = documentHash(doc);
    const existing = existingHashes.get(doc.id);
    if (existing !== hash) {
      toProcess.push({ ...doc, content_hash: hash });
    }
    existingHashes.delete(doc.id);  // remaining keys are deletions
  }

  console.log(`Sync: ${toProcess.length} new/changed, ${existingHashes.size} deleted`);

  // Step 3: embed changed documents
  if (toProcess.length > 0) {
    const embeddings = await embedBatch(toProcess.map(d => d.body));
    for (let i = 0; i < toProcess.length; i++) {
      toProcess[i].embedding = embeddings[i];
    }
  }

  // Step 4: upsert
  for (const doc of toProcess) {
    await pool.query(
      `INSERT INTO memory_entries (source_id, name, body, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_id) DO UPDATE
         SET name=EXCLUDED.name, body=EXCLUDED.body,
             content_hash=EXCLUDED.content_hash, embedding=EXCLUDED.embedding,
             updated_at=NOW()
         WHERE memory_entries.content_hash <> EXCLUDED.content_hash`,
      [doc.id, doc.name, doc.body, doc.content_hash, `[${doc.embedding.join(',')}]`]
    );
  }

  // Step 5: soft-delete removed documents
  for (const deletedId of existingHashes.keys()) {
    await pool.query(
      'UPDATE memory_entries SET deleted_at = NOW() WHERE source_id = $1',
      [deletedId]
    );
  }
}
```

## Rebuild Threshold

If too many documents have changed (suggesting a corpus migration, model change, or
bulk edit rather than incremental drift), a full rebuild is faster than individual upserts:

```js
const REBUILD_THRESHOLD = 0.5;  // 50% changed = full rebuild

const changeRatio = toProcess.length / sourceDocs.length;
if (changeRatio > REBUILD_THRESHOLD) {
  console.log(`Change ratio ${changeRatio.toFixed(2)} exceeds threshold -- running full rebuild`);
  await fullRebuild(pool, sourceDocs);
  return;
}
```

Full rebuild: truncate the table (or insert into a new table and rename), then run the
complete ingest pipeline. Full rebuild avoids the overhead of per-row conflict resolution
on a nearly-complete changeset.
