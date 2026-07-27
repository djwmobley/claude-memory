'use strict';

/**
 * test-host-agnostic-naming.js — Regression suite for #135 (host-agnostic naming
 * generalization): the marker rename + legacy read-fallback, the HANDOFF_BASE_DIR
 * and HANDOFF_PROMOTION_FILE env-var overrides, and the predicate-rename data
 * migration's collision-safety.
 *
 * Coverage:
 *   S1      Repo-sweep: no file outside handoff-paths.js (and an explicit,
 *           commented exemption list) may hand-roll the os.homedir()+'.claude'
 *           base-dir pattern that handoff-paths.js exists to centralize. Total
 *           classification, not an allow-list of known-bad files: every hit is
 *           either on the exemption list (with a stated reason) or the sweep
 *           fails — a new 10th such file can never be silently added. Matches
 *           on the co-occurrence of `os.homedir()` and the literal fragment
 *           `.claude` within a small line window, independent of quote style
 *           or path.join vs string-concatenation — see testS1_noHandRolledBaseDir
 *           for the documented limits of that detection.
 *   M1-M7   Dual-marker same-directory classification (project-marker.js):
 *           only-new, only-legacy, both-same-uuid, both-different-uuid (HARD
 *           ERROR, proof-of-firing), both-corrupt (HARD ERROR, proof-of-firing),
 *           per-level walk-up (nearer directory wins regardless of marker name),
 *           write-time collision check against BOTH names (proof-of-firing).
 *   B1-B14  HANDOFF_BASE_DIR validation matrix (handoff-paths.js resolveBaseDir):
 *           unset/empty/whitespace-only default; win32 drive-letter accepted;
 *           win32 MSYS-trap rejected (proof-of-firing); win32 non-absolute
 *           rejected; POSIX absolute accepted; POSIX relative rejected
 *           (proof-of-firing); POSIX Windows-style rejected; surrounding
 *           whitespace trimmed consistently for both the validity check and
 *           the actual path join; '..' traversal rejected on both win32 and
 *           POSIX absolute forms (proof-of-firing — a drive-letter-rooted or
 *           POSIX-absolute value can still climb outside the intended
 *           directory), while a legitimate directory name containing '..' as
 *           a substring within one segment (not its own segment) is accepted.
 *   P1-P12  HANDOFF_PROMOTION_FILE validation matrix (handoff-paths.js
 *           resolvePromotionFilePath): unset/empty/whitespace-only default;
 *           valid custom name accepted; reserved-name collisions rejected
 *           case-insensitively (marker, legacy marker, handoff.md) — each a
 *           proof-of-firing case; leading/trailing whitespace rejected
 *           (proof-of-firing); path separators and '..' segments rejected
 *           (proof-of-firing); absolute path rejected; a '..'-prefixed but
 *           non-traversal filename accepted; on-disk case-collision reuses
 *           the existing casing instead of the raw env value.
 *   D1-D3   Predicate migration collision-safety (schema DO block in
 *           handoff-core-schema.sql): a subject with BOTH an old-name and a
 *           new-name LIVE row survives the schema (re-)apply without a unique
 *           violation. Step 2 of the migration renames EVERY row (live or
 *           suppressed) to the new predicate name, so both rows end up under
 *           the new name — distinguished by `object` — with the former
 *           old-name row left suppressed and the former new-name row
 *           untouched; a subject with ONLY an old-name row gets renamed in
 *           place and stays live; re-applying the schema a second time is a
 *           clean no-op (idempotent).
 *
 * Usage:
 *   node scripts/test-host-agnostic-naming.js
 *
 * M/B/P tests are pure unit/filesystem tests — no Postgres required.
 * D tests require Postgres (claude_memory_eval_test) — SKIPPED (not failed)
 * if unavailable, matching the convention in test-schema-suppression-kind.js.
 * Exit 0 = all tests passed (or skipped). Exit 1 = any failure.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  MARKER_FILENAME,
  LEGACY_MARKER_FILENAME,
  findProjectRootByMarker,
  readMarker,
  persistMarker,
  mintUUID,
} = require('./lib/project-marker');
const { writeMarkerAtomic } = require('./lib/project-identity');
const { resolveBaseDir, resolveHandoffMdPath, resolvePromotionFilePath, DEFAULT_PROMOTION_FILENAME } =
  require('./lib/handoff-paths');

// ── Tracking ───────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }
function skip(label, reason) { console.log(`SKIP  ${label} (${reason})`); }

// ── Filesystem helpers ─────────────────────────────────────────────────────────

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `c135-${prefix}-`));
}

function rmTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function writeRawMarker(dir, filename, contents) {
  fs.writeFileSync(path.join(dir, filename), contents, 'utf8');
}

function validMarkerJson(uuid) {
  return JSON.stringify({ uuid, created_at: new Date().toISOString(), schema_version: 1 }, null, 2) + '\n';
}

// ── Env-var save/restore helper ────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Temporarily override process.platform for the duration of fn(), so the
 * win32/POSIX branches of resolveBaseDir() can both be exercised
 * deterministically in a single CI run regardless of the host OS actually
 * running this suite. This mocks an environment characteristic for the test;
 * it is not a platform branch in production or test *behavior* (P3's static
 * scan looks for `process.platform === 'win32'` conditionals, which this is
 * not — it is a property redefinition).
 */
