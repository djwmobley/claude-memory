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
//     tracked by git (when a .git directory is present at all -- packaged
//     / marketplace installs without a .git fall back to
//     manifest ∪ roster as the complete allowed set).
//   - 'apply-for-both' is not a legal classification (R-9) -- the manifest
//     schema enforces single-dialect or excluded only (validated below).
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
const { execFileSync } = require('child_process');

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
 * Returns { files: [{ basename, fullPath }...], errors: string[] }.
 */
function enumerateSqlDir(sqlDir) {
  const errors = [];
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(sqlDir, { withFileTypes: true });
  } catch (err) {
    errors.push(`cannot read schema directory ${sqlDir}: ${err.message}`);
    return { files, errors };
  }
  for (const ent of entries) {
    const isSqlExt = /\.sql$/i.test(ent.name);
    if (!isSqlExt) continue;
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
  return { files, errors };
}

/**
 * Determine the git-tracked subset of the given relative paths (POSIX-style,
 * relative to engineRoot) using `git ls-files`. Returns null when engineRoot
 * has no .git directory (packaged/marketplace install with no repo present)
 * — callers fall back to manifest ∪ roster as the complete allowed set in
 * that case, per R-2.
 */
function gitTrackedSqlFiles(engineRoot) {
  const gitDir = path.join(engineRoot, '.git');
  if (!fs.existsSync(gitDir)) return null;
  try {
    const out = execFileSync(
      'git', ['-C', engineRoot, 'ls-files', '--', path.join('scripts', SQL_DIRNAME) + '/'],
      { encoding: 'utf8' }
    );
    const rels = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return new Set(rels.map((r) => path.basename(r).toLowerCase()));
  } catch (_) {
    // git present but the invocation failed for some other reason (not a repo,
    // detached worktree oddity, etc.) — treat as "cannot determine", same as absent.
    return null;
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
 * per-file classification failure).
 *
 * @param {object} opts
 * @param {string} opts.engineRoot — absolute path to the claude-memory engine root
 * @returns {{ ok:boolean, errors:string[], manifest:object,
 *             unitsByDialect:{postgres:Array,sqlite:Array}, allFiles:Array }}
 */
function classifySchemaFiles({ engineRoot }) {
  const sqlDir = path.join(engineRoot, 'scripts', SQL_DIRNAME);
  const manifest = loadManifest(sqlDir);
  const errors = [];

  const { files, errors: enumErrors } = enumerateSqlDir(sqlDir);
  errors.push(...enumErrors);

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

  // ── git-tracked cross-check ──────────────────────────────────────────────
  const tracked = gitTrackedSqlFiles(engineRoot); // Set<lowercased basename> | null
  const manifestOrRoster = new Set([
    ...Object.keys(manifest.units).map((b) => b.toLowerCase()),
    ...manifest.required_roster.map((b) => b.toLowerCase()),
  ]);
  for (const f of files) {
    const lower = f.basename.toLowerCase();
    if (tracked !== null) {
      if (!tracked.has(lower)) {
        errors.push(
          `${f.basename}: enumerated in scripts/sql/ but NOT tracked by git — refusing to classify or apply ` +
          `an untracked file against a live project DB (remove it from scripts/sql/, or add+commit it with a ` +
          `header directive and a schema-manifest.json entry)`
        );
      }
    } else if (!manifestOrRoster.has(lower)) {
      // Packaged install with no .git: fall back to manifest ∪ roster as the
      // complete allowed set — an enumerated file outside that set is still loud.
      errors.push(
        `${f.basename}: enumerated in scripts/sql/ but not present in schema-manifest.json or the required ` +
        `roster (no .git present to cross-check git-tracked status — packaged/marketplace install fallback)`
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

  return {
    ok: errors.length === 0,
    errors,
    manifest,
    unitsByDialect,
    allFiles: files,
  };
}

module.exports = {
  classifySchemaFiles,
  normalizeContent,
  parseHeaderDirective,
  enumerateSqlDir,
};
