'use strict';

// schema-classify.js — total classification of scripts/sql/*.sql for the
// generalized schema bring-forward engine (cm#185).
//
// Design (per the cm#185 amended spec, R-2/R-3/R-5/R-9):
//   - Enumeration ALWAYS reads the filesystem: a non-recursive readdir of
//     scripts/sql/, case-folded *.sql matching, rejecting directories/
//     symlinks/non-regular entries. Enumeration drives inclusion-of-unknowns.
//   - A required-minimum roster (schema-manifest.json's required_roster)
//     drives absence detection: roster \ enumerated = loud error.
//   - Classification comes from an in-file first-lines header directive
//     ('-- handoff:dialect postgres' | '-- handoff:dialect sqlite' |
//     '-- handoff:excluded <reason>') CROSS-CHECKED against the tracked
//     manifest (scripts/sql/schema-manifest.json). The manifest supplies
//     classification + expected-objects metadata ONLY -- it is never used
//     to drive enumeration (an enumerated-but-unmanifested file is still a
//     loud error, not a silent skip).
//   - Total classification: every enumerated .sql file must resolve to
//     EXACTLY ONE of postgres | sqlite | excluded, with the header
//     directive and the manifest classification agreeing. Any of the
//     following is a loud, non-fatal (caller decides) classification
//     error: enumerated-but-unclassified, roster-but-absent, header/
//     manifest disagreement, basename collision after case-fold,
//     non-regular/dir/symlink entry, a *.sql file enumerated but not
//     present in schema-manifest.json or the required roster (manifest ∪
//     roster is the complete allowed set — see PR #262 review round 3 note
//     below for why this is now unconditional, not just a no-.git fallback).
//   - 'apply-for-both' is not a legal classification (R-9) -- the manifest
//     schema enforces single-dialect or excluded only (validated below).
//
// PR #262 review round 3 (perf): this used to additionally cross-check via
// a `git ls-files` subprocess spawn, falling back to manifest ∪ roster only
// when no .git directory was present. That git check's UNIQUE value over
// the manifest ∪ roster check alone was narrow (catching a file whose name
// matches a manifest entry but was never `git add`ed) and its own
// correctness cannot be captured by a simple file-stat signature (the git
// INDEX can change — a file gets committed — with zero effect on that
// file's own mtime/size), which would have made the memoization below
// either wrong (a stale "untracked" verdict surviving past the commit that
// tracked it) or required tracking un-cacheable git-index state. Dropped
// entirely: enumeration is already a plain directory read (this module's
// own enumerateSqlDir), and the "is this enumerated file expected"
// question is fully answered by manifest ∪ roster with no git dependency
// at all — removing the spawn also removes the dominant cost
// classifySchemaFiles paid on every call before this memoization existed.
//
// Also new in review round 3: classifySchemaFiles's result is memoized at
// module level, keyed on (engineRoot, a stat signature of schema-manifest.json
// + every *.sql-matching directory entry: path+size+mtimeMs+type). A cache
// hit skips BOTH the (now-removed) subprocess spawn and the per-file
// content parse/desync-check work — status previously paid the full
// classification cost on every touch even though the schema files
// virtually never change within one process's lifetime. The stat
// signature is recomputed (cheap: one readdir + N lstat calls, no content
// reads) on every call regardless of cache state, so a long-lived process
// (e.g. handoff-mcp.mjs's stdio server) still sees an edited schema file
// on its very next call — never a stale classification held past a real
// on-disk change.
//
// Exports:
//   classifySchemaFiles({ engineRoot }) -> {
//     ok: boolean,                 // true iff errors.length === 0
//     errors: string[],            // human-readable, one per problem found
//     manifest: object,            // parsed schema-manifest.json
//     unitsByDialect: {
//       postgres: [{ basename, fullPath, order }...],  // sorted by order then basename
//       sqlite:   [{ basename, fullPath, order }...],
//     },
//     allFiles: [{ basename, fullPath }...],  // every enumerated *.sql file
//   }

