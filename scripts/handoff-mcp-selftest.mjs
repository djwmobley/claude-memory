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
// Codex review F1 (2026-09-12): buildServer is exported by handoff-mcp.mjs
// specifically so this selftest can inspect real registered-tool handler
// FUNCTION OBJECTS in-process (fn.toString()) -- the stdio wire protocol
// (used everywhere else in this file) only ever serializes name/description/
// annotations/schema, never the handler code itself. Importing the module
// this way does NOT start a stdio server (see handoff-mcp.mjs's isDirectRun
// guard at the bottom of that file).
import { buildServer, actionableUsageSchemaError, libToolError } from './handoff-mcp.mjs';

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
  // CodeQL js/clear-text-logging (alert #21, #22): several checks below round-trip
  // CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID fixtures through the MCP tool
  // response. check() takes only a pre-computed boolean plus a fixed literal
  // label -- a tool-response string, an env-derived session id, or a caught
  // error's message must never reach console.log here, directly or via any
  // string built from them.
  function check(label, condition) {
    if (condition) { console.log(`PASS  ${label}`); passed++; }
    else { console.log(`FAIL  ${label}`); failed++; }
  }

  const stamp = Date.now();

  // usage-telemetry-schema.sql (schema-setup-only, idempotent `CREATE TABLE
  // IF NOT EXISTS`, no FK dependencies) -- PR #298 (feat(schema): telemetry
  // + feature_usage DDL in schema manifest, epoch 5) moved this file from
  // scripts/migrations/sql/migrate-11-usage-telemetry.sql to scripts/sql/
  // and registered it in scripts/sql/schema-manifest.json so
  // ensureSchemaCurrent's init/heal-on-touch path now applies it to every
  // live project DB directly -- it is no longer a standalone migration file
  // outside the base schema (path fixed here, fix/usage-record-marker-
  // fallback: the stale scripts/migrations/sql path this block referenced
  // pre-#298 no longer exists, which made every usage-telemetry check in
  // this file ENOENT before even connecting to a DB). Checks (b)/(c)/(d)/(g)
  // apply this SQL directly to their own throwaway DB the same way
  // test-pg-helpers.js's own applySchema() does for the base schema, so
  // they still exercise a DB with turn_usage even if a future schema-
  // manifest change makes it redundant with `setupProject`'s own init.
  const USAGE_MIGRATION_SQL = fs.readFileSync(
    path.join(__dirname, 'sql', 'usage-telemetry-schema.sql'),
    'utf8'
  );

  // (a) fix/usage-record-marker-fallback (2026-09-12): PR #298 registered
  // usage-telemetry-schema.sql in the base scripts/sql/schema-manifest.json
  // (epoch 5), so ensureSchemaCurrent's init/heal-on-touch path (run by
  // withProjectDb on EVERY §8/§18 tool call, before the tool's own query
  // ever executes) now recreates turn_usage/session_usage/feature_usage on
  // any live engine DB behind epoch 5, INCLUDING one this test just DROPped
  // the table from -- the "a DB genuinely lacking turn_usage" premise UT-A
  // used to test is no longer reachable through a live MCP call on a
  // current engine (heal-on-touch wins the race every time; verified: this
  // exact DROP-then-call sequence went from FAIL to a false PASS once #298
  // shipped, because usage_query started succeeding with an empty result
  // instead of erroring). The 42P01 mapping (actionableUsageSchemaError,
  // exported by handoff-mcp.mjs) is now a backstop for engines behind epoch
  // 5 or mid-race, not a live path this selftest can drive end-to-end --
  // so UT-A1..UT-A6 below test that mapping DIRECTLY with synthetic error
  // objects (no DB, no MCP round-trip), and UT-A7 replaces the old live
  // scenario with the actual current behavior: a fresh engine DB answers
  // usage_query cleanly, never erroring, never healing mid-call.
  //
  // UT-A1..UT-A3: each usage-telemetry relation maps to actionable text
  // that names the relation and points at the remedy ("init") -- never a
  // raw pg stack frame.
  {
    const cases = [
      ['turn_usage', 'UT-A1'],
      ['session_usage', 'UT-A2'],
      ['feature_usage', 'UT-A3'],
    ];
    for (const [relation, id] of cases) {
      const label = `${id}: synthetic 42P01 on "${relation}" maps to actionable text (names the relation, points at init, no raw stack frame)`;
      const err = { code: '42P01', message: `relation "${relation}" does not exist` };
      const mapped = actionableUsageSchemaError(err, { database: 'ut-a-synthetic-db', schemaReason: 'current' });
      const namesRelation = typeof mapped.message === 'string' && mapped.message.includes(relation);
      const pointsAtRemedy = typeof mapped.message === 'string' && (mapped.message.includes('epoch') || mapped.message.includes('init'));
      const noRawStackFrame = typeof mapped.message === 'string' && !mapped.message.includes('at Client');
      check(label, mapped !== err && namesRelation && pointsAtRemedy && noRawStackFrame);
    }
  }

  // UT-A4: a 42P01 on a relation this helper does NOT own (project_settings)
  // is passed through completely unchanged -- adversary G5, never fabricate
  // a schema-behind remedy for an unrecognized relation.
  {
    const label = 'UT-A4: synthetic 42P01 on "project_settings" (not a usage-telemetry relation) passes through unchanged';
    const err = { code: '42P01', message: 'relation "project_settings" does not exist' };
    const mapped = actionableUsageSchemaError(err, { database: 'ut-a-synthetic-db', schemaReason: 'current' });
    check(label, mapped === err);
  }

  // UT-A5: a non-42P01 pg error code is left completely unchanged.
  {
    const label = 'UT-A5: synthetic 23505 (unique_violation) passes through unchanged';
    const err = { code: '23505' };
    const mapped = actionableUsageSchemaError(err, { database: 'ut-a-synthetic-db', schemaReason: 'current' });
    check(label, mapped === err);
  }

  // UT-A6: libToolError renders a named-but-codeless lib error (usage-
  // telemetry.js's CostOutOfRangeError -- no `.code`, name set on the
  // instance rather than via a real subclass) by its actual name, never
  // falls through to a generic "[undefined]"-shaped stack dump.
  {
    const label = 'UT-A6: libToolError renders a CostOutOfRangeError by name, not "[undefined]"';
    const err = new Error('cost 999.99 exceeds configured ceiling');
    err.name = 'CostOutOfRangeError';
    const result = libToolError(err);
    const text = result.content[0].text;
    check(label, result.isError === true && text.includes('CostOutOfRangeError') && !text.includes('[undefined]'));
  }

  // UT-A7 (replaces the old live UT-A scenario): the REAL post-#298
  // behavior -- a fresh engine DB provisioned by ensureSchemaCurrent (via
  // setupProject's `handoff.js init`, epoch 5) already has feature_usage,
  // so usage_query at granularity="feature" against it never errors and
  // never needs a heal-on-touch mid-call; it answers with an empty result
  // because no feature_usage rows exist yet on this brand-new DB.
  {
    const dbName = `test_usage_mcp_fresh_${stamp}`;
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mcp-fresh-'));
    const label = 'UT-A7: usage_query granularity="feature" against a fresh engine DB returns an empty result, no error';
    try {
      await pgHelpers.createTestDb(dbName, projectDir);
      await pgHelpers.setupProject(dbName, projectDir);

      await withMcpClient({ HANDOFF_DB: dbName, CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, async (client) => {
        const result = await client.callTool({
          name: 'usage_query',
          arguments: { projectRoot: projectDir, granularity: 'feature' },
        });
        let rows;
        try {
          rows = result.isError ? null : JSON.parse(result.content[0].text).rows;
        } catch {
          rows = null;
        }
        check(label, result.isError !== true && Array.isArray(rows) && rows.length === 0);
      });
    } catch {
      check(label, false);
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
            const row = result.isError ? null : JSON.parse(result.content[0].text);
            check(label, !result.isError && row.sessionId === codexId);
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
            const row = result.isError ? null : JSON.parse(result.content[0].text);
            check(label, !result.isError && row.sessionId === 'claude-sess-ut-c');
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
            const row = result.isError ? null : JSON.parse(result.content[0].text);
            check(label, !result.isError && row.sessionId === 'explicit-sess-ut-d');
          }
        );
      }

      // (e) Codex review F2: an EXPLICIT sessionId:"" must NOT be treated as
      // omitted -- it must be rejected with the same non-empty-string
      // validation error usage-telemetry.js's own write path raises, never
      // silently replaced by the CODEX_THREAD_ID env default (the bug: the
      // prior `sessionId || resolveSessionIdFromEnv(...)` form treated ""
      // as falsy and defaulted it).
      {
        const label = 'UT-E: explicit sessionId="" is rejected, never silently defaulted from env';
        await withMcpClient(
          { HANDOFF_DB: dbName, HANDOFF_HOST: 'codex', CODEX_THREAD_ID: 'codex-thread-ut-e', CLAUDE_CODE_SESSION_ID: undefined },
          async (client) => {
            const result = await client.callTool({
              name: 'usage_record',
              arguments: { projectRoot: projectDir, sessionId: '', turnIdx: 4, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
            });
            const text = result.content[0]?.text ?? '';
            const rejectedProperly = result.isError === true && text.includes('must be a non-empty string');
            const leaked = text.includes('codex-thread-ut-e');
            check(label, rejectedProperly && !leaked);
          }
        );
      }

      // (f) Codex review F2: an explicit whitespace-only sessionId is
      // likewise an EXPLICIT blank value, not an omission -- same rejection,
      // never a silent env default. requireNonEmptyString's own zero-length
      // check would NOT catch this case (length > 0), which is exactly why
      // the MCP-layer guard (not usage-telemetry.js, out of scope for this
      // PR) has to trim before checking.
      {
        const label = 'UT-F: explicit whitespace-only sessionId is rejected, never silently defaulted from env';
        await withMcpClient(
          { HANDOFF_DB: dbName, HANDOFF_HOST: 'codex', CODEX_THREAD_ID: 'codex-thread-ut-f', CLAUDE_CODE_SESSION_ID: undefined },
          async (client) => {
            const result = await client.callTool({
              name: 'usage_record',
              arguments: { projectRoot: projectDir, sessionId: '   ', turnIdx: 5, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
            });
            const text = result.content[0]?.text ?? '';
            const rejectedProperly = result.isError === true && text.includes('must be a non-empty string');
            const leaked = text.includes('codex-thread-ut-f');
            check(label, rejectedProperly && !leaked);
          }
        );
      }

      // (g) fix/usage-record-marker-fallback: sessionId omitted, NEITHER env
      // id set, but a live project session_in_progress marker IS present ->
      // writes under the marker's session_id. This is the real Codex e2e
      // gap this PR fixes -- Codex's MCP server env carries no
      // CODEX_THREAD_ID at all (config.toml's `env` table for this server
      // only ever sets HANDOFF_HOST/HANDOFF_PROMOTION_FILE), so the marker
      // fallback (resolveSessionIdFromMarker, scripts/lib/session-identity.js)
      // is the path that actually serves Codex here -- same marker
      // handoff.js's own resolveSessionId and handoff_status already share.
      // Boolean-only assertion below (CodeQL js/clear-text-logging) -- the
      // marker session id is never logged, only compared.
      {
        // Codex review C1 (fix/usage-record-marker-fallback follow-up): this
        // case now also asserts session_id_source === "marker" -- the
        // provenance field the strict marker default (C1) added to every
        // usage_record result, distinguishing "resolved from env" from
        // "resolved from a project marker" without ever logging the id
        // itself (CodeQL js/clear-text-logging -- the boolean-only
        // assertion pattern below is unchanged).
        const label = 'UT-G: usage_record with no sessionId and no env ids, marker present -> row written under the marker id, source=marker';
        const markerSessionId = 'marker-sess-ut-g';
        const projectId = pgHelpers.resolveProjectId(projectDir);
        const markerDb = await pgHelpers.pgConnect(dbName);
        try {
          await pgHelpers.setSetting(
            markerDb, projectId, 'session_in_progress',
            JSON.stringify([{ session_id: markerSessionId, ts: new Date().toISOString(), host: 'codex' }])
          );
        } finally {
          await markerDb.end();
        }
        try {
          await withMcpClient(
            { HANDOFF_DB: dbName, HANDOFF_HOST: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined },
            async (client) => {
              const result = await client.callTool({
                name: 'usage_record',
                arguments: { projectRoot: projectDir, turnIdx: 6, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
              });
              const row = result.isError ? null : JSON.parse(result.content[0].text);
              check(
                label,
                !result.isError && row.sessionId === markerSessionId &&
                  row.session_id_source === 'marker' && typeof row.marker_ts === 'string'
              );
            }
          );
        } finally {
          // Clear the marker so it never leaks into a later check sharing this DB.
          const cleanupDb = await pgHelpers.pgConnect(dbName);
          try {
            await cleanupDb.query(
              `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
              [projectId]
            );
          } finally {
            await cleanupDb.end();
          }
        }
      }

      // (h) Codex review C1: TWO live project markers -> the strict marker
      // default refuses to guess between them (ambiguous), a hard error
      // naming only the count -- never a session id (CodeQL js/clear-text-
      // logging: the assertion below checks for the fixed literal substring
      // "ambiguous session markers (2)" and the ABSENCE of either marker id
      // in the error text, never logs an id itself).
      {
        const label = 'UT-H: usage_record with no sessionId, no env ids, TWO project markers -> ambiguous hard error, no id leaked';
        const markerIdA = 'marker-sess-ut-h-a';
        const markerIdB = 'marker-sess-ut-h-b';
        const projectId = pgHelpers.resolveProjectId(projectDir);
        const markerDb = await pgHelpers.pgConnect(dbName);
        try {
          await pgHelpers.setSetting(
            markerDb, projectId, 'session_in_progress',
            JSON.stringify([
              { session_id: markerIdA, ts: new Date().toISOString(), host: 'claude' },
              { session_id: markerIdB, ts: new Date().toISOString(), host: 'codex' },
            ])
          );
        } finally {
          await markerDb.end();
        }
        try {
          await withMcpClient(
            { HANDOFF_DB: dbName, HANDOFF_HOST: undefined, CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined },
            async (client) => {
              const result = await client.callTool({
                name: 'usage_record',
                arguments: { projectRoot: projectDir, turnIdx: 7, agentRole: 'ut-role', tokensIn: 10, tokensOut: 5 },
              });
              const text = result.content[0]?.text ?? '';
              const rejectedProperly = result.isError === true && text.includes('ambiguous session markers (2)');
              const leaked = text.includes(markerIdA) || text.includes(markerIdB);
              check(label, rejectedProperly && !leaked);
            }
          );
        } finally {
          const cleanupDb = await pgHelpers.pgConnect(dbName);
          try {
            await cleanupDb.query(
              `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
              [projectId]
            );
          } finally {
            await cleanupDb.end();
          }
        }
      }
    } catch {
      check('UT-BCDEFGH: setup/execution', false);
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

// ── Codex review P2 (2026-09-12, round 2): idempotentHint audit for every
// *_suppress and *_update tool ──────────────────────────────────────────
//
// assertion_suppress was idempotentHint:true despite its underlying write
// (entity-graph-crud.js's assertionSuppress) setting `invalid_at = now()`
// on every matching call, including a second call on an already-suppressed
// row -- the row's stored invalid_at differs per call, so repeat calls are
// NOT side-effect-free. This asserts the audited, consistent expectation
// for all six *_suppress/*_update tools in one place: a *_suppress or
// *_update tool that writes a now()-based bi-temporal column on every call
// is idempotentHint:false; one whose write is a plain flag/COALESCE set
// with no such column is left at its existing value. Before the P2 fix
// this fails on assertion_suppress (expected false, found true); after the
// fix all six match.
const IDEMPOTENT_HINT_EXPECTED = {
  entity_update: false,   // plain COALESCE overwrite, no now() column -- unaffected by the audit
  entity_suppress: true,  // `suppressed = true` only, no now() column -- repeat calls converge
  assertion_update: false, // supersession: invalid_at=now() on old row + a NEW inserted row every call
  assertion_suppress: false, // P2: invalid_at=now() on every call, even an already-suppressed row
  edge_update: false,     // plain COALESCE overwrite, no now() column -- unaffected by the audit
  edge_suppress: true,    // `suppressed = true` only, no now() column -- repeat calls converge
};

async function runIdempotentHintAuditCheck() {
  console.log('\n== idempotentHint audit: *_suppress / *_update tools (P2) ==');
  let ok = true;
  await withMcpClient({}, async (client) => {
    const toolsList = await client.listTools();
    const byName = new Map(toolsList.tools.map((t) => [t.name, t]));
    for (const [name, expected] of Object.entries(IDEMPOTENT_HINT_EXPECTED)) {
      const tool = byName.get(name);
      if (!tool) {
        console.log(`FAIL  tool "${name}" is not registered — cannot audit its idempotentHint`);
        ok = false;
        continue;
      }
      const actual = tool.annotations && tool.annotations.idempotentHint;
      if (actual !== expected) {
        console.log(`FAIL  tool "${name}" idempotentHint=${actual}, expected ${expected}`);
        ok = false;
      }
    }
    if (ok) {
      console.log(
        `PASS  all ${Object.keys(IDEMPOTENT_HINT_EXPECTED).length} audited *_suppress/*_update tools carry the ` +
        'expected idempotentHint (now()-per-call write => false; plain flag/COALESCE set => unchanged)'
      );
    }
  });
  return ok;
}

// ── Codex review F1 (2026-09-12): readOnlyHint mechanical trace check ──────
// ── Codex review P1 (2026-09-12, round 2): the brace-balanced scan below
//    used to start from the FIRST `{` after the function-name match. Every
//    toolXxx handler in this codebase is declared as
//    `async function toolXxx({ projectRoot, ... }) { ... }` -- a destructured
//    parameter object. The first `{` after the name match is THAT
//    destructuring brace, not the function body's opening brace, so the old
//    scan balanced to the destructure's own closing `}` and returned only
//    "async function toolXxx({ projectRoot, ... }" -- the signature, with
//    the entire body (and therefore any withProjectDb call inside it)
//    silently discarded. This is now fixed by first balancing the
//    PARENTHESES of the parameter list (handles nested parens too, e.g. a
//    default value that calls a function) to find where the parameter list
//    actually ends, THEN scanning for the body's opening `{` after that.
//
// Extracts the full source text of a named top-level `async function
// <fnName>(...) { ... }` declaration from `fileText` via brace-balanced
// scanning (never regex-bounded -- nested braces inside the function body,
// e.g. the withProjectDb callback's own `{ ... }`, would truncate a naive
// non-greedy match). Returns '' when no such declaration is found.
function extractFunctionSource(fileText, fnName) {
  const re = new RegExp(`\\basync function ${fnName}\\s*\\(`);
  const m = re.exec(fileText);
  if (!m) return '';
  const parenStart = fileText.indexOf('(', m.index);
  if (parenStart === -1) return '';
  // First balance the parameter list's own parens -- this is what a naive
  // "find the next {" got wrong (P1): the parameter list is very often a
  // destructured object (`{ projectRoot, ... }`), whose OWN brace is not
  // the function body's brace.
  let pdepth = 0;
  let k = parenStart;
  for (; k < fileText.length; k++) {
    if (fileText[k] === '(') pdepth++;
    else if (fileText[k] === ')') {
      pdepth--;
      if (pdepth === 0) { k++; break; }
    }
  }
  if (pdepth !== 0) return ''; // unbalanced parens -- cannot resolve safely
  const braceStart = fileText.indexOf('{', k);
  if (braceStart === -1) return '';
  let depth = 0;
  let j = braceStart;
  for (; j < fileText.length; j++) {
    if (fileText[j] === '{') depth++;
    else if (fileText[j] === '}') {
      depth--;
      if (depth === 0) { j++; break; }
    }
  }
  if (depth !== 0) return ''; // unbalanced braces -- cannot resolve safely
  return fileText.slice(m.index, j);
}

// Every registered tool's handler in handoff-mcp.mjs is a thin dispatch
// wrapper of the form `async (args) => toolXxx(args)` -- the wrapper's OWN
// fn.toString() never literally contains "withProjectDb" even when toolXxx
// unconditionally calls it. Scanning ONLY the wrapper (naive fn.toString())
// would make this check vacuous against exactly the pattern every tool here
// uses, so this resolves ONE level of delegation: it finds the `toolXxx(`
// call inside the wrapper's own source, then pulls toolXxx's full body out
// of the server file's source text (extractFunctionSource) and scans BOTH
// texts. A handler with no such delegate (an inline arrow body) is scanned
// as-is. This is a regression floor, not a full call-graph analysis --
// scope matches F1's mechanical-trace instruction exactly (fn.toString()),
// extended the one hop this file's own architecture requires to be
// meaningful at all.
const HEAL_PATH_TERMS = ['withProjectDb', 'ensureSchemaCurrent', 'ensureProjectIdentity'];

// Traces one (name, registeredToolEntry) pair against serverSource and
// returns { ok, foundTerms, unresolved, delegateName }. Pulled out of
// runReadOnlyHintTraceCheck (P1) so the fixture check below can drive the
// exact same trace logic against a synthetic mutated entry without touching
// disk or the real registered-tools map.
//
// P1 also requires: when the handler's own source cannot be resolved to
// real text (a bound/wrapped function whose toString() is a native-code
// stub, or an empty string) OR the handler delegates to a toolXxx name that
// extractFunctionSource could not find/balance in the server source, a
// readOnlyHint:true tool FAILS the check rather than silently passing on
// whatever partial text happened to be available.
function traceToolReadOnlyHint(name, entry, serverSource) {
  const handlerSrc = typeof entry.handler === 'function' ? entry.handler.toString() : '';
  const handlerUnresolved = handlerSrc.trim() === '' || handlerSrc.includes('[native code]');

  const delegateMatch = handlerUnresolved ? null : /\b(tool[A-Za-z0-9_]+)\s*\(/.exec(handlerSrc);
  let delegateSrc = '';
  let delegateUnresolved = false;
  if (delegateMatch) {
    delegateSrc = extractFunctionSource(serverSource, delegateMatch[1]);
    delegateUnresolved = delegateSrc === '';
  }

  const unresolved = handlerUnresolved || delegateUnresolved;
  const combinedSrc = handlerSrc + (delegateSrc ? '\n' + delegateSrc : '');
  const foundTerms = HEAL_PATH_TERMS.filter((term) => combinedSrc.includes(term));

  return {
    ok: !unresolved && foundTerms.length === 0,
    foundTerms,
    unresolved,
    delegateName: delegateMatch ? delegateMatch[1] : null,
  };
}

async function runReadOnlyHintTraceCheck() {
  console.log('\n== readOnlyHint mechanical trace check (F1/P1) ==');
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
  const server = buildServer();
  const registered = server._registeredTools;
  if (!registered || typeof registered !== 'object') {
    console.log('FAIL  could not reach McpServer._registeredTools (SDK internal shape changed?)');
    return false;
  }

  let ok = true;
  let trueCount = 0;
  let falseCount = 0;

  for (const [name, entry] of Object.entries(registered)) {
    if (!entry.annotations || typeof entry.annotations.readOnlyHint !== 'boolean') {
      console.log(`FAIL  tool "${name}" is missing an annotations.readOnlyHint boolean`);
      ok = false;
      continue;
    }
    if (entry.annotations.readOnlyHint === true) {
      trueCount++;
      const trace = traceToolReadOnlyHint(name, entry, serverSource);
      if (trace.unresolved) {
        console.log(
          `FAIL  tool "${name}" is readOnlyHint:true but its handler source could not be mechanically ` +
          `resolved (traced through ${trace.delegateName || '<inline handler>'}) -- failing closed rather ` +
          'than passing on an unverifiable trace'
        );
        ok = false;
      } else if (trace.foundTerms.length > 0) {
        console.log(
          `FAIL  tool "${name}" is readOnlyHint:true but its handler (traced through ` +
          `${trace.delegateName || '<inline handler>'}) contains: ${trace.foundTerms.join(', ')}`
        );
        ok = false;
      }
    } else {
      falseCount++;
    }
  }

  console.log(`readOnlyHint tally: ${trueCount} true, ${falseCount} false (${trueCount + falseCount} total registered tools)`);
  if (ok) {
    console.log(
      'PASS  every readOnlyHint:true tool\'s handler (traced through its delegate, if any) is free of ' +
      'withProjectDb/ensureSchemaCurrent/ensureProjectIdentity, and every trace resolved to real source'
    );
  }
  return ok;
}

// ── Codex review P1 fixture (2026-09-12, round 2) ──────────────────────────
// Regression coverage for the exact bug P1 found: clones the REAL memory_get
// registered-tool entry (never mutates the live server or disk), forces its
// annotations.readOnlyHint to true, and re-runs the SAME traceToolReadOnlyHint
// logic used above against toolMemoryGet's real source in handoff-mcp.mjs.
// toolMemoryGet unconditionally calls withProjectDb, so this MUST fail the
// trace. Before the P1 fix, extractFunctionSource sliced at the destructured
// parameter list's own brace and returned only the signature -- the trace
// found no heal-path terms and incorrectly reported ok:true. If this fixture
// ever again reports ok:true, the mechanical trace has regressed back to
// being vacuous against the one handler shape every tool in this file uses.
async function runReadOnlyHintFixtureCheck() {
  console.log('\n== readOnlyHint mechanical trace fixture check (P1 regression) ==');
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
  const server = buildServer();
  const registered = server._registeredTools;
  if (!registered || typeof registered !== 'object' || !registered.memory_get) {
    console.log('FAIL  could not reach registered "memory_get" tool entry to build the fixture');
    return false;
  }

  const realEntry = registered.memory_get;
  const fixtureEntry = {
    ...realEntry,
    annotations: { ...realEntry.annotations, readOnlyHint: true },
  };

  const trace = traceToolReadOnlyHint('memory_get (fixture: forced readOnlyHint:true)', fixtureEntry, serverSource);
  if (trace.ok) {
    console.log(
      'FAIL  fixture regression: forcing memory_get\'s readOnlyHint to true was NOT caught by the mechanical ' +
      'trace (toolMemoryGet calls withProjectDb; the trace should have found it and failed) -- the extractor ' +
      'has regressed to the P1 bug (slicing at the destructured-parameter brace instead of the function body)'
    );
    return false;
  }
  if (trace.unresolved) {
    console.log(
      'FAIL  fixture could not resolve toolMemoryGet\'s source at all (extractFunctionSource returned \'\') -- ' +
      'expected a resolved trace that finds withProjectDb, not an unresolved one'
    );
    return false;
  }
  console.log(
    `PASS  forcing memory_get's readOnlyHint to true is correctly caught by the trace (found: ${trace.foundTerms.join(', ')})`
  );
  return true;
}

async function runAll() {
  const annotationsOk = await runAnnotationsPresenceCheck();
  const idempotentHintAuditOk = await runIdempotentHintAuditCheck();
  const readOnlyHintTraceOk = await runReadOnlyHintTraceCheck();
  const readOnlyHintFixtureOk = await runReadOnlyHintFixtureCheck();
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

  if (!annotationsOk || !idempotentHintAuditOk || !readOnlyHintTraceOk || !readOnlyHintFixtureOk || !usageOk) {
    console.error('\nselftest FAILED: one or more checks failed (see PASS/FAIL lines above).');
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('selftest FAILED:', err);
  process.exit(1);
});
