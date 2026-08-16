'use strict';

const AUTHORED_BY = 'sonnet-t7-store-wide-gate-author-2026-08-16';

/**
 * test-caveman-economy-store-wide.js — §3.5's GENERALIZED caveman-economy
 * gate (K-1..K-11 amendment, memory-manager#12/T7), sibling to
 * test/north-star/test-caveman-economy.js (that file stays scoped to the
 * single-session close->resume round trip; this file scans the ENTIRE
 * target database's §5 schema — a driven manifest, not one fixture pair).
 *
 * CONTRACT (per scripts/migrations/verify-15-t7-caveman-economy.js, honored
 * EXACTLY — that wrapper checks for this file at this path first):
 *   module.exports.run(targetDbName) -> Promise<boolean>
 *   module.exports.AUTHORED_BY
 *
 * WHAT run() DOES (pure verifier — provisions NOTHING):
 *   1. Loads scripts/migrations/caveman-columns.json (K-9 manifest).
 *   2. K-8 completeness backstop: diffs the manifest (tables + out_of_scope_
 *      tables) against the target's ENTIRE live public-schema TEXT/VARCHAR
 *      column set, bidirectionally. Any (table,column) pair present in one
 *      side and not the other is a LOUD FAIL — this is what makes
 *      "unclassified-LOUD-FAIL" (K-9's 5th classification) real rather than
 *      aspirational: an unlisted column is refused, not silently skipped.
 *      Runs BEFORE any row scanning (a stale manifest invalidates every
 *      per-row result, so there is no point computing them).
 *   3. Per-row scan of every checked-caveman / checked-verbose-exempt /
 *      mandatory-caveman-no-column column across every §5 table:
 *        - FIDELITY (K-7): scripts/lib/caveman-lint.js's detectTruncation()
 *          against the cell's own content — a no-baseline heuristic (K-5:
 *          never fabricate a synthetic verbose baseline for a born-caveman
 *          row to diff against; that would be circular and gameable).
 *        - ECONOMY (K-5, ARM3-style): function-word-density ceiling
 *          (caveman-lint's functionWordRatio / CAVEMAN_FW_RATIO_CEILING),
 *          applied ONLY when the row is not exempt:
 *            * mandatory-caveman-no-column (body_caveman) -> always applies.
 *            * checked-caveman on a table with NO authoring_mode column
 *              (tasks.title, code_index.description, entities.description,
 *              checklist_items.*, workflow_discovery.*, agent_rewrites.*) ->
 *              always applies (no escape hatch exists).
 *            * checked-caveman / checked-verbose-exempt on a table WITH an
 *              authoring_mode column -> applies only when THIS ROW's
 *              authoring_mode = 'caveman'; NULL or 'verbose' skips economy
 *              (grandfathered/legacy-verbose rows, §3.6) but fidelity STILL
 *              applies to those rows (§3.5 step 3: verbose is exempt from
 *              (a) but never from (b)).
 *   4. pass = completeness.pass && zero per-row failures.
 *
 * Usage as a library: require(...).run('memory_manager_staging').
 * Usage as a CLI: `node test/north-star/test-caveman-economy-store-wide.js
 * [--db <name>]` — with NO --db, provisions its OWN throwaway `_staging`-
 * suffixed scratch database (migrate-01 -> schema-addenda -> migrate-13 ->
 * migrate-14 -> migrate-15 -> migrate-16 -> verify15-shared's applyDdl (for
 * own_graph_migration_ids) -> migrate-03's schema-only ADD COLUMN statements
 * replicated directly (for memory_entries/memory_entry_chunks.project_id) —
 * see provisionSchema()'s own doc comment for why the last two are NOT
 * invoked as their real migrate-*.js scripts), runs the gate against it, drops it, and exits
 * 0/1/2 — this is the CI GREEN-gate entry point, mirroring how
 * test-caveman-economy.js is wired into .github/workflows/test.yml (a
 * single `node test/north-star/test-caveman-economy-store-wide.js` step,
 * same PGHOST/PGUSER/PGPASSWORD env convention) while never touching the
 * real memory_manager_staging (repo-wide convention — see this workflow
 * file's own comments on every migrate-*.js test step). Real staging/
 * production runs (the actual §15 T7 acceptance-battery invocation) pass
 * --db memory_manager_staging explicitly, or go through
 * verify-15-t7-caveman-economy.js which calls run() as a library.
 *
 * CommonJS, US English, no external deps beyond `pg` (via scripts/package.json).
 */