const fs = require('fs');
const path = require('path');

const SQL_DIRNAME = 'sql';
const MANIFEST_BASENAME = 'schema-manifest.json';
const VALID_CLASSIFICATIONS = new Set(['postgres', 'sqlite', 'excluded']);

// Recognizes the in-file header directive on its own line, anywhere within
// the first HEADER_SCAN_LINES non-blank lines of the file (comments-only
// preamble; the spec's "first-lines header directive" — files open with a
// block comment banner of varying length, so we scan a small window rather
// than requiring line 1 exactly).
const HEADER_SCAN_LINES = 12;
const DIALECT_RE   = /^--\s*handoff:dialect\s+(postgres|sqlite)\s*$/i;
const EXCLUDED_RE  = /^--\s*handoff:excluded\s+(.+)$/i;

/**
 * Strip a leading UTF-8 BOM and normalize CRLF/CR -> LF.
 * Mirrors the content-normalization rule used by the fingerprint (R-3).
 */
function normalizeContent(raw) {
  let s = raw;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return s;
}

/**
 * Parse the header directive from a file's (normalized) content.
 * Returns { kind: 'dialect', value: 'postgres'|'sqlite' } |
 *         { kind: 'excluded', value: '<reason text>' } |
 *         { kind: null } (no directive found in the scan window).
 */
function parseHeaderDirective(normalizedContent) {
  const lines = normalizedContent.split('\n').slice(0, HEADER_SCAN_LINES);
  for (const line of lines) {
    const dm = line.match(DIALECT_RE);
    if (dm) return { kind: 'dialect', value: dm[1].toLowerCase() };
    const em = line.match(EXCLUDED_RE);
    if (em) return { kind: 'excluded', value: em[1].trim() };
  }
  return { kind: null, value: null };
}

/**
 * Non-recursive enumeration of engineRoot/scripts/sql/*.sql.
 * Rejects directories, symlinks, and any non-regular dirent.
 * Case-folds the extension match (.SQL, .Sql, etc. all match).
 * Returns { files: [{ basename, fullPath }...], errors: string[],
 *           rawNames: string[] } — rawNames is EVERY *.sql-matching dirent
 * name regardless of type (symlink/dir included), for the memoization
 * cache's stat signature (PR #262 review round 3): a newly-added symlink
 * is filtered out of `files` but must still invalidate the cache, since
 * re-classifying it is exactly what would surface its own rejection error
 * on the next real (non-cached) pass.
 */
function enumerateSqlDir(sqlDir) {
  const errors = [];
  const files = [];
  const rawNames = [];
  let entries;
  try {
    entries = fs.readdirSync(sqlDir, { withFileTypes: true });
  } catch (err) {
    errors.push(`cannot read schema directory ${sqlDir}: ${err.message}`);
    return { files, errors, rawNames };
  }
  for (const ent of entries) {
    const isSqlExt = /\.sql$/i.test(ent.name);
    if (!isSqlExt) continue;
    rawNames.push(ent.name);
    if (ent.isSymbolicLink()) {
      errors.push(`${ent.name}: symlink entries are not permitted in scripts/sql/ (rejected, not applied)`);
      continue;
    }
    if (!ent.isFile()) {
      errors.push(`${ent.name}: non-regular directory entry in scripts/sql/ (rejected, not applied)`);
      continue;
    }
    files.push({ basename: ent.name, fullPath: path.join(sqlDir, ent.name) });
  }
  return { files, errors, rawNames };
}

// ── Memoization (PR #262 review round 3) ───────────────────────────────────
//
// Keyed by engineRoot (a test suite calling classifySchemaFiles against
// several different scratch engineRoots within one process must never see
// one root's cached result leak into another's).
const _classifyCache = new Map(); // engineRoot -> { signature: Map<path,string>, result }

/**
 * Cheap stat signature for the manifest + every enumerated *.sql dirent:
 * one lstatSync per path (no content read). lstatSync (not statSync) so a
 * symlink's OWN mtime/type is what's compared — never dereferenced — and a
 * broken symlink never throws here (statSync would).
 */
