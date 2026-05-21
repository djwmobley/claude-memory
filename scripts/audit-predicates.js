#!/usr/bin/env node
'use strict';

/**
 * audit-predicates.js — Ops CLI: report any assertions rows whose predicate
 * is not in the declared predicate-registry vocabulary.
 *
 * Usage:
 *   node scripts/audit-predicates.js [--project=<uuid>]
 *
 * Exit codes:
 *   0  All distinct predicates are registered ("OK" report).
 *   2  DB unreachable — printed to stderr, clean exit so callers can distinguish
 *      infra failures from vocabulary drift.
 *   3  One or more unregistered predicates found — report printed to stdout.
 *
 * Honors PROJECT_ROOT env var (same as handoff.js and all other scripts).
 */

const path   = require('path');
const { createRequire } = require('module');

// Resolve pg from scripts/node_modules regardless of caller CWD.
const scriptsRequire = createRequire(path.join(__dirname, 'package.json'));
const { Client }     = scriptsRequire('pg');

const { loadConfig }               = require('./lib/shared');
const { auditAssertionPredicates } = require('./lib/predicate-audit');
const { recognizedPredicates }     = require('./lib/predicate-registry');

// ── Argument parsing ─────────────────────────────────────────────────────────

let projectId = null;

for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--project=(.+)$/);
  if (m) {
    projectId = m[1].trim();
    continue;
  }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write([
      'Usage: node scripts/audit-predicates.js [--project=<uuid>]',
      '',
      'Scans the assertions table and reports any predicate not listed in',
      'scripts/lib/predicate-registry.json.',
      '',
      'Exit 0 = all predicates registered.',
      'Exit 2 = DB unreachable.',
      'Exit 3 = unregistered predicates found.',
    ].join('\n') + '\n');
    process.exit(0);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg    = loadConfig();
  const client = new Client({
    host:     cfg.host,
    port:     cfg.port,
    database: cfg.database,
    user:     cfg.user,
  });

  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`audit-predicates: cannot connect to database "${cfg.database}" — ${err.message}\n`);
    process.stderr.write('Ensure Postgres is running and the database exists.\n');
    process.exit(2);
  }

  let unregistered;
  try {
    unregistered = await auditAssertionPredicates(client, { projectId: projectId || undefined });
  } finally {
    await client.end().catch(() => {});
  }

  if (unregistered.length === 0) {
    const total = recognizedPredicates().length;
    process.stdout.write(`OK — all ${total} distinct predicates registered\n`);
    process.exit(0);
  }

  process.stdout.write(`Found ${unregistered.length} unregistered predicate(s):\n\n`);
  for (const { predicate, count } of unregistered) {
    process.stdout.write(`  ${predicate} (${count})\n`);
  }
  process.stdout.write('\nAdd each predicate to scripts/lib/predicate-registry.json to resolve.\n');
  process.exit(3);
}

main().catch((err) => {
  process.stderr.write(`audit-predicates: unexpected error — ${err.message}\n`);
  process.exit(2);
});
