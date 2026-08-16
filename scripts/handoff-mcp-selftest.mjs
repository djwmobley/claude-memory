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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SERVER_PATH is always the sibling handoff-mcp.mjs in this same repo checkout
// — never a hardcoded absolute path — so this selftest runs unmodified from
// any clone location.
const SERVER_PATH = path.join(__dirname, 'handoff-mcp.mjs');

// PROJECT_ROOT has no default. Total classification: either the env var is a
// non-empty string (used as-is), or it is unset/empty and this script refuses
// to run — never a silent fallback to a hardcoded local path or a real
// project's checkout.
const PROJECT_ROOT = process.env.HANDOFF_SELFTEST_PROJECT_ROOT;
if (!PROJECT_ROOT || !PROJECT_ROOT.trim()) {
  console.error(
    'FATAL: HANDOFF_SELFTEST_PROJECT_ROOT is not set.\n' +
    '  This selftest needs an absolute path to a real, writable project directory to drive\n' +
    '  handoff_status and persist_decisions against. Set it and re-run, e.g.:\n' +
    '    HANDOFF_SELFTEST_PROJECT_ROOT=/absolute/path/to/scratch-project node scripts/handoff-mcp-selftest.mjs\n' +
    '  (PowerShell: $env:HANDOFF_SELFTEST_PROJECT_ROOT = \'C:\\path\\to\\scratch-project\'; ' +
    'node scripts/handoff-mcp-selftest.mjs)\n' +
    '  Use a disposable scratch directory, not a shared or production checkout — see the\n' +
    '  header comment in this file for what gets written where.'
  );
  process.exit(1);
}

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
  const expectedNames = ['handoff_status', 'handoff_checkpoint', 'handoff_close', 'handoff_init', 'persist_decisions'];
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

main().catch((err) => {
  console.error('selftest FAILED:', err);
  process.exit(1);
});