const path = require('path');
const fs = require('fs');

const shared = require('../../scripts/migrations/lib/verify15-shared');
const lint = require('../../scripts/lib/caveman-lint');

const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'migrations', 'caveman-columns.json');

// K-9's total classification is EXACTLY these four values — nothing else is
// ever a valid `class`. A hand-edited, 190+-entry JSON manifest is exactly
// where a typo eventually happens (independent review reproduced this: a
// corrupted class value silently fell through scanTable()'s `!== 'exempt-
// not-model-authored'` branch and checkCell()'s generic authoring-mode-
// column logic, producing a silent RESULT: PASS). Validated once here, in
// loadManifest(), so every caller — run(), checkCompleteness(), scanTable(),
// the CLI, and every test — gets the same loud refusal for free; never a
// second place this enum could drift out of sync.
const VALID_CLASSES = new Set([
  'checked-caveman',
  'checked-verbose-exempt',
  'mandatory-caveman-no-column',
  'exempt-not-model-authored',
]);

/** Load + parse the K-9 manifest. Throws loudly if missing/malformed, OR if
 * any column entry's `class` is outside the K-9 enum — never silently
 * treated as "no columns to check" or silently downgraded to generic
 * checked-caveman-ish handling (that would defeat K-8/K-9's total-
 * classification guarantee).
 *
 * @param {string} [manifestPath] - override for tests only (a corrupted
 *   temp-file copy); production callers always use the default MANIFEST_PATH.
 */
function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`caveman-columns.json manifest not found at ${manifestPath} — the store-wide gate has nothing to check against.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.tables) {
    throw new Error(`caveman-columns.json at ${manifestPath} is malformed (missing top-level "tables" key).`);
  }

  const badEntries = [];
  for (const [table, def] of Object.entries(manifest.tables)) {
    for (const [col, colDef] of Object.entries((def && def.columns) || {})) {
      const cls = colDef && colDef.class;
      if (!VALID_CLASSES.has(cls)) {
        badEntries.push(`${table}.${col} (class=${JSON.stringify(cls)})`);
      }
    }
  }
  if (badEntries.length > 0) {
    throw new Error(
      `${manifestPath}: ${badEntries.length} column entr${badEntries.length === 1 ? 'y has' : 'ies have'} a "class" value ` +
      `outside the K-9 total-classification enum (valid: ${[...VALID_CLASSES].join(' | ')}): ${badEntries.join(', ')}`
    );
  }

  return manifest;
}

// ─── K-8: COMPLETENESS BACKSTOP ─────────────────────────────────────────────

/**
 * Bidirectional diff: manifest (tables + out_of_scope_tables) vs the
 * target's ENTIRE live public-schema TEXT/VARCHAR/CHAR column set. TRUE
 * total classification, not an allow-list pre-filtered to §5 table names —
 * a wholly new table (in OR out of §5) that nobody updated the manifest for
 * shows up here, on either side, loud.
 *
 * @param {import('pg').Client} client
 * @param {object} manifest
 * @returns {Promise<{pass:boolean, onlyLive:string[], onlyManifest:string[], doubleClassified:string[]}>}
 */
async function checkCompleteness(client, manifest) {
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type IN ('text', 'character varying', 'character')`
  );
  const livePairs = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

  const manifestPairs = new Set();
  for (const [table, def] of Object.entries(manifest.tables || {})) {
    for (const col of Object.keys(def.columns || {})) manifestPairs.add(`${table}.${col}`);
  }
  const outOfScope = new Set(Object.keys(manifest.out_of_scope_tables || {}));

  const onlyLive = [...livePairs].filter((pair) => {
    const table = pair.slice(0, pair.lastIndexOf('.'));
    return !manifestPairs.has(pair) && !outOfScope.has(table);
  });
  const onlyManifest = [...manifestPairs].filter((pair) => !livePairs.has(pair));
  const doubleClassified = [...outOfScope].filter((t) =>
    Object.prototype.hasOwnProperty.call(manifest.tables || {}, t)
  );

  const pass = onlyLive.length === 0 && onlyManifest.length === 0 && doubleClassified.length === 0;
  return { pass, onlyLive, onlyManifest, doubleClassified };
}

