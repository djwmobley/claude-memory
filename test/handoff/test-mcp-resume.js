'use strict';

/**
 * test-mcp-resume.js — Focused tests for the `handoff_resume` MCP tool
 * (scripts/handoff-mcp.mjs), added because the auto-loader's SessionStart
 * hook and the CLI `resume` subcommand were previously the only way to
 * force-load prior-session context; the MCP server had no equivalent tool
 * (see commands/handoff/resume.md's now-removed "Preferred path — MCP" gap
 * note).
 *
 * Required check (no Postgres needed — tool registration is pure metadata,
 * `buildServer()` opens no DB connection):
 *   1. Spawn the real handoff-mcp.mjs over stdio, call tools/list, assert
 *      `handoff_resume` is present with `projectRoot` as its one required
 *      input property.
 *
 * Optional check (only runs if Postgres is reachable on localhost:5432 and
 * the DentalTalentConnect checkout — a real project with a `.memory-engine`
 * marker and an existing `pipeline_dentaltalentconnect` database — is
 * present on this machine; skipped, not failed, otherwise):
 *   2. A live `tools/call` for `handoff_resume` against that project root,
 *      asserting the returned `context` string contains
 *      "=== Retrieved context".
 *
 * Usage:
 *   node test/handoff/test-mcp-resume.js
 *
 * Exit codes: 0 all-pass (including a skipped optional check), 1 any
 * required-check failure, 2 infrastructure error (e.g. MCP SDK missing).
 */

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Live-call fixture: a real project checkout with its own `.memory-engine`
// marker and Postgres database, external to this repo. Not present on every
// machine that runs this test suite — the optional check below skips
// cleanly (not a failure) when it is absent.
const DENTAL_TALENT_CONNECT_ROOT = 'c:\\Users\\djwmo\\OneDrive - Advisicon\\dev\\DentalTalentConnect';

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    if (err && err.__skip__) {
      console.log(`SKIP  ${label} (${err.message})`);
      skipped++;
      return;
    }
    console.error(`FAIL  ${label}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function skip(reason) {
  const err = new Error(reason);
  err.__skip__ = true;
  throw err;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** Spawns the real handoff-mcp.mjs over stdio and connects an SDK client.
 * Caller is responsible for calling `client.close()`. */
async function connectMcpClient(extraEnv) {
  // Matches scripts/migrations/verify-20-mcp-surface.js's own SDK-resolution
  // convention (explicit node_modules path, not a package-relative require) —
  // the SDK's package.json exports map does not resolve cleanly through a
  // createRequire(scripts/package.json) subpath require.
  const { Client: SdkClient } = require(path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js'));
  const { StdioClientTransport } = require(path.join(PROJECT_ROOT, 'scripts', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'stdio.js'));

  const serverPath = path.join(PROJECT_ROOT, 'scripts', 'handoff-mcp.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, ...(extraEnv || {}) },
  });
  const client = new SdkClient({ name: 'test-mcp-resume', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/** True if a TCP connection to localhost:5432 succeeds within `timeoutMs`. */
function isPostgresReachable(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ host: '127.0.0.1', port: 5432 });
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function runTests() {
  // ── Required: tool registration ──────────────────────────────────────────
  await test('handoff-mcp.mjs registers handoff_resume with projectRoot as its one required property', async () => {
    const client = await connectMcpClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'handoff_resume');
      assert(tool, 'handoff_resume is registered in tools/list');
      assert(tool.inputSchema && tool.inputSchema.type === 'object', 'inputSchema is an object schema');
      assert(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties || {}, 'projectRoot'),
        'inputSchema.properties has a projectRoot key'
      );
      assertEq(tool.inputSchema.properties.projectRoot.type, 'string', 'projectRoot is typed string');
      assert(Array.isArray(tool.inputSchema.required), 'inputSchema.required is an array');
      assert(tool.inputSchema.required.includes('projectRoot'), 'projectRoot is required');
      assertEq(tool.inputSchema.required.length, 1, 'projectRoot is the ONLY required property');
    } finally {
      await client.close();
    }
  });

  await test('handoff-mcp.mjs tool count includes handoff_resume (31 total: 5 original + handoff_resume + 25 direct-pg)', async () => {
    const client = await connectMcpClient();
    try {
      const { tools } = await client.listTools();
      assertEq(tools.length, 31, 'tool count');
    } finally {
      await client.close();
    }
  });

  // ── Optional: live call against a real project (Postgres required) ──────
  await test('handoff_resume live call against DentalTalentConnect returns a Retrieved-context block', async () => {
    const fs = require('fs');
    if (!fs.existsSync(path.join(DENTAL_TALENT_CONNECT_ROOT, '.memory-engine'))) {
      skip('DentalTalentConnect checkout (or its .memory-engine marker) not present on this machine');
    }
    if (!(await isPostgresReachable())) {
      skip('Postgres not reachable on localhost:5432');
    }

    const client = await connectMcpClient();
    try {
      const result = await client.callTool({
        name: 'handoff_resume',
        arguments: { projectRoot: DENTAL_TALENT_CONNECT_ROOT },
      });
      assert(!result.isError, `handoff_resume call errored: ${result.isError ? result.content[0].text : ''}`);
      const parsed = JSON.parse(result.content[0].text);
      assert(typeof parsed.context === 'string', 'context is a string');
      assert(
        parsed.context.includes('=== Retrieved context'),
        'context includes a "=== Retrieved context" section'
      );
    } finally {
      await client.close();
    }
  });
}

runTests().then(() => {
  console.log('');
  if (failed > 0) {
    console.error(`${passed} passed, ${skipped} skipped, ${failed} FAILED.`);
    process.exit(1);
  } else {
    console.log(`${passed} passed, ${skipped} skipped. All required checks passed.`);
    process.exit(0);
  }
}).catch((err) => {
  console.error(`\nUnhandled error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(2);
});
