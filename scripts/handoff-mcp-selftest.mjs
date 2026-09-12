#!/usr/bin/env node
// handoff-mcp-selftest — spawns scripts/handoff-mcp.mjs over stdio and drives
// initialize -> tools/list -> tools/call handoff_status -> tools/call
// persist_decisions (with a throwaway row, then a cleanup instruction printed
// for the operator to run against Postgres directly — this script does not
// delete rows itself; see the ticket for the DELETE + reindex step run
// separately after this passes).
//
// How to run:
//   HANDOFF_SELFTEST_PROJECT_ROOT=/absolute/path/to/some/project node scripts/handoff-mcp-selftest.mjs
// (PowerShell: $env:HANDOFF_SELFTEST_PROJECT_ROOT = 'C:\path\to\project'; node scripts/handoff-mcp-selftest.mjs)
//
// The path must be a real, writable project directory this process can read
// and write to — ensureProjectIdentity() (scripts/lib/project-identity.js)
// will mint a project marker file under it on first run if one is not
// already present. Point this at a disposable scratch project, never at a
// shared or production checkout, since persist_decisions below performs a
// real write (plus embed) against whatever Postgres database that project
// resolves to (HANDOFF_DB env var, else .claude/pipeline.yml under the
// root, else the 'claude_memory_eval_test' built-in default — see
// resolveTargetDbForRoot() in scripts/lib/mcp-db-connect.js). Postgres must
// be reachable for the persist_decisions and handoff_status calls to
// succeed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// fix/mcp-usage-codex-identity: reuse the SAME throwaway-DB/project-bootstrap
// helpers test-l0/l2/l3/l4/resurrect/operator-pin already share — never a
// second hand-rolled createDb/dropDb/setupProject here.
const pgHelpers = require('./lib/test-pg-helpers.js');

// SERVER_PATH is always the sibling handoff-mcp.mjs in this same repo checkout
// — never a hardcoded absolute path — so this selftest runs unmodified from
// any clone location.
const SERVER_PATH = path.join(__dirname, 'handoff-mcp.mjs');