function withPlatform(platform, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

// ── S1: Repo-sweep — no hand-rolled os.homedir()+'.claude' base-dir duplicate ──

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SWEEP_DIRS    = [
  path.join(PROJECT_ROOT, 'scripts'),
  path.join(PROJECT_ROOT, 'hooks'),
  path.join(PROJECT_ROOT, 'test'),
];
const HANDOFF_PATHS_JS = path.join(PROJECT_ROOT, 'scripts', 'lib', 'handoff-paths.js');

/**
 * EXEMPTION LIST — every file where `os.homedir()` legitimately co-occurs with
 * the literal fragment `.claude` WITHOUT going through handoff-paths.js. Each
 * entry states WHY it is not a duplicate of the HANDOFF_BASE_DIR concept.
 * This list is the ONLY escape hatch from the sweep below — adding a file here
 * without a real justification defeats the purpose of the gate.
 */
const SWEEP_EXEMPTIONS = [
  {
    file: HANDOFF_PATHS_JS,
    reason: 'This IS the resolver. Its default branch and its own doc comments ' +
            'are the canonical single source of truth the rest of the repo must ' +
            'import — not a duplicate of itself.',
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'lib', 'encoded-cwd.js'),
    reason: "getClaudeProjectDir() resolves Claude Code's OWN session-transcript " +
            'storage location (~/.claude/projects/<encoded-cwd>/), read by the ' +
            'separate pipeline-memory-loader.js chunker subsystem — not our ' +
            'handoff.md. HANDOFF_BASE_DIR governs OUR file; honoring it here would ' +
            "make this function stop finding Claude Code's real transcripts.",
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'install.js'),
    reason: 'Installs the /handoff:* slash-command files to ~/.claude/commands/handoff/ ' +
            '— a Claude-Code-only concept (other MCP clients have no slash-command ' +
            'directory convention at all) and out of #135\'s scope, which covers ' +
            'handoff.md / the project marker / the promotion file, not command install location.',
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'pipeline-memory-loader.js'),
    reason: "Reads Claude Code's GLOBAL ~/.claude/CLAUDE.md (the user-level preferences " +
            'file, a distinct concept from our PROJECT-level promotion file governed by ' +
            'HANDOFF_PROMOTION_FILE). Out of scope for the project-level path resolvers.',
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'sync-hooks.js'),
    reason: 'Deploys hook files to ~/.claude/hooks/ (the documented live hook deploy ' +
            'target per hooks/README.md) — deployment tooling for a Claude-Code-only ' +
            'directory, unrelated to handoff.md storage.',
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'test-host-agnostic-naming.js'),
    reason: 'This file. Its B-series assertions must independently compute the REAL ' +
            'default (os.homedir()+.claude) to assert resolveBaseDir() returns exactly ' +
            'that when HANDOFF_BASE_DIR is unset — it is the test oracle, not a duplicate.',
  },
  {
    file: path.join(PROJECT_ROOT, 'test', 'eval', 'eval-retrieval.js'),
    reason: 'Stages fixture files at getClaudeProjectDir(tempCwd)+"/memory" so that ' +
            'pipeline-memory-loader.js (itself exempt, see encoded-cwd.js above) finds ' +
            'them at the exact real-homedir location it hardcodes. Routing this through ' +
            'HANDOFF_BASE_DIR would desync it from the unmodified loader and break the test ' +
            'the moment HANDOFF_BASE_DIR is set — this is deliberately NOT the handoff.md concept.',
  },
  {
    file: path.join(PROJECT_ROOT, 'scripts', 'test-install-engine-path.js'),
    reason: "Comment-only mention describing install.js's os.homedir() usage; no path " +
            'is actually constructed here.',
  },
  {
    file: path.join(PROJECT_ROOT, 'hooks', 'agent-adversary-floor.js'),
    reason: 'Comment-only mention ("not a hardcoded personal path, and not an ' +
            'os.homedir()") describing what the code does NOT do; no path is ' +
            'actually constructed here.',
  },
];