// ─── PER-ROW SCAN ────────────────────────────────────────────────────────────

/** Best-effort human-readable row label for FAIL messages (diagnostic only). */
function rowLabel(table, row) {
  if (row.id != null) return `${table}#${row.id}`;
  if (row.project_id != null && row.path != null) return `${table}[${row.project_id}:${row.path}]`;
  if (row.project_id != null && row.topic != null) return `${table}[${row.project_id}:${row.topic}]`;
  if (row.project_id != null && row.doc_id != null) return `${table}[${row.project_id}:${row.doc_id}]`;
  if (row.name != null) return `${table}[${row.name}]`;
  return `${table}[unindexed row]`;
}

const MIN_WORDS_FOR_ECONOMY_CHECK = 4; // guard against noisy density on tiny strings

/**
 * Decide + run the checks for one (row, column). Returns an array of
 * `{ check, reason }` failure objects (empty if the cell passes or is
 * empty/null — nothing to check).
 */
function checkCell(manifest, table, column, colDef, row) {
  const raw = row[column];
  if (raw == null) return [];
  const text = String(raw);
  if (text.trim() === '') return [];

  const tableDef = manifest.tables[table];
  const authCol = tableDef.authoring_mode_column;

  let requireEconomy;
  let rowMode = null;
  if (colDef.class === 'mandatory-caveman-no-column') {
    requireEconomy = true; // body_caveman — no escape hatch, ever (K-9).
  } else if (!authCol) {
    requireEconomy = true; // no authoring_mode column on this table at all — always-caveman.
  } else {
    rowMode = row[authCol]; // null | 'caveman' | 'verbose'
    requireEconomy = rowMode === 'caveman'; // NULL (grandfathered) or 'verbose' -> exempt (§3.6/§3.5 step 3).
  }

  const failures = [];

  // FIDELITY (K-7) — always, every classified column, every row.
  const trunc = lint.detectTruncation(text);
  if (trunc.truncated) {
    failures.push({
      check: 'fidelity',
      reason: `looks truncated mid-token (${trunc.smells.join(', ')}) — K-7: full-content coverage, not early-substring survival`,
    });
  }

  // ECONOMY (K-5, ARM3-style) — only when required, and only when there's
  // enough text to measure density meaningfully.
  if (requireEconomy) {
    const words = lint.wordTokens(text);
    if (words.length >= MIN_WORDS_FOR_ECONOMY_CHECK) {
      const ratio = lint.functionWordRatio(text);
      if (ratio > lint.CAVEMAN_FW_RATIO_CEILING) {
        failures.push({
          check: 'economy',
          reason: `function-word ratio ${(ratio * 100).toFixed(1)}% exceeds the ${(lint.CAVEMAN_FW_RATIO_CEILING * 100).toFixed(0)}% caveman ceiling — not telegraphic (K-5: no synthetic-baseline comparison, density-ceiling only)`,
        });
      }
    }
  }

  return failures.map((f) => ({ ...f, class: colDef.class, requireEconomy, rowMode }));
}

/**
 * Scan every checked column of one table. Returns
 * `{ scanned: number, failures: object[] }`.
 */
async function scanTable(client, manifest, table) {
  const tableDef = manifest.tables[table];
  const checkedCols = Object.entries(tableDef.columns).filter(
    ([, def]) => def.class !== 'exempt-not-model-authored'
  );
  if (checkedCols.length === 0) return { scanned: 0, failures: [] };

  // Table/column identifiers here come exclusively from our own committed
  // manifest (never request input) — safe to interpolate as a quoted ident.
  const { rows } = await client.query(`SELECT * FROM "${table}"`);

  const failures = [];
  for (const row of rows) {
    for (const [col, def] of checkedCols) {
      const cellFailures = checkCell(manifest, table, col, def, row);
      for (const f of cellFailures) {
        failures.push({ ...f, table, column: col, row: rowLabel(table, row) });
      }
    }
  }
  return { scanned: rows.length, failures };
}

// ─── TOP-LEVEL GATE ──────────────────────────────────────────────────────────