// PROJECT_ROOT has no default. Total classification: either the env var is a
// non-empty string (used as-is), or it is unset/empty, in which case ONLY
// this file's project-dependent section (main(), below — handoff_status +
// persist_decisions against a real project) is skipped with a printed note.
// fix/mcp-usage-codex-identity added runUsageTelemetryChecks() below, which
// is fully self-contained (its own throwaway DB + project dir via
// test-pg-helpers.js) and always runs regardless of this env var — it never
// needed a real project's checkout in the first place.
const PROJECT_ROOT = process.env.HANDOFF_SELFTEST_PROJECT_ROOT;

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
  });

  const client = new Client({ name: 'handoff-mcp-selftest', version: '0.1.0' }, { capabilities: {} });

  console.log('== initialize ==');
  await client.connect(transport);
  console.log('connected OK');

  console.log('\n== tools/list ==');
  const toolsList = await client.listTools();
  for (const t of toolsList.tools) {
    console.log(`- ${t.name}: ${t.description.slice(0, 80)}...`);
  }
  // cm#167: this list was stale (only the original 5 tools) — fixed 2026-09-06
  // (§17 B1) to the FULL current roster, kept in sync with
  // scripts/migrations/verify-20-mcp-surface.js's own `expected` array (the
  // authoritative source — see that file's runMcpRegistrationCheck).
  const expectedNames = [
    'handoff_status', 'handoff_checkpoint', 'handoff_close', 'handoff_init', 'persist_decisions',
    'handoff_resume',
    'memory_search', 'memory_upsert', 'memory_get', 'memory_lint',
    'memory_view_set', 'memory_view_run',
    'entity_create', 'entity_read', 'entity_update', 'entity_suppress',
    'assertion_create', 'assertion_read', 'assertion_update', 'assertion_suppress',
    'edge_create', 'edge_read', 'edge_update', 'edge_suppress',
    'exchange_append', 'exchange_read',
    'route_resolve', 'routing_profile_set', 'routing_profile_get',
    'model_registry_set', 'routing_session_override_set', 'routing_session_override_get', 'routing_session_override_clear',
    'usage_record', 'usage_query',
  ];
  const actualNames = toolsList.tools.map((t) => t.name).sort();
  const missing = expectedNames.filter((n) => !actualNames.includes(n));
  const extra = actualNames.filter((n) => !expectedNames.includes(n));
  console.log(`expected tool set match: ${missing.length === 0 && extra.length === 0 ? 'PASS' : 'FAIL'} (missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)})`);

  console.log('\n== tools/call handoff_status ==');
  const statusResult = await client.callTool({
    name: 'handoff_status',
    arguments: { projectRoot: PROJECT_ROOT },
  });
  console.log('isError:', statusResult.isError ?? false);
  console.log(statusResult.content[0].text);

  console.log('\n== tools/call persist_decisions (selftest row) ==');
  const persistResult = await client.callTool({
    name: 'persist_decisions',
    arguments: {
      rows: [
        {
          topic: 'handoff-mcp-selftest-fixture',
          decision: 'handoff-mcp self-test round-trip row — safe to delete after verification.',
          reason: 'Verifies persist_decisions upsert + embed + hybrid-verify round-trip end to end before shipping the PR.',
          session_num: null,
        },
      ],
      verifyQuery: 'handoff mcp selftest',
    },
  });
  console.log('isError:', persistResult.isError ?? false);
  console.log(persistResult.content[0].text);

  console.log('\n== tools/call persist_decisions (validation-rejection case) ==');
  const badResult = await client.callTool({
    name: 'persist_decisions',
    arguments: {
      rows: [{ topic: 'NotKebabCase', decision: '', reason: 'x' }],
      verifyQuery: 'should not run',
    },
  });
  console.log('isError (expect true):', badResult.isError ?? false);
  console.log(badResult.content[0].text);

  await client.close();
  console.log('\n== selftest complete ==');
}

// ── fix/mcp-usage-codex-identity: usage_record/usage_query MCP checks ───────
//
// Fully self-contained: creates its own throwaway Postgres DB(s) + project
// dir(s) via test-pg-helpers.js (the SAME shared harness test-l0/l2/l3/l4/
// resurrect/operator-pin already use — no second hand-rolled DB bootstrap),
// drives handoff-mcp.mjs over real stdio MCP transport (never imports its
// tool functions directly), and drops the throwaway DB(s) afterward in a
// `finally`. Needs no HANDOFF_SELFTEST_PROJECT_ROOT — runs unconditionally.
//
// Env control per sub-case uses StdioClientTransport's own `env` option
// (spread over process.env with unwanted keys deleted, never set to
// `undefined` verbatim — child_process.spawn does not accept that) so each
// MCP server child process sees EXACTLY the CLAUDE_CODE_SESSION_ID/
// CODEX_THREAD_ID/HANDOFF_HOST combination each sub-case needs, independent
// of whatever this test-runner process's own env happens to carry.