function _computeStatSignature(manifestPath, sqlDir, rawNames) {
  const sig = new Map();
  for (const p of [manifestPath, ...rawNames.map((n) => path.join(sqlDir, n))]) {
    try {
      const st = fs.lstatSync(p);
      sig.set(p, `${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'L' : st.isDirectory() ? 'D' : 'F'}`);
    } catch (_) {
      sig.set(p, 'MISSING');
    }
  }
  return sig;
}

/** Two stat signatures are equal iff they cover the same path set with identical values. */
function _signaturesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

/** Escape a string for literal use inside a RegExp. */
function _escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `identifier` appear as a whole word (\b-bounded, case-insensitive)
 * anywhere in `sql`? A cheap textual sanity check — NOT a DDL parser. It
 * exists solely to catch a manifest/DDL desync (adversary finding #1,
 * BLOCKER): a schema-manifest.json hand-edit (typo, rename, phantom entry)
 * with no corresponding SQL change. Since the schema fingerprint hashes only
 * the SQL files' bytes (never schema-manifest.json), such a desync leaves
 * the fingerprint 'current' forever while every touch's expected-objects
 * probe finds the phantom object "missing" — without this check, that flows
 * straight into the apply-retry branch (a no-op re-apply, since the SQL
 * didn't change) and BLOCKs every command forever on a manifest typo that
 * has nothing to do with the live database's actual state.
 */
function _identifierAppearsInSQL(sql, identifier) {
  const re = new RegExp('\\b' + _escapeRegExp(identifier) + '\\b', 'i');
  return re.test(sql);
}

/**
 * Cross-check one classified unit's own manifest entry (expected_objects +
 * pgvector_gated) against that SAME unit's own SQL text. Pushes one error
 * per entry with no textual match — a classification_error, never allowed
 * to silently pass through as a live "missing on this DB" finding (see
 * _identifierAppearsInSQL's doc for why this distinction matters).
 * Excluded units carry neither expected_objects nor pgvector_gated, so the
 * loops below are no-ops for them.
 */
function _checkManifestEntryAgainstOwnSQL(basename, normalizedSQL, manifestEntry, errors) {
  const eo = manifestEntry.expected_objects || {};
  for (const t of (eo.tables || [])) {
    if (!_identifierAppearsInSQL(normalizedSQL, t)) {
      errors.push(
        `${basename}: schema-manifest.json expected_objects.tables entry "${t}" has no textual match in ` +
        `this unit's own SQL — manifest/DDL desync (classification_error)`
      );
    }
  }
  for (const c of (eo.columns || [])) {
    if (!_identifierAppearsInSQL(normalizedSQL, c.column)) {
      errors.push(
        `${basename}: schema-manifest.json expected_objects.columns entry "${c.table}.${c.column}" — column ` +
        `"${c.column}" has no textual match in this unit's own SQL — manifest/DDL desync (classification_error)`
      );
    }
  }
  for (const idx of (eo.indexes || [])) {
    if (!_identifierAppearsInSQL(normalizedSQL, idx)) {
      errors.push(
        `${basename}: schema-manifest.json expected_objects.indexes entry "${idx}" has no textual match in ` +
        `this unit's own SQL — manifest/DDL desync (classification_error)`
      );
    }
  }
  const gated = manifestEntry.pgvector_gated;
  if (gated && Array.isArray(gated.columns)) {
    for (const c of gated.columns) {
      if (!_identifierAppearsInSQL(normalizedSQL, c.column)) {
        errors.push(
          `${basename}: schema-manifest.json pgvector_gated.columns entry "${c.table}.${c.column}" — column ` +
          `"${c.column}" has no textual match in this unit's own SQL — manifest/DDL desync (classification_error)`
        );
      }
    }
  }

  // FK follow-up (cm#185-schema-heal FK extension, F1): same desync guard,
  // extended to expected_fks — table, EVERY declared local column, ref_table,
  // and EVERY declared ref_column must each textually appear in this unit's
  // own SQL. A typo in any one of these must fail at classification time
  // (loud, non-fatal) — never silently become a permanent DEGRADED row from
  // an FK identity that can never match the live catalog.
  const expectedFks = Array.isArray(manifestEntry.expected_fks) ? manifestEntry.expected_fks : [];
  for (const fk of expectedFks) {
    const parts = [
      ['table', fk.table],
      ...((Array.isArray(fk.columns) ? fk.columns : []).map((c) => ['columns', c])),
      ['ref_table', fk.ref_table],
      ...((Array.isArray(fk.ref_columns) ? fk.ref_columns : []).map((c) => ['ref_columns', c])),
    ];
    for (const [field, identifier] of parts) {
      if (typeof identifier !== 'string' || !_identifierAppearsInSQL(normalizedSQL, identifier)) {
        errors.push(
          `${basename}: schema-manifest.json expected_fks entry (table="${fk.table}") — ${field} value ` +
          `"${identifier}" has no textual match in this unit's own SQL — manifest/DDL desync (manifest_desync)`
        );
      }
    }
  }

  // cm#185-schema-heal constraint extension: same desync guard for
  // expected_uniques/expected_not_nulls/expected_checks/expected_index_defs
  // — every table/columns/expression token declared must textually appear
  // in this unit's own SQL, or a manifest hand-edit (typo/rename/phantom)
  // fails loudly at classification time (manifest_desync) instead of
  // becoming a permanent DEGRADED row the live database can never satisfy.
  const expectedUniques = Array.isArray(manifestEntry.expected_uniques) ? manifestEntry.expected_uniques : [];
  for (const u of expectedUniques) {
    const parts = [
      ['table', u.table],
      ...((Array.isArray(u.columns) ? u.columns : []).map((c) => ['columns', c])),
    ];
    for (const [field, identifier] of parts) {
      if (typeof identifier !== 'string' || !_identifierAppearsInSQL(normalizedSQL, identifier)) {
        errors.push(
          `${basename}: schema-manifest.json expected_uniques entry (table="${u.table}") — ${field} value ` +
          `"${identifier}" has no textual match in this unit's own SQL — manifest/DDL desync (manifest_desync)`
        );
      }
    }
  }

  const expectedNotNulls = Array.isArray(manifestEntry.expected_not_nulls) ? manifestEntry.expected_not_nulls : [];
  for (const nn of expectedNotNulls) {
    for (const [field, identifier] of [['table', nn.table], ['column', nn.column]]) {
      if (typeof identifier !== 'string' || !_identifierAppearsInSQL(normalizedSQL, identifier)) {
        errors.push(
          `${basename}: schema-manifest.json expected_not_nulls entry (table="${nn.table}") — ${field} value ` +
          `"${identifier}" has no textual match in this unit's own SQL — manifest/DDL desync (manifest_desync)`
        );
      }
    }
  }

  const expectedChecks = Array.isArray(manifestEntry.expected_checks) ? manifestEntry.expected_checks : [];
  for (const ck of expectedChecks) {
    const parts = [
      ['table', ck.table],
      ...((Array.isArray(ck.expression_tokens) ? ck.expression_tokens : []).map((t) => ['expression_tokens', t])),
    ];
    for (const [field, identifier] of parts) {
      if (typeof identifier !== 'string' || !_identifierAppearsInSQL(normalizedSQL, identifier)) {
        errors.push(
          `${basename}: schema-manifest.json expected_checks entry (table="${ck.table}") — ${field} value ` +
          `"${identifier}" has no textual match in this unit's own SQL — manifest/DDL desync (manifest_desync)`
        );
      }
    }
  }

  const expectedIndexDefs = Array.isArray(manifestEntry.expected_index_defs) ? manifestEntry.expected_index_defs : [];
  for (const ix of expectedIndexDefs) {
    if (typeof ix.name !== 'string' || !_identifierAppearsInSQL(normalizedSQL, ix.name)) {
      errors.push(
        `${basename}: schema-manifest.json expected_index_defs entry — name value "${ix.name}" has no textual ` +
        `match in this unit's own SQL — manifest/DDL desync (manifest_desync)`
      );
    }
  }
}

function loadManifest(sqlDir) {
  const manifestPath = path.join(sqlDir, MANIFEST_BASENAME);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`schema-manifest.json missing or unreadable at ${manifestPath}: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`schema-manifest.json is not valid JSON: ${err.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.units || typeof manifest.units !== 'object') {
    throw new Error('schema-manifest.json missing required "units" object');
  }
  if (!Number.isInteger(manifest.schema_epoch) || manifest.schema_epoch < 1) {
    throw new Error('schema-manifest.json "schema_epoch" must be a positive integer');
  }
  if (!Array.isArray(manifest.required_roster)) {
    throw new Error('schema-manifest.json missing required "required_roster" array');
  }
  for (const [basename, entry] of Object.entries(manifest.units)) {
    if (!entry || typeof entry !== 'object' || !VALID_CLASSIFICATIONS.has(entry.classification)) {
      throw new Error(
        `schema-manifest.json unit "${basename}": classification must be one of ` +
        `postgres|sqlite|excluded (apply-for-both is not a legal classification, R-9)`
      );
    }
  }
  return manifest;
}

/**
 * Total classification pass over scripts/sql/. See module header for the
 * full contract. Never throws for ordinary classification problems (those
 * are collected into errors[]); only throws if schema-manifest.json itself
 * cannot be loaded/parsed at all (an engine-integrity failure, not a
 * per-file classification failure) — this can only happen on a genuine
 * cache MISS, since a cache HIT never re-reads the manifest's content.
 *
 * PR #262 review round 3: memoized per engineRoot, invalidated by a stat
 * signature (path+size+mtimeMs+type) over schema-manifest.json and every
 * *.sql dirent — see the module header and _computeStatSignature's own doc.
 * The signature itself is ALWAYS recomputed (cheap: one readdir + N lstat,
 * no content reads, no subprocess) — only the expensive per-file content
 * parse + desync-check work below is skipped on a cache hit.
 *
 * @param {object} opts
 * @param {string} opts.engineRoot — absolute path to the claude-memory engine root
 * @returns {{ ok:boolean, errors:string[], manifest:object,
 *             unitsByDialect:{postgres:Array,sqlite:Array}, allFiles:Array }}
 */
function classifySchemaFiles({ engineRoot }) {
  const sqlDir = path.join(engineRoot, 'scripts', SQL_DIRNAME);
  const manifestPath = path.join(sqlDir, MANIFEST_BASENAME);

  const { files, errors: enumErrors, rawNames } = enumerateSqlDir(sqlDir);
  const signature = _computeStatSignature(manifestPath, sqlDir, rawNames);

  const cached = _classifyCache.get(engineRoot);
  if (cached && _signaturesEqual(cached.signature, signature)) {
    return cached.result;
  }

  const manifest = loadManifest(sqlDir);
  const errors = [...enumErrors];

  // ── basename collision after case-fold ──────────────────────────────────
  const byLower = new Map();
  for (const f of files) {
    const lower = f.basename.toLowerCase();
    if (byLower.has(lower) && byLower.get(lower) !== f.basename) {
      errors.push(
        `basename collision after case-fold: "${byLower.get(lower)}" and "${f.basename}" both fold to "${lower}"`
      );
    } else {
      byLower.set(lower, f.basename);
    }
  }

  // ── expected-set cross-check (manifest ∪ roster; git-tracked-ness dropped
  //    entirely — see the module header's PR #262 review round 3 note) ─────
  const manifestOrRoster = new Set([
    ...Object.keys(manifest.units).map((b) => b.toLowerCase()),
    ...manifest.required_roster.map((b) => b.toLowerCase()),
  ]);
  for (const f of files) {
    const lower = f.basename.toLowerCase();
    if (!manifestOrRoster.has(lower)) {
      errors.push(
        `${f.basename}: enumerated in scripts/sql/ but not present in schema-manifest.json or the required roster`
      );
    }
  }

  // ── per-file header-directive vs manifest cross-check ───────────────────
  const classified = []; // { basename, fullPath, classification, order }
  for (const f of files) {
    let normalized;
    try {
      normalized = normalizeContent(fs.readFileSync(f.fullPath, 'utf8'));
    } catch (err) {
      errors.push(`${f.basename}: cannot read file: ${err.message}`);
      continue;
    }
    const header = parseHeaderDirective(normalized);
    const manifestEntry = manifest.units[f.basename];

    if (!manifestEntry) {
      errors.push(`${f.basename}: enumerated but has no schema-manifest.json entry (unclassified)`);
      continue;
    }
    if (header.kind === null) {
      errors.push(
        `${f.basename}: no '-- handoff:dialect <postgres|sqlite>' or '-- handoff:excluded <reason>' ` +
        `header directive found in the first ${HEADER_SCAN_LINES} lines`
      );
      continue;
    }
    const headerClassification = header.kind === 'dialect' ? header.value : 'excluded';
    if (headerClassification !== manifestEntry.classification) {
      errors.push(
        `${f.basename}: header directive says "${headerClassification}" but schema-manifest.json says ` +
        `"${manifestEntry.classification}" — disagreement`
      );
      continue;
    }
    classified.push({
      basename: f.basename,
      fullPath: f.fullPath,
      classification: manifestEntry.classification,
      order: typeof manifestEntry.order === 'number' ? manifestEntry.order : 0,
    });

    // Adversary finding #1 (BLOCKER): manifest/DDL desync check, scoped to
    // THIS unit's own SQL text only (never cross-unit) — a phantom or
    // renamed expected_objects/pgvector_gated entry with no matching DDL in
    // its own file is a loud classification_error here, never allowed to
    // reach the fingerprint-fast-path's ungated/gated probes as a live
    // "missing on this DB" finding.
    _checkManifestEntryAgainstOwnSQL(f.basename, normalized, manifestEntry, errors);
  }

  // ── required-roster absence check ────────────────────────────────────────
  const enumeratedLower = new Set(files.map((f) => f.basename.toLowerCase()));
  for (const rosterBasename of manifest.required_roster) {
    if (!enumeratedLower.has(rosterBasename.toLowerCase())) {
      errors.push(`required schema file missing from scripts/sql/: ${rosterBasename}`);
    }
  }

  const unitsByDialect = { postgres: [], sqlite: [] };
  for (const c of classified) {
    if (c.classification === 'postgres' || c.classification === 'sqlite') {
      unitsByDialect[c.classification].push({ basename: c.basename, fullPath: c.fullPath, order: c.order });
    }
  }
  unitsByDialect.postgres.sort((a, b) => (a.order - b.order) || (a.basename < b.basename ? -1 : 1));
  unitsByDialect.sqlite.sort((a, b) => (a.order - b.order) || (a.basename < b.basename ? -1 : 1));

  const result = {
    ok: errors.length === 0,
    errors,
    manifest,
    unitsByDialect,
    allFiles: files,
  };
  _classifyCache.set(engineRoot, { signature, result });
  return result;
}

/**
 * Test-only escape hatch: drop all memoized classification results. No
 * production call site ever needs this (the stat signature already
 * self-invalidates on any real on-disk change) — exists so a test process
 * that constructs multiple DIFFERENT schema-manifest.json/SQL fixtures at
 * the SAME reused path (rather than a fresh scratch dir per fixture) can
 * force a clean re-classification.
 */
function _clearClassifyCache() {
  _classifyCache.clear();
}

module.exports = {
  classifySchemaFiles,
  normalizeContent,
  parseHeaderDirective,
  enumerateSqlDir,
  // PR #262 review round 3 — exposed for test/test-schema-heal.js's own
  // memoization coverage (no test-side reimplementation of the cache).
  _clearClassifyCache,
};
