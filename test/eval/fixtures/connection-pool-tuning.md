---
name: connection-pool-tuning
description: Connection pool sizing formulas, timeout configuration, idle reaper settings, with pg.Pool example
type: reference
---

# Connection Pool Tuning

A well-tuned connection pool maximizes throughput without exhausting database connections.
Too few connections starve request processing; too many overwhelm the database and degrade
performance for all clients.

## Why Pool Size Matters

Each PostgreSQL backend process consumes memory (roughly 5-10 MB per connection), CPU
context-switch overhead, and file descriptors. PostgreSQL defaults to `max_connections = 100`.
With PgBouncer or Supabase's connection pooler, effective limits are higher, but the
fundamental constraint remains.

Beyond memory, CPU contention dominates at high connection counts. PostgreSQL's process
model means each connection is a separate OS process. For a server with 8 cores, saturating
with 200 connections creates a 25:1 scheduling ratio. The optimal pool size is often
smaller than developers expect.

## The Formula

A commonly cited starting point (from PgBouncer author's recommendation):

```
pool_size = (num_cores * 2) + num_effective_spindle_disks
```

For a modern cloud instance (8 vCPUs, NVMe SSD):
```
pool_size = (8 * 2) + 1 = 17
```

Round up to 20 as a practical ceiling per application node. For N application nodes
sharing one database, total connections = N * 20. Stay well below `max_connections`.

A simpler rule of thumb: start at `10-20` per application node, measure wait times, and
increase only if you observe connection acquisition timeouts under normal load.

## pg.Pool Configuration

```js
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'mydb',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',

  // Core sizing
  max:     parseInt(process.env.PG_POOL_MAX || '10'),

  // Timeouts
  idleTimeoutMillis:       30_000,  // release idle connection after 30s
  connectionTimeoutMillis:  5_000,  // error if can't acquire within 5s

  // Keep-alive (prevents NAT/firewall from killing idle connections)
  keepAlive:               true,
  keepAliveInitialDelayMillis: 10_000,
});
```

## Timeout Configuration Explained

**`connectionTimeoutMillis`:** How long `pool.connect()` or `pool.query()` waits to
acquire a connection before throwing. Default: `0` (wait forever). Always set this to
a finite value. Without it, a pool exhaustion event causes requests to queue indefinitely.

A good default is 3-5 seconds for web request handlers. For background jobs that can
tolerate longer wait, 15-30 seconds is reasonable.

**`idleTimeoutMillis`:** How long a connection sits idle in the pool before being closed
and removed. Default: `10000` (10s). Set to 30-60 seconds for applications with burst
traffic. Setting too low causes the pool to constantly open and close connections; setting
too high holds connections open unnecessarily when traffic drops.

**`statement_timeout`:** A PostgreSQL session-level setting (not a pg.Pool setting) that
aborts any query running longer than N milliseconds:

```js
// Set per-connection on acquisition
pool.on('connect', async (client) => {
  await client.query("SET statement_timeout = '30s'");
  await client.query("SET lock_timeout = '5s'");
});
```

`lock_timeout` aborts queries waiting more than N ms for a lock -- essential for
preventing long-running migrations from blocking application queries indefinitely.

## Idle Connection Reaper

The idle reaper (`idleTimeoutMillis`) runs internally in the pg pool. You can observe
it by monitoring pool stats:

```js
setInterval(() => {
  console.log({
    total:   pool.totalCount,
    idle:    pool.idleCount,
    waiting: pool.waitingCount,
  });
}, 10_000);
```

- `totalCount`: current open connections (should be <= max)
- `idleCount`: connections not currently in use (should drop between requests)
- `waitingCount`: requests waiting for a connection (should be near 0; spikes indicate pool exhaustion)

Alert when `waitingCount` is consistently above zero for more than a few seconds.

## Connection Exhaustion: Detection and Response

Symptoms of an under-sized pool:
- `connectionTimeoutMillis` errors in application logs
- High `waitingCount` in pool stats
- Database shows fewer than max_connections connections from this application node,
  but the application is still timing out (ruled out too-small `max_connections`)

Response:
1. Increase `max` by 5-10 per application node, verify it stays below 80% of `max_connections`.
2. Profile slow queries. A pool appears undersized when queries take longer than expected
   and hold connections for longer -- the real fix is query optimization, not more connections.
3. Introduce a PgBouncer transaction-mode pooler between application and database. In
   transaction mode, a server connection is only held for the duration of one transaction,
   allowing 1000+ application connections to share 20 server connections.

## PgBouncer Settings (Reference)

```ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
pool_mode       = transaction
max_client_conn = 500
default_pool_size = 20
min_pool_size     = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

server_idle_timeout = 60
client_idle_timeout = 120
server_connect_timeout = 10
server_login_retry = 5
```

In transaction mode, SET commands and `pg_advisory_lock` do not persist across
statements. LISTEN/NOTIFY also does not work in transaction mode. Use session mode
for applications that rely on these features.
