'use strict';

/**
 * test-fake-embed-server.js — standalone fake vLLM /v1/embeddings server,
 * run as a genuinely SEPARATE OS process (never an in-process http.Server).
 *
 * WHY a separate process: several tests need a fake embed endpoint that
 * stays REACHABLE while a synchronous `execFileSync`/`spawnSync` CLI
 * subprocess is running (e.g. `handoff.js init` performing the
 * init-embeddability amendment A1 preflight probe). Node's synchronous
 * child_process functions block the CALLING process's entire event loop
 * until the child exits — an in-process `http.Server` in that same process
 * cannot accept/answer a request during that window (verified empirically:
 * a same-process fake server deadlocks until the sync spawn's own timeout
 * fires). Running the fake server as its own OS process sidesteps this
 * entirely — it has its own independent event loop, unaffected by the
 * parent test process being blocked on a sync spawn.
 *
 * Usage: node scripts/lib/test-fake-embed-server.js <port> <nativeDims> [fillValue]
 *   Prints exactly one line "LISTENING <port>" to stdout once bound —
 *   callers must wait for this line before treating the server as ready.
 *   Runs until killed (SIGTERM/SIGKILL) — callers own its lifecycle.
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
const nativeDims = parseInt(process.argv[3], 10);
const fillValue = process.argv[4] !== undefined ? parseFloat(process.argv[4]) : 0.1;

if (!Number.isInteger(port) || !Number.isInteger(nativeDims)) {
  process.stderr.write('Usage: node test-fake-embed-server.js <port> <nativeDims> [fillValue]\n');
  process.exit(2);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: new Array(nativeDims).fill(fillValue) }] }));
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // A fixed port (e.g. 8800, the conventional local-vLLM port some
    // operator environments run a REAL embedding server on per standing
    // "always start vLLM" configuration) is already bound — something is
    // already listening there and will presumably answer the probe (a real
    // local vLLM on that exact port is, by construction, at least as good a
    // stub as this fake one). Report it as ready rather than failing the
    // whole test run over a port collision that isn't actually a problem.
    console.log(`ALREADY_LISTENING ${port}`);
    return;
  }
  console.error(`fake embed server error: ${err.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