function buildChildEnv(overrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

async function withMcpClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: buildChildEnv(env),
  });
  const client = new Client({ name: 'usage-telemetry-selftest', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function runUsageTelemetryChecks() {
  console.log('\n== usage_record / usage_query MCP checks (throwaway DBs) ==');
  let passed = 0;
  let failed = 0;
  const pass = (label) => { console.log(`PASS  ${label}`); passed++; };
  const fail = (label, reason) => { console.log(`FAIL  ${label}: ${reason}`); failed++; };

  const stamp = Date.now();

  // migrate-11-usage-telemetry.sql (schema-setup-only, idempotent
  // `CREATE TABLE IF NOT EXISTS`, no FK dependencies) is NOT part of the
  // base schema-manifest.json this repo ships today -- a freshly-`init`ed
  // throwaway project genuinely lacks turn_usage/session_usage out of the
  // box, which is exactly check (a)'s real-world reproduction (no DROP TABLE
  // needed at all). Checks (b)/(c)/(d) need a DB that DOES have turn_usage,
  // so they apply this migration SQL directly to their own throwaway DB --
  // running an existing migration file's SQL against a scratch fixture, same
  // as test-pg-helpers.js's own applySchema() does for the base schema, never
  // editing scripts/migrations/* (that tree is out of scope for this PR).
  const USAGE_MIGRATION_SQL = fs.readFileSync(
    path.join(__dirname, 'migrations', 'sql', 'migrate-11-usage-telemetry.sql'),
    'utf8'
  );

  // (a) usage_query against a freshly-init'ed DB, which genuinely lacks
  // turn_usage (see above) -> actionable error text, never a raw pg stack
  // trace ("at Client..." frames).
  {
    const dbName = `test_usage_mcp_missing_${stamp}`;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mcp-missing-'));
    const label = 'UT-A: usage_query against a DB lacking turn_usage returns the actionable string, no raw pg stack';
    try {
      await pgHelpers.createTestDb(dbName, projectDir);
      await pgHelpers.setupProject(dbName, projectDir);

      await withMcpClient({ HANDOFF_DB: dbName, CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async (client) => {
        // sessionId given -> the turn_usage-scoped path (usageQuerySessionScoped),
        // so the missing relation is turn_usage specifically, not session_usage's
        // rollup path (sessionId omitted would hit session_usage instead -- also
        // covered by this same helper, just a different relation name).
        const result = await client.callTool({ name: 'usage_query', arguments: { projectRoot: projectDir, sessionId: 'ut-a-session' } });
        const text = result.content[0].text;
        if (!result.isError) fail(label, `expected isError=true, got false (text: ${text.slice(0, 200)})`);
        else if (!text.includes('turn_usage is missing in') || !text.includes('ensureSchemaCurrent reason=')) {
          fail(label, `actionable text not found: ${text.slice(0, 400)}`);
        } else if (text.includes('at Client')) {
          fail(label, `a raw pg stack frame leaked into the message: ${text.slice(0, 400)}`);
        } else {
          pass(label);
        }
      });
    } catch (err) {
      fail(label, err.stack || String(err));
    } finally {
      await pgHelpers.dropTestDb(dbName, projectDir);
    }
  }

  // (b)/(c)/(d) share one DB with a full schema (turn_usage intact) — each
  // sub-case uses a distinct turnIdx so the (project_id, session_id,
  // turn_idx, agent_role) upserts never collide with each other.
  {
    const dbName = `test_usage_mcp_identity_${stamp}`;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mcp-identity-'));
    try {
      await pgHelpers.createTestDb(dbName, projectDir);
      await pgHelpers.setupProject(dbName, projectDir);
      const schemaDb = await pgHelpers.pgConnect(dbName);
      try {
        await schemaDb.query(USAGE_MIGRATION_SQL);
      } finally {
        await schemaDb.end();
      }

      // (b) sessionId omitted, CODEX_THREAD_ID set, HANDOFF_HOST=codex -> writes under CODEX_THREAD_ID.
      {
        const label = 'UT-B: usage_record with sessionId omitted, CODEX_THREAD_ID set + HANDOFF_HOST=codex writes under that id';
        const codexId = 'codex-thread-ut-b';
        await withMcpClient(
          { HANDOFF_DB: dbName, HANDOFF_HOST: 'codex', CODEX_THREAD_ID: codexId, CLAUDE_CODE_SESSION_ID: undefined },
          async (client) => {
            const result = await client.callTool({
              name: 'usage_record',
              arguments: { projectRoot: projectDir, turnIdx: 1, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
            });
            if (result.isError) { fail(label, `unexpected isError: ${result.content[0].text.slice(0, 300)}`); return; }
            const row = JSON.parse(result.content[0].text);
            if (row.sessionId !== codexId) fail(label, `expected sessionId=${codexId}, got ${JSON.stringify(row.sessionId)}`);
            else pass(label);
          }
        );
      }

      // (c) both env ids set and differing, HANDOFF_HOST unset -> CLAUDE_CODE_SESSION_ID wins (parity with handoff.js).
      {
        const label = 'UT-C: both env ids set and differing, HANDOFF_HOST unset -> CLAUDE_CODE_SESSION_ID wins';
        await withMcpClient(
          { HANDOFF_DB: dbName, HANDOFF_HOST: undefined, CLAUDE_CODE_SESSION_ID: 'claude-sess-ut-c', CODEX_THREAD_ID: 'codex-thread-ut-c' },
          async (client) => {
            const result = await client.callTool({
              name: 'usage_record',
              arguments: { projectRoot: projectDir, turnIdx: 2, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
            });
            if (result.isError) { fail(label, `unexpected isError: ${result.content[0].text.slice(0, 300)}`); return; }
            const row = JSON.parse(result.content[0].text);
            if (row.sessionId !== 'claude-sess-ut-c') fail(label, `expected claude-sess-ut-c, got ${JSON.stringify(row.sessionId)}`);
            else pass(label);
          }
        );
      }

      // (d) explicit sessionId always wins, even with both env ids set.
      {
        const label = 'UT-D: an explicit sessionId argument always wins over any env default';
        await withMcpClient(
          { HANDOFF_DB: dbName, HANDOFF_HOST: 'codex', CLAUDE_CODE_SESSION_ID: 'claude-sess-ut-d', CODEX_THREAD_ID: 'codex-thread-ut-d' },
          async (client) => {
            const result = await client.callTool({
              name: 'usage_record',
              arguments: { projectRoot: projectDir, sessionId: 'explicit-sess-ut-d', turnIdx: 3, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
            });
            if (result.isError) { fail(label, `unexpected isError: ${result.content[0].text.slice(0, 300)}`); return; }
            const row = JSON.parse(result.content[0].text);
            if (row.sessionId !== 'explicit-sess-ut-d') fail(label, `expected explicit-sess-ut-d, got ${JSON.stringify(row.sessionId)}`);
            else pass(label);
          }
        );
      }
    } catch (err) {
      fail('UT-BCD: setup/execution', err.stack || String(err));
    } finally {
      await pgHelpers.dropTestDb(dbName, projectDir);
    }
  }

  console.log(`\nusage-telemetry checks: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

// Every registered tool must carry an `annotations` object (readOnlyHint +
// idempotentHint) -- no live project/DB needed, tools/list is pure server
// metadata. Runs unconditionally, same as runUsageTelemetryChecks().
async function runAnnotationsPresenceCheck() {
  console.log('\n== tool annotations presence check ==');
  let ok = true;
  await withMcpClient({}, async (client) => {
    const toolsList = await client.listTools();
    for (const t of toolsList.tools) {
      if (!t.annotations || typeof t.annotations.readOnlyHint !== 'boolean') {
        console.log(`FAIL  tool "${t.name}" is missing an annotations.readOnlyHint boolean`);
        ok = false;
      }
    }
    if (ok) console.log(`PASS  all ${toolsList.tools.length} registered tools carry an annotations.readOnlyHint boolean`);
  });
  return ok;
}

async function runAll() {
  const annotationsOk = await runAnnotationsPresenceCheck();
  const usageOk = await runUsageTelemetryChecks();

  if (PROJECT_ROOT && PROJECT_ROOT.trim()) {
    await main();
  } else {
    console.log(
      '\n== skipping project-dependent section (handoff_status / persist_decisions) ==\n' +
      '  HANDOFF_SELFTEST_PROJECT_ROOT is not set — set it to a disposable scratch project directory to also ' +
      'run that section. See this file\'s header comment for details.'
    );
  }

  if (!annotationsOk || !usageOk) {
    console.error('\nselftest FAILED: one or more checks failed (see PASS/FAIL lines above).');
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('selftest FAILED:', err);
  process.exit(1);
});