/**
 * Full gate run against an already-provisioned target database. Pure
 * verifier — never applies schema, never seeds data.
 *
 * @param {string} targetDbName
 * @returns {Promise<{pass:boolean, completeness:object, tableResults:object[], totalScanned:number, failures:object[]}>}
 */
async function runGate(targetDbName) {
  const manifest = loadManifest();
  const client = await shared.connect(targetDbName);
  try {
    const completeness = await checkCompleteness(client, manifest);

    const tableResults = [];
    let totalScanned = 0;
    const failures = [];

    // Per-row scanning only makes sense once the manifest is known-accurate
    // against this target's live schema — a stale manifest invalidates
    // every per-row result computed against it.
    if (completeness.pass) {
      for (const table of Object.keys(manifest.tables)) {
        const r = await scanTable(client, manifest, table);
        totalScanned += r.scanned;
        failures.push(...r.failures);
        tableResults.push({ table, scanned: r.scanned, failed: r.failures.length });
      }
    }

    const pass = completeness.pass && failures.length === 0;
    return { pass, completeness, tableResults, totalScanned, failures };
  } finally {
    await client.end();
  }
}

/**
 * The verify-15-t7-caveman-economy.js contract: run(targetDbName) -> boolean.
 * Prints a human-readable report to stdout/stderr; returns/never throws for
 * an ordinary gate failure (throws only on infrastructure error — DB
 * unreachable, manifest missing/malformed — matching the wrapper's own
 * try/catch around gateModule.run()).
 *
 * @param {string} targetDbName
 * @returns {Promise<boolean>}
 */
async function run(targetDbName) {
  console.log(`[caveman-economy-store-wide] target="${targetDbName}"`);
  const result = await runGate(targetDbName);

  const c = result.completeness;
  console.log(`  completeness (K-8): ${c.pass ? 'PASS' : 'FAIL'}`);
  if (!c.pass) {
    if (c.onlyLive.length) console.log(`    unclassified-LOUD-FAIL (live, not in manifest): ${c.onlyLive.join(', ')}`);
    if (c.onlyManifest.length) console.log(`    stale manifest entries (not live): ${c.onlyManifest.join(', ')}`);
    if (c.doubleClassified.length) console.log(`    double-classified tables (both scoped and out-of-scope): ${c.doubleClassified.join(', ')}`);
  }

  console.log(`  rows scanned: ${result.totalScanned} across ${result.tableResults.length} table(s)`);
  for (const t of result.tableResults) {
    if (t.failed > 0) console.log(`    ${t.table}: scanned=${t.scanned} FAILED=${t.failed}`);
  }
  for (const f of result.failures) {
    console.log(`  FAIL [${f.check}] ${f.table}.${f.column} (${f.row}, class=${f.class}): ${f.reason}`);
  }

  console.log(`RESULT: ${result.pass ? 'PASS' : 'FAIL'}`);
  return result.pass;
}

// ─── CLI: self-contained CI smoke run ───────────────────────────────────────
//
// See module doc comment: with no --db, provisions + drops its own scratch
// `_staging`-suffixed database rather than ever touching the real
// memory_manager_staging (repo-wide test convention).

