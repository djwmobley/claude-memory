'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t0-roster-completeness.js — companion to T0 (§15.2, closes the
 * rest of V-1).
 *
 * T0 (verify-15-t0-roster.js) proves every roster entry has migration_manifest
 * coverage. It says NOTHING about whether the roster itself is complete
 * against the schema sections it claims to derive from — the roster's own
 * header comment asserts "cross-referenced against §1/§5.3/§9/§17/§18," but
 * nothing MACHINE-CHECKS that cross-reference; it is a hand-maintained
 * artifact whose completeness rests on self-attestation, the same failure
 * shape A-1 closed one layer down.
 *
 * This script diffs scripts/migrations/source-table-roster.json's
 * targetTable set against scripts/migrations/inventory-manifest.json — a
 * second, DELIBERATELY SEPARATE hand-maintained file enumerating every table
 * name §5.3's 13 absorbed-seam list, §9's four interop tables, §17's two
 * routing tables, and §18's two telemetry tables actually declare — in BOTH
 * directions:
 *   1. every inventory-manifest.json table has >=1 matching roster entry
 *   2. every roster entry's targetTable is either in inventory-manifest.json
 *      OR is one of the pre-existing §5.1/§5.2 graph-core/corpus tables that
 *      inventory-manifest.json is deliberately scoped to exclude (a bounded,
 *      documented boundary — NOT a silent allow-list: anything outside both
 *      sets is flagged)
 *
 * Either direction failing is a LOUD FAIL — this does not make the roster
 * itself machine-generated (future work, flagged rather than claimed done);
 * it makes the roster's claimed completeness against the schema sections a
 * CHECKED fact instead of an assertion.
 *
 * Pure file-diff — no database connection required or made.
 *
 * Usage: node scripts/migrations/verify-15-t0-roster-completeness.js
 * Exit codes: 0 = PASS, 1 = FAIL.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./lib/verify15-shared');

// Pre-existing graph-core / corpus tables (§5.1/§5.2, already schema'd by
// migrate-01-canonical-db.js's four SQL files). inventory-manifest.json is
// deliberately scoped to ONLY §5.3/§9/§17/§18 (per this battery's own task
// definition) — a roster entry pointing at one of these (e.g. a markdown
// source mapped to memory_entries, per §15.2's markdown-coverage note) is
// legitimately absent from inventory-manifest.json and must not be flagged.
const PRE_EXISTING_CORE_TABLES = new Set([
  'entities', 'assertions', 'edges', 'retrieval_contract',
  'retrieval_contract_history', 'project_settings', 'entity_communities',
  'extraction_queue', 'retrieval_events', 'retrieval_event_assertions',
  'memory_entries', 'memory_entry_chunks',
]);

// INVENTORY_MANIFEST env override exists ONLY for test/migrations/test-verify-15.js
// to exercise both mismatch directions against a crafted, deliberately-wrong
// inventory file without mutating the real (committed) inventory-manifest.json.
// Production use always resolves the committed file.
function loadInventory() {
  const p = process.env.INVENTORY_MANIFEST || path.join(shared.MIGRATIONS_DIR, 'inventory-manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    console.error(`FATAL: could not read inventory-manifest.json at "${p}": ${err.message}`);
    process.exit(1);
  }
  const data = JSON.parse(raw);
  if (!data.tables || !Array.isArray(data.tables)) {
    console.error(`FATAL: inventory-manifest.json at "${p}" has no "tables" array.`);
    process.exit(1);
  }
  return new Set(data.tables.map((t) => t.targetTable));
}

function checkCompleteness(roster, inventory) {
  const rosterTargets = new Set(roster.map((e) => e.targetTable));

  const missingFromRoster = [...inventory].filter((t) => !rosterTargets.has(t)).sort();
  const extraInRoster = [...rosterTargets]
    .filter((t) => !inventory.has(t) && !PRE_EXISTING_CORE_TABLES.has(t))
    .sort();

  return { missingFromRoster, extraInRoster, rosterTargets, inventory };
}

function main() {
  const roster = shared.loadRoster();
  const inventory = loadInventory();
  const { missingFromRoster, extraInRoster } = checkCompleteness(roster, inventory);

  let failed = false;
  if (missingFromRoster.length) {
    failed = true;
    console.error('[T0-completeness] FAIL: inventory-manifest.json table(s) with NO roster entry:');
    for (const t of missingFromRoster) console.error(`  - ${t}`);
  }
  if (extraInRoster.length) {
    failed = true;
    console.error('[T0-completeness] FAIL: roster targetTable(s) not declared in inventory-manifest.json and not a known pre-existing core table:');
    for (const t of extraInRoster) console.error(`  - ${t}`);
  }
  if (!failed) {
    console.log(`[T0-completeness] OK: roster and inventory-manifest.json cross-reference cleanly (${inventory.size} inventory tables checked).`);
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { AUTHORED_BY, PRE_EXISTING_CORE_TABLES, loadInventory, checkCompleteness };