function collectJsFilesForSweep(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.claude') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFilesForSweep(full));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * S1 — Repo-sweep for the hand-rolled os.homedir()+'.claude' base-dir pattern.
 *
 * Detection is on the SEMANTIC co-occurrence of `os.homedir()` and the literal
 * fragment `.claude` within a small line window (default: the same line, or
 * up to 3 lines below — covers a path.join(...) call split across lines) —
 * NOT on one exact syntactic shape. This is deliberate: a narrower regex tied
 * to a specific quote style or path.join specifically is exactly the kind of
 * allow-list-of-spellings a differently-written 10th offender could evade.
 * See the function-level comment on testS1 in the test file's header for the
 * documented limit of this approach (a window, not full semantic analysis).
 */
function findHandRolledBaseDirHits(dirs = SWEEP_DIRS, exemptions = SWEEP_EXEMPTIONS) {
  const allFiles = dirs.flatMap(collectJsFilesForSweep);
  const exemptSet = new Set(exemptions.map((e) => e.file));
  const hits = [];

  for (const filePath of allFiles) {
    if (exemptSet.has(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/os\.homedir\(\)/.test(lines[i])) continue;
      // Skip pure comment lines (// or leading * in a block comment) — the
      // sweep targets executable code, not prose that happens to mention the
      // API name (matches the convention in test-os-portability.js's P2/P3).
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const windowEnd = Math.min(lines.length, i + 4);
      const window = lines.slice(i, windowEnd).join('\n');
      if (window.includes('.claude')) {
        hits.push({ file: filePath, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

function testS1_noHandRolledBaseDir() {
  const label = 'S1 (repo-sweep): no hand-rolled os.homedir()+.claude base-dir pattern outside handoff-paths.js or an exempted file';
  try {
    // Sanity: the exemption list itself must point at real files — an exemption
    // for a typo'd or deleted path would silently exempt nothing while looking
    // like coverage.
    const missingExemptions = SWEEP_EXEMPTIONS.filter((e) => !fs.existsSync(e.file));
    if (missingExemptions.length > 0) {
      fail(label, `exemption list references non-existent file(s): ${JSON.stringify(missingExemptions.map((e) => e.file))}`);
      return;
    }

    const hits = findHandRolledBaseDirHits();
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${path.relative(PROJECT_ROOT, h.file)}:${h.line}: ${h.text}`).join('\n');
      fail(label, `hand-rolled os.homedir()+.claude pattern found outside handoff-paths.js and the exemption list:\n${detail}\n` +
        `  Fix: import resolveHandoffMdPath/resolveBaseDir from scripts/lib/handoff-paths.js, ` +
        `or add a justified entry to SWEEP_EXEMPTIONS in this file.`);
      return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); }
}

// PROOF-OF-FIRING: exercises the REAL findHandRolledBaseDirHits() (not a
// re-implemented copy of its predicate) against a synthetic tree, so this
// test cannot silently drift out of sync with the actual detector.
function testS1b_sweepFiresOnPlantedDuplicate() {
  const label = 'S1b (proof-of-firing): findHandRolledBaseDirHits() detects a freshly planted hand-rolled duplicate';
  const dir = makeTempDir('s1b-sweep');
  try {
    fs.writeFileSync(
      path.join(dir, 'planted.js'),
      "const p = path.join(os.homedir(), '.claude', 'projects', id, 'handoff.md');\n",
      'utf8'
    );
    const hits = findHandRolledBaseDirHits([dir], []); // no exemptions — must fire
    if (hits.length !== 1) {
      fail(label, `expected exactly 1 hit against the planted file, got ${hits.length}: ${JSON.stringify(hits)}`);
      return;
    }
    if (!hits[0].file.endsWith('planted.js')) {
      fail(label, `hit did not point at the planted file: ${JSON.stringify(hits[0])}`);
      return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING (variant spellings): the co-occurrence predicate must not be
// tied to one exact syntactic shape (double quotes, string concatenation, a
// multi-line path.join split across lines) — a narrow single-shape regex is
// exactly the allow-list-of-spellings this sweep exists to avoid.
function testS1c_sweepFiresOnSpellingVariants() {
  const label = 'S1c (proof-of-firing): sweep detects double-quote, concatenation, and multi-line variants';
  const dir = makeTempDir('s1c-sweep');
  try {
    fs.writeFileSync(path.join(dir, 'double-quotes.js'),
      'const p = path.join(os.homedir(), ".claude", "projects", id);\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'concat.js'),
      "const p = os.homedir() + '/.claude/projects/' + id;\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'multiline.js'),
      "const p = path.join(\n  os.homedir(),\n  '.claude',\n  'projects',\n  id\n);\n", 'utf8');

    const hits = findHandRolledBaseDirHits([dir], []);
    const hitFiles = new Set(hits.map((h) => path.basename(h.file)));
    const missing = ['double-quotes.js', 'concat.js', 'multiline.js'].filter((f) => !hitFiles.has(f));
    if (missing.length > 0) {
      fail(label, `sweep missed spelling variant(s): ${JSON.stringify(missing)} (hits: ${JSON.stringify(hits)})`);
      return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// ── M1-M7: Dual-marker same-directory classification ──────────────────────────

function testM1_onlyNew() {
  const label = 'M1: only new-name marker present — recognized';
  const dir = makeTempDir('m1');
  try {
    const uuid = mintUUID();
    persistMarker(dir, uuid);
    const marker = readMarker(dir);
    if (!marker || marker.uuid !== uuid) { fail(label, `expected uuid ${uuid}, got ${marker && marker.uuid}`); return; }
    if (findProjectRootByMarker(dir) !== dir) { fail(label, 'findProjectRootByMarker did not resolve dir'); return; }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

function testM2_onlyLegacy() {
  const label = 'M2: only legacy .claude-memory marker present — read-fallback recognized';
  const dir = makeTempDir('m2');
  try {
    const uuid = mintUUID();
    writeRawMarker(dir, LEGACY_MARKER_FILENAME, validMarkerJson(uuid));
    const marker = readMarker(dir);
    if (!marker || marker.uuid !== uuid) { fail(label, `expected uuid ${uuid}, got ${marker && marker.uuid}`); return; }
    if (findProjectRootByMarker(dir) !== dir) { fail(label, 'findProjectRootByMarker did not resolve dir'); return; }
    // No rewrite, no dual-write: the new-name file must NOT have been created.
    if (fs.existsSync(path.join(dir, MARKER_FILENAME))) {
      fail(label, 'read-fallback must not auto-write the new-name marker'); return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

function testM3_bothSameUuid() {
  const label = 'M3: both markers present, SAME uuid — recognized, reads the new-name file';
  const dir = makeTempDir('m3');
  try {
    const uuid = mintUUID();
    writeRawMarker(dir, MARKER_FILENAME, validMarkerJson(uuid));
    writeRawMarker(dir, LEGACY_MARKER_FILENAME, validMarkerJson(uuid));
    const marker = readMarker(dir);
    if (!marker || marker.uuid !== uuid) { fail(label, `expected uuid ${uuid}, got ${marker && marker.uuid}`); return; }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING: this is the case the branch exists to catch.
function testM4_bothDifferentUuid_hardError() {
  const label = 'M4 (proof-of-firing): both markers present, DIFFERENT uuids — HARD ERROR naming both paths';
  const dir = makeTempDir('m4');
  try {
    const uuidNew = mintUUID();
    const uuidOld = mintUUID();
    writeRawMarker(dir, MARKER_FILENAME, validMarkerJson(uuidNew));
    writeRawMarker(dir, LEGACY_MARKER_FILENAME, validMarkerJson(uuidOld));

    let threw = false, msg = '';
    try { readMarker(dir); } catch (err) { threw = true; msg = err.message; }
    if (!threw) { fail(label, 'readMarker did not throw on differing uuids — silently picked one'); return; }

    const newPath = path.join(dir, MARKER_FILENAME);
    const oldPath = path.join(dir, LEGACY_MARKER_FILENAME);
    if (!msg.includes(newPath) || !msg.includes(oldPath)) {
      fail(label, `error message must name BOTH absolute paths; got: ${msg}`); return;
    }

    // findProjectRootByMarker must ALSO throw (inline check, C2) — not defer.
    let threw2 = false;
    try { findProjectRootByMarker(dir); } catch (_) { threw2 = true; }
    if (!threw2) { fail(label, 'findProjectRootByMarker did not throw — dual check not inline'); return; }

    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING: either-corrupt branch.
function testM5_bothPresentOneCorrupt_hardError() {
  const label = 'M5 (proof-of-firing): both markers present, one corrupt — HARD ERROR naming both paths';
  const dir = makeTempDir('m5');
  try {
    const uuidNew = mintUUID();
    writeRawMarker(dir, MARKER_FILENAME, validMarkerJson(uuidNew));
    writeRawMarker(dir, LEGACY_MARKER_FILENAME, 'not valid json{{{');

    let threw = false, msg = '';
    try { readMarker(dir); } catch (err) { threw = true; msg = err.message; }
    if (!threw) { fail(label, 'readMarker did not throw when the legacy marker is corrupt'); return; }

    const newPath = path.join(dir, MARKER_FILENAME);
    const oldPath = path.join(dir, LEGACY_MARKER_FILENAME);
    if (!msg.includes(newPath) || !msg.includes(oldPath)) {
      fail(label, `error message must name BOTH absolute paths; got: ${msg}`); return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

function testM6_perLevelWalkUp_childWins() {
  const label = 'M6: per-level walk-up — nearer directory wins regardless of marker name (parent new, child legacy)';
  const parent = makeTempDir('m6-parent');
  const child  = path.join(parent, 'child');
  try {
    fs.mkdirSync(child, { recursive: true });
    const parentUuid = mintUUID();
    const childUuid   = mintUUID();
    writeRawMarker(parent, MARKER_FILENAME, validMarkerJson(parentUuid));
    writeRawMarker(child, LEGACY_MARKER_FILENAME, validMarkerJson(childUuid));

    const root = findProjectRootByMarker(child);
    if (root !== child) { fail(label, `expected nearest dir ${child}, got ${root}`); return; }
    const marker = readMarker(root);
    if (!marker || marker.uuid !== childUuid) { fail(label, `expected child uuid ${childUuid}, got ${marker && marker.uuid}`); return; }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(parent); }
}

// PROOF-OF-FIRING: write-time collision check must be a TOTAL two-name check
// (C10) — pre-existing LEGACY marker alone must still block a new-name write.
function testM7_writeTimeCollision_legacyBlocksNewWrite() {
  const label = 'M7 (proof-of-firing): writeMarkerAtomic refuses to write when ONLY the legacy marker exists';
  const dir = makeTempDir('m7');
  try {
    const legacyUuid = mintUUID();
    writeRawMarker(dir, LEGACY_MARKER_FILENAME, validMarkerJson(legacyUuid));

    let threw = false, msg = '';
    try { writeMarkerAtomic(dir); } catch (err) { threw = true; msg = err.message; }
    if (!threw) { fail(label, 'writeMarkerAtomic wrote a NEW marker despite an existing legacy marker — C10 violated'); return; }
    if (!/already exists/i.test(msg)) { fail(label, `expected "already exists" error, got: ${msg}`); return; }

    // No new-name marker must have been created (no dual-write).
    if (fs.existsSync(path.join(dir, MARKER_FILENAME))) {
      fail(label, 'a new-name marker was created despite the throw — dual-write occurred'); return;
    }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// Symmetric sanity check: pre-existing NEW marker also blocks a second write
// (covers the "only new" half of the total two-name check).
function testM7b_writeTimeCollision_newBlocksNewWrite() {
  const label = 'M7b: writeMarkerAtomic refuses to write when the new-name marker already exists';
  const dir = makeTempDir('m7b');
  try {
    const uuid = mintUUID();
    persistMarker(dir, uuid);

    let threw = false;
    try { writeMarkerAtomic(dir); } catch (_) { threw = true; }
    if (!threw) { fail(label, 'writeMarkerAtomic did not throw on an existing new-name marker'); return; }
    pass(label);
  } catch (err) { fail(label, err.message); } finally { rmTempDir(dir); }
}

// ── B1-B10: HANDOFF_BASE_DIR validation matrix ────────────────────────────────

function testB_unsetDefault() {
  const label = 'B1: HANDOFF_BASE_DIR unset — defaults to os.homedir()/.claude';
  withEnv({ HANDOFF_BASE_DIR: undefined }, () => {
    const got = resolveBaseDir();
    const want = path.join(os.homedir(), '.claude');
    if (got !== want) { fail(label, `expected ${want}, got ${got}`); return; }
    pass(label);
  });
}

function testB_emptyDefault() {
  const label = 'B2: HANDOFF_BASE_DIR="" — trimmed-empty treated as unset, defaults';
  withEnv({ HANDOFF_BASE_DIR: '' }, () => {
    const got = resolveBaseDir();
    const want = path.join(os.homedir(), '.claude');
    if (got !== want) { fail(label, `expected ${want}, got ${got}`); return; }
    pass(label);
  });
}

function testB_whitespaceOnlyDefault() {
  const label = 'B3: HANDOFF_BASE_DIR="   " (whitespace-only) — trimmed-empty treated as unset, defaults';
  withEnv({ HANDOFF_BASE_DIR: '   ' }, () => {
    const got = resolveBaseDir();
    const want = path.join(os.homedir(), '.claude');
    if (got !== want) { fail(label, `expected ${want}, got ${got}`); return; }
    pass(label);
  });
}

function testB_win32DriveLetterAccepted() {
  const label = 'B4: HANDOFF_BASE_DIR=C:\\Users\\x\\.claude on win32 — accepted verbatim';
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: 'C:\\Users\\x\\.claude' }, () => {
      let got;
      try { got = resolveBaseDir(); } catch (err) { fail(label, `unexpected throw: ${err.message}`); return; }
      if (got !== 'C:\\Users\\x\\.claude') { fail(label, `expected verbatim value, got ${got}`); return; }
      pass(label);
    });
  });
}

function testB_win32ForwardSlashDriveAccepted() {
  const label = 'B5: HANDOFF_BASE_DIR=C:/Users/x/.claude on win32 (forward slash) — accepted';
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: 'C:/Users/x/.claude' }, () => {
      let got;
      try { got = resolveBaseDir(); } catch (err) { fail(label, `unexpected throw: ${err.message}`); return; }
      if (got !== 'C:/Users/x/.claude') { fail(label, `expected verbatim value, got ${got}`); return; }
      pass(label);
    });
  });
}

// PROOF-OF-FIRING: the MSYS trap this check exists to catch.
function testB_win32MsysTrapRejected() {
  const label = 'B6 (proof-of-firing): HANDOFF_BASE_DIR=/c/Users/x/.claude on win32 (MSYS trap) — HARD ERROR';
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: '/c/Users/x/.claude' }, () => {
      // Sanity: this value DOES pass a naive path.isAbsolute() check — that is
      // exactly why isAbsolute() alone is documented as insufficient.
      if (!path.isAbsolute('/c/Users/x/.claude')) {
        fail(label, 'test premise broken: /c/Users/x/.claude is not path.isAbsolute() on this Node build'); return;
      }
      let threw = false, msg = '';
      try { resolveBaseDir(); } catch (err) { threw = true; msg = err.message; }
      if (!threw) { fail(label, 'resolveBaseDir() accepted the MSYS-style path on win32 — trap not caught'); return; }
      if (!/MSYS|drive-letter/i.test(msg)) { fail(label, `error message should explain the MSYS trap; got: ${msg}`); return; }
      pass(label);
    });
  });
}

function testB_win32NonAbsoluteRejected() {
  const label = 'B7 (proof-of-firing): HANDOFF_BASE_DIR=relative/path on win32 — HARD ERROR';
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: 'relative\\path' }, () => {
      let threw = false;
      try { resolveBaseDir(); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolveBaseDir() accepted a relative path on win32'); return; }
      pass(label);
    });
  });
}

function testB_posixAbsoluteAccepted() {
  const label = 'B8: HANDOFF_BASE_DIR=/home/x/.claude on POSIX — accepted';
  withPlatform('linux', () => {
    withEnv({ HANDOFF_BASE_DIR: '/home/x/.claude' }, () => {
      let got;
      try { got = resolveBaseDir(); } catch (err) { fail(label, `unexpected throw: ${err.message}`); return; }
      if (got !== '/home/x/.claude') { fail(label, `expected verbatim value, got ${got}`); return; }
      pass(label);
    });
  });
}

// PROOF-OF-FIRING: POSIX relative path.
function testB_posixRelativeRejected() {
  const label = 'B9 (proof-of-firing): HANDOFF_BASE_DIR=relative/path on POSIX — HARD ERROR';
  withPlatform('linux', () => {
    withEnv({ HANDOFF_BASE_DIR: 'relative/path' }, () => {
      let threw = false;
      try { resolveBaseDir(); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolveBaseDir() accepted a relative path on POSIX'); return; }
      pass(label);
    });
  });
}

function testB_posixWindowsStyleRejected() {
  const label = 'B10 (proof-of-firing): HANDOFF_BASE_DIR=C:\\Users\\x on POSIX — HARD ERROR (does not start with /)';
  withPlatform('linux', () => {
    withEnv({ HANDOFF_BASE_DIR: 'C:\\Users\\x' }, () => {
      let threw = false;
      try { resolveBaseDir(); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolveBaseDir() accepted a Windows-style path on POSIX'); return; }
      pass(label);
    });
  });
}

function testB_surroundingWhitespaceTrimmedConsistently() {
  const label = 'B11: HANDOFF_BASE_DIR with surrounding whitespace — same trimmed value used for check AND join';
  withPlatform('linux', () => {
    withEnv({ HANDOFF_BASE_DIR: '  /home/x/.claude  ' }, () => {
      let got;
      try { got = resolveBaseDir(); } catch (err) { fail(label, `unexpected throw: ${err.message}`); return; }
      if (got !== '/home/x/.claude') { fail(label, `expected trimmed value '/home/x/.claude', got ${JSON.stringify(got)}`); return; }
      // resolveHandoffMdPath must build on the trimmed value too (no raw-untrimmed leak).
      const handoffPath = resolveHandoffMdPath('some-project-id');
      if (handoffPath.includes('  ')) { fail(label, `handoff.md path leaked untrimmed whitespace: ${handoffPath}`); return; }
      pass(label);
    });
  });
}

// PROOF-OF-FIRING: the exact reviewer-constructed input — a drive-letter-rooted,
// absolute-per-the-earlier-check value that still climbs out via '..' segments.
function testB_win32DotDotTraversalRejected() {
  const label = "B12 (proof-of-firing): HANDOFF_BASE_DIR=C:\\Users\\x\\.claude\\..\\..\\Windows\\System32 on win32 — HARD ERROR ('..' traversal)";
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: 'C:\\Users\\x\\.claude\\..\\..\\Windows\\System32' }, () => {
      let threw = false, msg = '';
      try { resolveBaseDir(); } catch (err) { threw = true; msg = err.message; }
      if (!threw) { fail(label, "resolveBaseDir() accepted a drive-letter-rooted value containing '..' segments — traversal not caught"); return; }
      if (!/\.\./.test(msg)) { fail(label, `error message should mention the '..' segment; got: ${msg}`); return; }
      pass(label);
    });
  });
}

// PROOF-OF-FIRING: the same class of input in its POSIX-absolute form.
function testB_posixDotDotTraversalRejected() {
  const label = "B13 (proof-of-firing): HANDOFF_BASE_DIR=/home/x/.claude/../../etc on POSIX — HARD ERROR ('..' traversal)";
  withPlatform('linux', () => {
    withEnv({ HANDOFF_BASE_DIR: '/home/x/.claude/../../etc' }, () => {
      let threw = false;
      try { resolveBaseDir(); } catch (_) { threw = true; }
      if (!threw) { fail(label, "resolveBaseDir() accepted a POSIX-absolute value containing '..' segments — traversal not caught"); return; }
      pass(label);
    });
  });
}

// A legitimate directory name containing consecutive dots as a SUBSTRING
// (not a standalone '..' segment) must NOT false-positive — the check is
// segment-wise, not a substring match.
function testB_consecutiveDotsSubstringAccepted() {
  const label = "B14: HANDOFF_BASE_DIR=C:\\Users\\x\\my..dir ('..' as a substring within one segment, not its own segment) — accepted";
  withPlatform('win32', () => {
    withEnv({ HANDOFF_BASE_DIR: 'C:\\Users\\x\\my..dir' }, () => {
      let got;
      try { got = resolveBaseDir(); } catch (err) { fail(label, `unexpected throw on a legitimate '..'-substring directory name: ${err.message}`); return; }
      if (got !== 'C:\\Users\\x\\my..dir') { fail(label, `expected verbatim value, got ${got}`); return; }
      pass(label);
    });
  });
}

// ── P1-P12: HANDOFF_PROMOTION_FILE validation matrix ──────────────────────────

function testP_unsetDefault() {
  const label = 'P1: HANDOFF_PROMOTION_FILE unset — defaults to CLAUDE.md';
  const dir = makeTempDir('p1');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: undefined }, () => {
      const got = resolvePromotionFilePath(dir);
      if (got !== path.join(dir, DEFAULT_PROMOTION_FILENAME)) { fail(label, `unexpected path: ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

function testP_emptyDefault() {
  const label = 'P2: HANDOFF_PROMOTION_FILE="" — trimmed-empty treated as unset, defaults';
  const dir = makeTempDir('p2');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: '' }, () => {
      const got = resolvePromotionFilePath(dir);
      if (got !== path.join(dir, DEFAULT_PROMOTION_FILENAME)) { fail(label, `unexpected path: ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

function testP_whitespaceOnlyDefault() {
  const label = 'P3: HANDOFF_PROMOTION_FILE="   " — trimmed-empty treated as unset, defaults';
  const dir = makeTempDir('p3');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: '   ' }, () => {
      const got = resolvePromotionFilePath(dir);
      if (got !== path.join(dir, DEFAULT_PROMOTION_FILENAME)) { fail(label, `unexpected path: ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

function testP_validCustomNameAccepted() {
  const label = 'P4: HANDOFF_PROMOTION_FILE=NOTES.md — accepted';
  const dir = makeTempDir('p4');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: 'NOTES.md' }, () => {
      const got = resolvePromotionFilePath(dir);
      if (got !== path.join(dir, 'NOTES.md')) { fail(label, `unexpected path: ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING x4: each reserved name, case-insensitively.
function testP_reservedNameRejected(labelSuffix, envValue) {
  const label = `P5-8 (proof-of-firing): HANDOFF_PROMOTION_FILE=${envValue} (${labelSuffix}) — HARD ERROR`;
  const dir = makeTempDir('p-reserved');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: envValue }, () => {
      let threw = false;
      try { resolvePromotionFilePath(dir); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolvePromotionFilePath() accepted a reserved name'); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING: leading/trailing whitespace must be rejected, not silently trimmed.
function testP_trailingWhitespaceRejected() {
  const label = 'P9 (proof-of-firing): HANDOFF_PROMOTION_FILE="NOTES.md " (trailing space) — HARD ERROR';
  const dir = makeTempDir('p9');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: 'NOTES.md ' }, () => {
      let threw = false;
      try { resolvePromotionFilePath(dir); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolvePromotionFilePath() silently accepted trailing whitespace'); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

function testP_leadingWhitespaceRejected() {
  const label = 'P10 (proof-of-firing): HANDOFF_PROMOTION_FILE=" NOTES.md" (leading space) — HARD ERROR';
  const dir = makeTempDir('p10');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: ' NOTES.md' }, () => {
      let threw = false;
      try { resolvePromotionFilePath(dir); } catch (_) { threw = true; }
      if (!threw) { fail(label, 'resolvePromotionFilePath() silently accepted leading whitespace'); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

// PROOF-OF-FIRING: separators and '..' segments and absolute paths.
function testP_pathLikeValuesRejected() {
  const label = 'P11 (proof-of-firing): HANDOFF_PROMOTION_FILE path-like values — all HARD ERROR';
  const dir = makeTempDir('p11');
  try {
    const badValues = [
      'sub/NOTES.md',
      'sub\\NOTES.md',
      '..',
      '../NOTES.md',
      '/etc/passwd',
      'C:\\NOTES.md',
    ];
    const notThrown = [];
    for (const v of badValues) {
      withEnv({ HANDOFF_PROMOTION_FILE: v }, () => {
        let threw = false;
        try { resolvePromotionFilePath(dir); } catch (_) { threw = true; }
        if (!threw) notThrown.push(v);
      });
    }
    if (notThrown.length > 0) { fail(label, `accepted path-like value(s): ${JSON.stringify(notThrown)}`); return; }
    pass(label);
  } finally { rmTempDir(dir); }
}

function testP_dotDotPrefixedNonTraversalAccepted() {
  const label = "P12: HANDOFF_PROMOTION_FILE=..config (dot-dot PREFIX, not a full '..' segment) — accepted";
  const dir = makeTempDir('p12');
  try {
    withEnv({ HANDOFF_PROMOTION_FILE: '..config' }, () => {
      let got;
      try { got = resolvePromotionFilePath(dir); } catch (err) { fail(label, `unexpected throw: ${err.message}`); return; }
      if (got !== path.join(dir, '..config')) { fail(label, `unexpected path: ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

function testP_caseCollisionReusesOnDiskCasing() {
  const label = 'P13: on-disk case-collision reuses existing casing instead of the raw env value';
  const dir = makeTempDir('p13');
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), '# existing\n', 'utf8');
    withEnv({ HANDOFF_PROMOTION_FILE: 'NOTES.md' }, () => {
      const got = resolvePromotionFilePath(dir);
      const want = path.join(dir, 'notes.md'); // reuse ON-DISK casing, not the raw 'NOTES.md'
      if (got !== want) { fail(label, `expected on-disk casing reused (${want}), got ${got}`); return; }
      pass(label);
    });
  } finally { rmTempDir(dir); }
}

// ── D1-D3: Predicate migration collision-safety (Postgres) ───────────────────

async function isPgAvailable() {
  try {
    const { Client } = require('pg');
    const c = new Client({
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432', 10),
      user:     process.env.PGUSER     || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: 'claude_memory_eval_test',
    });
    await c.connect();
    await c.end();
    return true;
  } catch (_) {
    return false;
  }
}

async function runMigrationTests() {
  const pgAvail = await isPgAvailable();
  if (!pgAvail) {
    skip('D1-D3: predicate migration collision-safety', 'Postgres unavailable');
    return;
  }

  const { Client } = require('pg');
  const SCHEMA_SQL = fs.readFileSync(
    path.join(__dirname, 'sql', 'handoff-core-schema.sql'), 'utf8'
  );
  const TEST_SCHEMA = `c135_migration_test_${Date.now()}`;
  const PROJECT_ID  = 'test-c135-migration';

  let db;
  try {
    db = new Client({
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432', 10),
      user:     process.env.PGUSER     || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: 'claude_memory_eval_test',
    });
    await db.connect();
    await db.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await db.query(`SET search_path TO "${TEST_SCHEMA}"`);

    // First apply: fresh schema (predicate migration is a no-op — no old-name rows yet).
    await db.query(SCHEMA_SQL);

    // Seed:
    //   subject 'collide' — BOTH old-name and new-name LIVE rows (the collision case).
    //   subject 'legacy-only' — ONLY an old-name LIVE row (plain rename case).
    async function insertRow(subject, predicate, object) {
      await db.query(
        `INSERT INTO assertions (project_id, subject, predicate, object, confidence, source, suppressed)
         VALUES ($1, $2, $3, $4, 8, 'user_stated', false)`,
        [PROJECT_ID, subject, predicate, object]
      );
    }
    await insertRow('collide', 'are_safe_outside_claude-memory', 'old-value');
    await insertRow('collide', 'are_safe_outside_this_project',  'new-value');
    await insertRow('legacy-only', 'are_safe_outside_claude-memory', 'legacy-value');

    // D1: re-apply the schema (runs the migration DO block against live dual-name rows).
    const labelD1 = 'D1: predicate migration — dual-live-row subject survives schema re-apply with no unique violation';
    try {
      await db.query(SCHEMA_SQL);
      pass(labelD1);
    } catch (err) {
      fail(labelD1, `schema re-apply threw (collision-safety not honored): ${err.message}`);
      return; // remaining assertions are meaningless if the migration itself failed
    }

    // D2: the 'collide' subject — BOTH rows end up under the new predicate name
    // (the migration renames every row, live or suppressed, in step 2), but the
    // former old-name row must be the one left suppressed, and the former
    // new-name row must be untouched. Distinguish them by `object` (the
    // predicate string alone can no longer tell them apart post-rename).
    const labelD2 = "D2: predicate migration — 'collide' subject: former old-name row suppressed, former new-name row untouched, both under the new predicate, exactly 1 live row";
    {
      const { rows } = await db.query(
        `SELECT predicate, object, suppressed, suppression_kind FROM assertions
         WHERE project_id = $1 AND subject = 'collide' ORDER BY object`,
        [PROJECT_ID]
      );
      const formerOldRow = rows.find((r) => r.object === 'old-value');
      const formerNewRow = rows.find((r) => r.object === 'new-value');
      const liveCount = rows.filter((r) => r.suppressed === false).length;
      const allRenamed = rows.every((r) => r.predicate === 'are_safe_outside_this_project');

      if (!allRenamed) {
        fail(labelD2, `not every row was renamed to the new predicate: ${JSON.stringify(rows)}`);
      } else if (!formerOldRow || formerOldRow.suppressed !== true || formerOldRow.suppression_kind !== 'superseded') {
        fail(labelD2, `former old-name row not correctly suppressed: ${JSON.stringify(formerOldRow)}`);
      } else if (!formerNewRow || formerNewRow.suppressed !== false) {
        fail(labelD2, `former new-name row was modified: ${JSON.stringify(formerNewRow)}`);
      } else if (liveCount !== 1) {
        fail(labelD2, `expected exactly 1 live row for 'collide', got ${liveCount}`);
      } else {
        pass(labelD2);
      }
    }

    // D3: the 'legacy-only' subject — renamed in place, stays live.
    const labelD3 = "D3: predicate migration — 'legacy-only' subject: renamed to new predicate, stays live";
    {
      const { rows } = await db.query(
        `SELECT predicate, object, suppressed FROM assertions
         WHERE project_id = $1 AND subject = 'legacy-only'`,
        [PROJECT_ID]
      );
      if (rows.length !== 1) {
        fail(labelD3, `expected exactly 1 row for 'legacy-only', got ${rows.length}`);
      } else if (rows[0].predicate !== 'are_safe_outside_this_project' || rows[0].suppressed !== false || rows[0].object !== 'legacy-value') {
        fail(labelD3, `row not correctly renamed: ${JSON.stringify(rows[0])}`);
      } else {
        pass(labelD3);
      }
    }

    // D4: idempotency — re-applying the schema AGAIN is a clean no-op (no error, no drift).
    const labelD4 = 'D4: predicate migration — second re-apply is idempotent (no error, counts stable)';
    try {
      await db.query(SCHEMA_SQL);
      const { rows: afterRows } = await db.query(
        `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1`,
        [PROJECT_ID]
      );
      const n = parseInt(afterRows[0].n, 10);
      if (n !== 3) { fail(labelD4, `expected 3 total rows after second re-apply, got ${n}`); }
      else { pass(labelD4); }
    } catch (err) {
      fail(labelD4, `second re-apply threw: ${err.message}`);
    }
  } catch (err) {
    fail('D1-D3: predicate migration collision-safety (setup)', err.message);
  } finally {
    if (db) {
      try {
        await db.query('SET search_path TO public');
        await db.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      } catch (_) {}
      try { await db.end(); } catch (_) {}
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== test-host-agnostic-naming.js (#135) ===\n');

  testS1_noHandRolledBaseDir();
  testS1b_sweepFiresOnPlantedDuplicate();
  testS1c_sweepFiresOnSpellingVariants();

  testM1_onlyNew();
  testM2_onlyLegacy();
  testM3_bothSameUuid();
  testM4_bothDifferentUuid_hardError();
  testM5_bothPresentOneCorrupt_hardError();
  testM6_perLevelWalkUp_childWins();
  testM7_writeTimeCollision_legacyBlocksNewWrite();
  testM7b_writeTimeCollision_newBlocksNewWrite();

  testB_unsetDefault();
  testB_emptyDefault();
  testB_whitespaceOnlyDefault();
  testB_win32DriveLetterAccepted();
  testB_win32ForwardSlashDriveAccepted();
  testB_win32MsysTrapRejected();
  testB_win32NonAbsoluteRejected();
  testB_posixAbsoluteAccepted();
  testB_posixRelativeRejected();
  testB_posixWindowsStyleRejected();
  testB_surroundingWhitespaceTrimmedConsistently();
  testB_win32DotDotTraversalRejected();
  testB_posixDotDotTraversalRejected();
  testB_consecutiveDotsSubstringAccepted();

  testP_unsetDefault();
  testP_emptyDefault();
  testP_whitespaceOnlyDefault();
  testP_validCustomNameAccepted();
  testP_reservedNameRejected('exact new marker name', MARKER_FILENAME);
  testP_reservedNameRejected('legacy marker name, different case', LEGACY_MARKER_FILENAME.toUpperCase());
  testP_reservedNameRejected('handoff.md, different case', 'HANDOFF.MD');
  testP_reservedNameRejected('new marker name, different case', MARKER_FILENAME.toUpperCase());
  testP_trailingWhitespaceRejected();
  testP_leadingWhitespaceRejected();
  testP_pathLikeValuesRejected();
  testP_dotDotPrefixedNonTraversalAccepted();
  testP_caseCollisionReusesOnDiskCasing();

  await runMigrationTests();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
