'use strict';

const AUTHORED_BY = 'sonnet-t-battery-author-2026-07-27';

/**
 * verify-15-t7-caveman-economy.js — T7, caveman-economy gate (§15.2).
 *
 * Per spec: migrated text passes the GENERALIZED caveman lint (§3.5's
 * `test-caveman-economy-store-wide.js`), pointed at memory_manager_staging —
 * reuse/extend that gate, do NOT write a parallel one.
 *
 * PREREQUISITE NOT YET BUILT: as of this battery's authorship, only
 * test/north-star/test-caveman-economy.js exists in this repo — the
 * close-payload 3-arm gate (single-session-close scope). The STORE-WIDE
 * gate §3.5 describes (a lint over the ENTIRE target database's migrated
 * text, not one session's close payload) does not exist yet; building it is
 * OUT OF SCOPE for this task (a separate, larger piece of work — §3.5's own
 * section, not §15's acceptance battery).
 *
 * Per this canon's total-classification posture — an unlisted/missing
 * dependency fails LOUD, never silently passes, and this script explicitly
 * refuses to write a parallel/narrower lint as a workaround (the spec's own
 * "reuse/extend, do not write a parallel one" instruction) — this wrapper
 * REQUIRES the store-wide gate as a Node module (never shells it out — this
 * battery's child_process usage is confined to verify-15-acceptance.js
 * only, per this codebase's os-portability convention) and calls its
 * exported `run(targetDbName)` function. If the module is absent, or is
 * present but does not export `run`, this wrapper EXITS NON-ZERO with a
 * clear "prerequisite not built" message. If/when §3.5's store-wide gate is
 * built at one of the candidate paths below and exports `run`, this wrapper
 * picks it up automatically — no changes needed here.
 *
 * Usage: node scripts/migrations/verify-15-t7-caveman-economy.js [--db <target>]
 * Exit codes: 0 = store-wide gate found AND its run() resolved truthy,
 * 1 = store-wide gate not found / does not export run() (prerequisite
 * unmet), OR it ran and returned/threw failure.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./lib/verify15-shared');

const PROJECT_ROOT = path.resolve(shared.MIGRATIONS_DIR, '..', '..');

// Candidate module paths for §3.5's store-wide gate, checked in order. Kept
// explicit (not a glob/discovery scan) so a file dropped somewhere
// unexpected still trips the "not found" branch rather than being silently
// missed by a scan that only looked in the "right" place.
const STORE_WIDE_GATE_CANDIDATES = [
  path.join(PROJECT_ROOT, 'test', 'north-star', 'test-caveman-economy-store-wide.js'),
  path.join(PROJECT_ROOT, 'scripts', 'test-caveman-economy-store-wide.js'),
];

function findStoreWideGateModule() {
  return STORE_WIDE_GATE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const { name: target, source } = await shared.resolveAndClassifyTargetDb(argv);
  console.log(`verify-15-t7-caveman-economy: target="${target}" (resolved from ${source})`);

  const gatePath = findStoreWideGateModule();
  if (!gatePath) {
    console.error('[T7] FAIL: prerequisite §3.5 store-wide caveman-economy gate not built.');
    console.error('  Checked candidate paths:');
    for (const p of STORE_WIDE_GATE_CANDIDATES) console.error(`    - ${path.relative(PROJECT_ROOT, p)}`);
    console.error('  Per spec, this wrapper reuses/extends that gate rather than writing a');
    console.error('  parallel one — until §3.5 lands, T7 cannot pass and must not silently skip.');
    process.exit(1);
  }

  let gateModule;
  try {
    gateModule = require(gatePath);
  } catch (err) {
    console.error(`[T7] FAIL: found ${path.relative(PROJECT_ROOT, gatePath)} but it failed to load: ${err.message}`);
    process.exit(1);
  }
  if (typeof gateModule.run !== 'function') {
    console.error(`[T7] FAIL: found ${path.relative(PROJECT_ROOT, gatePath)} but it does not export a run(targetDbName) function — prerequisite not met.`);
    process.exit(1);
  }

  console.log(`[T7] found store-wide gate at ${path.relative(PROJECT_ROOT, gatePath)} — running run("${target}").`);
  let ok = false;
  try {
    ok = await gateModule.run(target);
  } catch (err) {
    console.error(`[T7] FAIL: store-wide gate threw: ${err.message}`);
    process.exit(1);
  }
  if (!ok) console.error('[T7] FAIL: store-wide gate reported failure.');
  else console.log('[T7] OK: store-wide gate passed.');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { AUTHORED_BY, findStoreWideGateModule, STORE_WIDE_GATE_CANDIDATES };
