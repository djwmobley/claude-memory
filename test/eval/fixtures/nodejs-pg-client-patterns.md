---
name: nodejs-pg-client-patterns
description: Node.js pg library patterns -- pg.Client, connection pooling, parameterized queries, transaction handling
type: reference
---

# Node.js pg Client Patterns

The `pg` library (node-postgres) is the standard PostgreSQL client for Node.js. This entry
covers the practical patterns for single clients, connection pools, parameterized queries,
and transactions.

## Installation

```bash
npm install pg
# or
pnpm add pg
```

## Single Client (short-lived scripts)

```js
const { Client } = require('pg');

async function run() {
  const client = new Client({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'mydb',
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || '',
  });

  await client.connect();
  try {
    const res = await client.query('SELECT NOW() AS ts');
    console.log(res.rows[0].ts);
  } finally {
    await client.end();
  }
}

run().catch(console.error);
```

Always call `client.end()` in a `finally` block. A leaked client holds a server-side
connection open indefinitely.

## Connection Pool (long-lived servers)

```js
const { Pool } = require('pg');

const pool = new Pool({
  host:            process.env.PGHOST     || 'localhost',
  port:            parseInt(process.env.PGPORT || '5432'),
  database:        process.env.PGDATABASE || 'mydb',
  user:            process.env.PGUSER     || 'postgres',
  password:        process.env.PGPASSWORD || '',
  max:             10,    // maximum connections in pool
  idleTimeoutMillis:  30000,  // release idle connection after 30s
  connectionTimeoutMillis: 5000, // error if can't acquire within 5s
});

// Simple query -- pool acquires + releases automatically
const res = await pool.query('SELECT id, name FROM users WHERE active = $1', [true]);
console.log(res.rows);
```

`pool.query()` is the convenient shorthand. It acquires a client from the pool,
runs the query, and releases the client automatically. Use it for single-statement
operations.

## Parameterized Queries

Always use `$1`, `$2`, ... placeholders, never string interpolation.

```js
// Safe -- parameterized
const result = await pool.query(
  'SELECT * FROM documents WHERE type = $1 AND created_at > $2',
  ['reference', new Date('2024-01-01')]
);

// NEVER do this -- SQL injection risk
const unsafe = await pool.query(
  `SELECT * FROM documents WHERE type = '${userInput}'`  // dangerous
);
```

Parameters can be strings, numbers, Dates, Buffers, arrays, and JSON objects.
PostgreSQL coerces the type at execution time based on the column definition.

## Named vs Positional Results

```js
const res = await pool.query('SELECT id, name, created_at FROM users LIMIT 5');

// Access by column name (recommended)
for (const row of res.rows) {
  console.log(row.id, row.name, row.created_at);
}

// Access by index (fragile -- breaks when column order changes)
console.log(res.rows[0][0]);  // avoid
```

## Transactions

For multi-statement transactions, acquire a client explicitly so all statements share
the same connection:

```js
const client = await pool.connect();
try {
  await client.query('BEGIN');

  const insert = await client.query(
    'INSERT INTO events (type, payload) VALUES ($1, $2) RETURNING id',
    ['user.signup', JSON.stringify({ email: 'test@example.com' })]
  );

  await client.query(
    'UPDATE accounts SET event_count = event_count + 1 WHERE user_id = $1',
    [insert.rows[0].id]
  );

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

`client.release()` returns the connection to the pool. Call it in `finally` so it
is released even if ROLLBACK throws.

## Handling Connection Errors

```js
pool.on('error', (err, client) => {
  console.error('Unexpected pool error:', err.message);
  // The pool will replace the broken connection automatically.
  // This handler prevents unhandled rejection on background keepalive queries.
});
```

Without this handler, background connection errors (e.g., server restart) appear as
unhandled Promise rejections.

## INSERT ON CONFLICT (Upsert)

```js
await pool.query(`
  INSERT INTO memory_entries (name, body, content_hash)
  VALUES ($1, $2, $3)
  ON CONFLICT (content_hash) DO UPDATE
    SET body = EXCLUDED.body,
        updated_at = NOW()
  RETURNING id
`, [name, body, hash]);
```

`ON CONFLICT ... DO UPDATE` is the PostgreSQL upsert pattern. `EXCLUDED.column`
refers to the value that would have been inserted.

## Bulk Insert with unnest

For high-throughput batch inserts, `unnest` is faster than multi-row VALUES or
repeated single-row inserts:

```js
const names  = rows.map(r => r.name);
const bodies = rows.map(r => r.body);
const hashes = rows.map(r => r.hash);

await pool.query(`
  INSERT INTO memory_entries (name, body, content_hash)
  SELECT * FROM unnest($1::text[], $2::text[], $3::char(64)[])
  ON CONFLICT (content_hash) DO NOTHING
`, [names, bodies, hashes]);
```

Pass JavaScript arrays as parameters; pgvector accepts them as typed arrays with
explicit casts.
