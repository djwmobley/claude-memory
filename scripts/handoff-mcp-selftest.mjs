#!/usr/bin/env node
// handoff-mcp-selftest — spawns scripts/handoff-mcp.mjs over stdio and drives
// initialize -> tools/list -> tools/call handoff_status -> tools/call
// persist_decisions (with a throwaway row, then a cleanup instruction printed
// for the operator to run against Postgres directly — this script does not
// delete rows itself; see the ticket for the DELETE + reindex step run
// separately after this passes).

import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = 'C:\\Users\\djwmo\\dev\\claude-memory\\scripts\\handoff-mcp.mjs';
const PROJECT_ROOT = 'C:\\Users\\djwmo\\dev\\advisicon-ppm-monolith';

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
          topic: 'ppm-monolith-handoff-mcp-selftest',
          decision: 'handoff-mcp self-test round-trip row (Task #4566) — safe to delete after verification.',
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