const { spawnSync } = require('child_process');
// pg lives in scripts/node_modules — resolve via createRequire anchored to
// scripts/package.json, same portable pattern as ns-harness.js and every
// test/migrations/*.js fixture harness (never a bare require('pg') from
// outside the scripts/ tree).
const { createRequire } = require('module');
const scriptsRequire = createRequire(require.resolve('../../scripts/package.json'));
const { Client } = scriptsRequire('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'scripts', 'migrations');
const MIGRATE01 = path.join(MIGRATIONS_DIR, 'migrate-01-canonical-db.js');
const ADDENDA = path.join(MIGRATIONS_DIR, 'migrate-schema-addenda.js');
const MIGRATE13 = path.join(MIGRATIONS_DIR, 'migrate-13-agent-exchange.js');
const MIGRATE14 = path.join(MIGRATIONS_DIR, 'migrate-14-seam-tables.js');
const MIGRATE15 = path.join(MIGRATIONS_DIR, 'migrate-15-mcp-addenda.js');
const MIGRATE16 = path.join(MIGRATIONS_DIR, 'migrate-16-caveman-addenda.js');

function runScript(scriptPath, args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

/** Apply the full §5 schema stack this gate needs against `dbName`. Throws
 * (with stdout/stderr context) on any step failure. Exported for reuse by
 * this gate's own test suite (test/migrations/test-caveman-gate-store-wide.js). */
async function provisionSchema(dbName) {
  const steps = [
    ['migrate-01-canonical-db', MIGRATE01],
    ['migrate-schema-addenda', ADDENDA],
    ['migrate-13-agent-exchange', MIGRATE13],
    ['migrate-14-seam-tables', MIGRATE14],
    ['migrate-15-mcp-addenda', MIGRATE15],
    ['migrate-16-caveman-addenda', MIGRATE16],
  ];
  for (const [label, scriptPath] of steps) {
    const r = runScript(scriptPath, ['--db', dbName]);
    if (r.status !== 0) {
      throw new Error(`${label} fixture setup failed for "${dbName}": status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
  }

  // own_graph_migration_ids (§6.1(c), PRs #171/#174) + memory_entries.
  // project_id / memory_entry_chunks.project_id (§6.1(d), PRs #170/#175)
  // landed in the manifest (caveman-columns.json) after this stack was
  // first written — same-change gap closed 2026-08-16. Neither is
  // provisioned via a plain schema-only migrate-*.js CLI step the way the
  // six above are:
  //   - own_graph_migration_ids's canonical DDL lives in verify15-
  //     shared.js's applyDdl() (shared, by reference, with every other §15
  //     battery-infra table — migration_manifest, containment_evidence,
  //     etc.) — reused here directly rather than invoking the full
  //     migrate-verify-own-graph.js data-migration script, which requires
  //     a --source-db and performs a real row-by-row migration; nothing
  //     this scratch/empty DB needs for a SCHEMA-shape fixture.
  //   - migrate-03-corpus-project-id.js is a real-estate-wide DISCOVERY +
  //     backfill script (enumerates ALL of pg_database, walks the
  //     filesystem project-marker tree) — wildly inappropriate to invoke
  //     against one throwaway scratch DB. Its schema-only effect (`ALTER
  //     TABLE ... ADD COLUMN IF NOT EXISTS project_id TEXT`, migrate-03's
  //     own statement, verified against its source) is replicated directly
  //     below instead. The scratch DB starts with zero corpus rows, so
  //     there is nothing to backfill.
  const client = new Client(shared.pgConfig(dbName));
  await client.connect();
  try {
    await shared.applyDdl(client);
    await client.query('ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS project_id TEXT');
    await client.query('ALTER TABLE memory_entry_chunks ADD COLUMN IF NOT EXISTS project_id TEXT');
  } finally {
    await client.end();
  }
}

async function dropScratchDb(dbName) {
  let sys;
  try {
    sys = new Client(shared.pgConfig('postgres'));
    await sys.connect();
    await sys.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await sys.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (_) {
    /* best-effort */
  } finally {
    if (sys) { try { await sys.end(); } catch (_) {} }
  }
}

async function cliMain() {
  const argv = process.argv.slice(2);
  const dbFlagIdx = argv.indexOf('--db');
  const explicitDb = dbFlagIdx >= 0 ? argv[dbFlagIdx + 1] : null;

  if (explicitDb) {
    console.log(`test-caveman-economy-store-wide: explicit --db "${explicitDb}" — scanning as-is (no provisioning).`);
    const ok = await run(explicitDb);
    process.exit(ok ? 0 : 1);
    return;
  }

  // No --db: self-contained CI smoke run against a throwaway scratch DB.
  const dbName = `caveman_storewide_${Date.now()}_staging`;
  console.log(`test-caveman-economy-store-wide: no --db given — provisioning scratch DB "${dbName}".`);
  let ok = false;
  try {
    await provisionSchema(dbName);
    ok = await run(dbName);
  } finally {
    await dropScratchDb(dbName);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  cliMain().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
}

module.exports = {
  AUTHORED_BY,
  run,
  runGate,
  loadManifest,
  checkCompleteness,
  scanTable,
  checkCell,
  rowLabel,
  provisionSchema,
  dropScratchDb,
  MANIFEST_PATH,
  VALID_CLASSES,
};
