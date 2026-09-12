'use strict';
const __startNs = process.hrtime.bigint();

/**
 * handoff.js — Phase 3.5 /handoff skill helper.
 *
 * Subcommand router invoked by ~/.claude/commands/handoff/*.md slash-command
 * definition files. Heavy lifting (DB queries, file IO, JSON contract evaluation)
 * lives here; the Markdown files are thin recipes.
 *
 * Usage:
 *   node scripts/handoff.js <subcommand> [flags]
 *
 * Subcommands:
 *   init                    First-run provisioning for this project.
 *                           Flags: -y/--yes/--force (bypass the confirm-before-DDL gate,
 *                           also covers CREATE EXTENSION vector when needed); --no-embeddings
 *                           (opt out of embedding capability, stamps project_settings.
 *                           embeddings_opt_out); --clear-opt-out (remove a prior opt-out);
 *                           --allow-remote-embed (accept a REMOTE embed endpoint with
 *                           data_egress_approved=false, printing the hand-edit approval SQL);
 *                           --seed-provider (standalone: seed/re-seed the default embedding
 *                           provider row on an already-initialized project, no schema/marker
 *                           work). Without --no-embeddings, init BLOCKS (exit 1, no marker/
 *                           handoff.md written) when pgvector cannot be installed or no embed
 *                           endpoint is configured anywhere (.claude/pipeline.yml, VLLM_EMBED_URL,
 *                           or ~/.claude/handoff-embed.json).
 *   backfill-embeddings     Embed assertions/decisions rows whose embedding is still NULL.
 *                           Flags: --apply (default: dry-run), --table=assertions|decisions|all,
 *                           --batch-size=N (default 10), --project-id=<id> (default: whole DB),
 *                           --force-mixed-provider (bypass the mixed-provider refusal).
 *   status                  Read-only: show counts, last close, contract names, and
 *                           embedding_readiness (DISABLED | UNEMBEDDABLE:no-extension |
 *                           UNEMBEDDABLE:no-provider | DEGRADED:probe-failed(<reason>) |
 *                           HEALING(<n>) | READY | UNSUPPORTED:sqlite — READY requires a
 *                           zero live+actionable backlog AND a successful live provider probe).
 *   resume                  Inline SessionStart load (prints compact context summary).
 *   drop                    Zero all assertions, archive handoff.md, create fresh one.
 *   checkpoint --json -     Mid-session extraction (reads JSON from stdin).
 *   close      --json -     End-of-session extraction (reads JSON from stdin).
 *   purge      [--yes]      Hard-delete all project rows (requires confirmation or --yes).
 *   promote    <id>         Explicitly promote an assertion to CLAUDE.md durable facts.
 *   resurrect  <topic>      Manually resurrect dormant notes by topic.
 *                           Flags: --revive (-r), --limit=N (default 20).
 *                           Dry-run by default; --revive un-suppresses rows.
 *   prune      [flags]      Operator manual prune: hard-delete selected assertion rows.
 *                           Flags: --suppressed, --suppression-kind <kind>, --subject <s>,
 *                           --older-than <days>, --include-pinned, --apply.
 *                           Dry-run by default; --apply performs the delete.
 *                           At least one criterion required. Manual/operator-invoked only.
 *   loader-load             Same inline load as resume; used directly or by tests.
 *   loader-hook             SessionStart hook entry point (outputs JSON to stdout).
 *   loader-stop             SessionEnd hook entry point (implicit close if unclosed).
 *   queue-drain [--max=N]   Drain pending async extraction queue rows (background worker).
 *
 * Environment:
 *   PROJECT_ROOT            Override project root detection.
 *   PGUSER / PGPASSWORD     Postgres credentials (standard env vars, picked up by pg).
 *   HANDOFF_MULTI_AUTHOR_OVERRIDE  Override git author count for testing (integer string).
 *
 * Exit codes: 0 success, 1 error, 2 usage.
 */

const fs    = require('fs');
const path  = require('path');
const readline = require('readline');

const { loadConfig, connect, c, findProjectRoot } = require('./lib/shared');
const { encodeCwd, getClaudeProjectDir }           = require('./lib/encoded-cwd');
const { classifyPredicate, isDirective }            = require('./lib/predicate-registry');
const { validatePayload }                          = require('./lib/payload-schema');
const {
  resolveDialect, createAdapter, createInitProbe,
  resolveSQLiteDbPath, probeInitEmbeddabilityState,
} = require('./lib/db-seam');
const { canonicalize }                             = require('./lib/subject-canon');
const { intentKey, intentKeyEquals }                = require('./lib/intent-key');
const {
  MARKER_FILENAME,
  LEGACY_MARKER_FILENAME,
  findProjectRootByMarker,
  readMarker,
  writeMarker,
  mintUUID,
  persistMarker,
} = require('./lib/project-marker');
const {
  ensureProjectIdentity,
  reconcileLegacySettings,
} = require('./lib/project-identity');
const {
  resolveHandoffMdPath,
} = require('./lib/handoff-paths');
const { resolveHost } = require('./lib/host-target');
const { embedQuery }                               = require('./lib/embed');
const { runVectorQuery }                            = require('./lib/memory-view');
const {
  seedLocalEmbeddingProvider,
  resolveConfiguredEmbedEndpointDetailed,
  resolveDefaultProvider,
  createProviderFromRow,
  probeProvider,
} = require('./lib/embedding-provider');
const { embedForWrite, classifyEmbeddingWriteError } = require('./lib/write-time-embed');
const { runBackfillEmbeddings }                    = require('./lib/backfill-embeddings');
const { runEmbedHealIfNeeded } = require('./lib/embed-heal');
const { execFileSync }                             = require('child_process');
const crypto                                       = require('crypto');
const { REALITY_CHECKS, runVerifyDispatch }        = require('./lib/reality-checks');
// cm#230: the SAME decisions-row writer scripts/handoff-mcp.mjs's
// persist_decisions MCP tool uses — writeExtraction below is the SECOND
// (and, before this fix, only-validated-never-written) entry point onto
// this one write path.
const { validateDecisionRows, persistDecisionRow } = require('./lib/decisions-writer');
const { renderKeyPathsBullets, healKeyPathsSection, resolvePromotionHost, resolvePromotionTarget, looksLikeFindReplaceCopy, resolveProjectDisplayName } = require('./lib/claude-md-key-paths');
const {
  resolveSessionIdFromEnv,
  parseSessionMarkersDetailed,
  parseSessionMarkers,
  latestSessionMarker,
  resolveSessionIdFromMarker,
} = require('./lib/session-identity');

process.on('exit', () => {
  const ms = Number(process.hrtime.bigint() - __startNs) / 1e6;
  process.stderr.write(`internal_ms=${ms.toFixed(1)}\n`);
});

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

// TARGET_DB resolution order (first wins):
//   1. process.env.HANDOFF_DB  — explicit env override (preserved for CI / scripts)
//   2. loadConfig().database   — from .claude/pipeline.yml
//   3. 'claude_memory_eval_test' — final hardcoded fallback
// Validated against a strict identifier regex because DDL cannot use parameterized $1 and
// the double-quote wrap in CREATE DATABASE can be broken by names containing '"'.
const _DB_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

let _rawTargetDb;
let _rawTargetDbSource;
if (process.env.HANDOFF_DB) {
  _rawTargetDb       = process.env.HANDOFF_DB;
  _rawTargetDbSource = 'HANDOFF_DB env var';
} else {
  try {
    const _cfg = loadConfig();
    if (_cfg && _cfg.database) {
      _rawTargetDb       = _cfg.database;
      _rawTargetDbSource = '.claude/pipeline.yml';
    }
  } catch (_) {
    // loadConfig() throws when no config file exists — fall through to default
  }
  if (!_rawTargetDb) {
    _rawTargetDb       = 'claude_memory_eval_test';
    _rawTargetDbSource = 'built-in default';
  }
}

if (!_DB_NAME_RE.test(_rawTargetDb)) {
  process.stderr.write(
    `Invalid database name "${_rawTargetDb}" (from ${_rawTargetDbSource}) — must match /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.\n`
  );
  process.exit(1);
}
const TARGET_DB = _rawTargetDb;

// ─── PLUGIN ROOT RESOLUTION ───────────────────────────────────────────────────
// When running as a Claude Code plugin, CLAUDE_PLUGIN_ROOT is set to the plugin
// install directory.  Asset paths (templates, SQL schemas) are resolved from
// the plugin root in that case, and from __dirname's parent otherwise.
// This lets standalone repo usage (CLAUDE_PLUGIN_ROOT unset) behave byte-identically
// to pre-plugin behavior — CI passes with no env-var changes required.
const _ENGINE_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? process.env.CLAUDE_PLUGIN_ROOT
  : path.resolve(__dirname, '..');

const HANDOFF_TEMPLATE = path.join(_ENGINE_ROOT, 'templates', 'handoff.md.tpl');
const PROJECT_CLAUDE_MD_TEMPLATE = path.join(_ENGINE_ROOT, 'templates', 'project-claude-md.tpl');
const PROJECT_AGENTS_MD_TEMPLATE = path.join(_ENGINE_ROOT, 'templates', 'project-agents-md.tpl');

// ─── OPERATING CANON (hardcoded trusted preamble) ─────────────────────────────
// Emitted unconditionally before the untrusted retrieved-context block so every
// session sees the canon in the trusted zone — never inside the untrusted delimiters.
const OPERATING_CANON = `=== OPERATING CANON (trusted — applies to this and every session) ===
1. Follow the user's directions and scope exactly. When asked to do X, and X has an established definition (a backlog item, a prior handoff, a multi-part deliverable), deliver all of X. Do not silently narrow scope, reinterpret it, or substitute a smaller deliverable. If scope genuinely seems too large or ambiguous, say so and ask — do not shrink it unilaterally.
2. Never autonomously defer authorized work to a subsequent session/bundle/phase. Deferring in-scope work without explicit user say-so is a bug. Surface genuine design forks as written open questions with a recommended lean; never use deferral or an invented "later phase" as a mechanism to offload work that is in scope now.
=== END OPERATING CANON ===`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Connect to the handoff DB.
 *
 * Composition root — the SINGLE place where dialect is resolved and an adapter
 * is selected.  Returns a StoragePort adapter (PostgresAdapter or SQLiteAdapter).
 * The engine (this file) never inspects the dialect after this point; it calls
 * only port methods that are identical across both adapters.
 *
 *   - STORAGE_BACKEND=sqlite  → embedded SQLite at <project_root>/.claude/handoff.sqlite
 *     (or HANDOFF_SQLITE_PATH env var override)
 *   - STORAGE_BACKEND=postgres or unset → Postgres at TARGET_DB (unchanged default)
 */
async function connectHandoff() {
  const cfg     = loadConfig();
  const dialect = resolveDialect(cfg);

  if (dialect === 'sqlite') {
    // Plugin mode: Postgres is a declared prerequisite. Silently falling back to
    // SQLite in plugin mode would violate the design premise and risk data loss /
    // incorrect behavior in multi-project setups. Fail loudly so the user can
    // configure Postgres rather than silently operating on a wrong backend.
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      const msg = [
        '[handoff plugin] STORAGE_BACKEND=sqlite is not supported in plugin mode.',
        'Postgres is required. Set PGHOST/PGUSER/PGPASSWORD (and optionally HANDOFF_DB)',
        'to point at your Postgres instance, then remove STORAGE_BACKEND=sqlite.',
        'SQLite is available only for the db-seam test suite (standalone repo mode).',
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(1);
    }
    const root   = findProjectRoot();
    const dbPath = resolveSQLiteDbPath(root);
    return createAdapter('sqlite', { dbPath });
  }

  // Postgres path (default) — behavior byte-identical to pre-abstraction.
  return createAdapter('postgres', {
    host:     cfg.host,
    port:     cfg.port,
    database: TARGET_DB,
    user:     cfg.user,
  });
}

/**
 * Resolve project_id for the current working directory.
 *
 * LEGACY FALLBACK: this function is used by subcommands that do not connect
 * to the DB (status, drop, purge, etc.) and by cmdInit. It returns the best
 * available id WITHOUT running the one-shot migration.
 *
 * Resolution order:
 *   1. If a project marker (new name, or legacy .claude-memory) exists at/above
 *      cwd → return the UUID.
 *   2. Otherwise fall back to encodeCwd(root) for backward compatibility.
 *
 * For the authoritative identity (with migration), use ensureProjectIdentity()
 * which is wired into cmdLoaderLoad and cmdClose.
 */
function resolveProjectId() {
  // Honor PROJECT_ROOT env var to match the behavior of findProjectRoot() and
  // ensureProjectIdentity() — subprocesses that set PROJECT_ROOT must not have
  // their marker walk start from the node process's cwd (which may be the repo
  // root and therefore find the wrong marker).
  const startDir = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(startDir);
  if (markerRoot) {
    const marker = readMarker(markerRoot);
    if (marker) return marker.uuid;
  }
  const root = findProjectRoot();
  return encodeCwd(root);
}

// resolveHandoffMdPath is imported from ./lib/handoff-paths (honors HANDOFF_BASE_DIR;
// defaults to ~/.claude/projects/<projectId>/handoff.md). See the import block above.

/** Read handoff.md frontmatter as a plain object. Returns {} if missing. */
function readHandoffFrontmatter(handoffPath) {
  if (!fs.existsSync(handoffPath)) return {};
  const text = fs.readFileSync(handoffPath, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1]] = kv[2].trim();
  }
  // Parse session_summary sub-keys
  const ssMatch = match[1].match(/session_summary:\s*\n((?:[ \t]+.*\n?)*)/);
  if (ssMatch) {
    const ss = {};
    for (const line of ssMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^\s+(\w[\w_]*):\s*(.*)$/);
      if (kv) ss[kv[1]] = kv[2].trim();
    }
    fm.session_summary = ss;
  }
  return fm;
}

/** Render a template file by replacing {{KEY}} placeholders. */
function renderTemplate(tplPath, vars) {
  let text = fs.readFileSync(tplPath, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  }
  return text;
}

/**
 * Write handoff.md from the template. Creates parent dir if needed.
 *
 * S5: atomic write — render to a sibling `<path>.tmp-<pid>` file, then
 * fs.renameSync into place. A process killed mid-write (hook timeout,
 * SIGKILL) leaves the temp file behind and the real handoff.md untouched
 * rather than a truncated/corrupt file; rename is a single filesystem
 * operation (atomic on both POSIX and NTFS for same-volume renames).
 */
function writeHandoffMd(handoffPath, vars) {
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  const content = renderTemplate(HANDOFF_TEMPLATE, vars);
  const tmpPath = `${handoffPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, handoffPath);
}

/**
 * Render a FRESH promotion file (CLAUDE.md / AGENTS.md) from scratch. Pulled
 * out of cmdInit's `writeFreshPromotionFile` closure (cm#promote-regenerate)
 * so cmdPromote's `--regenerate` path can render the exact same content
 * cmdInit would write for a brand-new project, without duplicating the
 * PROJECT_DESCRIPTION / KEY_PATHS interpolation logic.
 *
 * Renders from the template ONLY — it does not read any already-promoted
 * facts from an existing file (that carry-forward, when wanted, is the
 * caller's job — see cmdPromote's `--regenerate` handling below).
 *
 * `host` is accepted for documentation/logging parity with the caller's own
 * host resolution (resolvePromotionHost) — it plays no role in this function
 * since `promotionTemplate` already encodes which template (claude/codex) to
 * render; it is not required to be correct here.
 *
 * @param {object} opts
 * @param {string} opts.root              - project root (used only for the
 *                                           basename fallback below).
 * @param {string} [opts.projectName]     - defaults to path.basename(root).
 * @param {string} opts.promotionTemplate - absolute path to the .tpl file.
 * @param {string} [opts.host]            - 'claude' | 'codex' (informational).
 * @param {object} [opts.env]             - defaults to process.env.
 * @returns {string} the rendered file content, with whatever line endings
 *   the template happens to carry on disk (LF in the git blob, but this
 *   varies by checkout platform — e.g. Windows core.autocrlf — since
 *   .gitattributes does not pin *.tpl files to LF the way it does *.sql).
 *   Callers needing a specific EOL must normalize themselves.
 */
function renderFreshPromotionContent(opts) {
  const { root, promotionTemplate } = opts;
  const projectName = opts.projectName || path.basename(root);
  const env          = opts.env || process.env;
  const projectDesc  = `Memory and retrieval infrastructure project.`;
  const keyPathsBullets = renderKeyPathsBullets(env);
  return renderTemplate(promotionTemplate, {
    PROJECT_NAME:          projectName,
    PROJECT_DESCRIPTION:   projectDesc,
    KEY_PATHS_HANDOFF_PATH: keyPathsBullets.handoffPath,
    KEY_PATHS_HELPER_PATH:  keyPathsBullets.helperPath,
  });
}

/**
 * Thin atomic-write helper for a promotion file: render-to-tmp then rename,
 * same pattern as writeHandoffMd() above. Extracted so cmdPromote's
 * `--regenerate` write step doesn't hand-roll its own tmp+rename.
 */
function writePromotionFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Parse the "## Durable facts" section of an already-rendered promotion file
 * and return its non-placeholder content lines (annotation comments and fact
 * bullets, in original order) for carry-forward into a freshly regenerated
 * file. Tolerant of both LF and CRLF line endings (unlike the plain "\n"
 * literal cmdPromote's append-path regex uses, since a regenerate target may
 * be a CRLF file end-to-end).
 *
 * Returns:
 *   - `null` if no "## Durable facts" heading is found at all (section not
 *     parseable — caller should warn that prior content is not carried).
 *   - an array of content lines (possibly empty) if the heading IS found —
 *     an empty array means the section existed but had nothing but the
 *     placeholder line (or was itself empty), which is not a warning case:
 *     there was nothing to lose.
 */
function parseDurableFactsSection(text) {
  const m = text.match(/## Durable facts\r?\n([\s\S]*?)(?:\r?\n(?=##)|$)/);
  if (!m) return null;
  const body = m[1];
  const lines = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (/^-\s*\(No durable facts promoted yet/i.test(line.trim())) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * Detect the dominant line-ending style of a piece of text by counting CRLF
 * vs bare-LF terminators (mirrors dominantEol() in
 * scripts/lib/claude-md-key-paths.js, duplicated here rather than imported
 * since that helper works on the {content,term} record shape produced by its
 * own splitLines(), not a raw string).
 */
function detectDominantEol(text) {
  let crlf = 0, lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      if (i > 0 && text[i - 1] === '\r') crlf++; else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Normalize `text` to LF-only, then re-emit with the requested `eol`. */
function convertEol(text, eol) {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * Splice carried-forward "## Durable facts" content lines into a freshly
 * rendered promotion file, replacing the single placeholder bullet the
 * template ships with. No-op (returns freshContent unchanged) when there is
 * nothing to carry.
 */
function insertCarriedDurableFacts(freshContent, factLines) {
  if (!factLines || factLines.length === 0) return freshContent;
  // Both templates put a blank line between the "## Durable facts" heading
  // and the placeholder bullet — preserve that blank line, replacing only
  // the placeholder bullet itself with the carried-forward lines.
  return freshContent.replace(
    /(## Durable facts\n)(\n*)- \(No durable facts[^\n]*\)\n/,
    (_, heading, blanks) => `${heading}${blanks}${factLines.join('\n')}\n`
  );
}

/**
 * Total classification of a promotion-file regenerate TARGET path's on-disk
 * state, via lstat (so a symlink is detected as itself, never resolved
 * through). Every possible state maps to exactly one branch:
 *   'absent'    - ENOENT
 *   'file'      - regular file
 *   'directory' - a directory
 *   'symlink'   - a symbolic link (regardless of what it points to)
 *   'other'     - any other node type (FIFO, socket, block/char device, ...)
 */
function classifyPromotionRegenerateTarget(targetPath) {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory())    return 'directory';
  if (st.isFile())         return 'file';
  return 'other';
}

/**
 * Check whether a git object (commit, blob, tree, tag) exists in the repo.
 * Fail-open: returns true on any error (git unavailable, not a repo, timeout)
 * so that C-6 is never fired falsely when git is broken.
 *
 * @param {string} root  - Absolute path to the git repo root.
 * @param {string} sha   - SHA-like token to verify.
 * @returns {boolean}    - true if the object exists OR if the check fails.
 */
function gitObjectExists(root, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', sha], {
      cwd: root,
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;   // exit 0 → object exists
  } catch (err) {
    // exit 1 → object does not exist; any other error → fail-open (return true)
    if (err && typeof err.status === 'number' && err.status === 1) return false;
    return true;   // git unavailable, timeout, not a repo → fail-open
  }
}

/**
 * Detect contradictions between the LLM-authored payload fields and the
 * engine-verified degraded-subsystem state.
 *
 * Rules:
 *   C-1  Degraded label appears verbatim (case-insensitive) in payload.tldr.
 *   C-2  Fix-claim keyword appears within 60 chars of a degraded label in tldr.
 *   C-3  payload.retrieval_outcome === 'success' while C2 is degraded.
 *   C-4  INTENTIONALLY EXCLUDED — open_threads referencing degraded subsystems
 *        is acceptable inline divergence, not a contradiction.
 *   C-5  payload.tldr contains a green-build claim while the working tree is
 *        unpackaged (detectUnpackagedState reports dirty/ahead).
 *   C-6  payload.quick_references contains a SHA-like token that does not exist
 *        in the git object store. Fail-open when git is unavailable.
 *
 * @param {object}   payload          - Parsed stdin payload (tldr, quick_references, …).
 * @param {Array<{subsystem: string, reason: string}>} degradedList - Populated _degradedSubsystems.
 * @param {string}   root             - Absolute path to the project root.
 * @returns {Array<{rule: string, message: string}>}
 */
function detectCloseContradictions(payload, degradedList, root) {
  const contradictions = [];
  const tldr = (payload.tldr || '').toLowerCase();

  // ── C-1: Degraded label appears in tldr ─────────────────────────────────────
  for (const entry of degradedList) {
    const label = entry.subsystem.toLowerCase();
    if (tldr.includes(label)) {
      contradictions.push({
        rule: 'C-1',
        message:
          `TL;DR mentions degraded subsystem "${entry.subsystem}" — ` +
          `engine state: ${entry.reason}`,
      });
    }
  }

  // ── C-2: Fix-claim keyword adjacent (60-char window) to a degraded label ───
  const FIX_KEYWORDS = [
    'fix', 'fixes', 'fixed', 'resolved', 'resolves', 'working',
    'now works', 'now seeds', 'seeds', 'cleared', 'corrected',
    'repair', 'repaired',
  ];
  for (const entry of degradedList) {
    const label = entry.subsystem.toLowerCase();
    const idx = tldr.indexOf(label);
    if (idx === -1) continue;
    const windowStart = Math.max(0, idx - 60);
    const windowEnd   = Math.min(tldr.length, idx + label.length + 60);
    const window = tldr.slice(windowStart, windowEnd);
    for (const kw of FIX_KEYWORDS) {
      if (window.includes(kw)) {
        contradictions.push({
          rule: 'C-2',
          message:
            `TL;DR contains fix-claim keyword "${kw}" adjacent to degraded subsystem ` +
            `"${entry.subsystem}" — engine state: ${entry.reason}`,
        });
        break;  // one C-2 per label is sufficient
      }
    }
  }

  // ── C-3: retrieval_outcome=success while C2 is degraded ────────────────────
  if (payload.retrieval_outcome === 'success') {
    const c2Degraded = degradedList.some((d) => d.subsystem === 'C2');
    if (c2Degraded) {
      contradictions.push({
        rule: 'C-3',
        message:
          'payload.retrieval_outcome is "success" but C2 is degraded ' +
          '(no session id resolvable — success attribution is impossible)',
      });
    }
  }

  // ── C-4: INTENTIONALLY EXCLUDED ────────────────────────────────────────────
  // open_threads referencing degraded subsystems is acceptable inline divergence.

  // ── C-5: Green-build claim in tldr while working tree is unpackaged ─────────
  const GREEN_PATTERNS = [
    'all tests pass', 'tests pass', 'ci green', 'ci is green',
    'builds clean', 'build is clean',
  ];
  const hasGreenClaim = GREEN_PATTERNS.some((p) => tldr.includes(p));
  if (hasGreenClaim) {
    try {
      const packState = detectUnpackagedState(root);
      if (packState.unpackaged) {
        contradictions.push({
          rule: 'C-5',
          message:
            `TL;DR contains a green-build/test-pass claim but the working tree ` +
            `is unpackaged (${packState.label})`,
        });
      }
    } catch (_) {
      // detectUnpackagedState is fail-safe; if it throws, skip C-5.
    }
  }

  // ── C-6: SHA-like token in quick_references that does not exist in git ──────
  const quickRefs = payload.quick_references || '';
  const SHA_RE = /\b([0-9a-f]{7,40})\b/gi;
  let shaMatch;
  while ((shaMatch = SHA_RE.exec(quickRefs)) !== null) {
    const sha = shaMatch[1];
    if (!gitObjectExists(root, sha)) {
      contradictions.push({
        rule: 'C-6',
        message:
          `quick_references contains SHA-like token "${sha}" that does not ` +
          `exist in the git object store`,
      });
    }
  }

  return contradictions;
}

// ─── POINTER-STALENESS GATE ───────────────────────────────────────────────────
//
// validatePointers — detect and rewrite stale file:line references.
//
// Design rationale: code-pointer drift has recurred three times in succession
// (sessions N-2, N-1, N).  Per feedback_recurring_drift_build_enforcement_not_a_note,
// the fix is an automated gate wired into the harness — not another corrected line
// number stored in memory that will rot again.
//
// Extended in PR #86 (stale-entry categorical fix):
//
//  P-4 rule (prose-vs-content check): For legacy pointers (no stored anchor),
//  a prose-window vs. file-window identifier-overlap check is run before
//  deriving and locking in an anchor.  Zero overlap → P-4 finding; anchor NOT
//  derived.  This prevents silently locking in a wrong anchor for a pointer
//  whose line number has already drifted.
//
//  Bulk supersession (_suppressStaleLegacyPointers): Called at close time after
//  _backfillMissingAnchors.  Iterates anchor-IS-NULL assertions that have
//  pointer-shaped objects and runs the same prose-vs-content check.  Rows that
//  fail overlap are suppressed (suppressed = true) — §7 no-backfill invariant
//  respected (subject/predicate/object/source never updated).
//
//  Bare-filename path fallback (_resolvePointerPath): Pointers like
//  "handoff.js:1106" (no path prefix) now try scripts/, src/, lib/, test/ in
//  order before emitting a P-1 false positive.  The served pointer string is
//  never rewritten — only the existence check is more lenient.

/** Known code/text extensions that can contain valid code pointers. */
const POINTER_EXTENSIONS = new Set([
  'js', 'ts', 'json', 'md', 'sql', 'yml', 'yaml', 'sh', 'py', 'mjs', 'cjs', 'jsx', 'tsx',
]);

/**
 * Regex that matches code pointers: path/to/file.ext:N  or  path/to/file.ext:N-M
 * Capture groups: [1] full pointer, [2] path, [3] ext, [4] start line, [5] end line (optional)
 */
const POINTER_RE = /(?<![a-zA-Z0-9])(\b([\w./][\w./\-]*?\.([a-z]+)):([1-9][0-9]*)(?:-([1-9][0-9]*))?)\b/g;

function _isValidPointerMatch(ext, pth) {
  if (!POINTER_EXTENSIONS.has(ext.toLowerCase())) return false;
  const hasSlash = pth.includes('/') || pth.includes('\\');
  const hasDirOrKnownFile = hasSlash || /[a-zA-Z_-]/.test(pth.replace(/\.[^.]+$/, ''));
  return hasDirOrKnownFile;
}

function _extractPointers(text) {
  const seen    = new Set();
  const results = [];
  const re      = new RegExp(POINTER_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, pointer, pth, ext, startStr, endStr] = m;
    if (!_isValidPointerMatch(ext, pth)) continue;
    if (seen.has(pointer)) continue;
    seen.add(pointer);
    results.push({
      pointer,
      path:      pth,
      ext:       ext.toLowerCase(),
      startLine: parseInt(startStr, 10),
      endLine:   endStr ? parseInt(endStr, 10) : null,
    });
  }
  return results;
}

function _findEnclosingSymbol(lines, lineIdx, ext) {
  const jsExts = new Set(['js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx']);
  if (!jsExts.has(ext)) return null;
  const DECL_RE = /^\s*(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var|class)\s+(\w+)\s*[=\s({])/;
  const scanStart = Math.max(0, lineIdx - 200);
  for (let i = lineIdx; i >= scanStart; i--) {
    const m = DECL_RE.exec(lines[i]);
    if (m) return m[1] || m[2] || null;
  }
  return null;
}

function _deriveAnchor(root, pointerInfo) {
  // Use _resolvePointerPath so bare-filename pointers get the subdirectory fallback.
  const absPath = _resolvePointerPath(root, pointerInfo.path);
  if (!absPath) return null;
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch (_) { return null; }
  const lines   = content.split('\n');
  const lineIdx = pointerInfo.startLine - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const symbol  = _findEnclosingSymbol(lines, lineIdx, pointerInfo.ext);
  const snippet = symbol ? null : (lines[lineIdx].trim().slice(0, 80) || null);
  return {
    pointer:        pointerInfo.pointer,
    symbol:         symbol  || null,
    snippet:        snippet || null,
    last_validated: new Date().toISOString(),
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _findSymbolRange(lines, symbolName, ext) {
  const jsExts = new Set(['js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx']);
  if (!jsExts.has(ext)) return null;
  const DECL_RE = new RegExp(
    `^(\\s*)(?:async\\s+)?(?:function\\s+${escapeRegExp(symbolName)}|(?:const|let|var|class)\\s+${escapeRegExp(symbolName)}\\s*[=\\s({])`
  );
  for (let i = 0; i < lines.length; i++) {
    if (!DECL_RE.test(lines[i])) continue;
    let depth = 0;
    let endIdx = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth > 0 || (depth === 0 && j > i)) {
        endIdx = j;
        if (depth === 0) break;
      }
      if (j === lines.length - 1) { endIdx = j; break; }
    }
    return { startLine: i + 1, endLine: endIdx + 1 };
  }
  return null;
}

function _findSnippetLine(lines, snippet) {
  const trimmed = snippet.trim();
  if (!trimmed) return null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(trimmed)) return i + 1;
  }
  return null;
}

/**
 * Resolve a pointer path against the project root, trying common subdirectories
 * when the raw path does not exist.  Only the fallback search is attempted when
 * the pointer contains no slashes (bare filename like "handoff.js").
 *
 * @param {string} projectRoot   — absolute project root
 * @param {string} ptrPath       — path component from the pointer
 * @returns {string|null}        — resolved absolute path, or null if not found anywhere
 */
function _resolvePointerPath(projectRoot, ptrPath) {
  const direct = path.join(projectRoot, ptrPath);
  if (fs.existsSync(direct)) return direct;
  const hasSep = ptrPath.includes('/') || ptrPath.includes('\\');
  if (hasSep) return null;
  for (const sub of ['scripts', 'src', 'lib', 'test']) {
    const candidate = path.join(projectRoot, sub, ptrPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Extract identifier-shaped tokens from a text string.
 * Matches camelCase, snake_case, kebab-case, and dotted identifiers of length >= 4.
 *
 * @param {string} text
 * @returns {Set<string>} — lowercase token set
 */
function _extractIdentifierTokens(text) {
  const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_\-.]{3,}/g;
  const tokens   = new Set();
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[0];
    tokens.add(raw.toLowerCase());
    // Also split compound identifiers into parts so that kebab-case, snake_case,
    // camelCase, and dotted names all yield their component sub-tokens.
    // This ensures e.g. "semantic-vector-stub" (prose) matches "semanticVectorStub" (code).
    // Steps: (1) insert space at lower→Upper camelCase boundaries, (2) split on
    // delimiters and whitespace.
    const parts = raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase split
      .split(/[-_.\s]+/g);                    // kebab, snake, dotted, whitespace
    for (const p of parts) {
      if (p.length >= 4) tokens.add(p.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Extract identifier tokens from a +/-windowChars window around the pointer
 * literal in the prose text (the pointer literal itself is excluded).
 *
 * @param {string} text        — full prose text
 * @param {string} pointerStr  — the pointer literal
 * @param {number} windowChars — characters to include on each side (default 200)
 * @returns {Set<string>}
 */
function _extractProseTokens(text, pointerStr, windowChars = 200) {
  const idx = text.indexOf(pointerStr);
  if (idx === -1) return new Set();
  const before = text.slice(Math.max(0, idx - windowChars), idx);
  const after  = text.slice(idx + pointerStr.length, idx + pointerStr.length + windowChars);
  return _extractIdentifierTokens(before + ' ' + after);
}

/**
 * Run the prose-vs-content overlap check for a legacy pointer (no stored anchor).
 * Extracts identifier tokens from a prose window around the pointer and from a
 * +/-3-line window in the file.  Returns true if overlap >= 1 token.
 *
 * @param {string}   prose       — text block containing the pointer
 * @param {string}   pointerStr  — the pointer literal
 * @param {string[]} fileLines   — lines of the resolved file
 * @param {number}   startLine   — 1-based cited line
 * @returns {boolean}
 */
function _proseVsContentOverlap(prose, pointerStr, fileLines, startLine) {
  const lineIdx   = startLine - 1;
  const winStart  = Math.max(0, lineIdx - 3);
  const winEnd    = Math.min(fileLines.length, lineIdx + 4);
  const fileWindow = fileLines.slice(winStart, winEnd).join('\n');
  const fileTokens  = _extractIdentifierTokens(fileWindow);
  const proseTokens = _extractProseTokens(prose, pointerStr);
  for (const t of proseTokens) {
    if (fileTokens.has(t)) return true;
  }
  return false;
}

/**
 * Run the pointer-staleness gate over a text block.
 *
 * For each code pointer found in text:
 *  - P-1: file no longer present (or unreadable). Also emits P-1 if a bare-filename
 *    pointer is not found anywhere in scripts/, src/, lib/, or test/ subdirs.
 *  - P-2: no stored anchor and cited line is out of range / blank.
 *  - P-3: stored symbol/snippet no longer found in file.
 *  - P-4 (NEW): no stored anchor and prose-vs-content identifier overlap is zero —
 *    the pointer's cited line contains nothing that matches identifiers from the
 *    surrounding assertion prose.  Anchor is NOT derived; the pointer is flagged stale.
 *
 * Bare-filename path resolution (NEW): when pi.path contains no slashes and the file
 * is not at root, _resolvePointerPath tries scripts/, src/, lib/, test/ in order.
 * The served pointer string is never altered; only the existence check is more lenient.
 *
 * @param {string}  text           — text block to scan
 * @param {string}  projectRoot    — absolute project root path
 * @param {Map}     storedAnchors  — Map<pointer_string, anchorObj> from the DB
 * @param {Map}     derivedAnchors — accumulates newly derived/updated anchors (OUT param)
 * @param {Map}     correctedPtrs  — accumulates old→new pointer rewrites (OUT param)
 * @param {string}  mode           — 'close' | 'resume'
 * @param {boolean} warnLegacy     — if true, emit legacy-pointer warnings to stderr
 * @returns {{ rewrittenText:string, findings:Array<{rule:string, message:string}> }}
 */
function validatePointers(text, projectRoot, storedAnchors, derivedAnchors, correctedPtrs, mode, warnLegacy) {
  if (!text || typeof text !== 'string') return { rewrittenText: text, findings: [] };
  const pointers = _extractPointers(text);
  if (pointers.length === 0) return { rewrittenText: text, findings: [] };

  const findings  = [];
  let   rewritten = text;

  for (const pi of pointers) {
    // Sub-deliverable #3: bare-filename path fallback.
    // _resolvePointerPath tries scripts/, src/, lib/, test/ when the raw path fails.
    // The served pointer string is never changed; only the existence check is lenient.
    const absPath = _resolvePointerPath(projectRoot, pi.path);

    if (!absPath) {
      findings.push({ rule: 'P-1', message: `stale pointer: ${pi.pointer} — file ${pi.path} no longer present` });
      continue;
    }
    let fileLines;
    try { fileLines = fs.readFileSync(absPath, 'utf8').split('\n'); } catch (_) {
      findings.push({ rule: 'P-1', message: `stale pointer: ${pi.pointer} — file ${pi.path} unreadable` });
      continue;
    }

    // Build a pointerInfo that points at the resolved absolute path for _deriveAnchor.
    // For bare-filename fallbacks the resolved sub-path replaces pi.path internally.
    const resolvedRelPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
    const piResolved = resolvedRelPath !== pi.path
      ? Object.assign({}, pi, { path: resolvedRelPath })
      : pi;

    const stored = storedAnchors.get(pi.pointer);

    // No stored anchor — legacy path.
    if (!stored) {
      const lineIdx   = pi.startLine - 1;
      const plausible = lineIdx >= 0 && lineIdx < fileLines.length && fileLines[lineIdx].trim().length > 0;
      if (plausible) {
        // Sub-deliverable #1: prose-vs-content overlap check (P-4 rule).
        // Before locking in an anchor, require >= 1 identifier token shared between
        // the prose window around the pointer and the +-3-line window in the file.
        const hasOverlap = _proseVsContentOverlap(text, pi.pointer, fileLines, pi.startLine);
        if (!hasOverlap) {
          findings.push({ rule: 'P-4', message: `stale pointer: ${pi.pointer} — assertion prose does not match cited content` });
          // Do NOT derive an anchor. Do NOT add to derivedAnchors. Continue.
          continue;
        }
        if (!derivedAnchors.has(pi.pointer)) {
          const derived = _deriveAnchor(projectRoot, piResolved);
          if (derived) derivedAnchors.set(pi.pointer, Object.assign({}, derived, { pointer: pi.pointer }));
        }
        if (warnLegacy && mode === 'close') {
          process.stderr.write(`[handoff] pointer-gate: legacy pointer ${pi.pointer} — no stored anchor; derived for next close\n`);
        }
      } else {
        findings.push({ rule: 'P-2', message: `stale pointer: ${pi.pointer} — no anchor stored and line ${pi.startLine} is out of range or blank in ${pi.path}` });
      }
      continue;
    }

    // Symbol anchor path.
    if (stored.symbol) {
      const currentRange = _findSymbolRange(fileLines, stored.symbol, pi.ext);
      if (!currentRange) {
        findings.push({ rule: 'P-3', message: `stale pointer: ${pi.pointer} — anchor symbol "${stored.symbol}" no longer found in ${pi.path}` });
        continue;
      }
      const expectedEnd = pi.endLine !== null ? pi.endLine : pi.startLine;
      if (currentRange.startLine === pi.startLine && currentRange.endLine === expectedEnd) {
        derivedAnchors.set(pi.pointer, Object.assign({}, stored, { last_validated: new Date().toISOString() }));
      } else {
        const newPointer = pi.endLine !== null
          ? `${pi.path}:${currentRange.startLine}-${currentRange.endLine}`
          : `${pi.path}:${currentRange.startLine}`;
        rewritten = rewritten.split(pi.pointer).join(newPointer);
        correctedPtrs.set(pi.pointer, newPointer);
        derivedAnchors.set(newPointer, Object.assign({}, stored, { pointer: newPointer, last_validated: new Date().toISOString() }));
        if (warnLegacy) process.stderr.write(`[handoff] pointer-gate: corrected ${pi.pointer} → ${newPointer} (symbol "${stored.symbol}" moved)\n`);
      }
      continue;
    }

    // Snippet anchor path.
    if (stored.snippet) {
      const currentLine = _findSnippetLine(fileLines, stored.snippet);
      if (currentLine === null) {
        findings.push({ rule: 'P-3', message: `stale pointer: ${pi.pointer} — anchor snippet "${stored.snippet.slice(0, 40)}…" no longer found in ${pi.path}` });
        continue;
      }
      if (currentLine === pi.startLine) {
        derivedAnchors.set(pi.pointer, Object.assign({}, stored, { last_validated: new Date().toISOString() }));
      } else {
        const newPointer = `${pi.path}:${currentLine}`;
        rewritten = rewritten.split(pi.pointer).join(newPointer);
        correctedPtrs.set(pi.pointer, newPointer);
        derivedAnchors.set(newPointer, Object.assign({}, stored, { pointer: newPointer, last_validated: new Date().toISOString() }));
        if (warnLegacy) process.stderr.write(`[handoff] pointer-gate: corrected ${pi.pointer} → ${newPointer} (snippet moved)\n`);
      }
      continue;
    }

    // Anchor has neither symbol nor snippet — treat as legacy.
    if (warnLegacy && mode === 'close') {
      process.stderr.write(`[handoff] pointer-gate: anchor for ${pi.pointer} has neither symbol nor snippet — treating as legacy\n`);
    }
  }

  return { rewrittenText: rewritten, findings };
}

/**
 * Extract the set of assertion indices referenced by strict-mode validation errors.
 * Error messages have the form `assertions[N]...`; any error that does not match is
 * ignored (it refers to the payload top-level, not a specific assertion).
 *
 * @param {string[]} errors  — validation.errors array from validatePayload()
 * @returns {Set<number>}
 */
function _badAssertionIndices(errors) {
  return new Set(
    errors
      .map((e) => { const m = e.match(/^assertions\[(\d+)\]/); return m ? parseInt(m[1], 10) : null; })
      .filter((n) => n !== null)
  );
}

async function _loadStoredAnchors(db, projectId, ptrs) {
  const anchorMap = new Map();
  if (!ptrs.length) return anchorMap;
  try {
    const { rows } = await db.query(
      `SELECT anchor FROM assertions WHERE project_id = $1 AND anchor IS NOT NULL AND suppressed = false`,
      [projectId]
    );
    for (const row of rows) {
      let anchor;
      try { anchor = typeof row.anchor === 'string' ? JSON.parse(row.anchor) : row.anchor; } catch (_) { continue; }
      if (anchor && anchor.pointer && ptrs.includes(anchor.pointer)) {
        anchorMap.set(anchor.pointer, anchor);
      }
    }
  } catch (err) {
    process.stderr.write(`[handoff] pointer-gate: anchor load failed (non-fatal): ${err.message}\n`);
  }
  return anchorMap;
}

async function _persistPointerCorrections(db, projectId, correctedPtrs, derivedAnchors) {
  // §7 no-backfill invariant: we NEVER UPDATE the object field of source assertions.
  // Source assertions stay canonical; pointer rewrites happen only in the served
  // handoff.md output (via validatePointers / runPointerGate return values).
  //
  // What we DO persist: anchor metadata updates (anchor is not a canonical corpus
  // field — it is derived validation metadata).  S10 forbids updates to
  // subject / predicate / object / source; it permits anchor.
  if (!derivedAnchors.size) return;
  try {
    // For corrected pointers: persist the new anchor keyed by the new pointer string.
    for (const [oldPtr, newPtr] of correctedPtrs) {
      const anchor = derivedAnchors.get(newPtr) || derivedAnchors.get(oldPtr);
      if (!anchor) continue;
      await db.query(
        `UPDATE assertions SET anchor = $3
         WHERE project_id = $1 AND (anchor->>'pointer') = $2 AND suppressed = false`,
        [projectId, oldPtr, JSON.stringify(Object.assign({}, anchor, { pointer: newPtr }))]
      );
    }
    // For derived anchors that were not part of a correction (fresh derivations):
    for (const [ptr, anchor] of derivedAnchors) {
      if (correctedPtrs.has(ptr)) continue;
      await db.query(
        `UPDATE assertions SET anchor = $3
         WHERE project_id = $1 AND object LIKE $4
           AND (anchor IS NULL OR (anchor->>'pointer') = $2) AND suppressed = false`,
        [projectId, ptr, JSON.stringify(anchor), `%${ptr}%`]
      );
    }
  } catch (err) {
    process.stderr.write(`[handoff] pointer-gate: anchor persistence failed (non-fatal): ${err.message}\n`);
  }
}

async function _backfillMissingAnchors(db, projectId, projectRoot) {
  try {
    const { rows } = await db.query(
      `SELECT id, object FROM assertions WHERE project_id = $1 AND anchor IS NULL AND suppressed = false AND object ~ $2`,
      [projectId, '\\.[a-z]+:[0-9]']
    );
    if (!rows.length) return;
    let filled = 0;
    for (const row of rows) {
      const ptrs = _extractPointers(row.object);
      if (!ptrs.length) continue;
      const anchor = _deriveAnchor(projectRoot, ptrs[0]);
      if (!anchor) continue;
      await db.query(`UPDATE assertions SET anchor = $1 WHERE id = $2`, [JSON.stringify(anchor), row.id]);
      filled++;
    }
    if (filled > 0) process.stderr.write(`[handoff] pointer-gate: backfilled anchors for ${filled} assertion(s)\n`);
  } catch (err) {
    process.stderr.write(`[handoff] pointer-gate: anchor backfill failed (non-fatal): ${err.message}\n`);
  }
}

/**
 * Bulk supersession pass for pre-gate stale-pointer legacy rows.
 *
 * Called at close time (after _backfillMissingAnchors).  Iterates all
 * anchor-IS-NULL assertion rows with pointer-shaped objects and runs the
 * prose-vs-content overlap check.  Rows that fail overlap are suppressed
 * (suppressed = true).  Rows that pass get an anchor derived and persisted.
 *
 * Resume mode NEVER runs this pass (§7 no-backfill invariant + gate close/resume split).
 *
 * S10 compliance: we NEVER UPDATE subject / predicate / object / source.
 * Only `suppressed` and `anchor` are written.
 *
 * @param {object} db          — pg Client
 * @param {string} projectId
 * @param {string} projectRoot — absolute project root
 */
async function _suppressStaleLegacyPointers(db, projectId, projectRoot) {
  try {
    const { rows } = await db.query(
      `SELECT id, subject, predicate, object
         FROM assertions
        WHERE project_id = $1 AND anchor IS NULL AND suppressed = false
          AND object ~ $2`,
      [projectId, '\\.[a-z]+:[0-9]']
    );
    if (!rows.length) return;
    let suppressed = 0;
    let anchored   = 0;
    for (const row of rows) {
      const ptrs = _extractPointers(row.object);
      if (!ptrs.length) continue;
      const ptr = ptrs[0];
      // Resolve the file — use the same fallback logic as validatePointers.
      const absPath = _resolvePointerPath(projectRoot, ptr.path);
      if (!absPath) {
        // File not found — suppress as stale.
        await db.query(`UPDATE assertions SET suppressed = true WHERE id = $1`, [row.id]);
        suppressed++;
        process.stderr.write(`[handoff] pointer-gate: suppressed legacy stale-pointer assertion id=${row.id} pointer=${ptr.pointer} — file not found\n`);
        continue;
      }
      let fileLines;
      try { fileLines = fs.readFileSync(absPath, 'utf8').split('\n'); } catch (_) { continue; }
      // Compose prose from subject + predicate (object contains only the pointer in these rows).
      const prose = `${row.subject} ${row.predicate} ${row.object}`;
      const lineIdx = ptr.startLine - 1;
      const plausible = lineIdx >= 0 && lineIdx < fileLines.length && fileLines[lineIdx].trim().length > 0;
      if (!plausible) {
        await db.query(`UPDATE assertions SET suppressed = true WHERE id = $1`, [row.id]);
        suppressed++;
        process.stderr.write(`[handoff] pointer-gate: suppressed legacy stale-pointer assertion id=${row.id} pointer=${ptr.pointer} — line out of range or blank\n`);
        continue;
      }
      const hasOverlap = _proseVsContentOverlap(prose, ptr.pointer, fileLines, ptr.startLine);
      if (!hasOverlap) {
        await db.query(`UPDATE assertions SET suppressed = true WHERE id = $1`, [row.id]);
        suppressed++;
        process.stderr.write(`[handoff] pointer-gate: suppressed legacy stale-pointer assertion id=${row.id} pointer=${ptr.pointer} — prose-vs-content mismatch\n`);
      } else {
        // Overlap passes — derive and persist an anchor.
        const resolvedRelPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
        const piResolved = resolvedRelPath !== ptr.path
          ? Object.assign({}, ptr, { path: resolvedRelPath })
          : ptr;
        const anchor = _deriveAnchor(projectRoot, piResolved);
        if (anchor) {
          await db.query(`UPDATE assertions SET anchor = $1 WHERE id = $2`, [JSON.stringify(Object.assign({}, anchor, { pointer: ptr.pointer })), row.id]);
          anchored++;
        }
      }
    }
    if (suppressed > 0) process.stderr.write(`[handoff] pointer-gate: bulk-suppressed ${suppressed} stale legacy assertion(s)\n`);
    if (anchored   > 0) process.stderr.write(`[handoff] pointer-gate: derived anchors for ${anchored} passing legacy assertion(s)\n`);
  } catch (err) {
    process.stderr.write(`[handoff] pointer-gate: bulk supersession failed (non-fatal): ${err.message}\n`);
  }
}

/**
 * Run the full pointer-staleness gate over all text fields (TL;DR, open threads, quick references).
 * Integration entry point called from cmdClose (persistent) and cmdLoaderLoad (read-only).
 *
 * @param {object} fields        — { tldr, openThreads, quickReferences }
 * @param {string} projectRoot
 * @param {object} db            — pg Client
 * @param {string} projectId
 * @param {string} mode          — 'close' | 'resume'
 * @returns {Promise<{ rewrittenFields:object, findings:Array<{rule:string, message:string}> }>}
 */
async function runPointerGate(fields, projectRoot, db, projectId, mode) {
  const { tldr = '', openThreads = '', quickReferences = '' } = fields;
  const allPointers = [
    ..._extractPointers(tldr),
    ..._extractPointers(openThreads),
    ..._extractPointers(quickReferences),
  ];
  const uniquePtrs     = [...new Set(allPointers.map((p) => p.pointer))];
  const storedAnchors  = await _loadStoredAnchors(db, projectId, uniquePtrs);
  const derivedAnchors = new Map();
  const correctedPtrs  = new Map();
  const warnLegacy     = mode === 'close';
  const allFindings    = [];
  const fieldResult    = {};

  for (const [fieldName, fieldText] of [
    ['tldr',            tldr],
    ['openThreads',     openThreads],
    ['quickReferences', quickReferences],
  ]) {
    const { rewrittenText, findings } = validatePointers(
      fieldText, projectRoot, storedAnchors, derivedAnchors, correctedPtrs, mode, warnLegacy
    );
    fieldResult[fieldName] = rewrittenText;
    allFindings.push(...findings);
  }

  if (mode === 'close') {
    await _persistPointerCorrections(db, projectId, correctedPtrs, derivedAnchors);
  }

  return { rewrittenFields: fieldResult, findings: allFindings };
}

// ─── END POINTER-STALENESS GATE ───────────────────────────────────────────────

/**
 * Read JSON payload from stdin (used for --json - flag).
 * Validates structure: only allowed top-level keys, string-field length caps,
 * array length caps. Throws with a field-naming error message on violation.
 *
 * Allowed top-level keys: tldr, open_threads, quick_references, entities,
 *   assertions, edges, decisions, contract, session_id, confirm_claude_md_promotion.
 */
// A3: opts.allowEmpty controls what happens when stdin carries no data at
// all (as opposed to invalid JSON, which is always a hard reject regardless
// of allowEmpty). Default (allowEmpty: false, the caller-side default):
// empty stdin REJECTS with exit 2 and the exact message
// `--json - requires a payload on stdin`, so `close --help` or any other
// unintended argument can never again fall through to an extraction-empty
// write (see incident, scripts/lib/cli-args.js header comment). Callers that
// deliberately want a no-payload close/checkpoint must pass --allow-empty,
// which this function honors by resolving {} instead of rejecting.
function readStdin(opts = {}) {
  const allowEmpty = !!opts.allowEmpty;
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        if (allowEmpty) return resolve({});
        console.error('--json - requires a payload on stdin');
        process.exit(2);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return reject(new Error(`Failed to parse JSON from stdin: ${e.message}`));
      }

      // Must be a plain object, not array or primitive.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(new Error('stdin JSON: payload must be a plain object (not array or primitive)'));
      }

      // Reject unknown top-level keys.
      const ALLOWED_KEYS = new Set([
        'tldr', 'open_threads', 'quick_references',
        'entities', 'assertions', 'edges', 'decisions',
        'contract', 'session_id', 'confirm_claude_md_promotion',
        'retrieval_outcome', 'retrieval_outcome_notes',
        'resolved_threads',
      ]);
      for (const k of Object.keys(parsed)) {
        if (!ALLOWED_KEYS.has(k)) {
          return reject(new Error(`stdin JSON: unknown top-level key "${k}"`));
        }
      }

      // Validate retrieval_outcome if present.
      if ('retrieval_outcome' in parsed) {
        const VALID_OUTCOMES = new Set(['success', 'failure', 'irrelevant']);
        if (typeof parsed.retrieval_outcome !== 'string' || !VALID_OUTCOMES.has(parsed.retrieval_outcome)) {
          return reject(new Error(
            `stdin JSON: "retrieval_outcome" must be one of 'success', 'failure', 'irrelevant' ` +
            `(got ${JSON.stringify(parsed.retrieval_outcome)}); 'pending' and other values are not accepted`
          ));
        }
      }

      // String fields with length cap.
      // Note: open_threads is an array (not a string); quick_references is a string.
      const STRING_FIELDS = ['tldr', 'quick_references', 'session_id', 'retrieval_outcome_notes'];
      const STRING_MAX    = 4000;
      for (const field of STRING_FIELDS) {
        if (field in parsed) {
          if (typeof parsed[field] !== 'string') {
            return reject(new Error(`stdin JSON: "${field}" must be a string`));
          }
          if (parsed[field].length > STRING_MAX) {
            return reject(new Error(
              `stdin JSON: "${field}" exceeds max length (${parsed[field].length} > ${STRING_MAX})`
            ));
          }
        }
      }

      // open_threads: array of strings, each <= STRING_MAX, array length <= 200.
      if ('open_threads' in parsed) {
        if (!Array.isArray(parsed.open_threads)) {
          return reject(new Error('stdin JSON: "open_threads" must be an array'));
        }
        if (parsed.open_threads.length > 200) {
          return reject(new Error(
            `stdin JSON: "open_threads" array length ${parsed.open_threads.length} exceeds max 200`
          ));
        }
        for (let i = 0; i < parsed.open_threads.length; i++) {
          const item = parsed.open_threads[i];
          if (typeof item !== 'string') {
            return reject(new Error(`stdin JSON: "open_threads[${i}]" must be a string`));
          }
          if (item.length > STRING_MAX) {
            return reject(new Error(
              `stdin JSON: "open_threads[${i}]" exceeds max length (${item.length} > ${STRING_MAX})`
            ));
          }
        }
      }

      // resolved_threads: array of strings, each <= STRING_MAX, array length <= 200.
      if ('resolved_threads' in parsed) {
        if (!Array.isArray(parsed.resolved_threads)) {
          return reject(new Error('stdin JSON: "resolved_threads" must be an array'));
        }
        if (parsed.resolved_threads.length > 200) {
          return reject(new Error(
            `stdin JSON: "resolved_threads" array length ${parsed.resolved_threads.length} exceeds max 200`
          ));
        }
        for (let i = 0; i < parsed.resolved_threads.length; i++) {
          const item = parsed.resolved_threads[i];
          if (typeof item !== 'string') {
            return reject(new Error(`stdin JSON: "resolved_threads[${i}]" must be a string`));
          }
          if (item.length > STRING_MAX) {
            return reject(new Error(
              `stdin JSON: "resolved_threads[${i}]" exceeds max length (${item.length} > ${STRING_MAX})`
            ));
          }
        }
      }

      // Array-of-records fields: cap array length and per-record string field length.
      const ARRAY_FIELDS  = ['entities', 'assertions', 'edges', 'decisions'];
      const ARRAY_MAX     = 200;
      const RECORD_STR_MAX = 1000;
      // cm#227: decisions[].topic is the conflict-target column of the plain
      // btree `decisions_project_topic_unique (project_id, topic)` index — the
      // SAME physical-row-size class of defect that motivated re-keying
      // assertions_1ton_exact_unique on md5(object) (see handoff-core-schema.sql).
      // Capped by UTF-8 BYTE length (not char length): a multi-byte character
      // (e.g. CJK, emoji) can push a string well under RECORD_STR_MAX (1000)
      // chars past this physical limit. Checked up front, before any DB
      // mutation, in addition to (and independent of) the generic
      // RECORD_STR_MAX char-length check below.
      const DECISIONS_TOPIC_BYTE_MAX = 2000;
      for (const field of ARRAY_FIELDS) {
        if (field in parsed) {
          if (!Array.isArray(parsed[field])) {
            return reject(new Error(`stdin JSON: "${field}" must be an array`));
          }
          if (parsed[field].length > ARRAY_MAX) {
            return reject(new Error(
              `stdin JSON: "${field}" array length ${parsed[field].length} exceeds max ${ARRAY_MAX}`
            ));
          }
          for (let i = 0; i < parsed[field].length; i++) {
            const rec = parsed[field][i];
            if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
              return reject(new Error(`stdin JSON: "${field}[${i}]" must be a plain object`));
            }
            if (field === 'decisions' && typeof rec.topic === 'string') {
              const topicBytes = Buffer.byteLength(rec.topic, 'utf8');
              if (topicBytes > DECISIONS_TOPIC_BYTE_MAX) {
                return reject(new Error(
                  `stdin JSON: "decisions[${i}].topic" exceeds max byte length ` +
                  `(${topicBytes} > ${DECISIONS_TOPIC_BYTE_MAX} bytes)`
                ));
              }
            }
            for (const [k, v] of Object.entries(rec)) {
              if (typeof v === 'string' && v.length > RECORD_STR_MAX) {
                return reject(new Error(
                  `stdin JSON: "${field}[${i}].${k}" exceeds max length (${v.length} > ${RECORD_STR_MAX})`
                ));
              }
            }
          }
        }
      }

      resolve(parsed);
    });
    process.stdin.on('error', reject);
  });
}

/** Days since an ISO timestamp string. Returns null if not parseable. */
function daysSince(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/** Get a project_settings value, with a fallback default. */
async function getSetting(db, projectId, key, defaultVal) {
  const { rows } = await db.query(
    'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
    [projectId, key]
  );
  return rows.length > 0 ? rows[0].value : defaultVal;
}

/** Upsert a project_settings row. */
async function setSetting(db, projectId, key, value) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, key, String(value)]
  );
}

// ── session_in_progress marker — per-session aware (S3) ─────────────────────
//
// Stored under the single project_settings key 'session_in_progress' (PK is
// (project_id, key) — one row per key, so multiple concurrently-live sessions
// share ONE row whose value is a JSON array of {session_id, ts} objects).
// Pre-existing rows written by code that predates this fix (a bare ISO-8601
// timestamp string) are read back as ONE legacy marker with session_id: null
// — legacy markers carry no identity and are treated as matching ANY current
// session (see findMatchingMarkerIndex), so an upgrade never orphans a marker
// written by the old code.
//
// Total classification of the raw stored value (parseSessionMarkers):
//   - absent / null / ''                    -> []
//   - valid JSON, an array                  -> each element normalized to {session_id, ts};
//                                               a malformed element (no string .ts) is dropped
//   - valid JSON, not an array               -> [] (never produced by this code; fail open)
//   - not valid JSON, non-empty string       -> [{session_id: null, ts: raw}]  (legacy format —
//                                               see note below; ANY opaque string counts, not
//                                               only an ISO timestamp)
//   - not valid JSON, empty/non-string       -> [] (garbage — fail open, never crash)
//
// Note on the legacy branch: pre-S3 code (cmdLoaderHook/cmdResume) always wrote
// new Date().toISOString(), but the pre-S3 READ side (writeExtraction's session-id
// fallback, resolveSessionId) never actually required that shape — an opaque,
// non-date-parseable string was explicitly used as-is "for backward compat"
// (and test fixtures rely on exactly that: an arbitrary marker string standing
// in for "a session is in progress"). Preserving that same total classification
// here — legacy = "not JSON", full stop — is what keeps those callers correct
// after this fix; see latestSessionMarker's handling of an unparseable ts.

// parseSessionMarkersDetailed / parseSessionMarkers now live in
// ./lib/session-identity.js (required at the top of this file), lifted
// verbatim (fix/usage-record-marker-fallback) so resolveSessionIdFromMarker
// there — and every pre-existing caller here (status, loader-stop, resume,
// close) — read markers through the SAME implementation. No behavior
// change: same total classification, same dropped/coerced counting; see
// that module's header comment for the full doc this used to carry.

/** Read all in-flight session markers for a project. See parseSessionMarkers. */
async function getSessionMarkers(db, projectId) {
  const raw = await getSetting(db, projectId, 'session_in_progress', null);
  return parseSessionMarkers(raw);
}

/**
 * Write the full marker list back. An empty list DELETEs the row entirely —
 * this matches the legacy "absent key = no session in progress" semantics
 * every existing caller of getSetting(..., 'session_in_progress', null) relies on.
 */
async function setSessionMarkers(db, projectId, list) {
  if (!list || list.length === 0) {
    await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'session_in_progress'`,
      [projectId]
    );
    return;
  }
  await setSetting(db, projectId, 'session_in_progress', JSON.stringify(list));
}

/**
 * Concurrency hardening: run `fn()` inside a transaction holding a per-
 * project advisory lock on the session_in_progress marker row, closing the
 * read-modify-write race between two concurrent hook invocations for the
 * same project (e.g. two SessionStart hooks, or a SessionStart racing a
 * SessionEnd) that would otherwise lose one side's marker addition/removal.
 *
 * Style matches scripts/lib/routing-profile.js's routingProfileSet: caller-
 * side BEGIN, then a `pg_advisory_xact_lock(hashtext(key))` transaction-
 * scoped lock taken BEFORE the read, then COMMIT (ROLLBACK on error) —
 * reused here as its own helper (rather than re-inlined per call site)
 * because every marker mutation site needs the identical BEGIN/lock/COMMIT
 * wrapper, unlike routing-profile.js's single call site.
 *
 * The lock itself is taken via db.acquireNamedXactLock(lockKey) — a port
 * method on both db-seam.js adapters (S8 abstraction invariant: the engine
 * never branches on the adapter's backend/dialect; the dialect-specific
 * mechanism lives in db-seam.js, one call site per adapter). SQLite has no
 * cross-connection
 * advisory-lock primitive and this codebase's SQLite seam is a single-
 * process/test-only backend, so SQLiteAdapter.acquireNamedXactLock is a
 * documented no-op there.
 *
 * Callers must NOT already be inside a transaction on this `db` connection.
 */
async function withSessionMarkerLock(db, projectId, fn) {
  await db.query('BEGIN');
  try {
    await db.acquireNamedXactLock(`session_in_progress:${projectId}`);
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/**
 * Upsert this session's own marker into the list (dedupe by session_id —
 * re-writing the SAME session's marker, e.g. on /clear or /compact, refreshes
 * its ts rather than accumulating a duplicate entry). Lock-guarded — see
 * withSessionMarkerLock.
 */
async function addSessionMarker(db, projectId, sessionId, ts) {
  return withSessionMarkerLock(db, projectId, async () => {
    const list = await getSessionMarkers(db, projectId);
    const filtered = sessionId ? list.filter((m) => m.session_id !== sessionId) : list;
    filtered.push({ session_id: sessionId || null, ts });
    await setSessionMarkers(db, projectId, filtered);
  });
}

/**
 * PR4 (marker identity hardening): find the index of the marker matching
 * currentSessionId. Total classification — replaces the former "null
 * session_id is a wildcard whenever no exact match exists" behavior (S4),
 * which let ANY session (real or unresolved) claim a legacy marker even
 * when OTHER, real-identity markers coexisted in the same list — see the
 * spec's H2 finding.
 *
 *   1. An exact session_id match (marker.session_id === currentSessionId,
 *      currentSessionId non-null) always wins first.
 *   2. Otherwise, the legacy single-entry exception: if the ENTIRE list has
 *      EXACTLY ONE entry and that entry's session_id is null, it is claimed
 *      REGARDLESS of currentSessionId (null or a real, non-matching id) —
 *      the true pre-S3 legacy single-session shape, where "any session
 *      closing" is provably correct (there is no sibling to misattribute
 *      against), not a guess.
 *   3. Otherwise -1 (no match). In particular, two or more entries — even
 *      with a null entry present — NEVER auto-claim the null entry as a
 *      wildcard; the caller must report "unresolved legacy marker present"
 *      and leave everything in place (see cmdLoaderStop /
 *      clearSessionMarkerForClose).
 *
 * Returns -1 when no marker belongs to the current session — sibling
 * sessions' own markers are never matched.
 */
function findMatchingMarkerIndex(list, currentSessionId) {
  if (currentSessionId) {
    const exact = list.findIndex((m) => m.session_id === currentSessionId);
    if (exact !== -1) return exact;
  }
  // Legacy single-entry exception applies REGARDLESS of currentSessionId
  // (null or a real, non-matching id) — see the header comment above: there
  // is no sibling to misattribute against when the entire list is one
  // opaque legacy marker, so "any session closing" is provably correct.
  if (list.length === 1 && list[0].session_id === null) return 0;
  return -1;
}

// latestSessionMarker now lives in ./lib/session-identity.js (required at
// the top of this file), lifted verbatim alongside parseSessionMarkers* —
// see that module's header comment. No behavior change.

/**
 * Human-readable summary of the per-session session_in_progress markers for
 * /handoff:status display. A single legacy bare-string marker (session_id:
 * null) renders byte-identically to the pre-S3 single-value display; a real
 * (or multiple) per-session marker(s) render with a count + the latest
 * session-id prefix + timestamp, so an operator sees there's more than one
 * session in flight without decoding the raw JSON array by hand.
 * Returns { active: boolean, id: string|null, prose: string } — `id` is the
 * same representative value (real session_id, or legacy ts) every other
 * single-value consumer uses (see latestSessionMarker), kept for the
 * --json session_id field's existing string|null contract.
 */
function formatSessionMarkersForStatus(markers) {
  if (!markers || markers.length === 0) {
    return { active: false, id: null, prose: 'no' };
  }
  if (markers.length === 1 && markers[0].session_id === null) {
    // Legacy bare-string marker — byte-identical to the pre-S3 display.
    return { active: true, id: markers[0].ts, prose: `YES (session_id=${markers[0].ts})` };
  }
  const latest   = latestSessionMarker(markers);
  const idPrefix = latest.session_id ? latest.session_id.slice(0, 8) : '(legacy)';
  const id       = latest.session_id || latest.ts;
  const prose    = `YES (${markers.length} marker${markers.length === 1 ? '' : 's'} — latest ${idPrefix} at ${latest.ts})`;
  return { active: true, id, prose };
}

// resolveSessionIdFromEnv now lives in ./lib/session-identity.js (required at
// the top of this file) so scripts/handoff-mcp.mjs's usage_record/usage_query
// tools can resolve a default sessionId from the exact same env-var
// precedence without a second hand-rolled implementation (memory PR #284 /
// adversary G2). No behavior change — see that module for the full
// classification doc comment.

/**
 * Resolve the current session id from a Claude Code hook stdin payload
 * (already parsed — see readHookStdinPermissive), falling back to
 * resolveSessionIdFromEnv(host). Returns null when neither is available
 * (never fabricates an id here — loader-hook's fresh-marker write is the
 * only place a random fallback id is appropriate; see cmdLoaderHook).
 */
function resolveHookSessionId(hookPayload, host) {
  if (hookPayload && typeof hookPayload.session_id === 'string' && hookPayload.session_id.length > 0) {
    return hookPayload.session_id;
  }
  return resolveSessionIdFromEnv(host || null);
}

/**
 * PR4 (marker identity hardening): host-independent session id resolution
 * used everywhere a marker is ADDED (dedupe key: cmdLoaderHook's SessionStart
 * write, cmdResume's fresh marker) or CLEARED (cmdLoaderStop's SessionEnd
 * match, clearSessionMarkerForClose's explicit-close match). `host` is never
 * consulted — see the spec at
 * C:\Users\djwmo\Downloads\pr4-marker-identity-spec-2026-09-09.md section 2
 * for the reproduced defect this replaces: resolveHookSessionId/
 * resolveSessionIdFromEnv's host-based tie-break, applied at CLEAR time,
 * let a nested child process (which inherits an ancestor's CODEX_THREAD_ID
 * while also carrying its own distinct CLAUDE_CODE_SESSION_ID) resolve to
 * the PARENT's real identity and delete the parent's own marker. Guessing
 * which of two live, differing env values is "the current invocation" is
 * never safe — at ADD time a wrong guess merely creates a harmless extra
 * marker (self-correcting once that session closes properly); at CLEAR time
 * it deletes another session's live state (not self-correcting). This
 * resolver therefore refuses to guess in both directions, uniformly.
 *
 * Total classification over {payload.session_id, CLAUDE_CODE_SESSION_ID,
 * CODEX_THREAD_ID}:
 *   payload.session_id present (trimmed, non-empty)          -> that value
 *   else both env vars unset                                  -> null
 *   else exactly one env var set                               -> that one
 *   else both set and EQUAL (exact `===`, case-sensitive)      -> that value
 *   else both set and DIFFERENT                                -> null
 *     (unresolved — never guesses; see isAmbiguousSessionEnvPair, which
 *     names this exact branch for outcome reporting).
 *
 * All comparisons are exact string equality (`===`), case-sensitive; neither
 * this function nor its env-only helper performs any format validation on
 * the id itself (a malformed-looking string from payload or a single
 * unambiguous env var is still used as-is).
 *
 * A caller that needs a fresh id when this returns null (add-time only —
 * never at clear time, see the spec's "refusal is correct, not minting, for
 * clear specifically") does so itself: `resolveClearSessionId(p) ||
 * crypto.randomUUID()`.
 */
function resolveClearSessionId(hookPayload) {
  const rawPayloadId = (hookPayload && typeof hookPayload.session_id === 'string')
    ? hookPayload.session_id.trim()
    : '';
  if (rawPayloadId.length > 0) return rawPayloadId;

  const claudeRaw = process.env.CLAUDE_CODE_SESSION_ID;
  const codexRaw  = process.env.CODEX_THREAD_ID;
  const claudeId  = typeof claudeRaw === 'string' ? claudeRaw.trim() : '';
  const codexId   = typeof codexRaw  === 'string' ? codexRaw.trim()  : '';
  const hasClaudeId = claudeId.length > 0;
  const hasCodexId  = codexId.length > 0;

  if (!hasClaudeId && !hasCodexId) return null;
  if (hasClaudeId && !hasCodexId) return claudeId;
  if (!hasClaudeId && hasCodexId) return codexId;
  if (claudeId === codexId) return claudeId;
  // Both set and differ — refuse to guess. Unlike resolveSessionIdFromEnv,
  // host is never consulted and no notice is printed here; the caller
  // decides whether/how to surface "unresolved" (see cmdLoaderStop's
  // session_id_unresolved outcome and clearSessionMarkerForClose's branch E).
  return null;
}

/**
 * True iff CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are both set (after
 * trim) and differ — the exact env shape that makes resolveClearSessionId's
 * env fallback return null when the hook payload itself carried no usable
 * session_id. Used only to distinguish, for outcome reporting, "unresolved
 * because both env vars disagree" from "unresolved because neither is set"
 * — both resolve to the same `null` from resolveClearSessionId, but only
 * the former is the PR4 ambiguity case (session_id_unresolved).
 */
function isAmbiguousSessionEnvPair() {
  const claudeRaw = process.env.CLAUDE_CODE_SESSION_ID;
  const codexRaw  = process.env.CODEX_THREAD_ID;
  const claudeId  = typeof claudeRaw === 'string' ? claudeRaw.trim() : '';
  const codexId   = typeof codexRaw  === 'string' ? codexRaw.trim()  : '';
  return claudeId.length > 0 && codexId.length > 0 && claudeId !== codexId;
}

/**
 * S1: read Claude Code hook JSON from stdin with a permissive, fail-open
 * parser — total classification, evaluated with ZERO prior I/O beyond the
 * stdin read itself. Mirrors the proven pattern in
 * ~/.claude/hooks/handoff-close-worktree-gate.js's handleHookStdin(): any
 * failure (unreadable stdin, empty stdin, malformed JSON, non-object JSON)
 * returns null rather than throwing. Callers treat null as "nothing to act
 * on" and exit 0 immediately — this function itself never exits the process
 * so it can be reused by both the Stop-turned-SessionEnd gate (cmdLoaderStop)
 * and the SessionStart hook (cmdLoaderHook), which have different classification
 * rules for what a null/absent payload means.
 */
function readHookStdinPermissive() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Shared implicit-close writer used by cmdLoaderStop (this session ended
 * without an explicit close) AND cmdLoaderHook's late-close sweep (a sibling
 * session's marker went stale without ever being explicitly closed or
 * SessionEnd-triggered — e.g. the process was killed before teardown).
 * Re-renders handoff.md from the current frontmatter/body, preserving every
 * field except last_close and tldr.
 *
 * Design note on handoff.md body preservation: writeHandoffMd() re-renders
 * from the full template, which would overwrite the body (tldr, open_threads,
 * quick_references) with whatever we pass. For an implicit close we do NOT
 * have a fresh extraction payload, so we preserve the existing body by
 * reading the current frontmatter and passing its values back. The only
 * fields we override are last_close (set to now) and tldr (set to the
 * implicit-close notice). This matches the pattern used by cmdCheckpoint —
 * read current fm, then call writeHandoffMd with merged values — which is
 * cleaner than trying to surgically edit the raw file.
 */
function writeImplicitClose(handoffPath, projectId, root) {
  const fm    = readHandoffFrontmatter(handoffPath);
  const stamp = new Date().toISOString();

  const ss = fm.session_summary || {};
  const entitiesWritten   = ss.entities_written   || '0';
  const assertionsWritten = ss.assertions_written || '0';
  const edgesWritten      = ss.edges_written      || '0';
  const contractName      = fm.contract           || 'default';
  const projectName       = fm.project_name       || path.basename(root);

  // Reconstruct open_threads and quick_references from the handoff.md body
  // (they live in the body section, not in YAML frontmatter).
  let openThreads = '- (none)';
  let quickRefs   = '(none)';
  try {
    const raw  = fs.readFileSync(handoffPath, 'utf8');
    const body = raw.replace(/^---[\s\S]*?---\r?\n/, '');
    const otMatch = body.match(/##\s+Open threads\r?\n([\s\S]*?)(?=\r?\n##|\r?\n$|$)/);
    if (otMatch) openThreads = otMatch[1].trim() || '- (none)';
    const qrMatch = body.match(/##\s+Quick references\r?\n([\s\S]*?)(?=\r?\n##|\r?\n$|$)/);
    if (qrMatch) quickRefs = qrMatch[1].trim() || '(none)';
  } catch (_) {
    // Body parse failed — fall back to safe defaults.
  }

  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          stamp,
    CONTRACT:            contractName,
    ENTITIES_WRITTEN:    entitiesWritten,
    ASSERTIONS_WRITTEN:  assertionsWritten,
    EDGES_WRITTEN:       edgesWritten,
    PROJECT_NAME:        projectName,
    TLDR:                '(implicit close — session ended without explicit /handoff:close)',
    OPEN_THREADS:        openThreads,
    QUICK_REFERENCES:    quickRefs,
    DEGRADED_SECTION:    '',
    RECONCILIATION_SECTION: '',
  });
}

/**
 * L4: Record a degraded close — a subsystem (C2 or C3) that silently skipped
 * because the session id was unresolvable.
 *
 * Writes a project_settings row keyed `degraded_close:<closeStamp>` with a
 * JSON value carrying the subsystem name, reason, and timestamp. The key
 * includes an ISO timestamp so successive degraded closes accumulate as
 * distinct rows (append-style — never overwrites a prior degraded record).
 *
 * Non-fatal: any write error is logged to stderr and ignored so cmdClose
 * continues. Returns the stamp used in the key so callers can reference it.
 *
 * @param {object}      db         - storage adapter (port interface)
 * @param {string}      projectId
 * @param {string|null} sessionId  - session id if known, null if unresolvable
 * @param {string}      subsystem  - 'C2' | 'C3'
 * @param {string}      reason     - human-readable skip reason
 * @returns {Promise<string>}       - the ISO stamp used in the key
 */
// Monotonic counter for recordDegradedClose key uniqueness within a process.
// Ensures that two records written within the same millisecond get distinct keys.
let _degradedCloseSeq = 0;

async function recordDegradedClose(db, projectId, sessionId, subsystem, reason) {
  const stamp = new Date().toISOString();
  const seq   = String(_degradedCloseSeq++).padStart(4, '0');
  // Key: degraded_close:<ISO-stamp>:<seq> — ISO stamp for ordering/filtering;
  // seq suffix guarantees uniqueness when multiple subsystems degrade in the same ms.
  const key   = `degraded_close:${stamp}:${seq}`;
  const val   = JSON.stringify({ subsystem, reason, stamp, sessionId: sessionId || null });
  try {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, val]
    );
  } catch (writeErr) {
    process.stderr.write(`[handoff] recordDegradedClose write failed (non-fatal): ${writeErr.message}\n`);
  }
  return stamp;
}

/**
 * Prune excess degraded_close:* records, keeping the most recent `keep` rows.
 * Deletes only the oldest excess beyond the keep limit, preserving the
 * append-only audit trail for all recent records.
 *
 * Works on both Postgres and the SQLite seam: the NOT IN subquery is valid
 * in both dialects; $1 appears twice — pass [projectId, projectId] so the
 * SQLite rewrite (which maps each $\d+ → ?) gets two bound values.
 * Fail-soft: any error is logged to stderr and never aborts close.
 *
 * @param {object} db        — DB adapter with .query(sql, params) → {rows}
 * @param {string} projectId
 * @param {number} [keep=100]
 */
async function pruneDegradedClose(db, projectId, keep = 100) {
  try {
    // $1 / $2 are both projectId; using distinct positional params ($1 outer,
    // $2 subquery) satisfies Postgres (which counts unique $N references) while
    // the SQLite rewrite maps each $\d+ → ? giving two bound values — both work.
    await db.query(
      `DELETE FROM project_settings
       WHERE project_id = $1
         AND key LIKE 'degraded_close:%'
         AND key NOT IN (
           SELECT key FROM project_settings
           WHERE project_id = $2
             AND key LIKE 'degraded_close:%'
           ORDER BY key DESC
           LIMIT ${keep}
         )`,
      [projectId, projectId]
    );
  } catch (pruneErr) {
    process.stderr.write(`[handoff] degraded_close prune failed (non-fatal): ${pruneErr.message}\n`);
  }
}

/**
 * Deep-equal comparison for two retrieval contract objects.
 * Compares via JSON.stringify (contract shape is {queries:[...]}, deterministic).
 * Exported for unit tests.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function queriesEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/**
 * Record a contract change: bump the version and write a history row.
 *
 * Transactional:
 *   1. SELECT current version + queries for (projectId, name).
 *   2. If the row exists and its queries deep-equal newQueriesObj → NO-OP
 *      (idempotent — prevents history spam on identical re-close).
 *   3. Otherwise compute newVersion, UPSERT retrieval_contract with the new
 *      queries/version, and INSERT a retrieval_contract_history row.
 *
 * Non-fatal: callers must wrap in try/catch — a history failure must not abort
 * the operation that triggered it.
 *
 * @param {object}  db            — pg Client
 * @param {string}  projectId     — encoded_cwd
 * @param {string}  name          — contract name (e.g. 'default')
 * @param {object}  newQueriesObj — the new contract object (e.g. {queries:[...]})
 * @param {string|null} changeNote — human-readable note stored in history row
 */
async function recordContractChange(db, projectId, name, newQueriesObj, changeNote) {
  await db.query('BEGIN');
  try {
    // Read current state.
    const { rows } = await db.query(
      `SELECT version, queries FROM retrieval_contract
       WHERE project_id = $1 AND name = $2`,
      [projectId, name]
    );

    const existing = rows.length > 0 ? rows[0] : null;

    // Idempotent no-op: if the contract is unchanged, do nothing.
    if (existing && queriesEqual(existing.queries, newQueriesObj)) {
      await db.query('COMMIT');
      return;
    }

    const newVersion = existing ? (existing.version || 0) + 1 : 1;

    // Upsert the live contract row with the new queries and bumped version.
    await db.query(
      `INSERT INTO retrieval_contract (project_id, name, queries, version, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (project_id, name) DO UPDATE
         SET queries = EXCLUDED.queries, version = EXCLUDED.version, updated_at = now()`,
      [projectId, name, JSON.stringify(newQueriesObj), newVersion]
    );

    // Insert audit history row.
    await db.query(
      `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [projectId, name, newVersion, JSON.stringify(newQueriesObj), changeNote || null]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Detect whether the repository at `cwd` has more than one commit author in the
 * past year. Returns the distinct author-email count.
 *
 * Uses HANDOFF_MULTI_AUTHOR_OVERRIDE env var to inject a fixed count for tests.
 *
 * Silently returns 1 if:
 *   - git is unavailable
 *   - the directory is not a git repo
 *   - any other error occurs
 */
function detectMultiAuthor(cwd) {
  // Test hook: override the count without touching the real git log.
  const override = process.env.HANDOFF_MULTI_AUTHOR_OVERRIDE;
  if (override !== undefined) {
    const n = parseInt(override, 10);
    return isNaN(n) ? 1 : n;
  }

  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '--format=%ae', '--since=1 year ago'],
      {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        // Pass PROJECT_ROOT so any transitive subprocess resolves the correct project root.
        env: { ...process.env, PROJECT_ROOT: cwd },
      }
    );
    const emails = new Set(out.split('\n').map((e) => e.trim()).filter(Boolean));
    return emails.size || 1;
  } catch (_) {
    // git not available, not a repo, or no commits — treat as single-author.
    return 1;
  }
}

/**
 * Read-only git probe: determine whether the working tree at `root` has
 * unpackaged state (dirty tree or local commits not yet pushed upstream).
 *
 * Returns { dirty: boolean, aheadCount: number, label: string }.
 *
 * Failures (git unavailable, not a repo, no upstream) are handled silently:
 *   - git errors → dirty=false, aheadCount=0, label='clean (probe unavailable)'
 *   - no upstream branch → aheadCount treated as 0 (not an error condition)
 *
 * NEVER runs a mutating git command.
 */
function detectUnpackagedState(root) {
  try {
    // Pass PROJECT_ROOT so any transitive subprocess resolves the correct project root.
    const execOpts = {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PROJECT_ROOT: root },
    };

    // Check for dirty working tree (untracked, modified, or staged changes).
    const statusOut = execFileSync('git', ['-C', root, 'status', '--porcelain'], execOpts);
    // Defense-in-depth: filter out any porcelain line whose path basename matches the
    // reserved close-payload staging pattern.  This ensures that even an in-tree payload
    // file (which should NEVER be written inside the repo — see close.md) cannot flip the
    // snapshot to dirty.  The real fix is operator hygiene (use os.tmpdir() staging); this
    // filter is a safety net only.
    const PAYLOAD_STAGING_RE = /^(?:\.)?handoff-close-payload.*\.json$/i;
    const filteredLines = statusOut.split('\n').filter((line) => {
      if (!line.trim()) return false;
      // Git --porcelain format: "XY filename" or "XY dir/filename" (may include quotes).
      const filePart = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
      return !PAYLOAD_STAGING_RE.test(path.basename(filePart));
    });
    const dirty = filteredLines.length > 0;

    // Check for local commits ahead of upstream; treat no-upstream as 0.
    let aheadCount = 0;
    try {
      const aheadOut = execFileSync(
        'git', ['-C', root, 'rev-list', '--count', '@{upstream}..HEAD'], execOpts
      );
      aheadCount = parseInt(aheadOut.trim(), 10) || 0;
    } catch (_) {
      // No upstream configured — treat as 0 ahead, not an error.
      aheadCount = 0;
    }

    const unpackaged = dirty || aheadCount > 0;
    const parts = [];
    if (dirty) parts.push('dirty working tree');
    if (aheadCount > 0) parts.push(`${aheadCount} commit(s) ahead of upstream`);
    const label = unpackaged ? parts.join(', ') : 'clean';
    return { dirty, aheadCount, unpackaged, label };
  } catch (_) {
    // git unavailable, not a repo, or any other error — skip silently.
    return { dirty: false, aheadCount: 0, unpackaged: false, label: 'clean (probe unavailable)' };
  }
}

// ─── SCHEMA AUTO-APPLY (cm#185 generalized schema bring-forward) ─────────────
//
// Generalizes the former hardcoded two-file (core+sqlite) apply into a total
// classification of scripts/sql/*.sql (see scripts/lib/schema-classify.js and
// scripts/sql/schema-manifest.json). Design summary (full rationale in the
// cm#185 PR body / issue #185):
//   - Enumeration + a required-minimum roster + an in-file header directive
//     cross-checked against the tracked manifest together drive a TOTAL
//     classification of every file in scripts/sql/ into postgres | sqlite |
//     excluded. Any disagreement/absence/unknown is a loud, non-fatal error
//     (persistent project_settings 'schema_apply_degraded' row + stderr),
//     surfaced by /handoff:status and the resume banner — never a silent skip.
//   - The fingerprint is epoch-prefixed ("<epoch>:<hash>") so an older engine
//     talking to a DB stamped by a newer engine build detects "ahead" and
//     refuses to apply, rather than looping.
//   - Apply is per-file-transaction, fail-fast: a failing unit stops the
//     sequence immediately: later units are not attempted and the fingerprint
//     is not upserted.
//   - The whole detect+apply+verify+upsert sequence runs under a session-scoped
//     Postgres advisory lock (db.acquireSchemaApplyLock), with a fingerprint
//     re-check immediately after acquiring — a losing concurrent process is a
//     clean no-op.
//   - The fingerprint is upserted ONLY after a post-apply catalog probe
//     (db.schemaObjectsExist) confirms every expected table/column/index from
//     the applied units' manifest entries is actually present — "did not
//     throw" is never treated as proof of "is present" (closes the pgvector-
//     DO-block / duplicate-column-swallow silent-degrade class of bug).

const { classifySchemaFiles, normalizeContent } = require('./lib/schema-classify');

// Must match scripts/sql/schema-manifest.json's top-level "schema_epoch".
// Bump BOTH together whenever the applicable-unit set or any unit's DDL
// changes in a way that must force a re-apply on already-current databases.
// Bumped to 2 (cm#224): decisions-base.sql added to the postgres unit set --
// every already-current live project DB must re-apply once to pick up
// `decisions`/`audit_log`/the decisions_audit trigger.
// Bumped to 3 (cm#227): assertions_1ton_exact_unique re-keyed on md5(object)
// instead of the raw object column (fixes a live btree-row-size failure on
// long TL;DR/quick_reference intent rows) -- every already-current live
// project DB must re-apply once to pick up the DROP+CREATE pair for this
// index (see handoff-core-schema.sql's comment on the index for the full
// rationale; _extractIntegrityIndexOps pairs the DROP+CREATE atomically).
// Bumped to 4 (cm#233): open_thread subject derivation moved from
// deriveIntentSubject to intentKey (scripts/lib/intent-key.js) -- no DDL
// shape changed, but every already-current live project DB must run
// scripts/migrations/migrate-17-intent-key.js's one-time re-key ONCE so no
// DB is left with a mix of old-style (colon-split/80-char) and new-style
// (NFC/whitespace-collapsed/1000-byte) open_thread subjects. The epoch bump
// is the trigger ensureSchemaCurrent's wrapper (see runIntentKeyMigration-
// IfNeeded below) uses to know a re-touch is owed; applyAdditiveSchema
// itself is a pure no-op re-apply here (every unit's own DDL is IF NOT
// EXISTS / DROP+CREATE-idempotent) -- the epoch bump exists purely to force
// the migration gate to run at least once on every live DB, matching the
// PR #225 (cm#224) precedent for a non-DDL-shape reason to bump.
// Bumped to 5 (PR-A, 2026-09-12): usage-telemetry-schema.sql (turn_usage,
// session_usage) and feature-usage-schema.sql (feature_usage) -- formerly
// applied ONLY to memory_manager_staging via migrate-schema-addenda.js --
// are added to the postgres applicable-unit set in scripts/sql/, so every
// already-current live project DB must re-apply once to pick up these
// three tables via init/heal-on-touch.
const SCHEMA_EPOCH = 5;

// Module-level cache: maps schemaFilePath → { mtimeMs, size, hash } so repeated
// calls in one process don't re-read or re-hash the SQL files. Keyed on
// (mtimeMs, size) rather than mtimeMs alone (S-21) — a same-millisecond
// content-changing write with an unchanged size is vanishingly rare in this
// engine's own usage pattern (hand-edited SQL files between process runs),
// but the extra guard is free. Reset implicitly on process restart; never
// persisted.
const _schemaHashCache = new Map();

/**
 * Return a stable SHA-256 hex digest of a schema file's EOL/BOM-normalized
 * content (strip leading BOM; CRLF/CR → LF before hashing). Normalizing before
 * hashing is what makes the fingerprint identical across a Windows CRLF
 * working-tree checkout and a Linux CI LF checkout of the same commit (S-8).
 */
function _hashSchemaFileNormalized(filePath) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (_) { /* file absent */ }
  const mtimeMs = stat ? stat.mtimeMs : 0;
  const size    = stat ? stat.size    : 0;
  const cached  = _schemaHashCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
  const raw        = stat ? fs.readFileSync(filePath, 'utf8') : '';
  const normalized = normalizeContent(raw);
  const hash        = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  _schemaHashCache.set(filePath, { mtimeMs, size, hash });
  return hash;
}

/**
 * Compute the epoch-prefixed fingerprint for an ordered set of classified
 * schema units (the active dialect's applicable set — see
 * classifySchemaFiles().unitsByDialect). Entries are re-sorted here by
 * UTF-16 code-unit order on the (already-lowercase, since these are the
 * engine's own real basenames) basename — NOT filesystem/readdir order,
 * which is platform-dependent (S-7) — before hashing, so a rename with
 * identical content changes the fingerprint and a removal changes it too.
 *
 * cm#185-schema-heal (adversary finding #9, MINOR): also folds
 * schema-manifest.json's own bytes into the hash. Without this, an
 * expected_objects/pgvector_gated hand-edit with zero SQL byte change
 * (a typo, a rename, a phantom entry) leaves the fingerprint bit-identical
 * — the very next probe could flip degraded/healed status purely from a
 * manifest commit, with no epoch bump and no "drift detected" line
 * explaining why. Folding the manifest's bytes in means any such edit
 * forces exactly one (idempotent, safe) re-apply on the next touch, same as
 * any SQL file edit already does.
 *
 * @param {Array<{basename:string, fullPath:string}>} units
 * @returns {string} "<SCHEMA_EPOCH>:<sha256 hex>"
 */
function _computeSchemaFingerprint(units) {
  // cm#185 review N3: sort key is the LOWERCASED basename per R-3's identity
  // rule (identity = basename.toLowerCase()), not the raw basename. Every
  // current unit basename is already all-lowercase so this is a no-op today,
  // but keeps the sort order stable once a mixed-case unit is ever added
  // (case-fold collisions are already rejected earlier, in classifySchemaFiles).
  const sorted = [...units].sort((a, b) => {
    const al = a.basename.toLowerCase();
    const bl = b.basename.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  });
  const hash = crypto.createHash('sha256');
  for (const u of sorted) {
    hash.update(u.basename + '\0' + _hashSchemaFileNormalized(u.fullPath), 'utf8');
  }
  const manifestPath = path.join(_ENGINE_ROOT, 'scripts', 'sql', 'schema-manifest.json');
  hash.update('schema-manifest.json\0' + _hashSchemaFileNormalized(manifestPath), 'utf8');
  return `${SCHEMA_EPOCH}:${hash.digest('hex')}`;
}

/**
 * Parse a stored/current fingerprint string into { epoch, hash }.
 * Bare 64-hex-char legacy values (pre-epoch format, written by the engine
 * before cm#185) parse as epoch 0 — always "behind" the current epoch, so a
 * legacy-fingerprinted DB re-applies exactly once and then carries the new
 * epoch-prefixed format from then on.
 * Anything else unparseable → { epoch: null, hash: null }.
 */
function _parseSchemaFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return { epoch: null, hash: null };
  const epochMatch = value.match(/^(\d+):([0-9a-f]{64})$/);
  if (epochMatch) return { epoch: parseInt(epochMatch[1], 10), hash: epochMatch[2] };
  if (/^[0-9a-f]{64}$/.test(value)) return { epoch: 0, hash: value };
  return { epoch: null, hash: null };
}

/**
 * Compare a stored fingerprint against the current one.
 * Returns 'absent' | 'current' | 'behind' | 'ahead' | 'unknown'.
 */
function _compareSchemaFingerprint(stored, current) {
  if (stored == null) return 'absent';
  const s = _parseSchemaFingerprint(stored);
  const c = _parseSchemaFingerprint(current);
  if (s.epoch === null) return 'unknown';
  if (s.epoch > c.epoch) return 'ahead';
  if (s.epoch < c.epoch) return 'behind';
  return s.hash === c.hash ? 'current' : 'behind';
}

// The two integrity (partial unique) indexes whose CREATE can legitimately
// fail on a legacy-duplicate corpus and must therefore run in the non-fatal
// phase, separate from the fatal per-file DDL transaction.
const INTEGRITY_INDEX_NAMES = ['assertions_1to1_unique', 'assertions_1ton_exact_unique'];

/**
 * Extract the integrity-index operations from a unit's SQL text.
 *
 * For each name in INTEGRITY_INDEX_NAMES, if a CREATE [UNIQUE] INDEX
 * statement for that name is present, extract it — and, if a matching
 * `DROP INDEX IF EXISTS <name>;` statement precedes it in the same file,
 * extract that too and pair them (S-11: the DROP must run in the SAME
 * non-fatal phase as the CREATE, atomically, so a failing re-create can never
 * leave the index permanently destroyed). A lone CREATE (no preceding DROP)
 * runs via db.runIntegrityIndex() unchanged from prior behavior.
 *
 * @param {string} sql
 * @returns {{ coreSQL: string, ops: Array<{name, dropSql: string|null, createSql: string}> }}
 */
function _extractIntegrityIndexOps(sql) {
  let coreSQL = sql;
  const ops = [];
  for (const idxName of INTEGRITY_INDEX_NAMES) {
    const createPattern = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${idxName}[\\s\\S]*?;`,
      'i'
    );
    const createMatch = coreSQL.match(createPattern);
    if (!createMatch) continue;

    const dropPattern = new RegExp(`DROP\\s+INDEX\\s+IF\\s+EXISTS\\s+${idxName}\\s*;`, 'i');
    const dropMatch = coreSQL.match(dropPattern);
    let dropSql = null;
    if (dropMatch) {
      dropSql = dropMatch[0];
      coreSQL = coreSQL.replace(dropSql, '');
    }
    const createSql = createMatch[0];
    coreSQL = coreSQL.replace(createSql, '');
    ops.push({ name: idxName, dropSql, createSql });
  }
  return { coreSQL, ops };
}

/**
 * Apply an ordered set of classified schema units. Per-file transaction,
 * fail-fast: the first unit whose DDL throws stops the sequence — later
 * units are NOT attempted. Does NOT touch project_settings.schema_fingerprint;
 * callers decide whether/when to upsert (only after post-apply verification).
 *
 * splitStatements() (db-seam.js) is intentionally NEVER used here — the two
 * DO $$ ... $$ dollar-quoted blocks in handoff-core-schema.sql would be
 * shredded by its non-dollar-quote-aware statement splitter. Each unit's SQL
 * is sent to db.runSchema() as a single multi-statement string (Postgres
 * treats it as one implicit transaction segment inside our explicit BEGIN;
 * node:sqlite splits it internally via its own dollar-quote-free splitter,
 * which the two DO blocks never reach on the SQLite path since SQLite units
 * carry no DO blocks).
 *
 * @param {object} db — connected StoragePort adapter
 * @param {Array<{basename, fullPath}>} units — ordered, active-dialect classified units
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false]
 * @returns {Promise<{ok, appliedUnits, failedUnit, errorMsg, integrityResults}>}
 */
async function applyAdditiveSchema(db, units, { silent } = {}) {
  const appliedUnits = [];
  const integrityResults = [];

  for (const unit of units) {
    if (!fs.existsSync(unit.fullPath)) {
      return {
        ok: false, appliedUnits, failedUnit: unit.basename,
        errorMsg: `schema file not found: ${unit.fullPath}`, integrityResults,
      };
    }

    let sql = normalizeContent(fs.readFileSync(unit.fullPath, 'utf8'));
    // Strip psql meta-commands (\ir, \d, etc.) — not supported by the pg client.
    sql = sql.replace(/^\\[a-z].*$/gm, '');

    const { coreSQL, ops } = _extractIntegrityIndexOps(sql);

    // Phase A (this unit): fatal, transactional, timeout-budgeted DDL.
    await db.query('BEGIN');
    try {
      await db.setApplyTimeouts();
      await db.runSchema(coreSQL);
      await db.query('COMMIT');
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
      return {
        ok: false, appliedUnits, failedUnit: unit.basename,
        errorMsg: err.message, integrityResults,
      };
    }
    appliedUnits.push(unit.basename);

    // Phase B (this unit): non-fatal integrity-index ops, atomic pair when a
    // DROP precedes the CREATE (S-11).
    for (const op of ops) {
      const result = op.dropSql
        ? await db.runIntegrityIndexPair(op.dropSql, op.createSql)
        : await db.runIntegrityIndex(op.createSql);
      integrityResults.push({ unit: unit.basename, name: op.name, ok: result.ok, msg: result.msg });
      if (!result.ok && !silent) {
        process.stderr.write(
          `[handoff] applyAdditiveSchema: integrity index ${op.name} (${unit.basename}) skipped (non-fatal): ${result.msg}\n`
        );
      }
    }
  }

  return { ok: true, appliedUnits, failedUnit: null, errorMsg: null, integrityResults };
}

/**
 * L4-style persistent degradation signal for the schema-apply path (R-5).
 * Upserts a SINGLE project_settings row keyed 'schema_apply_degraded' (unlike
 * degraded_close:*, which accumulates one row per event — this key reflects
 * CURRENT state, so it is overwritten on each new degradation and deleted by
 * clearSchemaDegradation() once a fully-verified apply succeeds). Surfaced by
 * cmdStatus and the cmdLoaderLoad resume banner. Always also writes to
 * stderr (unless silent). Never throws.
 */
async function recordSchemaDegradation(db, projectId, reason, detail, { silent } = {}) {
  const val = JSON.stringify({ reason, detail: detail || null, stamp: new Date().toISOString() });
  try {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_apply_degraded', $2)
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [projectId, val]
    );
  } catch (writeErr) {
    if (!silent) process.stderr.write(`[handoff] recordSchemaDegradation write failed (non-fatal): ${writeErr.message}\n`);
  }
  if (!silent) {
    process.stderr.write(`[handoff] schema apply degraded (${reason}): ${JSON.stringify(detail)}\n`);
  }
}

/**
 * Clear the schema_apply_degraded row (a later fully-verified apply
 * succeeded). Returns whether a row actually existed to delete — lets a
 * caller (cmdStatus's "what did this touch heal" line) report an accurate
 * transition WITHOUT a separate pre-heal SELECT (PR #262 perf follow-up):
 * the DELETE's own rowCount already answers "was there something to clear".
 */
async function clearSchemaDegradation(db, projectId) {
  try {
    const result = await db.query(
      `DELETE FROM project_settings WHERE project_id = $1 AND key = 'schema_apply_degraded'`,
      [projectId]
    );
    return { cleared: typeof result?.rowCount === 'number' ? result.rowCount > 0 : false };
  } catch (_) {
    return { cleared: false };
  }
}

/**
 * cm#185-schema-heal (S2): the ONE shared upsert for project_settings'
 * schema_fingerprint row — used by both ensureSchemaCurrentCore's apply
 * sequence AND cmdInit (which, before this fix, never wrote this row at
 * all — a fresh/re-`init` left every project immediately BEHIND on its very
 * first touch). S2 unifies only this persistence PLUMBING (the literal
 * INSERT/UPDATE), never the surrounding pass/fail POLICY — cmdInit keeps
 * its own fatal-exit decision around a still-missing gated object; only the
 * write statement itself is shared, per adversary finding #4/#8.
 */
async function recordSchemaFingerprint(db, projectId, fingerprint) {
  await db.query(
    `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'schema_fingerprint', $2)
     ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, fingerprint]
  );
}

/**
 * isEmbeddingsOptedOut — init-embeddability spec: an operator who ran
 * `init --no-embeddings` (or had a prior opt-out auto-honored, adversary
 * finding #5) has explicitly said "proceed without embedding capability."
 * Write-time assertion embedding (A2) must respect that choice SILENTLY —
 * never surfacing a per-write DEGRADED divergence line for a state the
 * operator deliberately chose. This is DISTINCT from cm#230's existing,
 * intentional decisions[] contract (test-handoff.js: "embedding-provider-
 * down is non-fatal and surfaces a DIVERGENCE line") — that test exercises
 * a DB that has NOT opted out (a live default row temporarily flipped to
 * non-default), where a missing provider genuinely IS worth flagging every
 * time. The distinction is opted-out vs. merely-unconfigured, not
 * assertions vs. decisions — this helper is reused wherever an opt-out
 * check should suppress an otherwise-legitimate embed-degraded warning.
 * Read-only; any query failure (project_settings absent) is treated as
 * "not opted out" — never a false positive suppression.
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
async function isEmbeddingsOptedOut(db, projectId) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM project_settings WHERE project_id = $1 AND key = 'embeddings_opt_out'`,
      [projectId]
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * cm#224 follow-up (independent PR #225 review finding): detects
 * pgvector-gated schema objects that were silently SKIPPED on THIS
 * database. "Gated" = a column/index wrapped in a
 * `DO $$ ... EXCEPTION WHEN OTHERS $$` block that degrades gracefully
 * (RAISE NOTICE, no CREATE EXTENSION) when pgvector is absent —
 * handoff-core-schema.sql's assertions.embedding/
 * assertions_embedding_hnsw_idx and decisions-base.sql's
 * decisions.embedding/decisions_embedding_idx today. Before this fix, a
 * skipped gated object was invisible everywhere: no `pg` 'notice' listener
 * was ever registered, `schemaObjectsExist()` deliberately excludes gated
 * objects from `expected_objects` (so post-apply verification still
 * passes), and `ensureSchemaCurrent` reported `applied:true`/
 * `reason:'current'` regardless.
 *
 * GENERAL mechanism, declarative — reads `pgvector_gated` off EVERY
 * manifest unit in the active dialect's applicable set (today:
 * handoff-core-schema.sql, decisions-base.sql; a future gated object on
 * any other table needs only a manifest entry, never a code change here).
 * Runs on EVERY call (both the 'current' fast path and a fresh apply) —
 * a DB fingerprinted current BEFORE pgvector was ever installed must keep
 * reporting the degradation on every subsequent touch, not just the one
 * apply that first skipped it (that "reported once, then silent forever"
 * gap is exactly the finding this closes).
 *
 * cm#185-schema-heal (S4): always queries pg_extension + the live catalog
 * fresh on every call — never cached — so the result reflects the CURRENT
 * probe at the moment it's called, not a snapshot from classification time.
 *
 * @param {object} db — connected StoragePort adapter
 * @param {object} manifest — classification.manifest (schema-manifest.json, parsed)
 * @param {Array<{basename:string}>} units — the active dialect's applicable unit set
 * @returns {Promise<{ok:boolean, vectorExtensionPresent:boolean|null, missing:Array<{unit:string,table:string,column:string}>}>}
 */
/**
 * Collect every pgvector_gated column declared across the active unit set's
 * own manifest entries. Pure/no-DB — shared by checkPgvectorGatedObjects
 * (its own live probe) and the fast path's combined-query derivation
 * (PR #262 perf follow-up), so the two never drift on WHAT counts as gated.
 */
function _collectGatedColumns(manifest, units) {
  const gatedColumns = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const gated = entry && entry.pgvector_gated;
    if (gated && Array.isArray(gated.columns)) {
      for (const c of gated.columns) {
        gatedColumns.push({
          unit: u.basename, table: c.table, column: c.column,
          type: typeof c.type === 'string' ? c.type : null,
          dims: typeof c.dims === 'number' ? c.dims : null,
        });
      }
    }
  }
  return gatedColumns;
}

/**
 * Derive schemaObjectsExist's exact {ok, missing} shape for the UNGATED
 * expected_objects set from an already-fetched probeFastPathSchemaState
 * result — the fast path's PR #262 perf follow-up (one combined query
 * instead of three separate tables/columns/indexes queries).
 */
function _deriveUngatedMissing(expected, probe) {
  const missing = [];
  for (const t of (expected.tables || [])) {
    if (!probe.tablesFound.has(t)) missing.push({ type: 'table', table: t });
  }
  for (const c of (expected.columns || [])) {
    if (!probe.columnsFound.has(`${c.table}.${c.column}`)) missing.push({ type: 'column', table: c.table, column: c.column });
  }
  for (const i of (expected.indexes || [])) {
    if (!probe.indexesFound.has(i)) missing.push({ type: 'index', index: i });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Derive checkPgvectorGatedObjects's exact {ok, missing} shape (absence +
 * finding #6 shape-mismatch classification) from an already-fetched
 * columnsFound/shapes probe result, instead of issuing live queries. Shared
 * by checkPgvectorGatedObjects itself (fed from a fresh live probe) and the
 * fast path (fed from probeFastPathSchemaState's combined-query result) —
 * ONE classification rule, two data sources, per PR #262's perf follow-up.
 *
 * @param {Array} gatedColumns — from _collectGatedColumns
 * @param {Set<string>} columnsFound — "table.column" strings confirmed to exist
 * @param {Map<string,{type,dims}>} shapes — "table.column" -> actual shape, for columns that exist
 */
function _deriveGatedMissing(gatedColumns, columnsFound, shapes) {
  const missing = [];
  for (const gc of gatedColumns) {
    const key = `${gc.table}.${gc.column}`;
    if (!columnsFound.has(key)) {
      missing.push({ unit: gc.unit, table: gc.table, column: gc.column, reason: 'absent' });
      continue;
    }
    // Adversary finding #6 (MAJOR): existence alone does not prove SHAPE — a
    // column present with the wrong type/dims (e.g. a hand-created
    // `vector(1024)` instead of the manifest's intended `halfvec(4000)` —
    // this project's own prior legacy-1024-dim-store incident class) passes
    // the bare existence probe but is not the column the write path
    // actually expects. Only checked for a manifest entry that DECLARES a
    // type/dims (backward-compatible: an entry with neither behaves exactly
    // as before this fix).
    if (!gc.type && gc.dims == null) continue;
    const shape = shapes.get(key);
    if (!shape) continue; // probe itself found nothing here — never a false mismatch
    const typeOk = !gc.type || shape.type === gc.type;
    const dimsOk = gc.dims == null || shape.dims === gc.dims;
    if (!typeOk || !dimsOk) {
      missing.push({
        unit: gc.unit, table: gc.table, column: gc.column, reason: 'shape_mismatch',
        expected: { type: gc.type, dims: gc.dims }, actual: shape,
      });
    }
  }
  return missing;
}

/**
 * cm#185-schema-heal FK extension (F1): collect every `expected_fks` entry
 * declared across the active unit set's own manifest entries. Pure/no-DB —
 * mirrors _collectGatedColumns's shape/purpose for the pgvector case.
 */
function _collectExpectedFks(manifest, units) {
  const fks = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const list = entry && Array.isArray(entry.expected_fks) ? entry.expected_fks : [];
    for (const fk of list) {
      fks.push({
        unit: u.basename,
        table: fk.table,
        columns: Array.isArray(fk.columns) ? fk.columns : [],
        ref_table: fk.ref_table,
        ref_columns: Array.isArray(fk.ref_columns) ? fk.ref_columns : [],
        on_delete: (typeof fk.on_delete === 'string' && fk.on_delete) || 'NO ACTION',
      });
    }
  }
  return fks;
}

/** Postgres pg_constraint.confdeltype single-char code -> the SQL keyword. */
function _decodeConfdeltype(code) {
  switch (code) {
    case 'a': return 'NO ACTION';
    case 'c': return 'CASCADE';
    case 'n': return 'SET NULL';
    case 'd': return 'SET DEFAULT';
    case 'r': return 'RESTRICT';
    default:  return 'UNKNOWN';
  }
}

function _sameOrderedList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * cm#185-schema-heal FK extension (F3): TOTAL classification of every
 * expected FK against the live `fks` rows returned by
 * probeFastPathSchemaState's FK arm. Every expected entry maps to exactly
 * one of: table_absent | absent | present_mismatched(reason) |
 * present_matching — never a default "looks fine".
 *
 * Identity = (table, ordered columns, ref_table, ordered ref_columns) —
 * NEVER the constraint name (autogenerated/hand-picked, drifts across
 * manual repairs). `ON DELETE` and `convalidated` are compared as part of
 * "matching" but are not part of the identity key: a right-target,
 * wrong-action FK is present_mismatched, not absent.
 *
 * Inventory diff: any OTHER live FK sharing the same (table, columns) as
 * an expected entry — whether or not the correct one is also present — is
 * folded into that entry's result as `extras` (dropped during heal, F4).
 *
 * @param {Array} expectedFks — from _collectExpectedFks
 * @param {Set<string>} tablesFound — from probeFastPathSchemaState
 * @param {Array} liveFks — probe.fks (unfiltered rows for the queried tables)
 * @returns {Array<{unit,table,columns,ref_table,ref_columns,on_delete,state,reason?,actual?,extras?}>}
 */
function _classifyExpectedFks(expectedFks, tablesFound, liveFks) {
  const byLocal = new Map();
  for (const r of (liveFks || [])) {
    const key = `${r.table}::${(r.columns || []).join(',')}`;
    if (!byLocal.has(key)) byLocal.set(key, []);
    byLocal.get(key).push(r);
  }
  const results = [];
  for (const fk of expectedFks) {
    if (!tablesFound.has(fk.table)) {
      results.push({ ...fk, state: 'table_absent' });
      continue;
    }
    const key = `${fk.table}::${fk.columns.join(',')}`;
    const candidates = byLocal.get(key) || [];
    if (candidates.length === 0) {
      results.push({ ...fk, state: 'absent' });
      continue;
    }
    const match = candidates.find(
      (r) => r.ref_table === fk.ref_table && _sameOrderedList(r.ref_columns, fk.ref_columns)
    );
    // `extras` (F4 heal input): candidates OTHER than the identity-matching
    // one — a stale duplicate FK left on the same columns. `dropTargets`
    // (below) is the FULL drop list a heal must issue: for ANY
    // present_mismatched reason (wrong reference, ON DELETE, NOT VALID, or
    // a pure extra-constraint case) the offending/stale row(s) — the match
    // itself included whenever IT is what's wrong — must be dropped before
    // the corrective ADD CONSTRAINT, never left behind as a duplicate.
    const extras = match ? candidates.filter((r) => r.conname !== match.conname) : [];
    if (!match) {
      const bad = candidates[0];
      results.push({
        ...fk, state: 'present_mismatched',
        reason: `wrong_reference:${bad.ref_table}.${(bad.ref_columns || []).join(',')}`,
        actual: bad, extras: candidates, dropTargets: candidates,
      });
      continue;
    }
    const expectedOnDelete = fk.on_delete.toUpperCase();
    const actualOnDelete = _decodeConfdeltype(match.on_delete);
    if (actualOnDelete !== expectedOnDelete) {
      results.push({ ...fk, state: 'present_mismatched', reason: `on_delete:${actualOnDelete}`, actual: match, extras, dropTargets: candidates });
      continue;
    }
    if (match.validated === false) {
      results.push({ ...fk, state: 'present_mismatched', reason: 'not_validated', actual: match, extras, dropTargets: candidates });
      continue;
    }
    if (extras.length > 0) {
      results.push({
        ...fk, state: 'present_mismatched',
        reason: `extra_constraint:${extras.map((e) => e.conname).join(',')}`, actual: match, extras, dropTargets: extras,
      });
      continue;
    }
    results.push({ ...fk, state: 'present_matching', actual: match });
  }
  return results;
}

/** Strip a _classifyExpectedFks result entry to a compact, JSON-safe detail row. */
function _fkResultDetail(r) {
  return {
    unit: r.unit, table: r.table, columns: r.columns, ref_table: r.ref_table, ref_columns: r.ref_columns,
    state: r.state, ...(r.reason ? { reason: r.reason } : {}),
  };
}

/**
 * cm#185-schema-heal FK extension (F4): heal every fixable (absent |
 * present_mismatched) entry in ONE transaction via db.healForeignKeys —
 * drop the mismatched/extra constraint(s), add the correct one, all inside
 * a single acquireSchemaApplyLock-guarded call. table_absent entries are
 * never passed here (nothing to ALTER on a table that doesn't exist —
 * that gap is covered by the ungated expected_objects apply path instead).
 *
 * @returns {Promise<{ok:boolean, sqlstate?:string, message?:string}>}
 */
async function _healExpectedFks(db, projectId, fixable) {
  const lockKey = 'schema_apply:' + projectId;
  await db.acquireSchemaApplyLock(lockKey);
  try {
    // A pure `extra_constraint` result (the identity-matching FK is itself
    // already present_matching-correct; only a STALE duplicate on the same
    // columns needs to go) drops the stale row(s) and adds nothing new —
    // re-adding would leave two FKs covering the same columns. Every other
    // fixable reason (absent, wrong_reference, on_delete, not_validated)
    // drops the full identity-matching row set and adds the one correct
    // constraint fresh.
    const plans = fixable.map((fk) => {
      const dropTargets = fk.dropTargets || fk.extras || [];
      const needsAdd = !(typeof fk.reason === 'string' && fk.reason.startsWith('extra_constraint:'));
      return {
        table: fk.table,
        columns: fk.columns,
        ref_table: fk.ref_table,
        ref_columns: fk.ref_columns,
        on_delete: fk.on_delete,
        dropConnames: dropTargets.map((e) => e.conname).filter(Boolean),
        skipAdd: !needsAdd,
      };
    });
    return await db.healForeignKeys(plans);
  } finally {
    await db.releaseSchemaApplyLock(lockKey);
  }
}

/**
 * cm#185-schema-heal constraint extension: normalize a CHECK/index-def
 * expression for text comparison — collapse whitespace, lowercase, strip
 * outer parens (once — a def wrapped in more than one layer keeps its inner
 * parens, which is fine: they'll match on both sides identically as long as
 * both the expected and actual text went through this SAME function).
 */
function _normalizeDefText(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  // A CHECK constraint's pg_get_constraintdef text always leads with the
  // literal "CHECK " keyword before its own outer-parenthesized expression
  // (e.g. "CHECK ((qty >= 0))") — strip that keyword first so the outer-
  // paren strip below reaches the actual expression on both sides of a
  // comparison (a hand-written manifest `def` may or may not include the
  // "CHECK" keyword itself; this is a no-op when it's absent).
  t = t.replace(/^check\s*/, '');
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  return t;
}

function _sameColumnSet(a, b) {
  const sa = [...(a || [])].sort();
  const sb = [...(b || [])].sort();
  return _sameOrderedList(sa, sb);
}

// ── UNIQUE (constraints/indexes) ────────────────────────────────────────────

function _collectExpectedUniques(manifest, units) {
  const list = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const arr = entry && Array.isArray(entry.expected_uniques) ? entry.expected_uniques : [];
    for (const uq of arr) {
      list.push({
        unit: u.basename, table: uq.table,
        columns: Array.isArray(uq.columns) ? uq.columns : [],
        predicate: typeof uq.predicate === 'string' ? uq.predicate : null,
      });
    }
  }
  return list;
}

/** Total classification: table_absent | absent | present_mismatched(reason) | present_matching. */
function _classifyExpectedUniques(expected, tablesFound, liveUniques) {
  const byTable = new Map();
  for (const r of (liveUniques || [])) {
    if (!byTable.has(r.table)) byTable.set(r.table, []);
    byTable.get(r.table).push(r);
  }
  const results = [];
  for (const uq of expected) {
    if (!tablesFound.has(uq.table)) { results.push({ ...uq, state: 'table_absent' }); continue; }
    const candidates = (byTable.get(uq.table) || []).filter((r) => _sameColumnSet(r.columns, uq.columns));
    if (candidates.length === 0) { results.push({ ...uq, state: 'absent' }); continue; }
    const expPred = uq.predicate ? _normalizeDefText(uq.predicate) : null;
    const match = candidates.find((r) => {
      const actPred = r.predicate ? _normalizeDefText(r.predicate) : null;
      return actPred === expPred;
    });
    const extras = match ? candidates.filter((r) => r.name !== match.name) : [];
    if (!match) {
      results.push({ ...uq, state: 'present_mismatched', reason: 'predicate_mismatch', actual: candidates[0], extras: candidates, dropTargets: candidates });
      continue;
    }
    if (extras.length > 0) {
      results.push({ ...uq, state: 'present_mismatched', reason: `extra_constraint:${extras.map((e) => e.name).join(',')}`, actual: match, extras, dropTargets: extras });
      continue;
    }
    results.push({ ...uq, state: 'present_matching', actual: match });
  }
  return results;
}

async function _healExpectedUniques(db, projectId, fixable) {
  const lockKey = 'schema_apply:' + projectId;
  await db.acquireSchemaApplyLock(lockKey);
  try {
    const plans = fixable.map((uq) => {
      const dropTargets = uq.dropTargets || uq.extras || [];
      const needsAdd = !(typeof uq.reason === 'string' && uq.reason.startsWith('extra_constraint:'));
      return {
        kind: 'unique', table: uq.table, columns: uq.columns, predicate: uq.predicate,
        dropNames: dropTargets.map((e) => e.name).filter(Boolean), skipAdd: !needsAdd,
      };
    });
    return await db.healConstraints(plans);
  } finally {
    await db.releaseSchemaApplyLock(lockKey);
  }
}

// ── NOT NULL ─────────────────────────────────────────────────────────────

function _collectExpectedNotNulls(manifest, units) {
  const list = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const arr = entry && Array.isArray(entry.expected_not_nulls) ? entry.expected_not_nulls : [];
    for (const nn of arr) list.push({ unit: u.basename, table: nn.table, column: nn.column });
  }
  return list;
}

/** table_absent | absent (column present but nullable, or column missing entirely is table_absent's sibling — see below) | present_matching. */
function _classifyExpectedNotNulls(expected, tablesFound, liveNotNulls) {
  const byKey = new Map();
  for (const r of (liveNotNulls || [])) byKey.set(`${r.table}.${r.column}`, r);
  const results = [];
  for (const nn of expected) {
    if (!tablesFound.has(nn.table)) { results.push({ ...nn, state: 'table_absent' }); continue; }
    const row = byKey.get(`${nn.table}.${nn.column}`);
    if (!row) { results.push({ ...nn, state: 'absent' }); continue; } // column itself absent
    if (row.notNull !== true) { results.push({ ...nn, state: 'present_mismatched', reason: 'nullable' }); continue; }
    results.push({ ...nn, state: 'present_matching' });
  }
  return results;
}

async function _healExpectedNotNulls(db, projectId, fixable) {
  const lockKey = 'schema_apply:' + projectId;
  await db.acquireSchemaApplyLock(lockKey);
  try {
    const plans = fixable.map((nn) => ({ kind: 'notnull', table: nn.table, column: nn.column }));
    return await db.healConstraints(plans);
  } finally {
    await db.releaseSchemaApplyLock(lockKey);
  }
}

// ── CHECK ────────────────────────────────────────────────────────────────

function _collectExpectedChecks(manifest, units) {
  const list = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const arr = entry && Array.isArray(entry.expected_checks) ? entry.expected_checks : [];
    for (const ck of arr) {
      list.push({
        unit: u.basename, table: ck.table,
        // Identity (PR #268 review finding): the column set the CHECK
        // expression references, matched against the live probe's
        // pg_constraint.conkey-derived columns — never just "some CHECK on
        // this table with matching text", which let a drifted expression on
        // the SAME columns silently classify as a distinct-but-unrelated
        // "absent" entry (the exact suppression_kind CHECK-narrowing
        // failure class from PR #129) instead of present_mismatched.
        columns: Array.isArray(ck.columns) ? ck.columns : (Array.isArray(ck.expression_tokens) ? ck.expression_tokens : []),
        expression_tokens: Array.isArray(ck.expression_tokens) ? ck.expression_tokens : [],
        normalized_def: _normalizeDefText(ck.def || ''),
        def: ck.def,
      });
    }
  }
  return list;
}

/**
 * PR #268 review fix: TOTAL classification — table_absent | absent |
 * present_mismatched(check_def_drift:<conname> | extra_constraint:<names>)
 * | present_matching. Identity is (table, sorted column set) — NEVER just
 * "does some live CHECK on this table have matching text", which
 * previously let a drifted expression on the identity-matching columns
 * classify as `absent` (a phantom "missing" that then ADD-only healed
 * alongside the untouched stale one, silently masking it forever once the
 * fresh one cleared degradation — same failure class as PR #129's
 * suppression_kind CHECK narrowing).
 */
function _classifyExpectedChecks(expected, tablesFound, liveChecks) {
  const byIdentity = new Map();
  for (const r of (liveChecks || [])) {
    const key = `${r.table}::${[...(r.columns || [])].sort().join(',')}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(r);
  }
  const results = [];
  for (const ck of expected) {
    if (!tablesFound.has(ck.table)) { results.push({ ...ck, state: 'table_absent' }); continue; }
    const key = `${ck.table}::${[...(ck.columns || [])].sort().join(',')}`;
    const candidates = byIdentity.get(key) || [];
    if (candidates.length === 0) { results.push({ ...ck, state: 'absent' }); continue; }
    const match = candidates.find((r) => _normalizeDefText(r.def) === ck.normalized_def);
    const extras = match ? candidates.filter((r) => r.conname !== match.conname) : [];
    if (!match) {
      // Wrong/drifted expression on the identity-matching column set — drop
      // EVERY candidate on this identity (the whole stale set, not just the
      // first one) and add the correct constraint fresh.
      results.push({
        ...ck, state: 'present_mismatched',
        reason: `check_def_drift:${candidates[0].conname}`, actual: candidates[0],
        extras: candidates, dropTargets: candidates,
      });
      continue;
    }
    if (extras.length > 0) {
      results.push({
        ...ck, state: 'present_mismatched',
        reason: `extra_constraint:${extras.map((e) => e.conname).join(',')}`, actual: match,
        extras, dropTargets: extras,
      });
      continue;
    }
    results.push({ ...ck, state: 'present_matching', actual: match });
  }
  return results;
}

/**
 * PR #268 review fix: dropNames now carries the drifted/extra constraint
 * name(s) (never hardcoded []) so heal is a real DROP+ADD in one
 * transaction — a stale CHECK never lingers once the fresh one clears
 * degradation. `skipAdd` mirrors the FK/UNIQUE extra_constraint-only case:
 * the identity-matching constraint is already correct, only a stale extra
 * needs to go, so re-adding would leave a duplicate.
 */
async function _healExpectedChecks(db, projectId, fixable) {
  const lockKey = 'schema_apply:' + projectId;
  await db.acquireSchemaApplyLock(lockKey);
  try {
    const plans = fixable.map((ck, i) => {
      const dropTargets = ck.dropTargets || ck.extras || [];
      const needsAdd = !(typeof ck.reason === 'string' && ck.reason.startsWith('extra_constraint:'));
      return {
        kind: 'check', table: ck.table, conname: `heal_${i}_${Date.now()}`, def: ck.def,
        dropNames: dropTargets.map((e) => e.conname).filter(Boolean), skipAdd: !needsAdd,
      };
    });
    return await db.healConstraints(plans);
  } finally {
    await db.releaseSchemaApplyLock(lockKey);
  }
}

// ── INDEX DEFINITIONS ────────────────────────────────────────────────────

function _collectExpectedIndexDefs(manifest, units) {
  const list = [];
  for (const u of units) {
    const entry = manifest.units[u.basename];
    const arr = entry && Array.isArray(entry.expected_index_defs) ? entry.expected_index_defs : [];
    for (const ix of arr) {
      list.push({
        unit: u.basename, name: ix.name,
        create_sql: ix.create_sql,
        normalized_def: _normalizeDefText(ix.normalized_def || ix.create_sql || ''),
      });
    }
  }
  return list;
}

/** absent | present_mismatched(index_def_drift) | present_matching — no table_absent branch: identity is the index name itself (already covered by the ungated `indexes` expected-objects existence probe). */
function _classifyExpectedIndexDefs(expected, liveIndexDefs) {
  const byName = new Map();
  for (const r of (liveIndexDefs || [])) byName.set(r.name, r);
  const results = [];
  for (const ix of expected) {
    const row = byName.get(ix.name);
    if (!row) { results.push({ ...ix, state: 'absent' }); continue; }
    if (_normalizeDefText(row.def) !== ix.normalized_def) {
      results.push({ ...ix, state: 'present_mismatched', reason: 'index_def_drift', actual: row });
      continue;
    }
    results.push({ ...ix, state: 'present_matching', actual: row });
  }
  return results;
}

async function _healExpectedIndexDefs(db, projectId, fixable) {
  const lockKey = 'schema_apply:' + projectId;
  await db.acquireSchemaApplyLock(lockKey);
  try {
    const plans = fixable.map((ix) => ({ kind: 'indexdef', name: ix.name, def: ix.create_sql }));
    return await db.healConstraints(plans);
  } finally {
    await db.releaseSchemaApplyLock(lockKey);
  }
}

async function checkPgvectorGatedObjects(db, manifest, units) {
  const gatedColumns = _collectGatedColumns(manifest, units);
  if (gatedColumns.length === 0) return { ok: true, vectorExtensionPresent: null, missing: [] };

  let vectorExtensionPresent = null;
  try {
    const { rows } = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    vectorExtensionPresent = rows.length > 0;
  } catch (_) {
    // pg_extension itself unreadable — leave null (unknown), the check
    // below (the actual column probe) is authoritative regardless.
  }

  const check = await db.schemaObjectsExist({
    columns: gatedColumns.map((gc) => ({ table: gc.table, column: gc.column })),
  });
  const columnsFound = new Set();
  for (const gc of gatedColumns) {
    const key = `${gc.table}.${gc.column}`;
    const isMissing = (check.missing || []).some((m) => m.type === 'column' && m.table === gc.table && m.column === gc.column);
    if (!isMissing) columnsFound.add(key);
  }

  // Adversary finding #6 (MAJOR): shape (type/dims), for columns that exist
  // and declare a shape — only queried for those, never for absent ones.
  const shapes = new Map();
  const presentShaped = gatedColumns.filter((gc) => columnsFound.has(`${gc.table}.${gc.column}`) && (gc.type || gc.dims != null));
  if (presentShaped.length > 0 && typeof db.checkColumnShape === 'function') {
    for (const gc of presentShaped) {
      let shape = null;
      try { shape = await db.checkColumnShape(gc.table, gc.column); } catch (_) { shape = null; }
      if (shape) shapes.set(`${gc.table}.${gc.column}`, shape);
    }
  }

  const missing = _deriveGatedMissing(gatedColumns, columnsFound, shapes);
  return { ok: missing.length === 0, vectorExtensionPresent, missing };
}

/**
 * cm#embedding-readiness-single-classifier (owner directive "READY should
 * mean fully embedded", 2026-09-07): a `probeProvider` result cache, TTL-
 * bounded to a few seconds, keyed by `${projectId}:${providerId}` — E1
 * requires READY to include a successful LIVE provider probe on every call,
 * but a `status`/`resume`/close-Done-line touch happening seconds apart
 * (e.g. a hook chain) must not each pay a fresh network round-trip. Never
 * shared across providerId (a mid-session provider swap invalidates by key
 * change alone, not by explicit eviction).
 */
const _EMBED_PROBE_CACHE_TTL_MS = 5000;
const _embedProbeCache = new Map(); // key -> { ts, ok, reason }

async function _cachedProbeProvider(projectId, providerRow) {
  // Keyed by projectId + providerId + endpoint (as documented above): a
  // same-id provider row edited in place (e.g. its endpoint swapped) and a
  // second project sharing the same providerId in-process both bust the
  // cache — neither reuses a stale entry.
  const key = `${projectId}:${providerRow.id}:${providerRow.endpoint}`;
  const cached = _embedProbeCache.get(key);
  if (cached && (Date.now() - cached.ts) < _EMBED_PROBE_CACHE_TTL_MS) {
    return cached;
  }
  const provider = createProviderFromRow(providerRow);
  let result;
  try {
    await probeProvider(provider);
    result = { ts: Date.now(), ok: true, reason: null };
  } catch (err) {
    result = { ts: Date.now(), ok: false, reason: String(err.message || 'probe failed').replace(/\s+/g, ' ').trim().slice(0, 160) };
  }
  _embedProbeCache.set(key, result);
  return result;
}

/**
 * computeEmbeddingReadiness — E1 (owner directive "READY should mean fully
 * embedded"): a SINGLE total classification of "can this project embed
 * anything right now", surfaced VERBATIM by cmdStatus (prose + --json),
 * cmdLoaderLoad's resume banner, the MCP handoff_status tool (which shells
 * out to `status --json`), and the close/checkpoint Done line. Total
 * classification — every reachable state maps to exactly one of the
 * branches below, checked in this order, never a default "looks fine":
 *
 *   UNSUPPORTED:sqlite      — dialect-gated top branch (no embedding
 *                               column on any SQLite table at all; out of
 *                               this spec's 6-state enumeration by
 *                               construction — SQLite cannot embed at all,
 *                               see docs/how-memory-works.md).
 *   DISABLED                  — project_settings.embeddings_opt_out is on
 *                               file (an operator explicitly ran
 *                               `init --no-embeddings`). Renamed from the
 *                               prior `DEGRADED:opt-out` — an explicit,
 *                               standing operator choice is not "degraded."
 *   UNEMBEDDABLE:no-extension — pgvector is absent OR a gated column/index
 *                               was skipped at schema-apply time (reuses
 *                               checkPgvectorGatedObjects — the SAME check
 *                               schema-drift detection uses, never a
 *                               second, independently-drifting probe).
 *   UNEMBEDDABLE:no-provider  — extension/columns are fine, but no
 *                               embedding_providers row has is_default=true.
 *   DEGRADED:probe-failed(<reason>) — a default provider row exists, but a
 *                               LIVE probeProvider() call against it failed
 *                               (connection refused/timeout/HTTP error/dim
 *                               mismatch) — cached up to
 *                               _EMBED_PROBE_CACHE_TTL_MS so repeated
 *                               touches don't each pay a network round trip.
 *   HEALING(<n>)               — probe succeeded, but n>0 LIVE
 *                               (suppressed=false AND invalid_at IS NULL)
 *                               actionable (non-empty-text) rows across
 *                               assertions+decisions still carry
 *                               embedding IS NULL. n is the SAME
 *                               "actionable" predicate backfill-
 *                               embeddings.js uses (its `liveOnly` scoping,
 *                               added alongside this classifier) — one
 *                               source of truth, never a re-derivation.
 *   READY                      — n === 0 AND the live probe succeeded.
 *
 * Never throws — any unexpected probe error is folded into the
 * conservative UNEMBEDDABLE:no-extension branch (never a silent READY).
 *
 * @param {object} db
 * @param {string} projectId
 * @param {object} [opts]
 * @param {boolean} [opts.precomputedGatedOk] — cm#185-schema-heal (adversary
 *   finding #10, MINOR): when the CALLER already ran ensureSchemaCurrent
 *   moments earlier in the SAME command and knows its result unambiguously
 *   implies the gated-objects probe outcome (reason 'current'/'applied' ->
 *   true, reason 'degraded' -> false), pass that boolean here to skip this
 *   function's own classifySchemaFiles + checkPgvectorGatedObjects round
 *   trip — avoids two separate DB reads of the identical fact within one
 *   command (which, under READ COMMITTED, could otherwise observe two
 *   different snapshots if a concurrent apply lands between them). Any
 *   OTHER ensureSchemaCurrent outcome (classification_error, lock_acquire_
 *   failed, ahead, unknown, ...) is genuinely ambiguous for this purpose —
 *   omit the option and this function falls back to its own independent,
 *   conservative probe exactly as before.
 * @returns {Promise<string>} one of the states documented above
 */
async function computeEmbeddingReadiness(db, projectId, { precomputedGatedOk } = {}) {
  if (db && typeof db.supportsEmbeddingColumns === 'function' && !db.supportsEmbeddingColumns()) {
    return 'UNSUPPORTED:sqlite';
  }

  const optedOut = await isEmbeddingsOptedOut(db, projectId);
  if (optedOut) return 'DISABLED';

  if (typeof precomputedGatedOk === 'boolean') {
    if (!precomputedGatedOk) return 'UNEMBEDDABLE:no-extension';
  } else {
    try {
      const classification = classifySchemaFiles({ engineRoot: _ENGINE_ROOT });
      if (!classification.ok) return 'UNEMBEDDABLE:no-extension';
      const rosterEntry = classification.manifest.units[db.schemaFileName];
      const units = rosterEntry ? classification.unitsByDialect[rosterEntry.classification] : null;
      if (!units || units.length === 0) return 'UNEMBEDDABLE:no-extension';
      const gated = await checkPgvectorGatedObjects(db, classification.manifest, units);
      if (!gated.ok) return 'UNEMBEDDABLE:no-extension';
    } catch (_) {
      return 'UNEMBEDDABLE:no-extension';
    }
  }

  let providerRow;
  try {
    const { rows } = await db.query(`SELECT * FROM embedding_providers WHERE is_default = true LIMIT 1`);
    if (rows.length === 0) return 'UNEMBEDDABLE:no-provider';
    providerRow = rows[0];
  } catch (_) {
    return 'UNEMBEDDABLE:no-provider';
  }

  let probe;
  try {
    probe = await _cachedProbeProvider(projectId, providerRow);
  } catch (err) {
    // _cachedProbeProvider itself never throws by design, but fold any
    // unexpected failure into the conservative branch anyway.
    return `DEGRADED:probe-failed(${String(err.message || 'unknown').slice(0, 160)})`;
  }
  if (!probe.ok) return `DEGRADED:probe-failed(${probe.reason})`;

  let backlogN = 0;
  try {
    const dry = await runBackfillEmbeddings({ db, projectId, table: 'all', apply: false, liveOnly: true });
    backlogN = (dry.tables || []).reduce((sum, t) => sum + (t.actionableNull || 0), 0);
  } catch (_) {
    // Backlog probe failure is conservative-folded too — never a silent READY.
    return 'UNEMBEDDABLE:no-provider';
  }

  if (backlogN > 0) return `HEALING(${backlogN})`;
  return 'READY';
}

/**
 * _shouldWarnOnResume — the resume banner's own "is this state worth a
 * RESUME WARNING" predicate, extracted so it is exercised by tests and the
 * production banner from the SAME code path (never a re-derivation).
 * DISABLED (an operator's deliberate --no-embeddings opt-out) and
 * UNSUPPORTED:* (a backend that structurally cannot embed at all, e.g.
 * SQLite) are standing facts, not degradations — never a recurring nag on
 * every resume. Every other non-READY state (UNEMBEDDABLE:*,
 * DEGRADED:probe-failed(...), HEALING(<n>)) warrants a warning.
 */
function _shouldWarnOnResume(readiness) {
  return readiness !== 'READY' && readiness !== 'DISABLED' && !readiness.startsWith('UNSUPPORTED:');
}

/**
 * cm#185-schema-heal (adversary finding #10 helper): derive the
 * precomputedGatedOk boolean for computeEmbeddingReadiness from an
 * ensureSchemaCurrent/ensureSchemaCurrentCore result object, when — and
 * only when — that result unambiguously implies the gated-objects probe
 * outcome. Returns `undefined` (never a guessed boolean) for every other
 * reason, so callers can spread `{ precomputedGatedOk: ... }` and safely
 * fall back to computeEmbeddingReadiness's own independent probe.
 */
function _gatedOkFromSchemaHealResult(result) {
  if (!result) return undefined;
  if (result.reason === 'current' || result.reason === 'applied') return true;
  if (result.reason === 'degraded') return false;
  return undefined;
}

/**
 * computeEmbeddingNullCounts — E2 (owner directive "READY should mean
 * fully embedded"): per-table LIVE+actionable NULL-embedding counts, for
 * status/resume to print "whenever nonzero" (spec's own phrasing). Fixed
 * to the SAME live+actionable scope computeEmbeddingReadiness's HEALING(n)
 * uses (backfill-embeddings.js's `liveOnly` option) — an empty-text NULL
 * or a suppressed/invalidated assertion's NULL no longer inflates this
 * count (previously a bare `embedding IS NULL`, which double-counted rows
 * that can never legitimately embed and rows nobody will ever act on).
 * Reads only tables/columns that actually exist (a Postgres DB with the
 * gated embedding column absent, or a SQLite DB with no such column at
 * all, simply reports 0 for that table — never an error surfaced to the
 * operator for a structurally-expected absence).
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {Promise<{assertions:number, decisions:number, unembeddableEmptyText:{assertions:number, decisions:number}}>}
 */
async function computeEmbeddingNullCounts(db, projectId) {
  const counts = { assertions: 0, decisions: 0 };
  const emptyText = { assertions: 0, decisions: 0 };
  if (db && typeof db.supportsEmbeddingColumns === 'function' && !db.supportsEmbeddingColumns()) {
    return { ...counts, unembeddableEmptyText: emptyText }; // SQLite: never an error.
  }
  try {
    const dry = await runBackfillEmbeddings({ db, projectId, table: 'all', apply: false, liveOnly: true });
    for (const t of (dry.tables || [])) {
      if (t.table === 'assertions' || t.table === 'decisions') {
        counts[t.table] = t.actionableNull || 0;
        emptyText[t.table] = t.noTextNull || 0;
      }
    }
  } catch (_) {
    // Non-fatal — keep zeros rather than surface an error to the operator.
  }
  return { ...counts, unembeddableEmptyText: emptyText };
}

/**
 * cm#224 follow-up: shared "is this DB currently degraded by a skipped
 * pgvector-gated object?" check + record-and-build-response helper, used
 * by all three ensureSchemaCurrent call sites that can otherwise report
 * success (the 'current' fast path, the post-lock-acquire re-check, and a
 * freshly successful apply). Returns `null` when nothing is gated-missing
 * (caller proceeds with its own normal success return); otherwise records
 * the persistent degradation and returns the final response object.
 *
 * @param {object} [opts.precomputedGated] — cm#185-schema-heal (adversary
 *   finding #10): when the caller already has a fresh checkPgvectorGatedObjects
 *   result from a moment earlier IN THE SAME call with no intervening writes,
 *   pass it here to avoid a redundant round-trip re-querying the identical
 *   fact. Never pass a result that could be stale relative to a write this
 *   function's caller just performed — S4 requires the recorded row to
 *   reflect the CURRENT probe.
 */
async function reportPgvectorGatedDegradation(db, projectId, classification, units, { silent, applied, extraDetail, precomputedGated } = {}) {
  const gated = precomputedGated || await checkPgvectorGatedObjects(db, classification.manifest, units);
  if (gated.ok) return null;
  const detail = {
    // cm#185-schema-heal (finding #6): preserve reason/expected/actual when
    // present (a shape_mismatch entry) rather than stripping to bare
    // unit/table/column — the degraded row should say WHY, not just WHAT.
    missing: gated.missing.map((m) => ({
      unit: m.unit, table: m.table, column: m.column,
      ...(m.reason ? { reason: m.reason } : {}),
      ...(m.expected ? { expected: m.expected } : {}),
      ...(m.actual ? { actual: m.actual } : {}),
    })),
    vectorExtensionPresent: gated.vectorExtensionPresent,
    remedy:
      'Have a Postgres superuser run `CREATE EXTENSION vector;` on this database, then ask an operator ' +
      'to force a schema re-apply (a SCHEMA_EPOCH bump, or a direct manual ALTER TABLE/CREATE INDEX) — ' +
      'installing the extension alone does not retroactively add a column/index that was already skipped ' +
      'at apply time.',
    ...(extraDetail || {}),
  };
  await recordSchemaDegradation(db, projectId, 'pgvector_gated_skip', detail, { silent });
  return { applied: !!applied, reason: 'degraded', detail };
}

/**
 * Schema-apply drift sentinel — the sole entry point used by cmdInit,
 * cmdLoaderLoad, and cmdClose.
 *
 * Flow: classify scripts/sql/* (loud degradation + return on any
 * classification error) → resolve the active dialect's ordered unit set →
 * compute the epoch-prefixed fingerprint → compare against the stored value
 * (current/absent/behind/ahead/unknown) → hot-path no-op on 'current' →
 * acquire the session-scoped schema-apply advisory lock → re-check (loser
 * no-ops) → per-file apply (fail-fast) → integrity-index gate → post-apply
 * catalog verification → upsert fingerprint + clear any prior degradation.
 *
 * Non-fatal end-to-end: every error path records a persistent
 * schema_apply_degraded row (+ stderr) and returns without throwing; callers
 * must still wrap in try/catch as a belt-and-suspenders guard for unexpected
 * throws (matches the existing call-site convention).
 *
 * Returns a status object so callers/tests can observe what happened without
 * re-deriving it: { applied: boolean, reason: string, detail?: object }.
 * Production call sites (cmdLoaderLoad, cmdClose) ignore the return value —
 * adding it is a non-breaking testability improvement (R-10).
 *
 * @param {object}  db        — connected StoragePort adapter
 * @param {string}  projectId — encoded_cwd / project UUID
 * @param {object}  [opts]
 * @param {boolean} [opts.silent=false] — suppress informational stderr output
 * @returns {Promise<{applied:boolean, reason:string, detail?:object}>}
 */
async function ensureSchemaCurrentCore(db, projectId, { silent } = {}) {
  // cm#185 review N5: classification (a non-recursive readdir, a `git
  // ls-files` spawn, and reading+parsing all ~5 small scripts/sql/*.sql files
  // for their header directives) now runs on EVERY call, including the
  // common "schema is current" case — this is genuinely more work than the
  // pre-cm#185 "one SELECT" hot path, and was necessary to make the total-
  // classification safety guarantee (S-5: an untracked/unclassified file is
  // always caught, not just at apply time) hold on every invocation, not only
  // when something is about to change. Measured, not assumed: a
  // bench-handoff.js `resume` A/B (n=15 each, this project's own
  // claude_memory_eval_test-backed loop) against pre-cm#185 main (commit
  // 2fdd52c) showed p50 wall 282.8ms / p50 internal 225.9ms on main vs. p50
  // wall 276.2ms / p50 internal 227.2ms on this branch — within normal
  // run-to-run noise (DB round-trips dominate this path; see the datapoint
  // in the PR body). Left unoptimized; revisit if a future profile shows
  // otherwise.
  let classification;
  try {
    classification = classifySchemaFiles({ engineRoot: _ENGINE_ROOT });
  } catch (err) {
    await recordSchemaDegradation(db, projectId, 'manifest_error', { message: err.message }, { silent });
    return { applied: false, reason: 'manifest_error', detail: { message: err.message } };
  }
  if (!classification.ok) {
    await recordSchemaDegradation(db, projectId, 'classification_error', { errors: classification.errors }, { silent });
    return { applied: false, reason: 'classification_error', detail: { errors: classification.errors } };
  }

  // Resolve the active dialect purely via the adapter's existing schemaFileName
  // property, never a live-client dialect getter check — the engine's zero-
  // dialect-conditional invariant (enforced by test-both-backends.js S8)
  // forbids any such check outside connectHandoff().
  const rosterEntry = classification.manifest.units[db.schemaFileName];
  const units = rosterEntry ? classification.unitsByDialect[rosterEntry.classification] : null;
  if (!units || units.length === 0) {
    const errors = [`no applicable schema units resolved for active dialect (roster file: ${db.schemaFileName})`];
    await recordSchemaDegradation(db, projectId, 'classification_error', { errors }, { silent });
    return { applied: false, reason: 'classification_error', detail: { errors } };
  }

  const currentFingerprint = _computeSchemaFingerprint(units);

  // Fingerprint comparison: one SELECT (the DB round-trip is the dominant
  // cost on the "schema is current" path — see the N5 note above the
  // classification call for why this is no longer literally "the only work").
  const { rows } = await db.query(
    'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
    [projectId, 'schema_fingerprint']
  );
  const stored = rows.length > 0 ? rows[0].value : null;
  const cmp = _compareSchemaFingerprint(stored, currentFingerprint);

  /** Accumulate the ungated expected_objects set from every active unit's manifest entry. */
  function buildExpectedObjects() {
    const expected = { tables: [], columns: [], indexes: [] };
    for (const u of units) {
      const eo = (classification.manifest.units[u.basename] || {}).expected_objects || {};
      expected.tables.push(...(eo.tables || []));
      expected.columns.push(...(eo.columns || []));
      expected.indexes.push(...(eo.indexes || []));
    }
    return expected;
  }

  /**
   * Shared lock + apply + verify + fingerprint + gated-check sequence.
   *
   * Used by:
   *   - the classic 'absent'/'behind' fingerprint-mismatch path (no
   *     `alreadyFixedCheck` — the post-lock recheck is the fingerprint
   *     comparison itself, byte-identical to this engine's pre-cm#185-
   *     schema-heal behavior).
   *   - S1(b)/(d) (adversary finding #3, BLOCKER): a fingerprint-'current'
   *     DB whose live catalog is missing an ungated object, or a gated
   *     object whose gating extension is now present. Routes through this
   *     SAME lock — never a standalone apply — so two concurrent touches
   *     racing the identical gap can never both run applyAdditiveSchema.
   *     `alreadyFixedCheck` re-probes the LIVE OBJECT the caller actually
   *     cares about (never the fingerprint, which cannot detect either of
   *     these gaps — that's the whole reason this path exists) immediately
   *     after the lock is held; if a concurrent winner already fixed it,
   *     this call is a clean no-op, mirroring the classic path's own
   *     "someone already applied while we waited" semantics.
   */
  async function runSchemaApplySequence({ alreadyFixedCheck } = {}) {
    const lockKey = 'schema_apply:' + projectId;
    try {
      await db.acquireSchemaApplyLock(lockKey);
    } catch (lockErr) {
      // cm#185 review N1: bounded acquire (db-seam.js SET lock_timeout) means a
      // wedged/long-lived concurrent holder throws here instead of hanging this
      // process forever. Treat exactly like any other apply-time failure: loud,
      // non-fatal, retried on the next invocation.
      await recordSchemaDegradation(db, projectId, 'lock_acquire_failed', { message: lockErr.message }, { silent });
      return { applied: false, reason: 'lock_acquire_failed', detail: { message: lockErr.message } };
    }
    try {
      // cm#185-schema-heal (adversary finding #7, MAJOR; relocated here in
      // the PR #262 perf follow-up): the fast path's OWN read no longer
      // needs this pin at all (probeFastPathSchemaState hardcodes the
      // literal 'public' schema directly in its query text — see that
      // method's doc). This apply sequence's own DDL/verify statements are
      // still schema-UNQUALIFIED (the SQL files never qualify a CREATE/
      // ALTER TABLE target), so they DO still depend on session search_path
      // — pinned here, once per actual apply attempt (rare), rather than on
      // every fast-path touch (common).
      await db.pinCanonicalSchema();

      if (alreadyFixedCheck) {
        if (await alreadyFixedCheck()) {
          const degraded = await reportPgvectorGatedDegradation(db, projectId, classification, units, { silent, applied: false });
          return degraded || { applied: false, reason: 'current' };
        }
      } else {
        // Re-check immediately after acquiring the lock — a concurrent process
        // may have already applied and upserted while we were waiting; if so,
        // this invocation is a clean no-op (R-8).
        const { rows: rows2 } = await db.query(
          'SELECT value FROM project_settings WHERE project_id = $1 AND key = $2',
          [projectId, 'schema_fingerprint']
        );
        const stored2 = rows2.length > 0 ? rows2[0].value : null;
        if (_compareSchemaFingerprint(stored2, currentFingerprint) === 'current') {
          const degraded = await reportPgvectorGatedDegradation(db, projectId, classification, units, { silent, applied: false });
          return degraded || { applied: false, reason: 'current' };
        }
      }

      const applyResult = await applyAdditiveSchema(db, units, { silent });
      if (!applyResult.ok) {
        const detail = { failedUnit: applyResult.failedUnit, errorMsg: applyResult.errorMsg, appliedUnits: applyResult.appliedUnits };
        await recordSchemaDegradation(db, projectId, 'apply_failed', detail, { silent });
        return { applied: false, reason: 'apply_failed', detail };
      }

      const failedIndexes = applyResult.integrityResults.filter((r) => !r.ok);
      if (failedIndexes.length > 0) {
        // R-6: fingerprint MUST NOT be upserted when any integrity-index result
        // is ok:false — the fingerprint records "verified present", never
        // "apply did not throw".
        await recordSchemaDegradation(db, projectId, 'integrity_index_failed', { failedIndexes }, { silent });
        return { applied: false, reason: 'integrity_index_failed', detail: { failedIndexes } };
      }

      // Post-apply structural verification (S-13): derive the expected-objects
      // set from the applied units' manifest entries (never by parsing SQL) and
      // probe the live catalog. Only upsert the fingerprint when every expected
      // object is confirmed present.
      const expected = buildExpectedObjects();
      const verify = await db.schemaObjectsExist(expected);
      if (!verify.ok) {
        await recordSchemaDegradation(db, projectId, 'verification_failed', { missing: verify.missing }, { silent });
        return { applied: false, reason: 'verification_failed', detail: { missing: verify.missing } };
      }

      await recordSchemaFingerprint(db, projectId, currentFingerprint);

      // cm#224 follow-up: the DDL itself applied and verified successfully
      // (fingerprint upserted above), but a pgvector-gated column/index may
      // still have been silently skipped — degraded, not a clean 'applied'.
      // S1(d)/adversary finding #2 (BLOCKER): clears ONLY if this fresh
      // post-apply probe passes; otherwise re-stamps with the current probe
      // — never an unconditional clear just because an apply was attempted.
      const degraded = await reportPgvectorGatedDegradation(db, projectId, classification, units, {
        silent, applied: true,
        extraDetail: { appliedUnits: applyResult.appliedUnits, fingerprint: currentFingerprint },
      });
      if (degraded) return degraded;

      await clearSchemaDegradation(db, projectId);
      return { applied: true, reason: 'applied', detail: { appliedUnits: applyResult.appliedUnits, fingerprint: currentFingerprint } };
    } finally {
      await db.releaseSchemaApplyLock(lockKey);
    }
  }

  if (cmp === 'current') {
    // ── S1: total classification of the fingerprint-'current' fast path ───
    // (cm#185-schema-heal, all adversary amendments accepted). A fingerprint
    // match only proves the SQL bytes are unchanged — it says nothing about
    // whether the live catalog still has every object those bytes describe
    // (a column dropped by hand, or a gating extension that only appeared
    // AFTER this DB was first fingerprinted). Every reachable state below
    // maps to exactly one branch; there is no default "looks fine" path.
    //
    // PR #262 perf follow-up: this used to be pinCanonicalSchema (1 round
    // trip) + schemaObjectsExist (3: tables/columns/indexes) +
    // checkPgvectorGatedObjects (pg_extension + a columns query) + one
    // checkColumnShape call PER shaped gated column — up to 7-8 round trips
    // on EVERY touch, measured as a genuine p50 regression, not noise.
    // db.probeFastPathSchemaState collapses all of that into ONE combined
    // catalog query (tables/columns/indexes/extension/shape, hardcoding the
    // canonical 'public' schema directly rather than relying on
    // pinCanonicalSchema — see that method's own doc for why this is
    // strictly SAFER for finding #7, not merely faster).
    const expected = buildExpectedObjects();
    const gatedColumns = _collectGatedColumns(classification.manifest, units);
    const shapeTargets = gatedColumns
      .filter((gc) => gc.type || gc.dims != null)
      .map((gc) => ({ table: gc.table, column: gc.column }));
    // cm#185-schema-heal constraint extension: expected_index_defs names
    // must be included in the SAME `indexes` param the combined probe's
    // 'indexdef' arm filters by (F2-style: no table_absent branch, no extra
    // round trip on the common all-clean touch).
    const expectedIndexDefNames = _collectExpectedIndexDefs(classification.manifest, units).map((e) => e.name);
    const probeIndexes = [...new Set([...(expected.indexes || []), ...expectedIndexDefNames])];

    let probe;
    try {
      probe = await db.probeFastPathSchemaState({
        tables: expected.tables,
        columns: expected.columns.concat(gatedColumns.map((gc) => ({ table: gc.table, column: gc.column }))),
        indexes: probeIndexes,
        shapeTargets,
      });
    } catch (probeErr) {
      // S1's own "any other -> BLOCK" branch: a probe FAILURE (e.g. a
      // transient connection error) is a different fact than "objects are
      // genuinely missing" — routing it into the apply branch would attempt
      // DDL right after failing to read from this same database. BLOCK,
      // naming what the probe reported.
      const detail = { message: probeErr.message };
      await recordSchemaDegradation(db, projectId, 'verification_probe_failed', detail, { silent });
      return { applied: false, reason: 'verification_probe_failed', detail };
    }

    const ungatedProbe = _deriveUngatedMissing(expected, probe);
    if (!ungatedProbe.ok) {
      // S1(b): fingerprint says current, but the live catalog is missing an
      // UNGATED object (e.g. a column dropped by hand) — BEHIND in every
      // sense that matters even though the SQL bytes never changed. Routes
      // through the SAME lock+apply+verify+fingerprint sequence as an
      // absent/behind fingerprint (adversary finding #3) — never a
      // standalone apply.
      if (!silent) {
        process.stderr.write(
          '[handoff] schema drift detected on a fingerprint-current DB (missing objects) — running additive schema apply\n'
        );
      }
      return await runSchemaApplySequence({
        alreadyFixedCheck: async () => {
          const p2 = await db.probeFastPathSchemaState({ tables: expected.tables, columns: expected.columns, indexes: expected.indexes, shapeTargets: [] });
          return _deriveUngatedMissing(expected, p2).ok;
        },
      });
    }

    // ── FK verification + heal (cm#185-schema-heal FK extension, F1-F4) ────
    // probeFastPathSchemaState verified column existence + pgvector shape
    // but never the FK itself — a column recreated without its REFERENCES
    // clause reads HEALED and a later write (e.g. backfill-embeddings) fails
    // at runtime. Runs off the SAME combined probe already fetched above
    // (its FK arm is filtered by `expected.tables`, which already includes
    // every table an expected_fks entry can name) — no extra round trip on
    // the common all-clean touch.
    const expectedFks = _collectExpectedFks(classification.manifest, units);
    if (expectedFks.length > 0) {
      let fkResults = _classifyExpectedFks(expectedFks, probe.tablesFound, probe.fks);
      const fixable = fkResults.filter((r) => r.state === 'absent' || r.state === 'present_mismatched');
      if (fixable.length > 0) {
        const healOutcome = await _healExpectedFks(db, projectId, fixable);
        if (!healOutcome.ok) {
          // F4: ADD failure (e.g. orphan rows) rolled back inside
          // _healExpectedFks — the prior constraint (if any) is retained
          // exactly as it was. DEGRADED with the specific SQLSTATE.
          const detail = {
            fks: fkResults.map(_fkResultDetail),
            reason: `heal_failed:${(healOutcome.sqlstate || 'unknown')}`,
            healMessage: healOutcome.message,
          };
          await recordSchemaDegradation(db, projectId, 'fk_mismatch', detail, { silent });
          return { applied: false, reason: 'degraded', detail };
        }
        // F4: degraded clears ONLY after a fresh passing re-probe; a
        // re-probe ERROR keeps DEGRADED (verification_probe_failed), never
        // a silent clear on the strength of the heal call alone.
        let reprobe;
        try {
          reprobe = await db.probeFastPathSchemaState({
            tables: [...new Set(expectedFks.map((fk) => fk.table))], columns: [], indexes: [], shapeTargets: [],
          });
        } catch (probeErr) {
          const detail = { message: probeErr.message, reason: 'verification_probe_failed' };
          await recordSchemaDegradation(db, projectId, 'fk_mismatch', detail, { silent });
          return { applied: false, reason: 'degraded', detail };
        }
        fkResults = _classifyExpectedFks(expectedFks, reprobe.tablesFound, reprobe.fks);
      }
      const stillBad = fkResults.filter((r) => r.state !== 'present_matching');
      if (stillBad.length > 0) {
        // table_absent lands here too — nothing an FK-only heal can fix on
        // a table that doesn't exist (that gap is the ungated expected_
        // objects apply path's job, already passed above in practice for
        // both of today's expected_fks entries since assertions/decisions
        // are themselves expected tables).
        const detail = { fks: fkResults.map(_fkResultDetail) };
        await recordSchemaDegradation(db, projectId, 'fk_mismatch', detail, { silent });
        return { applied: false, reason: 'degraded', detail };
      }
      // All expected FKs present_matching — clear any prior fk_mismatch (or
      // other) degraded row exactly like the gated-column branch below does
      // when its own set is clean; idempotent no-op when nothing is set.
      await clearSchemaDegradation(db, projectId);
    }

    // ── UNIQUE/NOT NULL/CHECK/index-def verification + heal (cm#185-schema-
    // heal constraint extension) ────────────────────────────────────────────
    // Same shape as the FK block above, off the SAME combined probe — no
    // extra round trip on the common all-clean touch. Each kind runs
    // independently (a failure in one kind still lets the others heal) but
    // any kind left non-clean after its own heal attempt DEGRADEs the touch
    // with that kind's specific reason string.
    const constraintKinds = [
      { key: 'uniques',   reason: 'unique_mismatch',    collect: _collectExpectedUniques,   classify: (exp, tf, p) => _classifyExpectedUniques(exp, tf, p.uniques),   heal: _healExpectedUniques,   reprobeKind: 'uniques' },
      { key: 'notNulls',  reason: 'notnull_mismatch',   collect: _collectExpectedNotNulls,  classify: (exp, tf, p) => _classifyExpectedNotNulls(exp, tf, p.notNulls), heal: _healExpectedNotNulls,  reprobeKind: 'notNulls' },
      { key: 'checks',    reason: 'check_mismatch',     collect: _collectExpectedChecks,    classify: (exp, tf, p) => _classifyExpectedChecks(exp, tf, p.checks),    heal: _healExpectedChecks,    reprobeKind: 'checks' },
    ];
    for (const kindDef of constraintKinds) {
      const expectedList = kindDef.collect(classification.manifest, units);
      if (expectedList.length === 0) continue;
      let results = kindDef.classify(expectedList, probe.tablesFound, probe);
      const fixable = results.filter((r) => r.state === 'absent' || r.state === 'present_mismatched');
      if (fixable.length > 0) {
        const healOutcome = await kindDef.heal(db, projectId, fixable);
        if (!healOutcome.ok) {
          const detail = { items: results, reason: `heal_failed:${(healOutcome.sqlstate || 'unknown')}`, healMessage: healOutcome.message };
          await recordSchemaDegradation(db, projectId, kindDef.reason, detail, { silent });
          return { applied: false, reason: 'degraded', detail };
        }
        let reprobe;
        try {
          const reTables = [...new Set(expectedList.map((e) => e.table))];
          reprobe = await db.probeFastPathSchemaState({ tables: reTables, columns: [], indexes: [], shapeTargets: [] });
        } catch (probeErr) {
          const detail = { message: probeErr.message, reason: 'verification_probe_failed' };
          await recordSchemaDegradation(db, projectId, kindDef.reason, detail, { silent });
          return { applied: false, reason: 'degraded', detail };
        }
        results = kindDef.classify(expectedList, reprobe.tablesFound, reprobe);
      }
      const stillBad = results.filter((r) => r.state !== 'present_matching');
      if (stillBad.length > 0) {
        const detail = { items: stillBad };
        await recordSchemaDegradation(db, projectId, kindDef.reason, detail, { silent });
        return { applied: false, reason: 'degraded', detail };
      }
      await clearSchemaDegradation(db, projectId);
    }
    // index-defs: identity is the index name (no table_absent branch needed
    // — see _classifyExpectedIndexDefs's own doc) — kept as its own block
    // since it re-probes via the `indexes` param, not `tables`.
    {
      const expectedIndexDefs = _collectExpectedIndexDefs(classification.manifest, units);
      if (expectedIndexDefs.length > 0) {
        let results = _classifyExpectedIndexDefs(expectedIndexDefs, probe.indexDefs);
        const fixable = results.filter((r) => r.state === 'absent' || r.state === 'present_mismatched');
        if (fixable.length > 0) {
          const healOutcome = await _healExpectedIndexDefs(db, projectId, fixable);
          if (!healOutcome.ok) {
            const detail = { items: results, reason: `heal_failed:${(healOutcome.sqlstate || 'unknown')}`, healMessage: healOutcome.message };
            await recordSchemaDegradation(db, projectId, 'index_def_mismatch', detail, { silent });
            return { applied: false, reason: 'degraded', detail };
          }
          let reprobe;
          try {
            reprobe = await db.probeFastPathSchemaState({ tables: [], columns: [], indexes: expectedIndexDefs.map((e) => e.name), shapeTargets: [] });
          } catch (probeErr) {
            const detail = { message: probeErr.message, reason: 'verification_probe_failed' };
            await recordSchemaDegradation(db, projectId, 'index_def_mismatch', detail, { silent });
            return { applied: false, reason: 'degraded', detail };
          }
          results = _classifyExpectedIndexDefs(expectedIndexDefs, reprobe.indexDefs);
        }
        const stillBad = results.filter((r) => r.state !== 'present_matching');
        if (stillBad.length > 0) {
          const detail = { items: stillBad };
          await recordSchemaDegradation(db, projectId, 'index_def_mismatch', detail, { silent });
          return { applied: false, reason: 'degraded', detail };
        }
        await clearSchemaDegradation(db, projectId);
      }
    }

    // Ungated objects are all present — now total-classify the gated
    // (pgvector-dependent) objects, from the SAME combined probe (S4: this
    // probe just ran fresh, so it's authoritative for every branch below —
    // no separate live re-query needed).
    if (gatedColumns.length === 0) {
      const clearResult = await clearSchemaDegradation(db, projectId);
      return { applied: false, reason: 'current', ...(clearResult.cleared ? { detail: { healedDegradedRow: true } } : {}) };
    }
    const gatedMissing = _deriveGatedMissing(gatedColumns, probe.columnsFound, probe.shapes);
    const gated = { ok: gatedMissing.length === 0, vectorExtensionPresent: probe.vectorExtensionPresent, missing: gatedMissing };
    if (gated.ok) {
      // S1(a): HEALED. clearSchemaDegradation is an idempotent no-op DELETE
      // when no row exists, so calling it unconditionally here has the
      // identical net effect to "clear only if a degraded row exists AND
      // the re-probe passed" — its own return value (rowCount-derived) is
      // how the caller (cmdStatus) learns whether this was a real
      // transition, without a separate pre-heal SELECT.
      const clearResult = await clearSchemaDegradation(db, projectId);
      return { applied: false, reason: 'current', ...(clearResult.cleared ? { detail: { healedDegradedRow: true } } : {}) };
    }

    // finding #6 refinement: a shape_mismatch (column exists, wrong
    // type/dims) can NEVER be fixed by re-running ADD COLUMN IF NOT EXISTS —
    // that statement no-ops against an already-existing column regardless
    // of its shape. Only an 'absent' entry is something an apply attempt
    // could possibly resolve. A gated result made up ENTIRELY of
    // shape_mismatch entries therefore always falls through to (c)'s
    // report/re-stamp-only treatment, even when the extension is present —
    // routing it into (d) would just retry a no-win apply on every touch.
    const hasFixableAbsence = gated.missing.some((m) => m.reason !== 'shape_mismatch');

    if (gated.vectorExtensionPresent === true && hasFixableAbsence) {
      // Adversary finding #5 (MAJOR): an operator's explicit --no-embeddings
      // opt-out must never be silently overridden by pgvector later
      // appearing on a shared instance (e.g. another app on the same
      // cluster installs it) — report/re-stamp only, exactly like (c),
      // never an unsolicited ALTER TABLE/CREATE INDEX against a large table.
      if (await isEmbeddingsOptedOut(db, projectId)) {
        const degraded = await reportPgvectorGatedDegradation(db, projectId, classification, units, {
          silent, applied: false, precomputedGated: gated,
        });
        return degraded || { applied: false, reason: 'current' };
      }
      // S1(d): extension now present but the gated column/index is still
      // missing — apply now, through the SAME lock as (b)/behind (adversary
      // finding #3: no standalone apply, no double-apply race — see
      // runSchemaApplySequence's own doc). Clears ONLY if the post-apply
      // re-probe (inside the shared sequence) passes; otherwise re-stamps
      // with the current probe (adversary finding #2).
      return await runSchemaApplySequence({
        alreadyFixedCheck: async () => {
          const p2 = await db.probeFastPathSchemaState({
            tables: [], columns: gatedColumns.map((gc) => ({ table: gc.table, column: gc.column })), indexes: [], shapeTargets,
          });
          return _deriveGatedMissing(gatedColumns, p2.columnsFound, p2.shapes).length === 0;
        },
      });
    }

    // S1(c): gated missing (or shape-mismatched with nothing fixable), and
    // the extension's presence is either confirmed false OR itself
    // unreadable (vectorExtensionPresent === null gets the same
    // conservative "not confirmed true" treatment as false) — re-stamp with
    // the CURRENT probe, never apply (there is nothing an apply could fix here).
    const degraded = await reportPgvectorGatedDegradation(db, projectId, classification, units, {
      silent, applied: false, precomputedGated: gated,
    });
    return degraded || { applied: false, reason: 'current' };
  }

  if (cmp === 'ahead') {
    // Stored epoch is newer than this engine build knows about — refuse to
    // apply (would be a downgrade), warn persistently, continue non-fatally.
    const detail = { stored, current: currentFingerprint, note: 'stored schema_fingerprint epoch is newer than this engine build — refusing to apply; upgrade the engine' };
    await recordSchemaDegradation(db, projectId, 'fingerprint_ahead', detail, { silent });
    return { applied: false, reason: 'ahead', detail };
  }
  if (cmp === 'unknown') {
    await recordSchemaDegradation(db, projectId, 'fingerprint_unparseable', { stored }, { silent });
    return { applied: false, reason: 'unknown', detail: { stored } };
  }

  // cmp is 'absent' or 'behind' — apply.
  if (!silent) {
    process.stderr.write('[handoff] schema drift detected — running additive schema apply\n');
  }
  return await runSchemaApplySequence();
}

const INTENT_KEY_MIGRATION_SETTING_KEY = 'intent_key_migration_epoch';

/**
 * cm#233 cutover atomicity: run scripts/migrations/migrate-17-intent-key.js's
 * one-time re-key of live open_thread rows automatically on the first
 * ensureSchemaCurrent touch of a DB that has not yet run it AT this
 * SCHEMA_EPOCH (bumped to 4 for exactly this purpose — see SCHEMA_EPOCH's
 * own comment). Gate is a single cheap SELECT on project_settings when
 * already migrated (the common case after the first touch), matching the
 * schema_fingerprint gate's own cost shape. Non-fatal on any error — a
 * project DB is never left unusable because this data-quality migration
 * could not run; it is retried on the next touch.
 *
 * Deliberately NOT folded into ensureSchemaCurrentCore's own return value:
 * this never changes ensureSchemaCurrent's {applied, reason, detail}
 * contract (the S12 c-series/d-series tests pin those return shapes
 * byte-for-byte) — it only runs as an additional, purely side-effecting
 * step after a touch that confirms the DB is reachable and
 * schema-current/just-applied.
 */
async function runIntentKeyMigrationIfNeeded(db, projectId, { silent } = {}) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = $2`,
      [projectId, INTENT_KEY_MIGRATION_SETTING_KEY]
    );
    const stored = rows.length > 0 ? parseInt(rows[0].value, 10) : 0;
    if (Number.isFinite(stored) && stored >= SCHEMA_EPOCH) return; // already migrated at/after this epoch

    // Lazy require: avoids a require-cycle at module load. getSetting/
    // writeAssertionWithSupersession are passed DIRECTLY (both are already
    // local functions in this file) rather than left for migrate-17 to
    // require handoff.js itself — when handoff.js runs as the CLI entry
    // point (require.main === module, the normal `handoff.js close` path
    // that drives this auto-run-on-next-touch gate), handoff.js's own
    // `main()`-vs-`module.exports` guard means a require() of handoff.js
    // from inside migrate-17 would see an UNPOPULATED module.exports (the
    // `else` branch below never runs when this file is main) — see
    // migrate-17-intent-key.js's migrateIntentKeys header comment for the
    // full rationale.
    const { migrateIntentKeys } = require('./migrations/migrate-17-intent-key.js');
    // cm#233 fix-round: silent:true UNCONDITIONALLY — this auto-run gate
    // NEVER emits migrate-17's own console.log plan output (that was
    // polluting stdout on every project's first post-upgrade touch,
    // breaking scripts/smoketest-handoff.js's C2/C5 exact-stdout checks).
    // The one summary line below (gated on the OUTER `silent` — the same
    // flag ensureSchemaCurrent's other apply-time messages respect) is the
    // ONLY output this gate ever produces, and it goes to stderr, never
    // stdout.
    const result = await migrateIntentKeys(db, projectId, {
      dryRun: false,
      silent: true,
      getSetting,
      writeAssertionWithSupersession,
    });

    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [projectId, INTENT_KEY_MIGRATION_SETTING_KEY, String(SCHEMA_EPOCH)]
    );

    if (!silent && result && (result.changed > 0 || result.collisions > 0)) {
      process.stderr.write(
        `[handoff] intent-key migration (cm#233 cutover): rekeyed ${result.changed} open_thread row(s), ` +
        `${result.collisions} collision group(s) resolved\n`
      );
    }
  } catch (err) {
    process.stderr.write(`[handoff] intent-key migration check failed (non-fatal): ${err.message}\n`);
  }
}

/**
 * Public ensureSchemaCurrent — thin wrapper around ensureSchemaCurrentCore
 * that additionally runs the cm#233 intent-key migration gate exactly once
 * per touch, after a 'current' or freshly-'applied' result (i.e. only when
 * the DB is confirmed reachable and schema-current). The wrapper NEVER
 * alters the core function's return value — callers and tests see the
 * identical {applied, reason, detail} contract as before this wrapper
 * existed.
 */
async function ensureSchemaCurrent(db, projectId, opts = {}) {
  const result = await ensureSchemaCurrentCore(db, projectId, opts);
  if (result && (result.reason === 'current' || result.reason === 'applied')) {
    await runIntentKeyMigrationIfNeeded(db, projectId, opts);
    // cm#embed-heal-on-touch (categorical fix for the writer-bypasses-write-
    // time-embed NULL backlog — see embed-heal.js header): only runs after
    // schema is confirmed healed, same gating as the intent-key migration
    // immediately above. Fail-soft/never-throws/bounded — see that module's
    // own doc. Deliberately NOT folded into this function's return value,
    // for the same reason runIntentKeyMigrationIfNeeded isn't: it never
    // alters the {applied, reason, detail} contract callers/tests pin.
    try {
      await runEmbedHealIfNeeded(db, projectId, opts);
    } catch (embedHealErr) {
      // Belt-and-suspenders — runEmbedHealIfNeeded already never throws,
      // but a touch must never fail because of this side-effecting step.
      process.stderr.write(`[handoff] embed-heal check failed (non-fatal): ${embedHealErr.message}\n`);
    }
  }
  return result;
}

// ─── INIT PRE-FLIGHT HELPERS ──────────────────────────────────────────────────

/** Check that Node.js is >= 18. Returns { ok, msg, fatal }. */
function checkNodeVersion() {
  const parts = process.versions.node.split('.').map(Number);
  const major = parts[0];
  if (major < 18) {
    return {
      ok: false,
      msg: `Node ${process.versions.node} detected — requires Node >= 18. Upgrade: https://nodejs.org`,
      fatal: true,
    };
  }
  return { ok: true, msg: `Node ${process.versions.node}`, fatal: false };
}

/** Print a single pre-flight result line. */
function printPreflightLine(result, stepDesc) {
  if (result.ok) {
    console.log(`  [OK]    ${stepDesc}: ${result.msg}`);
  } else if (!result.fatal) {
    console.log(`  [WARN]  ${stepDesc} — ${result.msg}`);
  } else {
    console.log(`  [FAIL]  ${stepDesc} — ${result.msg}`);
  }
}

// ─── SUBCOMMANDS ─────────────────────────────────────────────────────────────

// ── init ─────────────────────────────────────────────────────────────────────

async function cmdInit(args) {
  console.log('Running: handoff:init\n');

  // ── --seed-provider: standalone backfill path ────────────────────────────
  // Runs ONLY the local-embedding-provider seeding step (see
  // seedLocalEmbeddingProvider / scripts/lib/embedding-provider.js) against
  // an ALREADY-INITIALIZED project's DB — no confirmation gate, no schema
  // apply, no marker/handoff.md/CLAUDE.md provisioning. This is the backfill
  // path for existing local projects that ran `init` before this seeding
  // step existed; a fresh `init` (below) seeds inline as part of its own
  // sequence and never needs this flag. embedding_providers is a global,
  // non-project-scoped table (see its own DDL comment), so no project
  // marker/UUID resolution is needed here at all.
  if (args.includes('--seed-provider')) {
    const seedCwd  = process.env.PROJECT_ROOT || process.cwd();
    const seedRoot = findProjectRootByMarker(seedCwd) || findProjectRoot();
    const seedAllowRemoteEmbed = args.includes('--allow-remote-embed');
    let seedDb;
    try {
      seedDb = await connectHandoff();
    } catch (err) {
      console.log(`  [FAIL]  DB connection failed — ${err.message}`);
      process.exit(1);
    }
    const result = await seedLocalEmbeddingProvider({ db: seedDb, projectRoot: seedRoot, allowRemoteEmbed: seedAllowRemoteEmbed });
    for (const line of result.lines) console.log(line);
    await seedDb.end();
    // Init changes item 2: standalone --seed-provider mode also BLOCKs
    // (exit 1) on an unseeded result — no marker/FS was ever written by
    // this standalone path, so there is nothing to unwind. `alreadyPresent`
    // (a default provider already exists — same name or a different one)
    // is a benign idempotent no-op, NEVER a BLOCK-worthy failure.
    if (!result.seeded && !result.alreadyPresent) {
      console.log(`\nDone: handoff:init --seed-provider — FAILED (no default provider seeded)`);
      process.exit(1);
    }
    console.log(`\nDone: handoff:init --seed-provider`);
    return;
  }

  // Determine project root: prefer the project marker (new name, or legacy
  // .claude-memory) if present, else fall back to the .git walk (same as
  // legacy behavior for the init case).
  // Honor PROJECT_ROOT env var as the starting point, matching findProjectRoot().
  const initCwd    = process.env.PROJECT_ROOT || process.cwd();
  const markerRoot = findProjectRootByMarker(initCwd);
  const root       = markerRoot || findProjectRoot();

  // ── Resolve or mint the project UUID (FS-deferred for atomicity) ──────────
  //
  // When no marker exists yet, we mint the UUID in memory and defer writing
  // the project marker file to the very last step — AFTER all DB operations
  // and all other FS writes succeed.  This ensures a failed init cannot leave
  // the project appearing handoff-enabled when the DB was never provisioned.
  //
  // When a marker already exists (re-init), we read the UUID as normal and
  // skip the deferred write; idempotency is preserved.
  //
  // fsLedger — tracks only the files THIS run creates (not pre-existing ones).
  // On any failure after we start writing files, unwindFsLedger() deletes
  // exactly those files in reverse order.
  const fsLedger = [];      // entries: absolute file path strings, push-ordered
  let   markerDeferred = false; // true when the marker is not yet on disk

  function unwindFsLedger() {
    const created = [...fsLedger].reverse();
    for (const filePath of created) {
      try { fs.rmSync(filePath, { force: true }); } catch (_) { /* best-effort */ }
    }
    if (created.length > 0) {
      console.log(`          Rolled back filesystem writes (${created.length} file(s) removed):`);
      for (const filePath of created) {
        console.log(`            - ${filePath}`);
      }
    } else {
      console.log(`          No filesystem changes were made.`);
    }
  }

  let projectId;
  {
    const existingMarker = readMarker(root);
    if (existingMarker) {
      projectId = existingMarker.uuid;
      console.log(`  [OK]    project marker present: uuid=${projectId}`);
      // marker already exists — no deferred write needed
    } else {
      // Mint UUID in memory; do NOT write the marker file yet.
      projectId     = mintUUID();
      markerDeferred = true;
      console.log(`  [OK]    project marker minted (deferred): uuid=${projectId}`);
      console.log(`          Path: ${path.join(root, MARKER_FILENAME)} (written last on success)`);
    }
  }

  const handoffPath  = resolveHandoffMdPath(projectId);
  // claudeMdPath / promotionHost are resolved together, later, via
  // resolvePromotionTarget() (see Step 11) — host must be known BEFORE the
  // filename default is picked (HANDOFF_HOST=codex with
  // HANDOFF_PROMOTION_FILE unset must resolve to AGENTS.md, not CLAUDE.md).
  // -y / --yes / --force all bypass the confirmation gate and enable DB auto-create.
  const autoCreate   = args.includes('-y') || args.includes('--yes') || args.includes('--force');

  const cfg = loadConfig();

  // ── Resolved target DB announcement ──────────────────────────────────────
  // Always print before any DDL so the operator knows which DB will be touched.
  console.log(`  Resolved target DB: ${TARGET_DB}  (source: ${_rawTargetDbSource})`);

  // ── init-embeddability: extension-state + opt-out probe, BEFORE the gate ──
  //
  // Adversary finding #1 (BLOCKER): the confirm-before-DDL gate below fires
  // BEFORE any DB connection exists — moving a pgvector-extension check to
  // "after schema apply" (as first drafted) would mean either (a) running
  // `CREATE EXTENSION vector;` completely unattended once discovered later,
  // violating the "no DDL without ack" policy the gate exists to enforce, or
  // (b) opening a SECOND prompt, which is forbidden (one gate, one policy).
  // So the probe runs HERE, before the gate, using its own short-lived
  // connection — its result only ever WIDENS the existing gate's prompt text
  // (never adds a second prompt) and can BLOCK OUTRIGHT (before any prompt)
  // on the two states the spec's extension table marks unconditional BLOCK.
  const noEmbeddingsFlag    = args.includes('--no-embeddings');
  const allowRemoteEmbed    = args.includes('--allow-remote-embed');
  const clearOptOutFlag     = args.includes('--clear-opt-out');
  const initDialect         = resolveDialect(cfg);

  // SQLite: dialect-gated top-level branch (per spec's "SQLite seam
  // behavior") — extension-state is N/A, never evaluated as BLOCK/DEGRADED.
  // Explicit --no-embeddings this run also skips the probe entirely — an
  // operator who has already opted out has no need for a pgvector-state
  // connection attempt at all.
  const extProbe = (initDialect === 'sqlite' || noEmbeddingsFlag)
    ? { state: noEmbeddingsFlag ? 'SKIPPED_NO_EMBEDDINGS' : 'N_A_SQLITE', optOut: null }
    : await probeInitEmbeddabilityState(cfg, TARGET_DB, projectId);

  // Resolve the configured embed endpoint NOW (pure — file/env reads only,
  // no I/O beyond that) so the persisted-opt-out auto-honor decision
  // (adversary finding #5) can see whether a real endpoint has since been
  // configured, and so the gate text can be built without a second lookup.
  const initEndpointDetail = resolveConfiguredEmbedEndpointDetailed({ projectRoot: root, env: process.env });

  // Adversary finding #5: an already-persisted embeddings_opt_out row is
  // auto-honored (no false re-BLOCK on a routine re-init) UNLESS this run
  // also configured a real endpoint (operator clearly wants embeddings
  // back) or explicitly passed --clear-opt-out.
  let effectiveNoEmbeddings = noEmbeddingsFlag;
  if (!effectiveNoEmbeddings && extProbe.optOut && !clearOptOutFlag && !initEndpointDetail.url) {
    effectiveNoEmbeddings = true;
    console.log(
      `  [NOTE]  embeddings opt-out already on file (stamped ${extProbe.optOut.stamp || 'unknown date'}) — ` +
      'honoring it for this run. Pass a real endpoint (pipeline.yml/env/~/.claude/handoff-embed.json) ' +
      'or --clear-opt-out to change this.'
    );
  }

  // Unconditional BLOCK branches (spec's extension table) — fire BEFORE the
  // confirm gate, regardless of -y/--yes/--force, since no confirmation
  // could make an impossible or unverifiable DDL operation succeed.
  if (!effectiveNoEmbeddings && initDialect !== 'sqlite') {
    if (extProbe.state === 'EXT_ABSENT_NO_PRIVILEGE') {
      console.log(`  [FAIL]  pgvector extension is not installed on database '${TARGET_DB}', and this role lacks CREATE privilege to install it.`);
      console.log(`          Have a Postgres superuser/owner run:`);
      console.log(`            CREATE EXTENSION vector;`);
      console.log(`          on database '${TARGET_DB}', then re-run init. Or pass --no-embeddings to proceed without embedding capability.`);
      unwindFsLedger();
      process.exit(1);
    }
    if (extProbe.state === 'PROBE_ERROR') {
      console.log(`  [FAIL]  could not determine pgvector extension state on database '${TARGET_DB}' — ${extProbe.error ? extProbe.error.message : 'unknown error'}`);
      console.log(`          Refusing to proceed with an unverifiable extension state (never a silent PROCEED). Or pass --no-embeddings to proceed without embedding capability.`);
      unwindFsLedger();
      process.exit(1);
    }
  }

  // Whether the schema-apply step (below, after DB connect) needs to run
  // `CREATE EXTENSION vector;` before applying the gated DDL. DB_ABSENT is
  // included: a freshly created Postgres database never has any extension
  // installed, so the same install step applies once it exists.
  const needsExtensionInstall = !effectiveNoEmbeddings && initDialect !== 'sqlite' &&
    (extProbe.state === 'EXT_ABSENT_HAS_PRIVILEGE' || extProbe.state === 'DB_ABSENT');

  // ── Confirmation gate — BEFORE any DDL ───────────────────────────────────
  //
  // Policy: no schema (CREATE DATABASE, CREATE EXTENSION, or schema apply)
  // executes without explicit acknowledgment.  Three paths:
  //   1. bypass flag (-y / --yes / --force) → skip prompt, proceed immediately.
  //   2. stdin is a TTY → interactive y/N prompt; non-yes answer aborts, exit 1.
  //   3. stdin is NOT a TTY and no bypass flag → safe-fail with a clear message,
  //      exit 1.  NEVER open a readline interface in this path — that hangs.
  //
  // Adversary finding #1 (BLOCKER, A2): the SAME single gate below also
  // covers `CREATE EXTENSION vector;` when needsExtensionInstall is true —
  // its prompt text is built conditionally from the probe above rather than
  // adding a second, independent prompt.
  let gatePromptText = `  Apply handoff schema to database '${TARGET_DB}' (source: ${_rawTargetDbSource})`;
  if (needsExtensionInstall && extProbe.state === 'EXT_ABSENT_HAS_PRIVILEGE') {
    gatePromptText += ' — this will also run `CREATE EXTENSION vector;` (pgvector is not yet installed on this database)';
  } else if (needsExtensionInstall && extProbe.state === 'DB_ABSENT') {
    gatePromptText += ' — this database does not exist yet and will be created, then `CREATE EXTENSION vector;` will be run on it';
  }
  gatePromptText += '? [y/N]: ';

  if (!autoCreate) {
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question(gatePromptText, (a) => { rl.close(); resolve(a.trim()); });
      });
      if (!/^y(es)?$/i.test(answer)) {
        console.log(`  Aborted — no schema changes were made.`);
        process.exit(1);
      }
    } else {
      // Non-interactive context with no bypass flag — safe-fail immediately.
      // Do NOT open readline here; that would hang agent/CI invocations indefinitely.
      console.log(`  Refusing to apply DDL without confirmation in a non-interactive context.`);
      console.log(`  Re-run with -y (or --force) to proceed, or run init in an interactive terminal.`);
      process.exit(1);
    }
  }

  // ── Pre-flight checks ─────────────────────────────────────────────────────

  // Step 1: Node version >= 18 (dialect-independent)
  const nodeCheck = checkNodeVersion();
  printPreflightLine(nodeCheck, 'Node version >= 18');
  if (nodeCheck.fatal) { process.exit(1); }

  // Steps 2-5: dialect-specific pre-flight — fully encapsulated inside the
  // probe adapter. createInitProbe() resolves dialect once and returns the
  // appropriate adapter. No dialect conditionals in this function.
  const probeAdapter = createInitProbe(cfg);
  try {
    await probeAdapter.runInitPreflight(cfg, TARGET_DB, autoCreate, root, printPreflightLine);
  } catch (err) {
    // fatal errors thrown by runInitPreflight are already printed by printPreflightLine
    process.exit(1);
  }

  // Step 6: schema classification — total classification of scripts/sql/*.sql,
  // resolved for the active dialect (cm#185 generalized bring-forward). Replaces
  // the former single-file "is handoff-core-schema.sql present" check: the
  // applicable unit set for Postgres is now [handoff-core-schema.sql,
  // app-retrieval-events-schema.sql] (ordered), for SQLite it is
  // [handoff-sqlite-schema.sql]. Any classification error is fatal at init
  // time (a fresh install with a broken scripts/sql/ directory should not
  // silently proceed).
  let classification;
  try {
    classification = classifySchemaFiles({ engineRoot: _ENGINE_ROOT });
  } catch (err) {
    console.log(`  [FAIL]  Schema classification failed — ${err.message}`);
    process.exit(1);
  }
  if (!classification.ok) {
    console.log(`  [FAIL]  Schema classification errors:`);
    for (const e of classification.errors) console.log(`          - ${e}`);
    process.exit(1);
  }
  const rosterEntry = classification.manifest.units[probeAdapter.schemaFileName];
  const units = rosterEntry ? classification.unitsByDialect[rosterEntry.classification] : null;
  if (!units || units.length === 0) {
    console.log(`  [FAIL]  No applicable schema units resolved for active dialect (roster file: ${probeAdapter.schemaFileName})`);
    process.exit(1);
  }
  console.log(`  [OK]    Schema units resolved (${units.length}): ${units.map((u) => u.basename).join(', ')}`);
  // cm#185-schema-heal (S2): computed once here, written to project_settings
  // after a successful apply+verify below (see recordSchemaFingerprint call).
  const currentFingerprint = _computeSchemaFingerprint(units);

  // Connect to target DB — adapter handles dialect-specific connection setup.
  let db;
  try {
    db = await probeAdapter.connectForInit(cfg, TARGET_DB, root);
  } catch (err) {
    console.log(`  [FAIL]  DB connection failed — ${err.message}`);
    process.exit(1);
  }
  // cm#185-schema-heal (adversary finding #7, MAJOR): pin the SAME canonical
  // schema ensureSchemaCurrentCore pins for every later touch — see
  // PostgresAdapter#pinCanonicalSchema's own doc. No-op on SQLite;
  // best-effort on Postgres.
  await db.pinCanonicalSchema();

  // ── init-embeddability: install pgvector BEFORE the gated schema DDL runs ──
  // Runs only after the SINGLE confirm gate above already covered this
  // exact DDL (needsExtensionInstall implies the operator already
  // confirmed, or passed -y/--force). Installing it here — before
  // applyAdditiveSchema below — means the schema SQL's own
  // `DO $$ ... EXCEPTION WHEN OTHERS $$` gated blocks see the extension
  // already present and create the gated columns/indexes in this SAME run,
  // rather than leaving them skipped for a later re-init.
  if (needsExtensionInstall) {
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log(`  [OK]    pgvector extension installed on '${TARGET_DB}' (CREATE EXTENSION vector)`);
    } catch (extErr) {
      await db.end();
      console.log(`  [FAIL]  CREATE EXTENSION vector failed on '${TARGET_DB}' — ${extErr.message}`);
      console.log(`          Have a Postgres superuser/owner run: CREATE EXTENSION vector; on database '${TARGET_DB}', then re-run init.`);
      unwindFsLedger();
      process.exit(1);
    }
  }

  // cm#185 review N2: take the same session-scoped schema-apply advisory lock
  // here that ensureSchemaCurrent takes on the drift-apply path — previously
  // only the sentinel path was locked, leaving a window where a concurrent
  // `init` and a concurrent drift-apply (or two concurrent inits) could
  // interleave their per-file apply transactions. Bounded (N1): a wedged
  // holder degrades init loud-and-non-destructively rather than hanging the
  // CLI process forever.
  const initLockKey = 'schema_apply:' + projectId;
  try {
    await db.acquireSchemaApplyLock(initLockKey);
  } catch (lockErr) {
    await db.end();
    console.log(`  [FAIL]  Could not acquire schema-apply lock — ${lockErr.message}`);
    unwindFsLedger();  // ledger is empty at this point — prints accurate status
    process.exit(1);
  }

  // Step 7: apply the classified unit set via the same engine used by the
  // drift sentinel (applyAdditiveSchema) — per-file transaction, fail-fast:
  // a failing unit stops the sequence; units already committed before it stay
  // committed (this is a deliberate behavior change from the old single-file
  // atomicity — see PR body R-6). Integrity-index creation for
  // assertions_1to1_unique / assertions_1ton_exact_unique remains non-fatal
  // on a legacy-duplicate corpus, exactly as before:
  //
  //   State when an integrity index is NOT created (legacy-dupe corpus):
  //     - The additive bi-temporal columns (valid_at, invalid_at, suppression_kind,
  //       pinned) ARE present — the per-file DDL transaction guarantees this.
  //     - Supersession correctness is still enforced transactionally in
  //       writeAssertionWithSupersession (BEGIN/suppress+INSERT/COMMIT).
  //     - The missing index is a defense-in-depth layer, not the primary guarantee.
  //     - The blocking rows are LIVE duplicates (suppressed=false). The `prune
  //       --suppressed` command targets only suppressed=true rows and will NOT
  //       resolve this condition. Resolving live-duplicate rows is corpus-dedupe
  //       work — precisely the §7 SKIP (WILL-NOT-RUN) decision — and requires
  //       explicit operator authorization, not a routine command.
  const applyResult = await applyAdditiveSchema(db, units, { silent: false });
  if (!applyResult.ok) {
    await db.releaseSchemaApplyLock(initLockKey);
    await db.end();
    console.log(`  [FAIL]  Schema apply failed on ${applyResult.failedUnit} — ${applyResult.errorMsg}`);
    console.log(`  [FAIL]  That unit's transaction rolled back; earlier unit(s) already applied remain committed: ${applyResult.appliedUnits.join(', ') || '(none)'}`);
    unwindFsLedger();  // ledger is empty at this point — prints accurate status
    process.exit(1);
  }
  console.log(`  [OK]    Schema applied: ${applyResult.appliedUnits.join(', ')}`);

  for (const r of applyResult.integrityResults) {
    if (!r.ok) {
      console.log(`  [WARN]  Integrity index NOT created: ${r.name} (${r.unit})`);
      console.log(`          Reason: ${r.msg}`);
      console.log(`          This means the DB contains pre-existing duplicate live rows`);
      console.log(`          (same project_id/subject/predicate with suppressed=false) that`);
      console.log(`          violate the uniqueness constraint — a legacy-duplicate corpus.`);
      console.log(`          The blocking rows are LIVE duplicates (suppressed=false).`);
      console.log(`          prune --suppressed targets only suppressed=true rows and will`);
      console.log(`          NOT resolve this — do not run it for this condition.`);
      console.log(`          Resolving live-duplicate rows is corpus-dedupe work (§7 SKIP,`);
      console.log(`          WILL-NOT-RUN) and requires explicit operator authorization.`);
      console.log(`          Until that decision is taken, handoff init succeeds WITHOUT`);
      console.log(`          this index. Supersession correctness is still enforced`);
      console.log(`          transactionally in writeAssertionWithSupersession`);
      console.log(`          (BEGIN/suppress+INSERT/COMMIT). The missing index is`);
      console.log(`          defense-in-depth only.`);
    }
  }

  // Post-apply structural verification (S-13): fatal at init time — a fresh
  // install that fails this check indicates a real DDL problem, not benign
  // extension absence (the expected-objects lists in schema-manifest.json
  // deliberately exclude the pgvector/pg_trgm-gated objects — see that
  // file's handoff-core-schema.sql "_note").
  //
  // Deliberately excludes any integrity index whose applyResult.integrityResults
  // entry is ok:false (review B1 fix): a legacy-duplicate corpus that blocks
  // assertions_1to1_unique/assertions_1ton_exact_unique creation is a WARN,
  // non-fatal condition (see the loop above and the §7 SKIP decision) — it
  // must not be re-promoted to a FAIL here. Only a genuinely-missing DDL
  // object (one that was never attempted, or attempted and NOT reported as a
  // non-fatal integrity-index failure) still fails init hard.
  const failedIndexNames = new Set(
    applyResult.integrityResults.filter((r) => !r.ok).map((r) => r.name)
  );
  const expectedObjects = { tables: [], columns: [], indexes: [] };
  for (const u of units) {
    const eo = (classification.manifest.units[u.basename] || {}).expected_objects || {};
    expectedObjects.tables.push(...(eo.tables || []));
    expectedObjects.columns.push(...(eo.columns || []));
    expectedObjects.indexes.push(...(eo.indexes || []).filter((i) => !failedIndexNames.has(i)));
  }
  const verify = await db.schemaObjectsExist(expectedObjects);
  if (!verify.ok) {
    await db.releaseSchemaApplyLock(initLockKey);
    await db.end();
    console.log(`  [FAIL]  Post-apply schema verification failed — missing objects:`);
    for (const m of verify.missing) console.log(`          - ${JSON.stringify(m)}`);
    unwindFsLedger();
    process.exit(1);
  }
  console.log(
    `  [OK]    Post-apply schema verification passed ` +
    `(${expectedObjects.tables.length} tables, ${expectedObjects.columns.length} columns, ${expectedObjects.indexes.length} indexes checked)`
  );
  await db.releaseSchemaApplyLock(initLockKey);

  // cm#185-schema-heal (S2): record schema_fingerprint now that the ungated
  // DDL is applied and verified — this is the "cmdInit never wrote
  // schema_fingerprint" gap that left every fresh/re-init project BEHIND on
  // its very first subsequent touch (status/resume/close would immediately
  // re-detect drift and re-run the whole apply sequence again). Shares only
  // the persistence PLUMBING (recordSchemaFingerprint — the literal INSERT)
  // with ensureSchemaCurrentCore's apply path; the pass/fail POLICY around
  // it stays entirely cmdInit's own (adversary finding #4/#8) — see the
  // gated-column FATAL block a few lines below, which is UNCHANGED from
  // before this fix.
  //
  // R-6 parity: mirrors ensureSchemaCurrentCore's own rule that the
  // fingerprint records "verified present", never "apply did not throw" —
  // skip the write when an integrity index failed to (re)create (the
  // legacy-duplicate-corpus WARN case above), exactly as the sentinel path
  // already refuses to upsert in that same condition.
  if (failedIndexNames.size === 0) {
    await recordSchemaFingerprint(db, projectId, currentFingerprint);
    console.log(`  [OK]    schema_fingerprint recorded (epoch ${SCHEMA_EPOCH})`);
  } else {
    console.log(`  [NOTE]  schema_fingerprint NOT recorded — an integrity index failed to (re)create (see WARN above); will retry apply on next touch`);
  }

  // ── init-embeddability spec extension table, row 2: "extension present,
  // gated columns still missing" → BLOCK if STILL missing after this run's
  // own apply. Since CREATE EXTENSION (above) runs BEFORE applyAdditiveSchema,
  // a normal re-init naturally re-creates any previously-skipped gated
  // column/index in the SAME pass — this check only fires for a genuine
  // schema-apply bug (extension confirmed present, yet the gated DDL still
  // didn't take), not for the ordinary "extension was just installed" path.
  //
  // cm#185-schema-heal (S2, adversary finding #4, BLOCKER): cmdInit KEEPS
  // its own fatal exit here — the touch path's non-fatal record-and-continue
  // policy is deliberately NOT imported into init. Only the degraded-row
  // PLUMBING (recordSchemaDegradation/clearSchemaDegradation, via
  // reportPgvectorGatedDegradation) is shared, so a re-init of an
  // already-marker'd project that still fails this check leaves `status`
  // showing the real, current state (S4) instead of silence.
  if (!effectiveNoEmbeddings && initDialect !== 'sqlite') {
    const gatedCheck = await checkPgvectorGatedObjects(db, classification.manifest, units);
    if (!gatedCheck.ok) {
      await reportPgvectorGatedDegradation(db, projectId, classification, units, {
        silent: true, applied: true, precomputedGated: gatedCheck,
      });
      await db.end();
      console.log(`  [FAIL]  pgvector extension is present but gated column(s)/index(es) are still missing after schema apply:`);
      for (const m of gatedCheck.missing) console.log(`          - ${m.table}.${m.column} (${m.unit})`);
      console.log(`          This indicates a genuine schema-apply defect, not a privilege/extension problem — investigate before re-running init.`);
      unwindFsLedger();
      process.exit(1);
    }
    // A prior touch's degraded row (e.g. pgvector installed after an
    // earlier init/apply left it gated-missing) is now resolved — clear it.
    await clearSchemaDegradation(db, projectId);
  }

  // Step 7.5: seed a default embedding_providers row, or record an explicit
  // embeddings opt-out. Deliberately lives HERE — inside cmdInit only,
  // never inside ensureSchemaCurrent's drift-apply path — so it runs
  // exactly once per fresh init (idempotent re-init is a DO-NOTHING no-op)
  // and never as a side effect of an unrelated drift-detection check.
  //
  // Total classification (init changes item 2 — replaces the old
  // NONE/INVALID/REMOTE "NOTE, continue" behavior with BLOCK):
  //   effectiveNoEmbeddings          → stamp/preserve project_settings.embeddings_opt_out; PROCEED.
  //   seedLocalEmbeddingProvider seeds (LOCAL, or REMOTE+--allow-remote-embed) → PROCEED.
  //   seedLocalEmbeddingProvider does NOT seed (NONE/INVALID/REMOTE-without-allow) → BLOCK, exit 1.
  if (clearOptOutFlag) {
    try {
      await db.query(`DELETE FROM project_settings WHERE project_id = $1 AND key = 'embeddings_opt_out'`, [projectId]);
      console.log(`  [OK]    cleared prior embeddings_opt_out (if any)`);
    } catch (clearErr) {
      console.log(`  [NOTE]  could not clear embeddings_opt_out (non-fatal): ${clearErr.message}`);
    }
  }

  if (effectiveNoEmbeddings) {
    if (noEmbeddingsFlag) {
      // Explicit --no-embeddings this run — stamp/refresh the opt-out record.
      try {
        await db.query(
          `INSERT INTO project_settings (project_id, key, value) VALUES ($1, 'embeddings_opt_out', $2)
           ON CONFLICT (project_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [projectId, JSON.stringify({ reason: 'operator', stamp: new Date().toISOString() })]
        );
        console.log(`  [NOTE]  embeddings opted out (--no-embeddings) — project_settings.embeddings_opt_out stamped`);
      } catch (optErr) {
        console.log(`  [NOTE]  could not stamp embeddings_opt_out (non-fatal): ${optErr.message}`);
      }
    }
    // else: the persisted-opt-out-honored branch already printed its own
    // NOTE line above, before the confirm gate — nothing further to do here.
  } else {
    const seedResult = await seedLocalEmbeddingProvider({ db, projectRoot: root, allowRemoteEmbed });
    for (const line of seedResult.lines) console.log(line);
    // alreadyPresent (a default provider already exists — same name or a
    // different one) is a benign idempotent no-op, NEVER a BLOCK-worthy
    // failure — only NONE/INVALID/REMOTE-without-allow BLOCK.
    if (!seedResult.seeded && !seedResult.alreadyPresent) {
      await db.end();
      console.log(`  [FAIL]  no default embedding provider could be seeded — see NOTE(s) above.`);
      console.log(`          Configure an endpoint (pipeline.yml/env/~/.claude/handoff-embed.json), pass --allow-remote-embed for a` +
        ` remote endpoint, or pass --no-embeddings to proceed without embedding capability.`);
      unwindFsLedger();
      process.exit(1);
    }
  }

  // Step 8: Insert default project_settings rows (idempotent)
  const defaults = {
    staleness_days:                   '7',
    loader_token_budget:              '4000',
    // L2: corroboration-quality gate mode. 'enforce' (default) withholds consolidation
    // when no independently-trustworthy corroborator exists. 'report' logs but does not
    // block. ON CONFLICT DO NOTHING ensures existing rows are never overridden on re-init.
    consolidation_gate_mode:          'enforce',
    // Resurrect query type: token sub-budget for the ### Resurrected section.
    // Enforced as min(globalRemaining, resurrect_token_budget) so the loader-wide
    // envelope is never exceeded.
    resurrect_token_budget:           '1500',
    // Resurrect semantic seed: cosine similarity threshold for the vLLM embedding path.
    // Range [0, 1]; 0.75 requires a strong semantic match before a subject is considered
    // a candidate. Lowering increases recall; raising increases precision.
    resurrect_cosine_threshold:       '0.75',
    implicit_close:                   'enabled',
    // S3: SessionStart late-close sweep liveness threshold — a sibling session's
    // marker older than this is judged abandoned (process killed before its own
    // SessionEnd could fire) and gets a late implicit close + a DIVERGENCE note.
    // A marker younger than this is assumed to belong to a still-live sibling
    // session and is left untouched.
    implicit_close_stale_hours:       '24',
    decay_rate_default:               '0.05',
    retrieval_outcome_timeout_days:   '14',
    cluster_aware_retrieval:          'enabled',
    cluster_max_siblings:             '10',
    // Graph edge traversal retrieval (opt-in via contract kind:'graph', default OFF-by-contract).
    // When graph_retrieval_enabled='disabled', the branch is a no-op even with a graph query
    // in the contract. Default contract has no graph query — byte-identical to pre-feature.
    graph_retrieval_enabled:          'enabled',
    graph_max_depth:                  '2',
    graph_max_nodes:                  '25',
    // C2: outcome→ranking+decay feedback loop (default ON as of PR-B).
    // When explicitly set to any value other than 'enabled', gate-OFF SQL remains
    // byte-identical in structure (no outcome_bias term); see I-6 in the spec.
    feedback_loop_enabled:            'enabled',
    feedback_success_delta:           '0.5',   // bias nudge per success outcome
    feedback_failure_delta:           '-0.75', // bias nudge per failure outcome
    feedback_irrelevant_delta:        '-0.25', // bias nudge per irrelevant outcome (smaller penalty)
    feedback_bias_clamp:              '3.0',   // max absolute value of outcome_bias ∈ [-clamp, +clamp]
    // C3: auto-evolve retrieval_contract from retrieval_events outcome patterns (default OFF).
    // Fully independent of feedback_loop_enabled — evolution can be evaluated even when bias
    // feedback is disabled (uses only retrieval_events.outcome, not assertions.outcome_bias).
    // When 'disabled', zero contract mutation occurs — cmdClose output byte-identical to pre-C3.
    contract_evolution_enabled:       'disabled',
    contract_evolution_window_days:   '30',    // rolling window for outcome aggregation
    contract_evolution_min_events:    '10',    // minimum events per kind before any rule fires
    contract_evolution_failure_threshold: '0.5', // failure+irrelevant rate that triggers budget reduction
    contract_evolution_budget_floor:  '200',   // minimum token_budget for any kind (never reduced below)
    contract_evolution_budget_step:   '200',   // max budget change per evolution pass (gradual, bounded)
    // Async extraction queue (opt-in, default OFF — byte-identical to synchronous write when disabled).
    // When 'true', cmdClose and cmdCheckpoint enqueue the payload for the deterministic
    // background worker (queue-drain subcommand) instead of writing synchronously.
    extraction_async_enabled:         'false',
    // Predicate registry enforcement mode (default 'permissive' — unrecognized predicates
    // are flagged via stderr warning but still written; 'strict' skips them).
    predicate_registry_mode:          'permissive',
  };
  for (const [key, val] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO project_settings (project_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, key, val]
    );
  }
  console.log(`  [OK]    project_settings defaults ensured (${Object.keys(defaults).length} keys, idempotent)`);

  // Step 9: Insert default retrieval_contract row (DO NOTHING keeps it idempotent)
  await db.query(
    `INSERT INTO retrieval_contract (project_id, name, queries, updated_at)
     VALUES ($1, 'default', $2::jsonb, now())
     ON CONFLICT (project_id, name) DO NOTHING`,
    [projectId, JSON.stringify({ queries: [] })]
  );
  console.log(`  [OK]    retrieval_contract 'default' row ensured`);

  // Idempotently ensure a v1 baseline history row exists (non-fatal).
  // If the project is brand new, the DO NOTHING above just inserted v1 and there
  // is no history row yet. If init is re-run, DO NOTHING above is a no-op and a
  // baseline row may already exist — we guard with a COUNT check.
  try {
    const { rows: hRows } = await db.query(
      `SELECT COUNT(*) AS n FROM retrieval_contract_history
       WHERE project_id = $1 AND name = 'default'`,
      [projectId]
    );
    if (parseInt(hRows[0].n, 10) === 0) {
      // Fetch the contract's current version and queries for the baseline row.
      const { rows: rcRows } = await db.query(
        `SELECT version, queries FROM retrieval_contract WHERE project_id = $1 AND name = 'default'`,
        [projectId]
      );
      if (rcRows.length > 0) {
        await db.query(
          `INSERT INTO retrieval_contract_history (project_id, name, version, queries, change_note)
           VALUES ($1, 'default', $2, $3::jsonb, 'init baseline')`,
          [projectId, rcRows[0].version, JSON.stringify(rcRows[0].queries)]
        );
      }
    }
    console.log(`  [OK]    retrieval_contract_history baseline ensured (idempotent)`);
  } catch (histErr) {
    console.log(`  [WARN]  retrieval_contract_history baseline failed (non-fatal): ${histErr.message}`);
  }

  await db.end();

  // ── FS writes — begin post-DB phase (ledger-tracked for atomicity) ─────────

  // Step 10: Write handoff.md (only if all DB steps succeeded)
  if (fs.existsSync(handoffPath)) {
    console.log(`  [OK]    handoff.md already exists — skipped: ${handoffPath}`);
  } else {
    try {
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      writeHandoffMd(handoffPath, {
        PROJECT_ID:          projectId,
        LAST_CLOSE:          new Date().toISOString(),
        CONTRACT:            'default',
        ENTITIES_WRITTEN:    '0',
        ASSERTIONS_WRITTEN:  '0',
        EDGES_WRITTEN:       '0',
        PROJECT_NAME:        path.basename(root),
        TLDR:                '(init — no sessions closed yet)',
        OPEN_THREADS:        '- (none)',
        QUICK_REFERENCES:    '(none)',
        DEGRADED_SECTION:    '',
        RECONCILIATION_SECTION: '',
      });
      fsLedger.push(handoffPath);
      console.log(`  [OK]    handoff.md created: ${handoffPath}`);
    } catch (err) {
      console.log(`  [FAIL]  Could not write handoff.md — ${err.message}`);
      unwindFsLedger();
      process.exit(1);
    }
  }

  // Step 11: Write the durable-facts promotion file (only if all DB steps
  // succeeded). Host AND filename are resolved TOGETHER via
  // resolvePromotionTarget() (scripts/lib/claude-md-key-paths.js) — the
  // single shared classification of the (HANDOFF_HOST, HANDOFF_PROMOTION_FILE)
  // env pair. Host resolution: env HANDOFF_HOST wins if set (must be 'claude'
  // or 'codex'); otherwise inferred from the promotion filename's basename
  // ('AGENTS.md', case-insensitively -> codex, everything else -> claude).
  // The resolved host then supplies the filename DEFAULT (CLAUDE.md vs
  // AGENTS.md) used only when HANDOFF_PROMOTION_FILE is unset — this is what
  // fixes the prior bug where HANDOFF_HOST=codex with HANDOFF_PROMOTION_FILE
  // unset still resolved the path to CLAUDE.md while selecting the AGENTS.md
  // template, writing AGENTS-flavored content into a file named CLAUDE.md.
  // Host also selects which template renders a FRESH file, and gates the
  // find-and-replace-copy warning below — it never changes
  // healKeyPathsSection()'s behavior, which stays host-agnostic (it heals
  // whichever file is actually there).
  const promotionTargetResult = resolvePromotionTarget(root, process.env);
  if (!promotionTargetResult.ok) {
    console.log(`  [FAIL]  ${promotionTargetResult.reason}`);
    unwindFsLedger();
    process.exit(2);
  }
  if (promotionTargetResult.warning) {
    process.stderr.write(promotionTargetResult.warning + '\n');
  }
  const claudeMdPath = promotionTargetResult.filePath;
  const promotionFilename = promotionTargetResult.filename;
  const promotionHost = promotionTargetResult.host;
  const promotionTemplate = promotionHost === 'codex' ? PROJECT_AGENTS_MD_TEMPLATE : PROJECT_CLAUDE_MD_TEMPLATE;
  const forcePromotion = args.includes('--force-promotion');

  // Project display name — resolved via the SAME shared resolver
  // cmdPromoteRegenerate uses (resolveProjectDisplayName,
  // scripts/lib/claude-md-key-paths.js), instead of falling back to
  // `path.basename(root)` locally (the PR #290 bug: a worktree checkout's
  // disposable directory name leaked into a fresh CLAUDE.md's H1).
  // `existingFileContent` is passed only for the --force-promotion
  // regenerate branch below, where a prior file's H1 (N1) can be reused;
  // the brand-new-file branch has no prior content, so N1 naturally falls
  // through to N2/N3.
  function writeFreshPromotionFile(existingFileContent) {
    const explicitName = args.find((a) => !a.startsWith('-'));
    const nameResolution = resolveProjectDisplayName({ root, explicitName, existingFileContent });
    return renderFreshPromotionContent({ root, projectName: nameResolution.name, promotionTemplate, host: promotionHost, env: process.env });
  }

  if (fs.existsSync(claudeMdPath)) {
    const existingContent = fs.readFileSync(claudeMdPath, 'utf8');

    // --force-promotion: unconditional backup + regenerate, bypassing the
    // heal-on-touch path entirely. Intended for the specific known-bad shape
    // a hand-made find-and-replace copy left behind (see
    // looksLikeFindReplaceCopy), but not gated on that detection — an
    // explicit --force-promotion is honored regardless of why it was given.
    if (forcePromotion) {
      try {
        const backupPath = `${claudeMdPath}.bak-${Date.now()}-${process.hrtime.bigint()}-${process.pid}`;
        fs.copyFileSync(claudeMdPath, backupPath);
        const content = writeFreshPromotionFile(existingContent);
        const tmpPath = `${claudeMdPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, claudeMdPath);
        console.log(`  [OK]    ${promotionFilename} regenerated via --force-promotion (backup: ${backupPath}): ${claudeMdPath}`);
      } catch (err) {
        console.log(`  [FAIL]  Could not regenerate ${promotionFilename} via --force-promotion — ${err.message}`);
        unwindFsLedger();
        process.exit(1);
      }
    } else {
      if (looksLikeFindReplaceCopy(existingContent)) {
        process.stderr.write(
          `handoff: ${promotionFilename} looks like a find-and-replace copy of a Claude template ` +
          `(contains "~/.Codex/" or "# Codex-memory") — re-run \`init\` with --force-promotion to regenerate it ` +
          `from the correct template (a backup is made first).\n`
        );
      }
      // heal-on-touch: heal a legacy/absolute "## Key paths" section on touch, rather
      // than a bare skip. Total classification in healKeyPathsSection() — only
      // the 'healed' outcome writes; every other outcome leaves the file as-is
      // (with a diagnostic note on stderr for 'ambiguous'/'unrecognized').
      try {
        const healResult = healKeyPathsSection(existingContent, process.env);
        for (const note of healResult.notes) {
          process.stderr.write(`handoff: ${promotionFilename} Key paths: ${note}\n`);
        }
        if (healResult.outcome === 'healed') {
          const tmpPath = `${claudeMdPath}.tmp-${process.pid}`;
          fs.writeFileSync(tmpPath, healResult.text, 'utf8');
          fs.renameSync(tmpPath, claudeMdPath);
          console.log(`  [OK]    ${promotionFilename} already exists — healed absolute Key paths bullet(s): ${claudeMdPath}`);
        } else {
          console.log(`  [OK]    ${promotionFilename} already exists — skipped (Key paths: ${healResult.outcome}): ${claudeMdPath}`);
        }
      } catch (err) {
        console.log(`  [WARN]  ${promotionFilename} Key paths heal check failed (non-fatal): ${err.message}`);
      }
    }
  } else {
    try {
      const content = writeFreshPromotionFile();
      fs.writeFileSync(claudeMdPath, content, 'utf8');
      fsLedger.push(claudeMdPath);
      console.log(`  [OK]    ${promotionFilename} created: ${claudeMdPath}`);
      console.log(`  [NOTE]  ${promotionFilename} should be git-committed.`);
    } catch (err) {
      console.log(`  [FAIL]  Could not write ${promotionFilename} — ${err.message}`);
      unwindFsLedger();
      process.exit(1);
    }
  }

  // Step 12 (LAST): Persist the deferred project marker.
  // Only reached after ALL DB operations and ALL other FS writes succeed.
  // A failure here is extremely unlikely (directory exists, disk not full) but
  // we unwind the other FS writes to leave the project in a clean state.
  if (markerDeferred) {
    try {
      persistMarker(root, projectId);
      fsLedger.push(path.join(root, MARKER_FILENAME));
      console.log(`  [OK]    project marker written: uuid=${projectId}`);
    } catch (err) {
      console.log(`  [FAIL]  Could not persist project marker — ${err.message}`);
      // Remove handoff.md and the promotion file written above (marker not in ledger yet).
      unwindFsLedger();
      process.exit(1);
    }
  }

  // Multi-author detection — inform once per invocation; no behavior change today.
  const authorCount = detectMultiAuthor(root);
  if (authorCount > 1) {
    // Re-open DB to persist the flag (init already closed db above).
    try {
      const flagCfg = loadConfig();
      const { Client } = require('pg');
      const flagDb = new Client({
        host: flagCfg.host, port: flagCfg.port,
        database: TARGET_DB, user: flagCfg.user,
      });
      await flagDb.connect();
      await setSetting(flagDb, projectId, 'multi_author_detected', 'true');
      await flagDb.end();
    } catch (_) { /* non-fatal */ }
    process.stderr.write(
      `[handoff] multi-author repo detected — see README#trust-model before relying on ${promotionFilename} auto-promotion\n`
    );
  }

  console.log(`\nDone: handoff:init — project ${projectId} provisioned`);
}

// ── live-row count helper (cm#232) ──────────────────────────────────────────
//
// Single source of truth for what "live" means per table, so status/close/
// checkpoint can never report divergent numbers for the same underlying data.
// entities/edges carry only `suppressed` (no bi-temporal column); assertions
// additionally carry `invalid_at` (bi-temporal supersession — see
// handoff-core-schema.sql). The live predicate mirrors the one already used
// throughout writeAssertionWithSupersession/persistSessionIntent/the resurrect
// engine: `suppressed = false AND invalid_at IS NULL`.
//
// Before this fix, handoff:status's `assertions` count was a raw
// `COUNT(*) FROM assertions` with no suppressed/invalid_at filter at all —
// it counted every row ever written for the project, suppressed or not,
// inflating the reported live count (evidence: pwa-etl reported 30 after
// 4 suppressions + 3 adds when the live count was 26). entities/edges had
// the identical unfiltered-COUNT(*) bug (no `suppressed = false` filter).
const ASSERTIONS_LIVE_SQL = 'suppressed = false AND invalid_at IS NULL';

async function getLiveCounts(db, projectId) {
  const entRes = await db.query(
    'SELECT COUNT(*) AS n FROM entities WHERE project_id = $1 AND suppressed = false',
    [projectId]
  );
  const edgRes = await db.query(
    'SELECT COUNT(*) AS n FROM edges WHERE project_id = $1 AND suppressed = false',
    [projectId]
  );
  const assLiveRes = await db.query(
    `SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND ${ASSERTIONS_LIVE_SQL}`,
    [projectId]
  );
  const assSuppRes = await db.query(
    'SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = true',
    [projectId]
  );
  const assInvOnlyRes = await db.query(
    'SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1 AND suppressed = false AND invalid_at IS NOT NULL',
    [projectId]
  );
  const assTotalRes = await db.query(
    'SELECT COUNT(*) AS n FROM assertions WHERE project_id = $1',
    [projectId]
  );

  return {
    entities:                  parseInt(entRes.rows[0].n, 10),
    edges:                     parseInt(edgRes.rows[0].n, 10),
    assertionsLive:            parseInt(assLiveRes.rows[0].n, 10),
    assertionsSuppressed:      parseInt(assSuppRes.rows[0].n, 10),
    assertionsInvalidatedOnly: parseInt(assInvOnlyRes.rows[0].n, 10),
    assertionsTotal:           parseInt(assTotalRes.rows[0].n, 10),
  };
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(args = []) {
  console.log('Running: handoff:status');

  const jsonFlag      = args.includes('--json');
  const breakdownFlag = args.includes('--breakdown');
  const staleFlag     = args.includes('--stale-pointers');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const fm          = readHandoffFrontmatter(handoffPath);
  const root        = findProjectRoot();
  // cm#232: human-readable project name, distinct from the marker uuid
  // (projectId) — surfaced so a status/close summary read out of context
  // (e.g. pasted into chat) can't be misread as belonging to another project.
  const projectName = path.basename(root);

  // cm(status-host-fields): host + promotion_file — SAME shared resolver
  // cmdInit/cmdPromote/cmdClose use (resolvePromotionTarget,
  // scripts/lib/claude-md-key-paths.js), so status can never report a value
  // that disagrees with what promote/close actually targeted. Note: unlike
  // cmdLoaderStop, promote/cmdPromote never parse a --host argv flag at
  // all — resolvePromotionTarget reads HANDOFF_HOST/HANDOFF_PROMOTION_FILE
  // from process.env only — so status deliberately does the same rather
  // than inventing a --host flag promote itself doesn't accept.
  // Non-fatal: an unresolvable pair (e.g. HANDOFF_HOST set to an invalid
  // value) surfaces as null fields + a stderr note, never a crash — status
  // stays read-only and always prints the rest of the report.
  let statusHost = null;
  let statusPromotionFile = null;
  try {
    const promotionTargetResult = resolvePromotionTarget(root, process.env);
    if (promotionTargetResult.ok) {
      statusHost = promotionTargetResult.host;
      statusPromotionFile = promotionTargetResult.filePath;
      if (promotionTargetResult.warning) {
        process.stderr.write(promotionTargetResult.warning + '\n');
      }
    } else {
      process.stderr.write(`handoff status: host/promotion_file unresolved — ${promotionTargetResult.reason}\n`);
    }
  } catch (err) {
    process.stderr.write(`handoff status: host/promotion_file resolution failed (non-fatal): ${err.message}\n`);
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // cm#185-schema-heal (S3): heal BEFORE classifying anything else this
  // command reports — a fingerprint-current DB missing an ungated/gated
  // object (S1) is fixed here, so every count/readiness value below already
  // reflects the healed state rather than a stale one status would then
  // have to explain away.
  //
  // PR #262 perf follow-up: NO pre-heal SELECT here — that was a redundant
  // extra round trip on every status call. "What did this call heal" is
  // instead derived entirely from schemaHealResult's own return value
  // (clearSchemaDegradation's rowCount-derived `detail.healedDegradedRow`,
  // or `reason === 'applied'`) plus the ALREADY-NEEDED post-heal
  // schema_apply_degraded read below (existing R-5 display feature, not new).
  let schemaHealResult = null;
  try {
    schemaHealResult = await ensureSchemaCurrent(db, projectId, { silent: true });
  } catch (schemaHealErr) {
    process.stderr.write('[handoff] schema heal check failed (non-fatal): ' + schemaHealErr.message + '\n');
  }

  // Counts — cm#232: getLiveCounts is the single shared query behind every
  // entity/assertion/edge count status reports (prose, --json, and the Done
  // line all derive from this one call — see getLiveCounts above).
  const liveCounts = await getLiveCounts(db, projectId);
  const rcRes  = await db.query('SELECT name        FROM retrieval_contract  WHERE project_id = $1 ORDER BY name', [projectId]);

  // Session-in-progress marker(s) — S3 per-session format; see getSessionMarkers.
  const sessionMarkers = await getSessionMarkers(db, projectId);

  // ── --breakdown: counts by tier and suppression ──────────────────────────
  let breakdown = null;
  if (breakdownFlag) {
    // Tier counts (probationary vs consolidated vs null/grandfathered).
    // NULL tier rows are grandfathered (written before tier column existed); they
    // behave as consolidated in retrieval (see tier_aware_retrieval gate).
    const tierRes = await db.query(
      `SELECT COALESCE(tier, 'grandfathered') AS tier, COUNT(*) AS n
         FROM assertions WHERE project_id = $1
         GROUP BY tier
         ORDER BY tier`,
      [projectId]
    );

    // Suppressed vs live counts.
    const suppRes = await db.query(
      `SELECT suppressed, COALESCE(suppression_kind, 'none') AS kind, COUNT(*) AS n
         FROM assertions WHERE project_id = $1
         GROUP BY suppressed, suppression_kind
         ORDER BY suppressed, kind`,
      [projectId]
    );

    // Top-10 predicate distribution across LIVE assertions only.
    // cm#232: was suppressed=false only, missing invalid_at IS NULL — now uses
    // the same ASSERTIONS_LIVE_SQL predicate as getLiveCounts above.
    const predRes = await db.query(
      `SELECT predicate, COUNT(*) AS n
         FROM assertions WHERE project_id = $1 AND ${ASSERTIONS_LIVE_SQL}
         GROUP BY predicate
         ORDER BY n DESC
         LIMIT 10`,
      [projectId]
    );

    breakdown = {
      by_tier: tierRes.rows.reduce((acc, r) => {
        acc[r.tier] = parseInt(r.n, 10);
        return acc;
      }, {}),
      by_suppression: suppRes.rows.reduce((acc, r) => {
        const key = r.suppressed ? `suppressed(${r.kind})` : 'live';
        acc[key] = (acc[key] || 0) + parseInt(r.n, 10);
        return acc;
      }, {}),
      top_predicates: predRes.rows.map((r) => ({ predicate: r.predicate, count: parseInt(r.n, 10) })),
    };
  }

  // ── --stale-pointers: count assertions with unresolvable code pointers ───
  let stalePointerCount = null;
  if (staleFlag) {
    let statusRoot = null;
    try { statusRoot = findProjectRoot(); } catch (_) {}

    if (statusRoot) {
      // Fetch object text from all live assertions; scan each for pointer patterns.
      const ptrRes = await db.query(
        `SELECT id, object, subject, predicate
           FROM assertions
           WHERE project_id = $1 AND suppressed = false
           AND object IS NOT NULL`,
        [projectId]
      );

      let unresolved = 0;
      for (const row of ptrRes.rows) {
        const ptrs = _extractPointers(String(row.object));
        for (const pi of ptrs) {
          const absPath = _resolvePointerPath(statusRoot, pi.path);
          if (!absPath) {
            unresolved++;
          } else {
            try {
              const lines = fs.readFileSync(absPath, 'utf8').split('\n');
              const lineIdx = pi.startLine - 1;
              if (lineIdx < 0 || lineIdx >= lines.length || lines[lineIdx].trim().length === 0) {
                unresolved++;
              }
            } catch (_) {
              unresolved++;
            }
          }
        }
      }
      stalePointerCount = unresolved;
    }
  }

  // cm#185 R-5: surface a current schema_apply_degraded row, if any. This
  // read runs AFTER the heal call above, so it already reflects whatever
  // ensureSchemaCurrent just cleared/re-stamped/left behind.
  let schemaDegraded = null;
  try {
    const { rows: schemaDegRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_apply_degraded'`,
      [projectId]
    );
    if (schemaDegRows.length > 0) {
      try { schemaDegraded = JSON.parse(schemaDegRows[0].value); } catch (_) { schemaDegraded = { reason: 'unknown' }; }
    }
  } catch (_) {
    // Non-fatal — status still reports the rest even if this probe fails.
  }

  // cm#185-schema-heal (S3): what did the heal call above actually DO? Total
  // classification of the observable transition, for the "what it healed"
  // line — never a guess, only what schemaHealResult/schemaDegraded together
  // actually prove happened in THIS invocation. PR #262 perf follow-up: no
  // pre-heal read needed for any of these three branches —
  // clearSchemaDegradation's own rowCount-derived `healedDegradedRow` flag
  // (set only when a row genuinely existed to delete) replaces it; a
  // schemaDegraded row still present after ANY ensureSchemaCurrent call was
  // necessarily just (re-)written by THAT SAME call (S4: the gated check
  // always re-stamps fresh on every touch it reaches), so its mere
  // post-heal presence already proves "re-stamped just now", not merely
  // "left over from before".
  let schemaHealedLine = null;
  if (schemaHealResult && schemaHealResult.detail && schemaHealResult.detail.healedDegradedRow) {
    schemaHealedLine = 'HEALED — a prior schema_apply_degraded row was cleared';
  } else if (schemaHealResult && schemaHealResult.reason === 'applied') {
    const applied = (schemaHealResult.detail && schemaHealResult.detail.appliedUnits) || [];
    schemaHealedLine = `applied schema drift (${applied.join(', ') || 'no units listed'})`;
  } else if (schemaDegraded) {
    schemaHealedLine = 're-stamped (still degraded — see schema_apply line below)';
  }

  // init-embeddability spec (A3): loud, always-computed readiness state +
  // per-table NULL-embedding counts (printed only when nonzero).
  // cm#185-schema-heal (adversary finding #10): reuse the heal call's own
  // gated-objects verdict when it unambiguously implies one (never a guess —
  // see _gatedOkFromSchemaHealResult) instead of a second, independent
  // classifySchemaFiles + checkPgvectorGatedObjects round-trip for the same fact.
  let embeddingReadiness = 'UNEMBEDDABLE:no-extension';
  let embeddingNullCounts = { assertions: 0, decisions: 0 };
  try {
    embeddingReadiness = await computeEmbeddingReadiness(db, projectId, {
      precomputedGatedOk: _gatedOkFromSchemaHealResult(schemaHealResult),
    });
    embeddingNullCounts = await computeEmbeddingNullCounts(db, projectId);
  } catch (_) {
    // Non-fatal — status still reports the rest even if this probe fails.
  }

  // cm#embed-heal-on-touch (E3): surface the heal-on-touch step's own
  // record from THIS invocation's ensureSchemaCurrent call above (or a
  // prior touch's, if this touch's heal didn't run — e.g. schema wasn't
  // 'current'/'applied'). Total-classification outcome string, never a
  // guess: absent entirely means the heal step has never recorded anything
  // for this project (e.g. SQLite backend, or first touch after upgrade).
  let lastEmbedHeal = null;
  try {
    const rawHeal = await getSetting(db, projectId, 'last_embed_heal', null);
    if (rawHeal) lastEmbedHeal = JSON.parse(rawHeal);
  } catch (_) {
    // Non-fatal — status still reports the rest even if this probe fails.
  }

  // cm#263 (loader-stop verifiability): surface the last recorded SessionEnd
  // (loader-stop) outcome — the only persisted evidence that the hook ever
  // fired, since it otherwise only writes to stderr, which the harness
  // swallows.
  let lastLoaderStop = null;
  try {
    const lastLoaderStopRaw = await getSetting(db, projectId, 'last_loader_stop', null);
    if (lastLoaderStopRaw) lastLoaderStop = JSON.parse(lastLoaderStopRaw);
  } catch (_) {
    // Non-fatal — status still reports the rest even if this probe fails.
  }

  await db.end();

  const lastClose = fm.last_close || 'never';
  const days      = daysSince(fm.last_close);
  const daysStr   = days !== null ? `${days} day(s) ago` : 'N/A';
  const contracts = rcRes.rows.map((r) => r.name).join(', ') || '(none)';
  const sipDisplay = formatSessionMarkersForStatus(sessionMarkers);

  // Packaging-honesty probe (read-only — no DB writes).
  let packagingState = null;
  let packagingLine  = '';
  try {
    const statusRoot   = findProjectRoot();
    const packState    = detectUnpackagedState(statusRoot);
    packagingState = packState.unpackaged ? `UNPACKAGED (${packState.label})` : 'clean';
    packagingLine = packState.unpackaged
      ? `  packaging:        UNPACKAGED (${packState.label})`
      : `  packaging:        clean`;
  } catch (_) {
    // Non-fatal — skip display if probe fails for any unexpected reason.
  }

  // ── JSON output path ────────────────────────────────────────────────────
  if (jsonFlag) {
    const out = {
      project_id:     projectId,
      project_name:   projectName,
      host:           statusHost,
      promotion_file: statusPromotionFile,
      db:             'connected',
      handoff_md:     fs.existsSync(handoffPath) ? handoffPath : null,
      last_close:     lastClose,
      days_since:     days,
      entities:       liveCounts.entities,
      assertions:     liveCounts.assertionsLive,
      assertions_suppressed: liveCounts.assertionsSuppressed,
      assertions_invalidated: liveCounts.assertionsInvalidatedOnly,
      assertions_total: liveCounts.assertionsTotal,
      edges:          liveCounts.edges,
      contracts:      rcRes.rows.map((r) => r.name),
      session_active: sipDisplay.active,
      session_id:     sipDisplay.id,
      packaging:      packagingState,
      schema_heal:    schemaHealedLine,
      schema_apply_degraded: schemaDegraded,
      embedding_readiness: embeddingReadiness,
      embedding_null_counts: { assertions: embeddingNullCounts.assertions, decisions: embeddingNullCounts.decisions },
      // E2: aggregate LIVE+actionable backlog (the same n the classifier's
      // HEALING(n) state carries) and the empty-text carve-out — --json only,
      // per spec; empty-text NULLs never block READY and never count toward n.
      backlog: embeddingNullCounts.assertions + embeddingNullCounts.decisions,
      unembeddable_empty_text: (embeddingNullCounts.unembeddableEmptyText.assertions || 0) + (embeddingNullCounts.unembeddableEmptyText.decisions || 0),
      last_embed_heal: lastEmbedHeal,
      last_loader_stop: lastLoaderStop,
    };
    if (breakdownFlag && breakdown !== null) {
      out.breakdown = breakdown;
    }
    if (staleFlag && stalePointerCount !== null) {
      out.stale_pointer_count = stalePointerCount;
    }
    console.log(JSON.stringify(out, null, 2));
    console.log(`\nDone: handoff:status — project=${projectName} marker=${projectId} — ${out.entities} entities, ${out.assertions} assertions (suppressed: ${out.assertions_suppressed}, invalidated: ${out.assertions_invalidated}), ${out.edges} edges`);
    return;
  }

  // ── Prose output path (default) ─────────────────────────────────────────
  console.log('\n  === handoff status ===');
  console.log(`  project_name:     ${projectName}`);
  console.log(`  project_id:       ${projectId}`);
  console.log(`  host:             ${statusHost || '(unresolved)'}`);
  console.log(`  promotion_file:   ${statusPromotionFile || '(unresolved)'}`);
  console.log(`  last_close:       ${lastClose} (${daysStr})`);
  console.log(`  handoff.md:       ${fs.existsSync(handoffPath) ? handoffPath : '(missing)'}`);
  console.log(`  entities:         ${liveCounts.entities}`);
  console.log(`  assertions:       ${liveCounts.assertionsLive} (suppressed: ${liveCounts.assertionsSuppressed}, invalidated: ${liveCounts.assertionsInvalidatedOnly})`);
  console.log(`  edges:            ${liveCounts.edges}`);
  console.log(`  contracts:        ${contracts}`);
  console.log(`  session_active:   ${sipDisplay.prose}`);
  console.log(`  last SessionEnd (loader-stop): ${lastLoaderStop ? `${lastLoaderStop.ts} ${lastLoaderStop.outcome}${lastLoaderStop.session_id ? ` [session ${lastLoaderStop.session_id}]` : ''}` : 'never'}`);
  if (packagingLine) console.log(packagingLine);
  if (schemaHealedLine) {
    console.log(`  schema_heal:      ${schemaHealedLine}`);
  }
  if (schemaDegraded) {
    console.log(`  schema_apply:     DEGRADED (${schemaDegraded.reason || 'unknown'}) — see detail: ${JSON.stringify(schemaDegraded.detail)}`);
  }
  // E3: render the classifier's return verbatim — no per-surface
  // re-derivation. A nonzero backlog is already surfaced as its own
  // HEALING(n) state by computeEmbeddingReadiness itself (never a bare
  // "READY (backlog N)" print-time override — that was PR #269's design,
  // now superseded: HEALING(n) carries the same information as a real
  // classifier state, not a prose annotation bolted onto READY).
  console.log(`  embedding:        ${embeddingReadiness}`);
  if (embeddingNullCounts.assertions > 0 || embeddingNullCounts.decisions > 0) {
    console.log(`  embedding NULLs:  assertions=${embeddingNullCounts.assertions}, decisions=${embeddingNullCounts.decisions}`);
  }
  if (lastEmbedHeal && (lastEmbedHeal.embedded > 0 || lastEmbedHeal.outcome === 'partial')) {
    console.log(`  embedding heal:   embedded ${lastEmbedHeal.embedded}, remaining ${lastEmbedHeal.remaining != null ? lastEmbedHeal.remaining : '?'} (${lastEmbedHeal.outcome})`);
  }

  if (breakdownFlag && breakdown !== null) {
    console.log('\n  --- breakdown ---');
    console.log('  by tier:');
    for (const [tier, n] of Object.entries(breakdown.by_tier)) {
      console.log(`    ${tier}: ${n}`);
    }
    console.log('  by suppression:');
    for (const [key, n] of Object.entries(breakdown.by_suppression)) {
      console.log(`    ${key}: ${n}`);
    }
    console.log('  top predicates (live assertions):');
    for (const { predicate, count } of breakdown.top_predicates) {
      console.log(`    ${predicate}: ${count}`);
    }
  }

  if (staleFlag) {
    if (stalePointerCount !== null) {
      console.log(`\n  stale pointers:   ${stalePointerCount}`);
    } else {
      console.log('\n  stale pointers:   (could not resolve project root)');
    }
  }

  console.log(`\nDone: handoff:status — project=${projectName} marker=${projectId} — ${liveCounts.entities} entities, ${liveCounts.assertionsLive} assertions (suppressed: ${liveCounts.assertionsSuppressed}, invalidated: ${liveCounts.assertionsInvalidatedOnly}), ${liveCounts.edges} edges`);
}

// ── runResurrectQuery — shared resurrect engine ───────────────────────────────

/**
 * Execute the resurrect query logic: seed resolution, fuzzy-match fallback,
 * depth-2 graph fan-out, M2 trusted-anchor gate, eligible-row fetch, optional
 * revival mutation.
 *
 * Called from BOTH the loader's contract-driven 'resurrect' branch AND from
 * cmdResurrect (slash command). The loader path supplies tokenBudget from its
 * sub-budget calculation; cmdResurrect passes Infinity (no budget limit for CLI).
 *
 * @param {object} db              Connected StoragePort adapter.
 * @param {string} projectId       Project UUID / encoded-cwd.
 * @param {object} q               Query object: { type?, seed?, revive?, limit? }
 * @param {object} opts
 * @param {boolean} [opts.silent=false]      Suppress non-fatal console.error lines.
 * @param {number}  [opts.tokenBudget]       Token ceiling for the output section. Default Infinity.
 * @returns {Promise<{
 *   sectionText: string|null,    Section markdown string, or null if nothing to emit.
 *   revivedRows:  number,        Count of eligible rows (for assertionsCount tracking).
 *   revivedIds:   number[],      IDs of rows un-suppressed (empty unless revive was applied).
 *   candidateCount: number,      Candidate subject count after seed resolution.
 * }>}
 */
async function runResurrectQuery(db, projectId, q, opts = {}) {
  const silent      = opts.silent === true;
  const tokenBudget = (opts.tokenBudget != null && isFinite(opts.tokenBudget))
    ? opts.tokenBudget
    : Infinity;
  // Serve-time reality re-probe option: when serveTimeRcEnabled='enabled', the
  // caller may pass opts.serveRoot (the project root path) so that the resurrect
  // path also annotates its served rows with [STALE:] / [verified✓].
  // Matches the annotation logic in cmdLoaderLoad's post-loop pass.
  const serveRoot           = opts.serveRoot || null;
  const serveTimeRcEnabled  = opts.serveTimeRcEnabled || 'disabled';

  const seedText   = (q.seed || q.query || '').trim();
  const reviveOpt  = q.revive === true;
  const fuzzyLimit = typeof q.limit === 'number' && q.limit > 0 ? q.limit : 20;

  // Tracks whether the ### Resurrected section was actually emitted.
  // Step 6 (revival DB mutation) MUST NOT run unless this is true.
  let resurrectEmitted = false;

  // ── Step 1: Resolve candidate subjects via semantic or fuzzy seed ──────────
  let candidateSubjects = [];
  const embedSkip = (process.env.EMBED_SKIP === '1');

  if (!embedSkip && seedText) {
    // Semantic seed — embed the query via vLLM and run a cosine ANN search
    // directly on assertions.embedding (halfvec 4000, Qwen/Qwen3-Embedding-8B).
    // This is the primary path; pg_trgm fuzzy is the fallback below.
    // On any embed error, we log a non-fatal warning and fall through to fuzzy.
    const cosineThreshold = parseFloat(
      await getSetting(db, projectId, 'resurrect_cosine_threshold', '0.75')
    );
    try {
      const vec = await embedQuery(seedText);
      // Bind embedding as a halfvec literal string that pgvector accepts.
      const vecLiteral = '[' + vec.join(',') + ']';
      const { rows: semRows } = await db.query(
        `SELECT DISTINCT subject
         FROM (
           SELECT subject, (embedding <=> $2::halfvec) AS dist
           FROM assertions
           WHERE project_id = $1
             AND embedding IS NOT NULL
             AND 1 - (embedding <=> $2::halfvec) >= $3
           ORDER BY dist ASC
           LIMIT $4
         ) sub`,
        [projectId, vecLiteral, cosineThreshold, fuzzyLimit]
      );
      for (const r of semRows) {
        if (r.subject && !candidateSubjects.includes(r.subject)) {
          candidateSubjects.push(r.subject);
        }
      }
    } catch (embedErr) {
      if (!silent) {
        process.stderr.write(
          `[handoff] resurrect semantic seed degraded: ${embedErr.message}\n`
        );
      }
      // candidateSubjects remains empty → falls through to pg_trgm fuzzy below.
    }
  }

  // Fuzzy fallback (runs when embedSkip=1, semantic unavailable, or semantic returned empty).
  if (candidateSubjects.length === 0 && seedText) {
    const { sql: fuzzySql, params: fuzzyParams } = db.buildFuzzyMatch(
      projectId, seedText, fuzzyLimit
    );
    try {
      const { rows: fuzzyRows } = await db.query(fuzzySql, fuzzyParams);
      for (const r of fuzzyRows) {
        if (r.subject && !candidateSubjects.includes(r.subject)) {
          candidateSubjects.push(r.subject);
        }
      }
    } catch (fuzzyErr) {
      // pg_trgm may be absent — degrade to empty candidate set (no resurrect section).
      if (!silent) console.error(`[handoff] resurrect fuzzy-match error (non-fatal): ${fuzzyErr.message}`);
    }
  }

  // If still no candidates (and a seed was provided), use all subjects with
  // resurrect-eligible rows (bounded). Gated on seedText so that a whitespace-only
  // or absent seed does not trigger an unconstrained fallback fetch of all probation
  // subjects — that would bypass the empty-seed guard at Step 6.
  if (candidateSubjects.length === 0 && seedText) {
    const { rows: allSubj } = await db.query(
      `SELECT DISTINCT subject FROM assertions
       WHERE project_id = $1
         AND suppressed = true
         AND suppression_kind = 'downvoted_probation'
       LIMIT $2`,
      [projectId, fuzzyLimit]
    );
    candidateSubjects = allSubj.map((r) => r.subject);
  }

  const candidateCount = candidateSubjects.length;

  // ── Step 2: Depth-2 graph fan-out from candidate subjects ────────────────
  if (candidateSubjects.length > 0) {
    try {
      const graphMaxDepth = 2;
      const graphMaxNodes = parseInt(
        await getSetting(db, projectId, 'graph_max_nodes', '25'), 10
      );
      const { sql: cteSql, params: cteParams } = db.buildGraphCTE(
        'out', candidateSubjects, graphMaxDepth, graphMaxNodes, projectId
      );
      const { rows: fanOutRows } = await db.query(cteSql, cteParams);
      for (const r of fanOutRows) {
        if (r.entity_name && !candidateSubjects.includes(r.entity_name)) {
          candidateSubjects.push(r.entity_name);
        }
      }
    } catch (_fanErr) {
      // Non-fatal — proceed with the seed subjects only.
    }
  }

  // ── Step 3: Filter by M2 seed-gate (trusted anchor required) ─────────────
  // Only resurrect assertions whose subject has at least one trusted anchor:
  //   reality_check='verified' OR pinned=true  (the L2 hasQualityCorroborator predicate).
  let trustedSubjects = [];
  if (candidateSubjects.length > 0) {
    const { clause: tsClauses, params: tsContainsParams } =
      db.buildArrayContains('subject', candidateSubjects, 2);
    const { rows: trustedRows } = await db.query(
      `SELECT DISTINCT subject FROM assertions
       WHERE project_id = $1
         AND ${tsClauses}
         AND suppressed = false
         AND (reality_check = 'verified' OR pinned = true)`,
      [projectId, ...tsContainsParams]
    );
    trustedSubjects = trustedRows.map((r) => r.subject);
  }

  // ── Step 4: Fetch resurrect-eligible rows scoped to trusted subjects ──────
  // Limit to 5 rows per subject (using a subquery rank to avoid any single
  // subject flooding the result set and excluding other trusted subjects).
  let resurrectRows = [];
  if (trustedSubjects.length > 0) {
    const { clause: subjClause, params: subjContainsParams } =
      db.buildArrayContains('subject', trustedSubjects, 2);
    const { rows: eligibleRows } = await db.query(
      `SELECT id, subject, predicate, object, confidence, source,
              suppression_kind, created_at
       FROM (
         SELECT id, subject, predicate, object, confidence, source,
                suppression_kind, created_at,
                ROW_NUMBER() OVER (PARTITION BY subject ORDER BY created_at DESC) AS rn
         FROM assertions
         WHERE project_id = $1
           AND ${subjClause}
           AND suppressed = true
           AND suppression_kind = 'downvoted_probation'
       ) ranked
       WHERE rn <= 5
       ORDER BY subject ASC, created_at DESC
       LIMIT 50`,
      [projectId, ...subjContainsParams]
    );
    resurrectRows = eligibleRows;
  }

  // ── Step 5: Build output section (read-only by default) ───────────────────
  //
  // Serve-time reality re-probe (resurrect path): when serveTimeRcEnabled is
  // 'enabled' AND serveRoot is provided, run runVerifyDispatch over the
  // resurrect rows before building the output lines so that stale rows are
  // annotated with [STALE: now "<live>"] / [verified✓] just as the loader path
  // does.  Fail-soft: any error here leaves lines unannotated (no crash).
  let sectionText = null;
  if (resurrectRows.length > 0) {
    // Build annotation map (id → suffix) if serve-time re-probe is active.
    const annotationMap = new Map();
    if (serveTimeRcEnabled === 'enabled' && serveRoot) {
      try {
        // Build probe-compatible row objects (need id/subject/predicate/object).
        const probeRows = resurrectRows.map((r) => ({
          id:        r.id,
          subject:   r.subject,
          predicate: r.predicate,
          object:    r.object,
        }));
        const dispatchResults = await runVerifyDispatch(db, projectId, serveRoot, probeRows);
        for (const res of dispatchResults) {
          let suffix;
          if (res.tag === 'mismatch') {
            suffix = ` [STALE: now "${res.probeResult}"]`;
          } else if (res.tag === 'verified') {
            suffix = ' [verified✓]';
          } else {
            suffix = null; // unverifiable — no annotation
          }
          if (suffix !== null) annotationMap.set(res.id, suffix);
          // Refresh reality_check column (fail-soft; §7 no-backfill).
          try {
            await db.query(
              `UPDATE assertions SET reality_check = $1 WHERE id = $2`,
              [res.tag, res.id]
            );
          } catch (_rcUpErr) { /* non-fatal */ }
        }
      } catch (_reprErr) {
        // Fully non-fatal — serve path must never throw.
        if (!silent) process.stderr.write(
          `[handoff] resurrect serve-time re-probe failed (non-fatal): ${_reprErr.message}\n`
        );
      }
    }

    const lines = resurrectRows.map((r) => {
      const ts = r.created_at
        ? (typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString())
        : 'unknown';
      const baseLine = `- [${r.source}|conf=${r.confidence}|${r.suppression_kind}|${ts}] ${r.subject} ${r.predicate} ${r.object}`;
      const suffix = annotationMap.get(r.id);
      return suffix ? baseLine + suffix : baseLine;
    });
    const bodyText = lines.join('\n');
    const candidate = `### Resurrected (decayed/probationary, on-demand)\n${bodyText}`;
    const cost = Math.ceil(candidate.length / 4);
    // Enforce budget constraint.
    if (cost <= tokenBudget) {
      sectionText      = candidate;
      resurrectEmitted = true;
    } else {
      // Budget gate suppressed the section — warn if revival was requested.
      if (reviveOpt) {
        if (!silent) console.error(
          `[handoff] resurrect: revival SKIPPED — token budget exhausted before section could be emitted (tokenBudget=${tokenBudget}, cost=${cost}). Probation rows NOT revived.`
        );
      }
    }
  }

  // ── Step 6: Revival mechanic (only on explicit opt-in q.revive=true) ──────
  // INVARIANT: resurrectEmitted must be true before any DB mutation runs.
  // If the section was budget-blocked or seed was empty, skip revival and warn.
  let revivedIds = [];
  if (reviveOpt && !seedText) {
    // Blank-seed guard: a revive with no seed would mass-revive all probation
    // subjects. Read-only surfacing is still allowed; revival is not.
    if (!silent) console.error(
      '[handoff] resurrect: revival SKIPPED — revive=true requires a non-empty seed (blank seed would mass-revive all probation subjects). Probation rows NOT revived.'
    );
  } else if (reviveOpt && resurrectEmitted && resurrectRows.length > 0) {
    revivedIds = resurrectRows.map((r) => r.id);
    const rehabStmt = db.buildProbationRehabUpdate(revivedIds);
    if (rehabStmt) {
      await db.query(rehabStmt.sql, rehabStmt.params);
    }
  }

  return {
    sectionText,
    revivedRows:    resurrectRows.length,
    revivedIds,
    candidateCount,
  };
}

// ── loader-load (shared with resume and loader-hook) ─────────────────────────

/**
 * Core context-loading logic. Reads handoff.md and runs retrieval contract queries.
 *
 * @param {object} opts
 * @param {boolean} [opts.silent=false]  When true, suppress console.log output (hook mode).
 * @param {object}  [opts.db]            Pre-connected pg.Client (hook passes its own to avoid
 *                                       a second connect/disconnect cycle).
 * @returns {Promise<{
 *   outputText: string,
 *   tokensUsed: number,
 *   sectionsCount: number,
 *   entitiesCount: number,
 *   assertionsCount: number,
 *   vectorCount: number,
 *   contractName: string,
 *   lastClose: string|null,
 *   daysSinceClose: number|null,
 * }>}
 */
async function cmdLoaderLoad(opts = {}) {
  const silent = opts.silent === true;

  // Use a caller-supplied DB connection when available (avoids double connect in hook path).
  let db = opts.db || null;
  let ownDb = false;
  if (!db) {
    try {
      db = await connectHandoff();
      ownDb = true;
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Identity resolution (MUST run before ensureSchemaCurrent) ────────────
  // Ordering constraint: project_id (which keys the schema_fingerprint row)
  // cannot be known until identity is resolved. ensureProjectIdentity is
  // the FIRST internal-check step; ensureSchemaCurrent follows immediately.
  let projectId;
  try {
    const identity = await ensureProjectIdentity(db, { silent });
    projectId = identity.projectId;
  } catch (idErr) {
    // ensureProjectIdentity calls process.exit(1) on fatal errors.
    // This catch is a belt-and-suspenders guard for unexpected throws.
    process.stderr.write('[handoff] identity resolution failed (unexpected): ' + idErr.message + '\n');
    process.exit(1);
  }

  const handoffPath = resolveHandoffMdPath(projectId);
  const fm          = readHandoffFrontmatter(handoffPath);

  const lastClose     = fm.last_close || null;
  const daysSinceClose = daysSince(lastClose);

  // Deliverable A: auto-apply additive schema on drift (non-fatal).
  // Runs immediately after identity resolution, before retrieval_contract SELECT.
  // Any error here must NOT abort resume/load — wrap and continue.
  // cm#185-schema-heal: the result is kept (not discarded) so the
  // computeEmbeddingReadiness call further below (the resume-banner
  // embedding-unreadiness check) can reuse its gated-objects verdict
  // instead of a second, independent round-trip re-checking the same fact
  // (adversary finding #10).
  let schemaHealResult = null;
  try {
    schemaHealResult = await ensureSchemaCurrent(db, projectId, { silent });
  } catch (schemaErr) {
    process.stderr.write('[handoff] schema auto-apply failed (non-fatal): ' + schemaErr.message + '\n');
  }

  // L4: Resume banner — warn if the last close ran degraded (C2/C3 skipped).
  // Query project_settings for any degraded_close:* key newer than the last
  // clean close (i.e., last_close frontmatter timestamp). Non-fatal: any error
  // here must not abort the load.
  try {
    const { rows: degradedRows } = await db.query(
      `SELECT key, value FROM project_settings
       WHERE project_id = $1 AND key LIKE 'degraded_close:%'
       ORDER BY key DESC`,
      [projectId]
    );
    if (degradedRows.length > 0) {
      // Filter to rows newer than the last clean close (if we have one).
      // Key format: degraded_close:<ISO-stamp>:<seq> — extract the ISO portion
      // (first 24 chars of the ISO 8601 timestamp) for comparison.
      const lastCleanStamp = lastClose || null;
      const newerRows = lastCleanStamp
        ? degradedRows.filter((r) => {
            // Key format: degraded_close:<ISO-stamp>:<seq>
            // Extract ISO stamp: the segment between the first ':' separator
            // (after 'degraded_close') and the trailing ':<seq>'.
            const afterPrefix  = r.key.slice('degraded_close:'.length);
            // ISO stamp is everything up to the last ':' (the seq suffix).
            const lastColon    = afterPrefix.lastIndexOf(':');
            const stampPart    = lastColon >= 0 ? afterPrefix.slice(0, lastColon) : afterPrefix;
            return stampPart > lastCleanStamp;
          })
        : degradedRows;
      if (newerRows.length > 0) {
        // Collect unique subsystem names and session ids for the banner.
        const degradedEntries = newerRows.map((r) => {
          try { return JSON.parse(r.value); } catch (_) { return null; }
        }).filter(Boolean);
        const subsystems = [...new Set(degradedEntries.map((e) => e.subsystem))].join(', ');
        const sessionRef = degradedEntries[0] && degradedEntries[0].sessionId
          ? degradedEntries[0].sessionId
          : 'unknown';
        const bannerLine =
          `RESUME WARNING: last close ran degraded (${subsystems} skipped) — ` +
          `feedback/evolution state is stale for session ${sessionRef}`;
        if (!silent) {
          console.log(`\n  ${bannerLine}`);
        } else {
          process.stderr.write(`[handoff] ${bannerLine}\n`);
        }
      }
    }
  } catch (degradedCheckErr) {
    process.stderr.write('[handoff] degraded-close resume check failed (non-fatal): ' + degradedCheckErr.message + '\n');
  }

  // cm#185 R-5: resume banner — warn if the schema-apply sentinel is currently
  // degraded (classification error, apply failure, integrity-index failure,
  // verification failure, or an unparseable/ahead fingerprint). This is a
  // CURRENT-state single row (not an accumulating log like degraded_close:*),
  // cleared by clearSchemaDegradation() the next time a fully-verified apply
  // succeeds. Non-fatal: any error here must not abort the load.
  try {
    const { rows: schemaDegRows } = await db.query(
      `SELECT value FROM project_settings WHERE project_id = $1 AND key = 'schema_apply_degraded'`,
      [projectId]
    );
    if (schemaDegRows.length > 0) {
      let parsed = null;
      try { parsed = JSON.parse(schemaDegRows[0].value); } catch (_) { /* fall through */ }
      const reason = parsed && parsed.reason ? parsed.reason : 'unknown';
      const bannerLine = `RESUME WARNING: schema apply is degraded (${reason}) — run /handoff:status for detail`;
      if (!silent) {
        console.log(`\n  ${bannerLine}`);
      } else {
        process.stderr.write(`[handoff] ${bannerLine}\n`);
      }
    }
  } catch (schemaDegCheckErr) {
    process.stderr.write('[handoff] schema-degradation resume check failed (non-fatal): ' + schemaDegCheckErr.message + '\n');
  }

  // E3 (owner directive "READY should mean fully embedded"): render the
  // classifier's return verbatim — warn on any GENUINE problem state (was
  // previously narrowed to just `readiness.startsWith('UNEMBEDDABLE')`,
  // which stayed silent through DEGRADED:probe-failed/HEALING — a resumed
  // session now sees those without running `status` separately, matching
  // the schema-degradation banner's own loud-whenever-not-clean convention
  // above). DISABLED and UNSUPPORTED:sqlite are standing, structural facts
  // (an operator's deliberate opt-out; a backend that cannot embed at all)
  // — never a recurring nag on every resume.
  try {
    const readiness = await computeEmbeddingReadiness(db, projectId, {
      precomputedGatedOk: _gatedOkFromSchemaHealResult(schemaHealResult),
    });
    if (_shouldWarnOnResume(readiness)) {
      const bannerLine = `RESUME WARNING: embedding ${readiness} — run /handoff:status for detail`;
      if (!silent) {
        console.log(`\n  ${bannerLine}`);
      } else {
        process.stderr.write(`[handoff] ${bannerLine}\n`);
      }
    }
    const nullCounts = await computeEmbeddingNullCounts(db, projectId);
    if (nullCounts.assertions > 0 || nullCounts.decisions > 0) {
      const countLine = `embedding NULLs pending: assertions=${nullCounts.assertions}, decisions=${nullCounts.decisions} (run \`handoff.js backfill-embeddings\`)`;
      if (!silent) {
        console.log(`  ${countLine}`);
      } else {
        process.stderr.write(`[handoff] ${countLine}\n`);
      }
    }
  } catch (embedReadinessErr) {
    process.stderr.write('[handoff] embedding-readiness resume check failed (non-fatal): ' + embedReadinessErr.message + '\n');
  }

  // Load retrieval_contract
  const contractName = fm.contract || 'default';
  const rcRes = await db.query(
    'SELECT queries FROM retrieval_contract WHERE project_id = $1 AND name = $2',
    [projectId, contractName]
  );
  const contract = rcRes.rows.length > 0 ? rcRes.rows[0].queries : { queries: [] };
  const queries  = contract.queries || [];

  const tokenBudget = parseInt(await getSetting(db, projectId, 'loader_token_budget', '4000'), 10);
  let tokensUsed     = 0;
  const sections     = [];

  // Per-type counters for the Done: line and hook output.
  let entitiesCount   = 0;
  let assertionsCount = 0;
  let vectorCount     = 0;

  // W3: collect entity names retrieved during the contract loop for cluster expansion.
  const retrievedEntityNames = [];

  // C1: collect assertion ids retrieved during the contract loop for attribution.
  const retrievedAssertionIds = [];

  // Serve-time reality re-probe: collect full assertion row objects (id + all fields)
  // so the post-loop pass can run runVerifyDispatch against them.
  // Only populated when serve_time_reality_check is 'enabled' (default).
  const servedAssertionRows = [];

  // C2: read feedback gate once before the loop.
  // Default is now 'enabled' (PR-B default-on).  When explicitly set to any other value,
  // gate-OFF SQL has no outcome_bias term — byte-identical in structure to pre-C2 (I-6).
  const feedbackLoopEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'enabled');

  // Serve-time reality re-probe gate.
  // Default 'enabled': after section building, re-probe verify-mode registry entries and
  // annotate served lines with live results.  Any other value: output is byte-identical
  // to pre-feature (no annotations, no re-probe).
  // Mirrors how cluster_aware_retrieval / tier_aware_retrieval gates are written.
  const serveTimeRcEnabled = await getSetting(db, projectId, 'serve_time_reality_check', 'enabled');

  // Two-tier durability retrieval gate (orthogonal to C2 feedback gate).
  // Default 'enabled' = ON.  Prepends a tier-priority sort key to ORDER BY so that
  // consolidated/NULL rows rank above probationary rows.  Probationary rows are NEVER
  // filtered out (only re-ranked) — the LIMIT-30 dormancy floor invariant is preserved.
  // When any other value: ORDER BY is byte-identical to the pre-feature SQL (no CASE WHEN
  // tier term at all) — the I-6 byte-identical guarantee is honored on this gate as well.
  // Gate composition: 4 explicit SQL strings (feedbackOn/Off × tierOn/Off) remain readable.
  const tierAware = await getSetting(db, projectId, 'tier_aware_retrieval', 'enabled');
  // Computed prefix: if tier-aware ON, prepend the CASE WHEN tier sort key to ORDER BY.
  // CASE WHEN tier='probationary' THEN 1 ELSE 0 END is plain SQL, valid on PG and node:sqlite
  // — no rewrite/port method needed (no now(), no EXTRACT, no dialect-specific syntax).
  // NULL tier (grandfathered rows) hits ELSE → 0 → ranked with consolidated. Correct.
  const tierPrefix = tierAware === 'enabled'
    ? "(CASE WHEN tier = 'probationary' THEN 1 ELSE 0 END) ASC, "
    : '';

  // ── Restructure: read handoff.md body BEFORE the contract loop ──────────────
  // This lets us compute servedBody before the loop so the sectionBudget
  // reservation can account for the MD body size.  Moved from the assembly block
  // below; behavior is identical — the body is passed unchanged into the output.
  let servedBody = '';
  if (fs.existsSync(handoffPath)) {
    const raw  = fs.readFileSync(handoffPath, 'utf8');
    let   body = raw.replace(/^---[\s\S]*?---\r?\n/, '');

    // Pointer-staleness gate — resume mode: rewrite stale line numbers in the served
    // output but do NOT persist corrections back to the DB (close is the mutation point).
    // Runs non-fatally; any error leaves body unchanged.
    try {
      const resumeRoot = findProjectRoot();
      // Pass the full handoff.md body as tldr (single scan covers all pointer references).
      const gateResult = await runPointerGate(
        { tldr: body, openThreads: '', quickReferences: '' },
        resumeRoot,
        db,
        projectId,
        'resume'
      );
      body = gateResult.rewrittenFields.tldr;
    } catch (ptrResumeErr) {
      process.stderr.write(`[handoff] pointer-gate (resume) failed (non-fatal): ${ptrResumeErr.message}\n`);
    }

    servedBody = body.trim();
  }

  // ── Budget reservation: keep sections + MD body + canon within token budget ──
  // Reported `tokensUsed` stays sections-only (graph-traversal test B-3 depends on this).
  // sectionBudget is what sections may consume; actual served output = canon + md + sections.
  const canonTokens    = Math.ceil(OPERATING_CANON.length / 4);
  const mdBodyTokens   = servedBody ? Math.ceil(servedBody.length / 4) : 0;
  const overheadMargin = 120;
  const sectionBudget  = Math.max(0, tokenBudget - canonTokens - mdBodyTokens - overheadMargin);

  for (const q of queries) {
    if (tokensUsed >= sectionBudget) break;

    if (q.type === 'entity' || q.kind === 'entity') {
      const { rows } = await db.query(
        `SELECT name, entity_type, description FROM entities
         WHERE project_id = $1 AND ($2::text IS NULL OR name = $2)
         ORDER BY created_at DESC LIMIT 20`,
        [projectId, q.filter?.name || null]
      );
      if (rows.length) {
        const text = rows.map((r) => `- ${r.name} (${r.entity_type}): ${r.description || ''}`).join('\n');
        sections.push(`### Entities\n${text}`);
        tokensUsed    += Math.ceil(text.length / 4);
        entitiesCount += rows.length;
        // W3: capture names for cluster-aware sibling expansion.
        for (const r of rows) retrievedEntityNames.push(r.name);
      }

    } else if (q.type === 'assertion' || q.kind === 'assertion') {
      // Commit B: decay is a ranking-only signal — it no longer gates rows out of the loader.
      // Previously the WHERE clause enforced a >= 1.0 effective-confidence cutoff, which caused
      // dormancy: any assertion not retrieved for ~6+ weeks decayed below 1.0 and was silently
      // excluded, even though the data was intact in the DB. Fix: remove the decay cutoff from
      // WHERE entirely; LIMIT 30 is now the guaranteed top-N floor. Suppressed rows are still
      // excluded via suppressed = false.
      //
      // Gate ON (feedback_loop_enabled='enabled'): ORDER BY uses
      //   confidence * exp(-decay_rate * age_days) + outcome_bias  (decayed score + feedback bias).
      // Gate OFF: ORDER BY uses confidence * exp(-decay_rate * age_days) (decayed score only).
      // The gate-ON/gate-OFF difference is now only the outcome_bias term in the ranking expression.
      // outcome_bias semantics (gap 5b) are unchanged.
      //
      // Clamp design: outcome_bias is bounded by feedback_bias_clamp on write (see cmdClose).
      let assertionQuerySql;
      let assertionQueryParams;
      if (feedbackLoopEnabled === 'enabled') {
        // Gate ON: rank by decayed score + outcome_bias; no cutoff filter.
        // PR-B: also exclude bi-temporally invalidated rows (invalid_at IS NULL = still live).
        // Tier gate (orthogonal, I-6 honored): tierPrefix prepended to ORDER BY when
        // tier_aware_retrieval='enabled'; empty string when disabled (byte-identical then).
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY ${tierPrefix}(confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) + outcome_bias) DESC, last_reinforced DESC LIMIT 30`;
        assertionQueryParams = [projectId, q.filter?.subject || null];
      } else {
        // Gate OFF: rank by decayed score only (no outcome_bias term); no cutoff filter.
        // I-6: when C2 is EXPLICITLY disabled, the gate-OFF SQL omits the outcome_bias term —
        // that is the ONLY C2-driven difference vs gate-ON. The AND invalid_at IS NULL predicate
        // is a bi-temporal extension (PR-B) present identically in both gate-ON and gate-OFF;
        // it is NOT a C2 change.
        // Tier gate (orthogonal, I-6 honored): tierPrefix prepended to ORDER BY when
        // tier_aware_retrieval='enabled'; empty string when disabled (byte-identical then).
        assertionQuerySql = `SELECT id, subject, predicate, object, confidence, source FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY ${tierPrefix}confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400) DESC, last_reinforced DESC LIMIT 30`;
        assertionQueryParams = [projectId, q.filter?.subject || null];
      }
      const { rows } = await db.query(assertionQuerySql, assertionQueryParams);
      if (rows.length) {
        // Accumulate rows one-at-a-time, bounded by sectionBudget.
        const lineTexts = [];
        for (const r of rows) {
          const lineText = `- [${r.source}|conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
          const rowCost  = Math.ceil(lineText.length / 4);
          if (tokensUsed + rowCost > sectionBudget) break;
          lineTexts.push(lineText);
          tokensUsed      += rowCost;
          assertionsCount += 1;
          retrievedAssertionIds.push(r.id);
          // Serve-time re-probe: track full row for the post-loop annotation pass.
          if (serveTimeRcEnabled === 'enabled') servedAssertionRows.push(r);
        }
        if (lineTexts.length) {
          sections.push(`### Assertions\n${lineTexts.join('\n')}`);
        }
        // 4C: Bump reinforcement timestamps ONLY for the rows actually returned
        // (per-row precision instead of project-wide or subject-wide).
        // OQ-2: AND suppressed=false prevents bumping suppressed history rows.
        // Dialect-specific SQL (IN vs ANY, now() vs datetime('now')) is
        // encapsulated inside db.buildBumpAssertions() — no conditionals here.
        const bumpStmt = db.buildBumpAssertions(retrievedAssertionIds);
        if (bumpStmt) {
          await db.query(bumpStmt.sql, bumpStmt.params);
        }
      }

    } else if (q.type === 'recency' || q.kind === 'recency') {
      // Commit B: decay cutoff removed from recency kind too — dormancy fix applies here.
      // Recency queries are ordered by last_reinforced DESC regardless of gate state;
      // decay is not factored into the ORDER BY for recency (recency stays recency-ordered).
      // LIMIT 20 is the guaranteed top-N floor; suppressed = false still excludes suppressed rows.
      // Ordered by last_reinforced DESC; suppressed=false and invalid_at IS NULL
      // exclude suppressed rows and bi-temporally invalidated (superseded) rows.
      const recencyQuerySql = `SELECT id, subject, predicate, object, confidence FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND invalid_at IS NULL
         ORDER BY last_reinforced DESC LIMIT 20`;
      const { rows } = await db.query(recencyQuerySql, [projectId]);
      if (rows.length) {
        // Accumulate rows one-at-a-time, bounded by sectionBudget.
        const lineTexts = [];
        for (const r of rows) {
          const lineText = `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
          const rowCost  = Math.ceil(lineText.length / 4);
          if (tokensUsed + rowCost > sectionBudget) break;
          lineTexts.push(lineText);
          tokensUsed      += rowCost;
          assertionsCount += 1;
          retrievedAssertionIds.push(r.id);
          // Serve-time re-probe: track full row for the post-loop annotation pass.
          if (serveTimeRcEnabled === 'enabled') servedAssertionRows.push(r);
        }
        if (lineTexts.length) {
          sections.push(`### Recent assertions\n${lineTexts.join('\n')}`);
        }
      }

    } else if (q.type === 'history' || q.kind === 'history') {
      // 4E history kind: return suppressed / bi-temporally invalidated rows for a given
      // subject so the caller can inspect the superseded trail + probation rows without
      // paying the default context cost.
      //
      // PR-B additions:
      //   - Includes rows with suppressed=true OR invalid_at IS NOT NULL (catches
      //     downvoted_probation rows that are excluded from standard retrieval).
      //   - suppression_kind and invalid_at are included in the formatted output.
      //   - NO bump: history retrieval must not reinforce non-live rows (OQ-2).
      //
      // Design decisions (per spec §7.3 + PR-B Fork 1):
      //   - Opt-in via contract kind:'history' + filter.subject; never in default contract.
      //   - created_at is included so the caller can reason about temporal ordering.
      //
      // I-2 guard: the default contract ({queries:[]}) contains no history query, so
      // this branch is unreachable in a default session.  Including a history query in
      // the contract is an explicit opt-in that must go through recordContractChange.
      const historySubject = q.filter?.subject || null;
      const { rows: hRows } = await db.query(
        `SELECT id, subject, predicate, object, confidence, source, created_at,
                suppression_kind, invalid_at
         FROM assertions
         WHERE project_id = $1
           AND ($2::text IS NULL OR subject = $2)
           AND (suppressed = true OR invalid_at IS NOT NULL)
         ORDER BY subject, predicate, created_at DESC
         LIMIT 20`,
        [projectId, historySubject]
      );
      if (hRows.length) {
        const text = hRows.map((r) => {
          const ts = r.created_at
            ? (typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString())
            : 'unknown';
          const kindTag = r.suppression_kind ? `|${r.suppression_kind}` : '|suppressed';
          return `- [${r.source}|conf=${r.confidence}${kindTag}|${ts}] ${r.subject} ${r.predicate} ${r.object}`;
        }).join('\n');
        sections.push(`### Assertion history (suppressed/probation trail)\n${text}`);
        tokensUsed      += Math.ceil(text.length / 4);
        assertionsCount += hRows.length;
        // No bump — history rows are read-only for decay purposes.
      }

    } else if (q.type === 'graph' || q.kind === 'graph') {
      // Graph kind: recursive-CTE edge traversal from seed entities.
      //
      // Design decisions:
      //   1. Seeds: q.filter.seed (string or array). If absent, fall back to
      //      retrievedEntityNames (so a graph query placed after an entity query
      //      inherits the entity results as seeds). If still no seeds → no-op.
      //   2. Direction: q.filter.direction ∈ 'out'|'in'|'both', default 'out'.
      //   3. Depth: effective = q.filter.max_depth if positive int, else setting
      //      graph_max_depth (default '2'). HARD-clamped to Math.min(effective, 5).
      //   4. Node cap: setting graph_max_nodes (default '25'). Deterministic ordering:
      //      min_depth ASC, weight DESC, entity_name ASC.
      //   5. Recursive CTE with cycle prevention via path array.
      //   6. Gating: graph_retrieval_enabled default 'enabled'. When 'disabled', no-op.
      //   7. Output: strictly additive "### Related (graph)" section.
      //   8. No modification of default contract — default session: byte-identical output.
      //      (Same I-2 guard as the history kind.)
      //
      // REGRESSION GUARD: the default retrieval_contract is NOT modified by this PR.
      // A default session has no graph query, so this branch is unreachable in default
      // sessions — loader output is byte-identical to pre-feature. (I-2 guarantee.)
      try {
        const graphEnabled = await getSetting(db, projectId, 'graph_retrieval_enabled', 'enabled');
        if (graphEnabled !== 'enabled') {
          // Gate off: no-op. Do not add any section or modify tokensUsed.
        } else {
          // Resolve seeds.
          let seeds = [];
          if (q.filter && q.filter.seed != null) {
            seeds = Array.isArray(q.filter.seed) ? q.filter.seed : [q.filter.seed];
            seeds = seeds.filter((s) => typeof s === 'string' && s.length > 0);
          }
          if (seeds.length === 0) {
            seeds = retrievedEntityNames.slice(); // fallback: entities retrieved earlier
          }

          if (seeds.length > 0 && tokensUsed < sectionBudget) {
            // Resolve direction.
            const direction = (q.filter && q.filter.direction) || 'out';

            // Resolve max depth.
            const settingDepth = parseInt(
              await getSetting(db, projectId, 'graph_max_depth', '2'), 10
            );
            const filterDepth = (q.filter && Number.isInteger(q.filter.max_depth) && q.filter.max_depth > 0)
              ? q.filter.max_depth : settingDepth;
            const maxDepth = Math.min(filterDepth, 5); // abuse guard

            // Resolve node cap.
            const maxNodes = parseInt(
              await getSetting(db, projectId, 'graph_max_nodes', '25'), 10
            );

            // Build + execute the graph CTE.
            // Dialect-specific SQL construction (ARRAY path for Postgres vs.
            // delimited-string path for SQLite) is fully encapsulated in the
            // adapter's buildGraphCTE() method — no conditionals in the engine.
            const { sql: cteSql, params: cteParams } =
              db.buildGraphCTE(direction, seeds, maxDepth, maxNodes, projectId);
            const { rows: graphRows } = await db.query(cteSql, cteParams);

            if (graphRows.length > 0 && tokensUsed < sectionBudget) {
              const graphText = graphRows.map((r) =>
                `- ${r.entity_name} (depth ${r.min_depth}, via ${r.rep_from} -[${r.rep_edge_type}]-> ${r.rep_to})`
              ).join('\n');
              const graphSection = `### Related (graph)\n${graphText}`;
              // Only add if budget allows.
              const cost = Math.ceil(graphSection.length / 4);
              if (tokensUsed + cost <= sectionBudget) {
                sections.push(graphSection);
                tokensUsed += cost;
              }
            }
          }
        }
      } catch (graphErr) {
        // Non-fatal: any error degrades gracefully (no graph section, no crash).
        if (!silent) console.error(`[handoff] graph traversal error (non-fatal): ${graphErr.message}`);
      }

    } else if (q.type === 'resurrect' || q.kind === 'resurrect') {
      // Resurrect kind: on-demand revival of decay-suppressed (downvoted_probation) rows.
      //
      // DIALECT CONTRACT: the resurrect branch runs exclusively on the Postgres loader
      // path. The SQLite adapter arm is not exercised by the loader. All inline queries
      // in this branch use Postgres boolean literals (suppressed = true / false) and
      // parameterized $N placeholders. The db-seam adapter methods (buildFuzzyMatch,
      // buildGraphCTE, buildArrayContains, buildProbationRehabUpdate) handle dialect
      // translation internally; the no-candidate fallback query below uses the same
      // Postgres literal style consistent with Steps 3/4 throughout this branch.
      //
      // Design decisions:
      //   1. Eligibility: EXACTLY suppressed=true AND suppression_kind='downvoted_probation'.
      //      Hard-excludes 'downvoted_terminal', 'superseded', 'retired', and live rows.
      //      Terminal-is-terminal is an enforced invariant (test-both-backends S3).
      //   2. M2 seed-gate: only assertions whose subject/entity is corroborated by a trusted
      //      anchor may be resurrected. Trusted = reality_check='verified' OR pinned=true
      //      (the same quality-corroborator predicate L2 consolidation uses — see hasQualityCorroborator).
      //      This prevents a forged probationary row from self-resurrecting.
      //   3. Semantic seed: embeds query via vLLM (Qwen/Qwen3-Embedding-8B) and runs
      //      cosine ANN directly on assertions.embedding (halfvec 4000, project-scoped).
      //      Degrades to pg_trgm fuzzy match (db.buildFuzzyMatch) under EMBED_SKIP=1
      //      or when the embed backend is unreachable/throws. Both paths are non-fatal.
      //      Both paths route through the seam — zero dialect conditionals in the engine.
      //   4. Graph fan-out: from seeded subjects, calls db.buildGraphCTE(out, seeds, 2)
      //      to pull depth-2 connected entities and include their resurrect-eligible rows.
      //   5. Revival mechanic: gated on q.revive===true. When false (default), the branch
      //      surfaces rows read-only into the loader output without mutating suppressed.
      //      When true, calls db.buildProbationRehabUpdate(ids) — the only sanctioned
      //      mutation; only revivable (downvoted_probation) rows.
      //   6. Sub-budget: resurrect_token_budget setting, default '1500'. Enforced as
      //      min(globalRemaining, subBudget).
      //   7. I-2 guard: the default contract ({queries:[]}) contains no resurrect query,
      //      so this branch is unreachable in a default session — byte-identical to pre-feature.
      //      (Same I-2 guarantee as history/graph kinds.)
      //
      // REGRESSION GUARD: the default retrieval_contract is NOT modified by this PR.
      // A default session has no resurrect query, so this branch is unreachable in default
      // sessions — loader output is byte-identical to pre-feature. (I-2 guarantee.)
      //
      // Pre-existing limitation: the async queue-drain path (cmdQueueDrain) is a known
      // pre-existing L4-handled corner when payload.session_id is absent AND the
      // session_in_progress marker has already been cleared. This is not introduced here.
      try {
        // Resolve sub-budget (use sectionBudget so resurrection is bounded correctly).
        const subBudgetRaw = await getSetting(db, projectId, 'resurrect_token_budget', '1500');
        const subBudget    = Math.min(
          sectionBudget - tokensUsed,
          Math.max(0, parseInt(subBudgetRaw, 10) || 1500)
        );
        if (subBudget > 0) {
          const result = await runResurrectQuery(db, projectId, q, {
            silent,
            tokenBudget: subBudget,
            // Pass serve-time re-probe context so resurrect annotations match
            // the loader assertion path (both serve paths are consistent).
            serveTimeRcEnabled,
            serveRoot: findProjectRoot(),
          });
          if (result.sectionText) {
            sections.push(result.sectionText);
            tokensUsed      += Math.ceil(result.sectionText.length / 4);
            assertionsCount += result.revivedRows;
          }
        }
        // subBudget <= 0: skip silently (no section, no crash).
      } catch (resurrectErr) {
        // Non-fatal: any error degrades gracefully (no resurrect section, no crash).
        if (!silent) console.error(`[handoff] resurrect error (non-fatal): ${resurrectErr.message}`);
      }

    } else if (q.type === 'vector' || q.kind === 'vector') {
      // Vector kind: runs the SAME canonical vector-search path the
      // memory_view_run / memory_search MCP tools use — memory-view.js's
      // runVectorQuery, which delegates BY REFERENCE to memory-search.js's
      // memorySearch (no second embedding/scoring implementation).
      //
      // Fail-soft, total classification: an embedder/provider error (vLLM
      // unreachable, endpoint unconfigured/NONE, mock-fixture miss, empty
      // query text, etc.) is caught here and rendered as exactly ONE line
      // in the same single-line style the pre-fix stub used — never a
      // silent blank, never a thrown/uncaught error, never a partial
      // section. vectorCount is left at 0 on that path; only real hits
      // increment it.
      const vectorQueryText = (q.query || '').trim();
      try {
        const { hits, skippedTables } = await runVectorQuery(db, projectId, { ...q, query: vectorQueryText });
        // skippedTables (2026-09-08, PR #274 review; reshaped 2026-09-09 by
        // the per-table availability gate PR): memorySearch's own total-
        // classification probe means a table absent from THIS connected DB
        // (e.g. agent_exchange pre-migrate-13), missing/shape-mismatched
        // columns (e.g. a degraded schema with embedding skipped at apply
        // time), or a per-table live-query error is skipped, never fatal to
        // the whole query — surfaced here as one diagnostic line, appended
        // after any bullets, so a missing table is visible rather than
        // silently dropped or (the pre-fix bug) killing every hit from every
        // OTHER table too. skippedTables entries are now `{table, reason,
        // detail}` objects (was a bare table-name string) — this render only
        // ever named the table, so it maps `.table` out; a bare string
        // survives unchanged (defensive — no known caller passes one today).
        const skipLine = (skippedTables && skippedTables.length)
          ? `— skipped missing tables: ${skippedTables.map((s) => (typeof s === 'string' ? s : s.table)).join(', ')}` : null;

        if (hits.length) {
          // Accumulate hits one-at-a-time, bounded by sectionBudget — same
          // discipline as the ### Assertions / ### Recent assertions loops.
          const lineTexts = [];
          for (const h of hits) {
            const lineText = `- [${h.sourceTable}|score=${h.score.toFixed(3)}] ${h.label}: ${h.snippet}`;
            const rowCost  = Math.ceil(lineText.length / 4);
            if (tokensUsed + rowCost > sectionBudget) break;
            lineTexts.push(lineText);
            tokensUsed  += rowCost;
            vectorCount += 1;
          }
          if (lineTexts.length) {
            let sectionText = `### Vector query (${vectorQueryText})\n${lineTexts.join('\n')}`;
            if (skipLine) sectionText += `\n${skipLine}`;
            tokensUsed += skipLine ? Math.ceil(skipLine.length / 4) : 0;
            sections.push(sectionText);
          }
        } else if (skipLine) {
          // No hits AND at least one candidate table was skipped (up to and
          // including every candidate) — never silently blank: render the
          // header plus the skip line so the missing table(s) are visible.
          const sectionText = `### Vector query (${vectorQueryText}) ${skipLine}`;
          sections.push(sectionText);
          tokensUsed += Math.ceil(sectionText.length / 4);
        }
        // hits.length === 0 && !skipLine: no matches, nothing skipped — no
        // section, mirrors the other kinds' `if (rows.length)` guard.
      } catch (vectorErr) {
        const failLine = `### Vector query (${vectorQueryText}) — vector query unavailable: ${vectorErr.message}`;
        sections.push(failLine);
        tokensUsed += Math.ceil(failLine.length / 4);
      }
    }
  }

  // ── Retrieval event logging (side-channel, non-fatal) ────────────────────────
  // Insert one retrieval_events row per loader invocation for observability.
  // C1: capture RETURNING id and bulk-insert retrieval_event_assertions rows.
  // Wrapped entirely in try/catch — never throws, never alters return value or output.
  try {
    const kinds = [...new Set(queries.map((q) => q.kind || q.type || 'unknown'))].join(',');
    const queryText = `loader:contract=${contractName};kinds=${kinds};sections=${sections.length}`.slice(0, 1000);
    // S3: session_in_progress is now a JSON array of per-session markers — resolve
    // to the single most-recently-written one (see latestSessionMarker's header comment).
    const _loaderMarkers = await getSessionMarkers(db, projectId);
    const _loaderLatest   = latestSessionMarker(_loaderMarkers);
    const sessionId = _loaderLatest ? (_loaderLatest.session_id || _loaderLatest.ts) : null;
    const notes = `entities=${entitiesCount};assertions=${assertionsCount};vector=${vectorCount};tokens=${tokensUsed}`.slice(0, 1000);
    const evtRes = await db.query(
      `INSERT INTO retrieval_events (project_id, query_text, session_id, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [projectId, queryText, sessionId || null, notes]
    );
    // C1: attribute the retrieved assertions to this event.
    // Deduplicate ids (recency and assertion queries may overlap) and bulk-insert.
    // Dialect-specific multi-row VALUES formatting is encapsulated in buildMultiPairInsert().
    const eventId = evtRes.rows[0] && evtRes.rows[0].id;
    if (eventId != null && retrievedAssertionIds.length > 0) {
      const uniqueIds = [...new Set(retrievedAssertionIds)];
      const insertStmt = db.buildMultiPairInsert(
        'retrieval_event_assertions', 'event_id', 'assertion_id', eventId, uniqueIds
      );
      await db.query(insertStmt.sql, insertStmt.params);
    }
  } catch (evtErr) {
    if (!silent) console.error(`[handoff] retrieval_events insert failed (non-fatal): ${evtErr.message}`);
  }

  // ── W3: cluster-aware sibling expansion (strictly additive, fully gated) ──────
  // Appends a "### Related (community)" section for same-community sibling entities
  // of the entities already retrieved. Fully wrapped in try/catch — any error causes
  // a clean no-op fallback to pre-W3 output. No community run in entity_communities
  // => guaranteed byte-identical pre-W3 output (no regression).
  try {
    const clusterSetting = await getSetting(db, projectId, 'cluster_aware_retrieval', 'enabled');
    if (clusterSetting === 'enabled' && retrievedEntityNames.length > 0 && tokensUsed < sectionBudget) {
      // Find the latest community run for this project.
      const runRes = await db.query(
        `SELECT run_id FROM entity_communities WHERE project_id = $1 ORDER BY computed_at DESC LIMIT 1`,
        [projectId]
      );
      if (runRes.rows.length > 0) {
        const latestRunId = runRes.rows[0].run_id;
        // Find community_ids for the hit entities in this run.
        // buildCommunityIdsQuery() encapsulates the dialect-specific array lookup.
        const cidQ = db.buildCommunityIdsQuery(projectId, latestRunId, retrievedEntityNames);
        const communityRes = await db.query(cidQ.sql, cidQ.params);
        if (communityRes.rows.length > 0) {
          const communityIds = communityRes.rows.map((r) => r.community_id);
          const clusterMaxSiblings = parseInt(
            await getSetting(db, projectId, 'cluster_max_siblings', '10'), 10
          );
          // Fetch sibling entities in the same communities, excluding already-retrieved ones.
          // buildSiblingsQuery() encapsulates the dialect-specific IN/ANY and NOT IN/<>ALL.
          const sibQ = db.buildSiblingsQuery(
            projectId, latestRunId, communityIds, retrievedEntityNames, clusterMaxSiblings
          );
          const siblingRes = await db.query(sibQ.sql, sibQ.params);
          if (siblingRes.rows.length > 0 && tokensUsed < sectionBudget) {
            const siblingText = siblingRes.rows.map((r) => `- ${r.entity_name}`).join('\n');
            sections.push(`### Related (community)\n${siblingText}`);
            tokensUsed += Math.ceil(siblingText.length / 4);
          }
        }
      }
    }
  } catch (clusterErr) {
    // Non-fatal: any error degrades gracefully to pre-W3 output (no expansion).
    if (!silent) console.error(`[handoff] W3 cluster expansion error (non-fatal): ${clusterErr.message}`);
  }

  // ── Session intent section (north-star default resume) ───────────────────────
  // Surface open_thread / session_tldr / quick_reference rows when the contract
  // did NOT already include an assertion or recency query (which would serve them
  // via the "### Assertions" or "### Recent assertions" block).
  // Gated off when either of those kinds already ran (no double-serve).
  // Suppressed rows are excluded (P2 superseded / lifecycle-C devalued intent).
  const contractHasAssertionQuery = queries.some(
    (q) => q.type === 'assertion' || q.kind === 'assertion' ||
            q.type === 'recency'   || q.kind === 'recency'
  );
  if (!contractHasAssertionQuery && tokensUsed < sectionBudget) {
    try {
      const { rows: intentRows } = await db.query(
        `SELECT id, subject, predicate, object, confidence, source FROM assertions
           WHERE project_id = $1
             AND predicate IN ('open_thread', 'session_tldr', 'quick_reference')
             AND suppressed = false
             AND invalid_at IS NULL
           ORDER BY (confidence * exp(-decay_rate * EXTRACT(EPOCH FROM (now() - last_reinforced)) / 86400)) DESC,
                    last_reinforced DESC
           LIMIT 50`,
        [projectId]
      );
      if (intentRows.length > 0) {
        const lineTexts = [];
        for (const r of intentRows) {
          const lineText = `- [${r.source}|conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
          const rowCost  = Math.ceil(lineText.length / 4);
          if (tokensUsed + rowCost > sectionBudget) break;
          lineTexts.push(lineText);
          tokensUsed      += rowCost;
          assertionsCount += 1;
          retrievedAssertionIds.push(r.id);
          // Serve-time re-probe: track full row for the post-loop annotation pass.
          if (serveTimeRcEnabled === 'enabled') servedAssertionRows.push(r);
        }
        if (lineTexts.length > 0) {
          sections.push(`### Session intent\n${lineTexts.join('\n')}`);
        }
      }
    } catch (intentSectionErr) {
      // Non-fatal: any error degrades gracefully to pre-intent output.
      if (!silent) process.stderr.write(`[handoff] session intent section error (non-fatal): ${intentSectionErr.message}\n`);
    }
  }

  // ── Serve-time reality re-probe (post-loop annotation pass) ─────────────────
  //
  // When serve_time_reality_check='enabled' (default), re-probe every served
  // assertion row whose predicate has a mode:'verify' registry entry.  For each
  // row that mismatches, annotate the served line with [STALE: now "<probeResult>"].
  // Verified rows get [verified✓].  Unverifiable rows get [unverifiable].
  // Also REFRESH the reality_check column via fail-soft UPDATE (bounded by served
  // row count; only the reality_check column is written — §7 no-backfill).
  //
  // Gate off path: serveTimeRcEnabled !== 'enabled' → servedAssertionRows is empty
  // (we never pushed to it) → this block is a structural no-op (loop body never runs).
  // Byte-identical output guaranteed when gate is off.
  //
  // Fail-soft: any probe or DB error → treat as 'unverifiable'/skip;
  // NEVER abort or throw out of a serve path.
  if (serveTimeRcEnabled === 'enabled' && servedAssertionRows.length > 0) {
    try {
      const serveRoot = findProjectRoot();

      // Build a quick lookup: assertion line text → result, keyed by the baseline
      // line text as it appears in sections[].  We annotate in-place.
      const dispatchResults = await runVerifyDispatch(db, projectId, serveRoot, servedAssertionRows);

      if (dispatchResults.length > 0) {
        // Build a map from row id → annotation suffix.
        // 'unverifiable' results get no visible annotation (suffix=null) to keep
        // output clean, but their reality_check column IS still refreshed below.
        const annotationMap = new Map();
        for (const res of dispatchResults) {
          let suffix;
          if (res.tag === 'mismatch') {
            suffix = ` [STALE: now "${res.probeResult}"]`;
          } else if (res.tag === 'verified') {
            suffix = ' [verified✓]';
          } else {
            // 'unverifiable' — skip annotation (no suffix) to keep output clean.
            suffix = null;
          }
          if (suffix !== null) annotationMap.set(res.id, { suffix, tag: res.tag });
        }

        if (annotationMap.size > 0) {
          // Build a per-row lookup so we can match lines by content.
          // Row lines have the form: "- [<source>|conf=<n>] <subject> <predicate> <object>"
          // or "- [conf=<n>] <subject> <predicate> <object>" (recency format without source).
          // We build a map from id → expected base line text for safe matching.
          const idToBaseLine = new Map();
          for (const r of servedAssertionRows) {
            const ann = annotationMap.get(r.id);
            if (!ann) continue;
            // Construct the base line as the section-builder would produce it.
            let baseLine;
            if (r.source) {
              baseLine = `- [${r.source}|conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
            } else {
              baseLine = `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
            }
            idToBaseLine.set(r.id, baseLine);
          }

          // Annotate sections in-place.  Walk every section line; if it matches a
          // base line for which we have an annotation, append the suffix.
          for (let si = 0; si < sections.length; si++) {
            const sectionLines = sections[si].split('\n');
            let changed = false;
            for (let li = 0; li < sectionLines.length; li++) {
              // Check each tracked row against this line.
              for (const [rowId, baseLine] of idToBaseLine) {
                if (sectionLines[li] === baseLine) {
                  const ann = annotationMap.get(rowId);
                  sectionLines[li] = baseLine + ann.suffix;
                  changed = true;
                  break; // one annotation per line
                }
              }
            }
            if (changed) sections[si] = sectionLines.join('\n');
          }
        }

        // Refresh reality_check column for ALL dispatch results, including
        // 'unverifiable' rows.  This is unconditional (not guarded by
        // annotationMap.size) so that probe failures correctly write
        // 'unverifiable' even when no visible annotation is emitted.
        // Fail-soft UPDATE — bounded by served-row count.
        // Only reality_check is written — §7 no-backfill invariant.
        for (const res of dispatchResults) {
          try {
            await db.query(
              `UPDATE assertions SET reality_check = $1 WHERE id = $2`,
              [res.tag, res.id]
            );
          } catch (_rcUpdateErr) {
            // Non-fatal — serve path must never throw.
          }
        }
      }
    } catch (serveRcErr) {
      // Fully non-fatal: any error in the serve-time re-probe must not abort resume.
      process.stderr.write(`[handoff] serve-time reality re-probe failed (non-fatal): ${serveRcErr.message}\n`);
    }
  }

  if (ownDb) await db.end();

  // Assemble output text (same content whether silent or not).
  // All retrieved content is wrapped with trust-boundary labels — unconditional
  // hygiene for both solo and multi-author repos. "untrusted" is the correct label
  // on a public repo where PR/code review content may flow into Claude sessions.
  const outputParts = [];
  // Trusted canon is always the first element — never inside the untrusted delimiters.
  outputParts.push(OPERATING_CANON);
  const retrievedParts = [];

  // Use servedBody computed before the loop (avoids double-read of handoff.md).
  // servedBody is '' when the file does not exist; only push if it has content.
  if (servedBody) {
    retrievedParts.push('=== Handoff context ===');
    retrievedParts.push(servedBody);
  }

  if (sections.length) {
    retrievedParts.push('=== Retrieved context (contract: ' + contractName + ') ===');
    retrievedParts.push(sections.join('\n'));
  }

  if (retrievedParts.length) {
    outputParts.push('=== BEGIN RETRIEVED CONTEXT (untrusted) ===');
    outputParts.push(retrievedParts.join('\n'));
    outputParts.push('=== END RETRIEVED CONTEXT ===');
  }

  // Token-budget reporting:
  // - tokensUsed (sections-only) is preserved unchanged — graph-traversal test B-3 depends on it.
  // - trueServedTokens is computed from the FULLY assembled output string (Math.ceil(len/4)),
  //   which includes OPERATING_CANON + servedBody (handoff.md body) + sections.
  //   This reflects actual bootstrap cost to the model.
  // We assemble a temporary output to measure before pushing the token line.
  const outputTextForMeasure = outputParts.join('\n');
  const trueServedTokens = Math.ceil(outputTextForMeasure.length / 4);
  outputParts.push(`\n  tokens used: ~${trueServedTokens} / ${tokenBudget} (sections: ~${tokensUsed})`);

  const outputText = outputParts.join('\n');

  if (!silent) {
    console.log(outputText);
  }

  return {
    outputText,
    tokensUsed,
    trueServedTokens,
    sectionsCount:   sections.length,
    entitiesCount,
    assertionsCount,
    vectorCount,
    contractName,
    lastClose,
    daysSinceClose,
  };
}

// ── loader-hook (SessionStart hook entry point) ───────────────────────────────

async function cmdLoaderHook(args) {
  // ── S1 (codex-host-adapter): --host total classification ─────────────────
  // Codex's hooks.json entries invoke this with a trailing ` --host codex`
  // (see scripts/lib/host-target.js / install.js S3) so the SAME flag the
  // Claude Code hooks path never sends must still be recognized and validated
  // here — a malformed --host is a refusal (exit 2), never silently ignored.
  // This check runs BEFORE the "swallow errors, exit 0" convention below: a
  // malformed invocation is a caller bug (bad hooks.json), not a runtime
  // condition the hook should degrade gracefully around.
  let host = 'claude';
  {
    const hostResult = resolveHost(args || [], process.env);
    if (!hostResult.ok) {
      process.stderr.write(`handoff loader-hook: refusing — ${hostResult.reason}\n`);
      process.exit(2);
    }
    host = hostResult.host;
  }
  // All errors are swallowed and exit 0 — the hook must never break session start.
  // S3: read the SessionStart hook JSON (source / session_id) up front. This is
  // read-only and side-effect-free — safe to do before the handoff.md-existence
  // no-op check below. A missing/malformed payload (e.g. a manual invocation
  // with no stdin, as the plugin-packaging tests do) degrades to the pre-S3
  // default: source is treated as unset (never 'clear'/'compact'), so the
  // late-close sweep still runs exactly as it would today.
  const hookPayload = readHookStdinPermissive();
  let db = null;
  try {
    const projectId   = resolveProjectId();
    const handoffPath = resolveHandoffMdPath(projectId);

    // Silent no-op when handoff.md is absent (non-claude-memory project or not yet init-ed).
    if (!fs.existsSync(handoffPath)) {
      process.exit(0);
    }

    const fm         = readHandoffFrontmatter(handoffPath);
    const lastClose  = fm.last_close || null;
    const daysN      = daysSince(lastClose);
    const daysLabel  = daysN !== null ? `${daysN} days ago` : 'never';

    try {
      db = await connectHandoff();
    } catch (err) {
      // DB unavailable — exit silently, do not break session start.
      process.stderr.write(`handoff loader-hook: DB connection failed (${err.message}) — skipping\n`);
      process.exit(0);
    }

    const stalenessDays = parseInt(
      await getSetting(db, projectId, 'staleness_days', '7'),
      10
    );

    // ── Staleness gate ────────────────────────────────────────────────────────
    if (daysN !== null && daysN > stalenessDays) {
      process.stderr.write(
        `Running: handoff loader (project=${projectId}, last=${daysLabel}, STALE — threshold=${stalenessDays})\n`
      );

      await db.end();

      const staleMsg = [
        `⚠️  Handoff context is STALE (last close: ${lastClose}, ${daysN} days ago — threshold ${stalenessDays} days).`,
        '',
        'The auto-loader did not inject context. To proceed, run one of:',
        '  /handoff:status   — see counts and last-close details',
        '  /handoff:resume   — load context anyway, despite staleness',
        '  /handoff:drop     — archive prior session memory and start fresh',
      ].join('\n');

      // Single-line JSON on stdout — hook parser requirement.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: staleMsg,
          },
        }) + '\n'
      );

      process.stderr.write('Done: handoff loader — staleness gate triggered, no context injected\n');
      process.exit(0);
    }

    // ── Non-stale path: load and inject context ───────────────────────────────
    process.stderr.write(
      `Running: handoff loader (project=${projectId}, last=${daysLabel})\n`
    );

    const result = await cmdLoaderLoad({ silent: true, db });

    // Re-connect db if cmdLoaderLoad closed it (ownDb path); re-open for the marker write.
    // In practice cmdLoaderLoad receives our db via opts.db so it doesn't close it, but
    // guard defensively: connectHandoff again only if needed.
    let markerDb = db;
    let markerDbOwned = false;
    if (!markerDb || markerDb._ending) {
      try {
        markerDb = await connectHandoff();
        markerDbOwned = true;
      } catch (_) {
        markerDb = null;
      }
    }

    // ── S3: per-session marker — late-close sweep, then write the fresh marker ──
    //
    // Skipped entirely on /clear and /compact: those SessionStart events fire
    // for the SAME logical session continuing (not a new one whose siblings'
    // markers should be judged stale). Running the sweep there risks a
    // false-positive DIVERGENCE banner on ordinary /clear.
    //
    // The sweep AND the fresh-marker write are folded into ONE
    // withSessionMarkerLock-guarded transaction (rather than two separate
    // calls) — folding them avoids a nested BEGIN (addSessionMarker takes
    // its own lock) and closes the race window between "sweep decided which
    // markers are stale" and "fresh marker written" that two separate locked
    // transactions would otherwise leave open.
    const hookSource       = (hookPayload && typeof hookPayload.source === 'string') ? hookPayload.source : null;
    // PR4 R4: host-independent add-time resolution (never guesses across an
    // ambiguous env pair) — an unresolved env pair mints a fresh id and
    // APPENDS rather than dedupe-overwriting a sibling's real marker.
    const currentSessionId = resolveClearSessionId(hookPayload) || crypto.randomUUID();
    let lateCloseDivergenceLines = [];

    if (markerDb) {
      try {
        await withSessionMarkerLock(markerDb, projectId, async () => {
          let markers = await getSessionMarkers(markerDb, projectId);

          if (hookSource !== 'clear' && hookSource !== 'compact') {
            const implicitCloseLate = await getSetting(markerDb, projectId, 'implicit_close', 'enabled');
            if (implicitCloseLate === 'enabled') {
              const staleHoursRaw = parseInt(
                await getSetting(markerDb, projectId, 'implicit_close_stale_hours', '24'),
                10
              );
              const staleHours = (Number.isFinite(staleHoursRaw) && staleHoursRaw > 0) ? staleHoursRaw : 24;
              const staleMs    = staleHours * 60 * 60 * 1000;

              const staleForeign = [];
              const kept         = [];
              for (const m of markers) {
                const isForeign = m.session_id !== currentSessionId;
                if (!isForeign) { kept.push(m); continue; }
                const ageMs = Date.now() - Date.parse(m.ts);
                // NaN age (unparseable ts) is treated as stale — a garbage marker
                // must eventually be cleaned up, never left orphaned forever.
                const isStale = Number.isNaN(ageMs) || ageMs > staleMs;
                if (isStale) staleForeign.push(m); else kept.push(m);
              }

              if (staleForeign.length > 0) {
                // ONE implicit close for the project — not one per stale marker
                // (there is only one handoff.md).
                writeImplicitClose(handoffPath, projectId, findProjectRoot());
                markers = kept;
                lateCloseDivergenceLines = staleForeign.map(
                  (m) => `DIVERGENCE: late implicit close for session ${m.session_id || '(legacy marker)'} (marker ts ${m.ts})`
                );
              }
            }
          }

          // Write the fresh marker for THIS session so a true SessionEnd
          // (loader-stop) knows a close is still needed — inline rather than
          // via addSessionMarker (which would attempt a nested BEGIN here).
          // Codex review C1 (fix/usage-record-marker-fallback follow-up):
          // stamp `host` ('claude'|'codex', resolved from --host above) onto
          // the marker so scripts/lib/session-identity.js's
          // resolveUsageRecordMarkerDefault — used ONLY by the MCP
          // usage_record tool's sessionId default, never by this file's own
          // resolveSessionId — can filter out a stale marker from a
          // different host instead of accepting any live project marker.
          // Backward compatible: a marker written before this change (or by
          // /handoff:resume, which does not stamp host) simply has no host
          // field — parseSessionMarkersStrict/filterMarkersByHost treat that
          // as "unknown", never as a crash or a schema change here.
          const filtered = currentSessionId
            ? markers.filter((m) => m.session_id !== currentSessionId)
            : markers;
          filtered.push({ session_id: currentSessionId || null, ts: new Date().toISOString(), host });
          await setSessionMarkers(markerDb, projectId, filtered);
        });
      } catch (markerErr) {
        process.stderr.write(`[handoff] loader-hook: late-close sweep / marker write failed (non-fatal): ${markerErr.message}\n`);
      }
    }

    if (markerDbOwned && markerDb) await markerDb.end();
    else if (!markerDbOwned && db) await db.end();

    const finalOutputText = lateCloseDivergenceLines.length > 0
      ? `${result.outputText}\n\n${lateCloseDivergenceLines.join('\n')}`
      : result.outputText;

    // Single-line JSON on stdout.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: finalOutputText,
        },
      }) + '\n'
    );

    process.stderr.write(
      `Done: handoff loader — injected ${result.assertionsCount} assertions, ${result.entitiesCount} entities, ${result.vectorCount} vector matches\n`
    );

    process.exit(0);

  } catch (err) {
    // Catch-all: log to stderr, never break session start.
    process.stderr.write(`handoff loader-hook error: ${err.message}\n`);
    if (db) {
      try { await db.end(); } catch (_) { /* ignore */ }
    }
    process.exit(0);
  }
}

// ── resume ────────────────────────────────────────────────────────────────────

async function cmdResume() {
  console.log('Running: handoff:resume');
  const result = await cmdLoaderLoad();

  // Seed session_in_progress so the SessionEnd hook and cmdClose can resolve
  // session_id for C2 bias attribution.  The SessionStart auto-loader hook seeds
  // this same marker on hook-triggered sessions; manual /handoff:resume must do
  // the same. cmdLoaderLoad opens and closes its own db connection (ownDb path),
  // so we open a fresh connection here for the marker write — identical
  // defensive pattern to the loader-hook block above.
  try {
    const projectId = resolveProjectId();
    let markerDb = null;
    let markerDbOwned = false;
    try {
      markerDb = await connectHandoff();
      markerDbOwned = true;
    } catch (_) {
      markerDb = null;
    }
    if (markerDb) {
      // PR4 R4: host-independent add-time resolution (see resolveClearSessionId).
      const resumeSessionId = resolveClearSessionId(null) || crypto.randomUUID();
      await addSessionMarker(markerDb, projectId, resumeSessionId, new Date().toISOString());
      if (markerDbOwned) await markerDb.end();
    }
  } catch (markerErr) {
    // Non-fatal: marker write failure must never abort resume.
    process.stderr.write(`[handoff] resume: session_in_progress marker write failed (non-fatal): ${markerErr.message}\n`);
  }

  console.log(`\nDone: handoff:resume — injected ${result.assertionsCount} assertions, ${result.entitiesCount} entities, ${result.vectorCount} vector matches`);
}

// ── drop ──────────────────────────────────────────────────────────────────────

async function cmdDrop() {
  console.log('Running: handoff:drop');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Suppress all assertions for this project (keeps rows for recovery).
  const dropRes = await db.query(
    `UPDATE assertions SET suppressed = true WHERE project_id = $1`,
    [projectId]
  );
  const zerodCount = dropRes.rowCount || 0;

  // Archive handoff.md
  let archivePath = null;
  if (fs.existsSync(handoffPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    archivePath = handoffPath.replace(/handoff\.md$/, `handoff.${stamp}.archived.md`);
    fs.renameSync(handoffPath, archivePath);
  }

  // Create new empty handoff.md
  const root = findProjectRoot();
  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          new Date().toISOString(),
    CONTRACT:            'default',
    ENTITIES_WRITTEN:    '0',
    ASSERTIONS_WRITTEN:  '0',
    EDGES_WRITTEN:       '0',
    PROJECT_NAME:        path.basename(root),
    TLDR:                '(dropped — prior session memory archived)',
    OPEN_THREADS:        '- (none)',
    QUICK_REFERENCES:    '(none)',
    DEGRADED_SECTION:    '\n\n<!-- dropped — prior session memory archived -->',
    RECONCILIATION_SECTION: '',
  });

  await db.end();

  console.log(`\n  assertions zeroed: ${zerodCount}`);
  if (archivePath) console.log(`  archived: ${archivePath}`);
  console.log(`  new handoff.md: ${handoffPath}`);
  console.log(`\nDone: handoff:drop — ${zerodCount} assertions suppressed, handoff.md archived`);
}

// ── extraction (shared by checkpoint and close) ───────────────────────────────

/**
 * 4A — Cardinality-aware write-time supersession helper.
 *
 * For each incoming assertion, execute the two-step suppress+INSERT within an
 * explicit transaction so the pair is atomic (spec §4A mechanism-a):
 *
 *   1:1 predicate — suppress any existing live row for (project_id, subject, predicate).
 *   1:N predicate — suppress only an exact duplicate (project_id, subject, predicate, object).
 *   Unrecognized  — permissive fallback → treat as 1:N (classifyPredicate handles this).
 *
 * COHERENCE CONTRACT (OQ-5): the WHERE-key used here is the canonical supersession key.
 * The 4D distillation migration script applies the same key directly; shared test fixtures
 * enforce correctness of both paths.  The steady-state write path (this function) and the
 * migration MUST NOT diverge in their key selection.
 *
 * @param {object} db            — pg Client
 * @param {string} projectId     — encoded_cwd
 * @param {object} ass           — assertion object: {subject, predicate, object, confidence, source}
 * @param {string} sessionId     — session_id (may be null)
 * @param {string} registryMode  — 'permissive'|'strict'
 * @param {object} [opts]        — cm#231: opts.returnRow (boolean, default false).
 *   When false/omitted, the return contract is BYTE-IDENTICAL to every existing
 *   call site (a plain boolean — true if a row was inserted, false if skipped/
 *   touch-only). When true (used by the MCP assertion_create/assertion_update
 *   write path, cm#231), returns a richer object instead:
 *     { inserted: true,  row: <the newly-inserted row> }
 *     { inserted: false, row: <the touch-only-bumped row>, touchOnly: true }
 *     { inserted: false, row: null, skipped: true, reason: <string> }  — strict-mode
 *       registry rejection (unrecognized predicate); the caller decides whether
 *       that is a hard error (MCP single-call API) or a swallowed skip (close
 *       payload batch).
 * @returns {boolean|object} see opts.returnRow above.
 */
// cm#231: named tier constants — the assertions.tier CHECK constraint's own
// authoritative vocabulary (handoff-core-schema.sql:
// CHECK (tier IN ('probationary', 'consolidated'))). writeAssertionWithSupersession's
// own L0/L2 gate branches below keep their pre-existing inline literals unchanged
// (this function's tier-decision logic is unchanged by cm#231 — touching it risks
// the very consolidation-gate invariants L0/L2's test suites pin byte-for-byte).
// These constants exist so that OTHER write paths that need to mint a fresh,
// never-corroborated assertion row (entity-graph-crud.js's assertionCreate/
// assertionUpdate, cm#231) reference the SAME string values by name instead of
// re-typing the literal — never a second, independently-typo-able copy of the
// vocabulary.
const ASSERTION_TIER_PROBATIONARY = 'probationary';
const ASSERTION_TIER_CONSOLIDATED = 'consolidated';

async function writeAssertionWithSupersession(db, projectId, ass, sessionId, registryMode, opts) {
  opts = opts || {};
  // Classify predicate cardinality.  strict throws for unrecognized; permissive returns 1:N.
  let cardinality;
  try {
    const classification = classifyPredicate(ass.predicate, registryMode);
    if (!classification.recognized && registryMode !== 'strict') {
      process.stderr.write(
        `[handoff] unrecognized predicate "${ass.predicate}" — registry permissive mode, treated 1:N (flag for registry extension)\n`
      );
    }
    cardinality = classification.cardinality;
  } catch (regErr) {
    // strict mode: skip
    process.stderr.write(
      `[handoff] skipping assertion (predicate="${ass.predicate}"): ${regErr.message}\n`
    );
    if (opts.returnRow) return { inserted: false, row: null, skipped: true, reason: regErr.message };
    return false;
  }

  const conf   = Math.min(10, Math.max(1, parseFloat(ass.confidence) || 5));
  const source = ['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior'].includes(ass.source)
    ? ass.source : 'model_extracted';

  // ── Spine step 5: prospective subject canonicalization (Option 2, §7-honoring) ──
  //
  // Canonicalize the incoming subject: trim + lowercase + collapse whitespace + alias-map.
  // The NEW row is inserted with the canonical subject.
  //
  // Canonical-aware supersession match (application-code approach — dialect-neutral):
  //   We fetch candidate prior live rows scoped to (project_id, predicate [+ object for 1:N]),
  //   canonicalize each stored subject in JS, and identify those whose canonical form equals
  //   the new canonical subject.  We then suppress those rows by calling buildSupersessionUpdate
  //   with their stored subject (so the existing PR-B mechanism handles dialect-specific
  //   boolean/timestamp SQL — zero new dialect conditionals in the engine).
  //
  //   Rationale: dialect-specific SQL expressions like lower(regexp_replace(...)) are NOT
  //   portable — SQLite (node:sqlite, zero extensions) has no regexp_replace.  The
  //   application-code approach uses only plain SELECT + the existing suppression port method,
  //   both already dialect-neutral.
  //
  // §7 zero-corpus-mutation guarantee:
  //   The ONLY writes are: (a) the new INSERT with canonical subject, and (b) the existing
  //   PR-B suppression mechanism setting suppressed/invalid_at/suppression_kind on matched rows.
  //   We NEVER issue UPDATE assertions SET subject = ... on any existing row.
  //   A matched prior row's stored subject column is NOT modified — it retains its original
  //   byte-for-byte value.  The suppression path (buildSupersessionUpdate) writes only
  //   suppressed, invalid_at, and suppression_kind — never the subject column.
  const canonSubject = canonicalize(ass.subject);

  // ── Write-time embedding (init-embeddability spec A2) ─────────────────────
  // Computed BEFORE opening the transaction below — never hold a
  // transaction open across a network round-trip (same discipline
  // decisions-writer.js's persistDecisionRow/write-time-embed.js's
  // writeRowWithProvenanceRetry already follow for the `decisions` table).
  // Postgres-only: handoff-sqlite-schema.sql declares no `embedding` column
  // on ANY table — the dialect-neutral engine skips the attempt entirely on
  // SQLite rather than computing a vector it could never store (no
  // per-call dialect branch needed elsewhere: `hasEmbedding` below is
  // simply always false on that backend). Fail-soft always: embedForWrite
  // never throws — a failure (no default provider, network error, bounded
  // timeout) yields vectorLiteral:null, and the INSERT below omits the
  // embedding columns entirely (backfillable-NULL via `backfill-embeddings`).
  // opts.embedder/opts.embedderProviderId (test-only, both-or-neither) and
  // opts.embedTimeoutMs are threaded straight to embedForWrite; opts.warnSink,
  // when supplied as an array, collects a `{predicate, subject, message,
  // kind:'embed_degraded'}` entry per degraded embed — writeExtraction uses
  // only this array's LENGTH (assertionEmbedWarnCount below), never its
  // contents: it is counted into the Done line's `embed_warnings` figure,
  // never rendered into handoff.md (init-embeddability A2, PR #260 — see
  // the header comment above the assertionWriteFailures/assertionEmbedWarnCount
  // declarations below for the full rationale, which decisions[] shares).
  const embedSkipped = (db && typeof db.supportsEmbeddingColumns === 'function' && !db.supportsEmbeddingColumns())
    || !!opts.embeddingsOptedOut;
  const embedResult = embedSkipped
    ? { vectorLiteral: null, providerId: null, warning: null }
    : await embedForWrite(db, canonSubject, {
        embedder: opts.embedder,
        embedderProviderId: opts.embedderProviderId,
        timeoutMs: opts.embedTimeoutMs,
      });
  if (embedResult.warning && Array.isArray(opts.warnSink)) {
    opts.warnSink.push({
      predicate: ass.predicate,
      subject: canonSubject,
      message: embedResult.warning,
      kind: 'embed_degraded',
    });
  }

  // Wrap suppress+INSERT in an explicit transaction (atomicity requirement I-A mechanism-a).
  //
  // PR-B: supersession is enriched via db.buildSupersessionUpdate() which sets:
  //   suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
  // on the prior live row(s).  Rows with pinned = true are EXEMPT from auto-suppression
  // here — they are skipped by buildSupersessionUpdate's WHERE clause.
  // Note: explicit user re-statement of a 1:1 predicate WILL supersede a pinned row
  // (pinned blocks C2 AUTO actions, not explicit writes — documented distinction).
  //
  // The new INSERT also sets valid_at = now() to record when the assertion became live.
  await db.query('BEGIN');
  try {
    // ── Step 1: Canonical-aware match — find prior live rows to suppress ──────────
    //
    // Fetch candidate rows using only the non-subject scope keys (project_id, predicate
    // [+ object for 1:N]), suppressed=false AND invalid_at IS NULL, non-pinned.
    // Canonicalize each stored subject in JS.  Collect the stored subjects of rows whose
    // canonical form equals canonSubject — these are the rows to suppress.
    //
    // We group by stored subject so that each unique stored subject triggers exactly one
    // buildSupersessionUpdate call.  This handles both the exact-match case (stored subject
    // already canonical) and the variant-spelling case (stored subject differs in case/whitespace
    // but maps to the same canonical form).
    // Note on pinned guard: we omit the pinned filter from the candidate SELECT intentionally.
    // buildSupersessionUpdate already guards on pinned (= 0 for SQLite, = false OR IS NULL for
    // Postgres) — so even if a pinned candidate is collected here, it will be skipped by the
    // UPDATE's WHERE clause.  Omitting the pinned filter here keeps the SELECT dialect-neutral
    // (no boolean literal that differs between backends).
    const storedSubjectsToSuppress = new Set();
    // Touch-only ids: same-session exact repeats that should only have last_reinforced bumped,
    // NOT suppressed+reinserted. Accumulate across both cardinalities before deciding path.
    const touchOnlyIds = [];
    // Two-tier durability: track corroboration signals from 1:N exact-duplicate matches.
    // For 1:N only (pre-L0): collect session_id and corroboration_count from canonical-matched
    // prior live rows to determine cross-session corroboration (hybrid consolidation trigger b).
    // See the INSERT below for how these are used to compute tier and corroboration_count.
    //
    // L0: crossSessionCorroborated is also set for 1:1 cardinality when the same
    // (subject, predicate, object) was seen from a distinct prior non-null session_id.
    // The disabled-mode path uses preLo1NCorroborated (1:N only, pre-L0 formula) to
    // preserve byte-identical behavior when the gate is disabled.
    let crossSessionCorroborated = false; // L0 enforce gate: both 1:1 and 1:N
    let preLo1NCorroborated      = false; // disabled-mode path: 1:N only (pre-L0 formula)
    let maxPriorCorrob = 1;

    // L2: track whether at least one cross-session corroborating row is independently
    // trustworthy (reality_check='verified' OR pinned=true/1).
    // This is the positive-evidence quality plug — the load-bearing L2 element.
    let hasQualityCorroborator = false; // ≥1 independently-trustworthy corroborating prior row

    if (cardinality === '1:1') {
      const { rows: candidates } = await db.query(
        `SELECT id, subject, object, session_id, confidence, source, reality_check, pinned FROM assertions
         WHERE project_id = $1
           AND predicate  = $2
           AND suppressed = false
           AND invalid_at IS NULL`,
        [projectId, ass.predicate]
      );
      for (const r of candidates) {
        if (canonicalize(r.subject) === canonSubject) {
          // Same-session exact repeat (1:1): object, conf, source, session all match →
          // touch-only (bump last_reinforced only; no new row, no suppression).
          if (
            r.object === ass.object &&
            r.session_id != null && sessionId != null &&
            r.session_id === sessionId &&
            Number(r.confidence) === conf && r.source === source
          ) {
            touchOnlyIds.push(r.id);
          } else {
            storedSubjectsToSuppress.add(r.subject);
            // L0: Cross-session corroboration for 1:1 — same (subject, predicate, object)
            // asserted from a DISTINCT non-null session_id counts as genuine corroboration.
            // Same-session re-assertion (or null session_id on either side) does NOT count.
            // Note: the 1:1 corroboration signal is ONLY used by the L0 enforce gate;
            // the disabled-mode path preserves the pre-L0 formula exactly (see Step 3).
            if (
              r.object === ass.object &&
              r.session_id !== null && r.session_id !== undefined &&
              sessionId !== null && sessionId !== undefined &&
              r.session_id !== sessionId
            ) {
              crossSessionCorroborated = true;
              // L2 quality plug: this corroborating row is independently trustworthy if
              // reality_check='verified' OR pinned=true/1.
              if (r.reality_check === 'verified' || r.pinned === true || r.pinned === 1) {
                hasQualityCorroborator = true;
              }
            }
          }
        }
      }
    } else {
      // 1:N: only exact (project_id, subject[canonical], predicate, object) duplicates.
      // Also retrieve session_id and corroboration_count for the Hybrid consolidation check.
      // Cross-session corroboration requires: both session_ids non-null AND DISTINCT from each other.
      // Same-session re-assertion does NOT graduate. NULL session_id on either side is NOT corroboration.
      const { rows: candidates } = await db.query(
        `SELECT id, subject, session_id, corroboration_count, confidence, source, reality_check, pinned FROM assertions
         WHERE project_id = $1
           AND predicate  = $2
           AND object     = $3
           AND suppressed = false
           AND invalid_at IS NULL`,
        [projectId, ass.predicate, ass.object]
      );
      for (const r of candidates) {
        if (canonicalize(r.subject) === canonSubject) {
          // Same-session exact repeat (1:N): conf, source, session all match →
          // touch-only (bump last_reinforced only; skip suppression + corroboration tracking).
          if (
            r.session_id != null && sessionId != null &&
            r.session_id === sessionId &&
            Number(r.confidence) === conf && r.source === source
          ) {
            touchOnlyIds.push(r.id);
            continue; // skip suppression + corroboration tracking for this row
          }
          storedSubjectsToSuppress.add(r.subject);
          // Cross-session corroboration check: prior row must have a non-null session_id
          // that is DISTINCT from the incoming sessionId (also non-null).
          if (
            r.session_id !== null && r.session_id !== undefined &&
            sessionId !== null && sessionId !== undefined &&
            r.session_id !== sessionId
          ) {
            crossSessionCorroborated = true; // L0 enforce path
            preLo1NCorroborated      = true; // disabled-mode path (pre-L0 formula, 1:N only)
            // L2 quality plug: this corroborating row is independently trustworthy if
            // reality_check='verified' OR pinned=true/1.
            if (r.reality_check === 'verified' || r.pinned === true || r.pinned === 1) {
              hasQualityCorroborator = true;
            }
          }
          // Track max corroboration_count among matched priors (for new row's count).
          const priorCount = typeof r.corroboration_count === 'number'
            ? r.corroboration_count
            : parseInt(r.corroboration_count, 10) || 1;
          if (priorCount > maxPriorCorrob) maxPriorCorrob = priorCount;
        }
      }
    }

    // ── Touch-only short-circuit ───────────────────────────────────────────────
    // ALL matched live candidates are same-session exact repeats: bump last_reinforced/
    // last_retrieved only via buildBumpAssertions, then commit and return false.
    // No new row, no suppression, no advance of valid_at/tier/consolidated_at/corroboration_count.
    // Mixed case (some touch-only + some suppress): fall through to normal suppress+INSERT path.
    if (touchOnlyIds.length > 0 && storedSubjectsToSuppress.size === 0) {
      const bumpStmt = db.buildBumpAssertions(touchOnlyIds);
      if (bumpStmt) await db.query(bumpStmt.sql, bumpStmt.params);
      if (opts.returnRow) {
        const { rows: touched } = await db.query(
          `SELECT * FROM assertions WHERE id = $1`, [touchOnlyIds[0]]
        );
        await db.query('COMMIT');
        return { inserted: false, row: touched[0] || null, touchOnly: true };
      }
      await db.query('COMMIT');
      return false; // no new row; caller must NOT increment assertionsWritten
    }

    // ── Step 2: Suppress matched prior rows via the existing PR-B port method ────
    //
    // buildSupersessionUpdate(cardinality, projectId, storedSubject, predicate, object)
    // matches on the exact stored subject in its WHERE clause.  Passing the stored subject
    // (not the canonical one) ensures it hits the exact rows we identified above.
    // This reuses the existing mechanism without modification — the subject column of
    // the matched rows is NEVER updated (only suppressed/invalid_at/suppression_kind).
    for (const storedSubject of storedSubjectsToSuppress) {
      const supersessionStmt = db.buildSupersessionUpdate(
        cardinality, projectId, storedSubject, ass.predicate, ass.object
      );
      await db.query(supersessionStmt.sql, supersessionStmt.params);
    }

    // ── Step 3: INSERT the new row with canonical subject ─────────────────────────
    //
    // Two-tier durability (Hybrid consolidation trigger):
    //   (a) High-trust: source='user_stated' AND confidence >= 9 — subject to L0 gate (see below).
    //   (b) Cross-session corroboration: same (subject, predicate, object) asserted
    //       from a DISTINCT non-null prior-session row → tier='consolidated'.
    //       (1:N tracked via the candidate loop above; 1:1 also tracked since L0.)
    //   Otherwise → tier='probationary'.
    //
    // L0 — consolidation_corroboration_gate (Attack-1 single-close forge prevention):
    //   When setting = 'enforce' (DEFAULT): the FULL newTier consolidated-birth decision
    //   is gated on genuine cross-session corroboration (crossSessionCorroborated = true).
    //   Defense-in-depth: the gate covers the ENTIRE decision (not just the isHighTrust
    //   boolean term) — both trigger (a) and trigger (b) require corroboration.
    //   A single close cannot self-stamp consolidated regardless of the source/confidence
    //   values it supplies — those are model-controlled fields. Only persisted, distinct
    //   prior close rows from a different session_id (which the closing model cannot
    //   fabricate in one close) satisfy the gate.
    //   If corroboration does NOT hold: row is born probationary (data fully preserved;
    //   probationary still participates in retrieval, ranked below consolidated).
    //   When setting = 'disabled': reverts to pre-L0 behavior byte-for-byte.
    //   The pre-L0 formula was: (isHighTrust || (cardinality === '1:N' && 1:N-corroboration))
    //   which is reproduced exactly via preLo1NCorroborated (1:N only, the original variable).
    //   Pinned rows: pinned is a suppression-exemption flag; not a tier-grant flag at write
    //   time. L0 does not alter pinned handling (suppression path, unaffected by newTier).
    //
    // L2 — consolidation_gate_mode (patient-adversary quality plug):
    //   Builds on L0 with a 3-arm gate.  A row is born consolidated ONLY IF:
    //     Arm (a) — reality-verified: this assertion's corroborating row OR the incoming
    //               close's own reality_check will be 'verified' (L3 reality-bound). However,
    //               the incoming row's reality_check is written AFTER the INSERT by the L3
    //               verify pass. For the L2 arm (a), we check whether the insertion context
    //               will be verified: not feasible at INSERT time without circular dependency.
    //               Instead, arm (a) is implemented via the pinned/reality_check check on
    //               the incoming assertion's own prior corroborators (or operator-confirmed).
    //               See note below: arm (a) for the NEW row itself is handled post-INSERT by
    //               cmdClose's L3 pass re-evaluating reality_check='verified' rows (these rows
    //               are already born consolidated by arm (a) if they arrive with a verified prior).
    //     Arm (b) — corroborated AND quality-plugged: crossSessionCorroborated=true AND
    //               hasQualityCorroborator=true (≥1 corroborating prior-session row is
    //               independently trustworthy: reality_check='verified' OR pinned).
    //     Arm (c) — operator-confirmed: the incoming assertion's pinned flag is true.
    //               This is the only genuine second actor in a single-operator system.
    //   Count-based thresholds (THR) are RETIRED: N corroborations is never the criterion.
    //   Only ONE independently-trustworthy corroborator is needed — adding more self-stamped
    //   corroborations never changes the outcome (a patient attacker cannot forge quality).
    //
    //   NOTE on the "genuinely user-evidenced" corroborator path: the design also names
    //   "genuinely user-evidenced" as a trustworthy basis, but that depends on L1
    //   (model-independent transcript capture) which is NOT implemented. In v1, the
    //   independently-trustworthy predicate is: (reality_check='verified') OR (pinned).
    //   The user-evidenced arm activates when L1 lands.
    //
    // consolidation_gate_mode: new setting controlling L2 behavior.
    //   disabled: L2 inert — tier outcomes byte-identical to post-L0 main (L0 gate applies).
    //   report:   compute L2 decision, LOG would-withhold, but do NOT change tier outcomes.
    //             (DEFAULT — mandatory report window before enforce)
    //   enforce:  full L2 3-arm gate actually decides tier.
    //
    // consolidated_at: set to now() when consolidated, SQL NULL otherwise.
    // corroboration_count: 1 + maxPriorCorrob when cross-session corroboration fires; 1 otherwise.
    //
    // SQL style note: consolidated_at uses now() (PG) / datetime('now') (SQLite) as a raw SQL
    // fragment embedded in the query string (matching the existing valid_at / last_reinforced
    // style) — NOT as a JS parameter.  The SQLiteAdapter's rewriteForSQLite regex rewrites
    // now() → datetime('now') automatically.  Do not parametrize a SQL function.
    //
    // L0 gate: read once, inside the transaction (plain SELECT — safe, no write).
    const corrobGate  = await getSetting(db, projectId, 'consolidation_corroboration_gate', 'enforce');
    const gateMode    = await getSetting(db, projectId, 'consolidation_gate_mode', 'enforce');
    const isHighTrust = (source === 'user_stated' && conf >= 9);
    const isPinned    = (ass.pinned === true || ass.pinned === 1);

    // L2 arm evaluation (evaluated regardless of gateMode for report/enforce use):
    //   arm (a): any corroborating prior row has reality_check='verified' (or is itself pinned)
    //            — hasQualityCorroborator already captures this from the candidate loop above.
    //   arm (b): crossSessionCorroborated AND hasQualityCorroborator.
    //   arm (c): the incoming assertion is operator-pinned.
    const l2ArmA = hasQualityCorroborator; // independently-trustworthy corroborator exists
    const l2ArmB = crossSessionCorroborated && hasQualityCorroborator;
    const l2ArmC = isPinned; // operator-confirmed
    const l2Consolidates = l2ArmA || l2ArmB || l2ArmC;

    // L0 tier outcome (used as base for disabled/report modes):
    const l0Tier = (corrobGate === 'disabled')
      ? ((isHighTrust || (cardinality === '1:N' && preLo1NCorroborated)) ? 'consolidated' : 'probationary')
      : (crossSessionCorroborated ? 'consolidated' : 'probationary');

    // newTier — full consolidated-birth decision considering both L0 and L2:
    let newTier;
    if (gateMode === 'enforce') {
      // L2 enforce: full 3-arm gate.
      newTier = l2Consolidates ? 'consolidated' : 'probationary';
    } else {
      // disabled or report: tier outcome is byte-identical to L0 (post-L0 main behavior).
      newTier = l0Tier;
      if (gateMode === 'report' && l0Tier === 'consolidated' && !l2Consolidates) {
        // Report mode: log what WOULD be withheld under enforce (but do NOT change the tier).
        process.stderr.write(
          `[handoff] L2 report: would-withhold consolidated→probationary for ` +
          `${canonSubject} ${ass.predicate} "${ass.object}" ` +
          `(crossSessionCorroborated=${crossSessionCorroborated}, hasQualityCorroborator=${hasQualityCorroborator}, pinned=${isPinned})\n`
        );
      }
    }

    const consolidatedAtSql = (newTier === 'consolidated') ? 'now()' : 'NULL';
    const newCorrob = (cardinality === '1:N' && crossSessionCorroborated)
      ? (maxPriorCorrob + 1)
      : 1;

    // RETURNING id: harmless addition for every existing caller (none of them
    // destructure the query result today) — cm#231's opts.returnRow path uses
    // it to fetch the full row below, inside the same transaction, before COMMIT.
    //
    // Embedding columns are included ONLY when embedResult actually produced
    // a vector (mirrors memory-upsert.js's upsertDecisionRow convention
    // exactly) — never referenced at all when embedForWrite failed soft, so
    // a DB with the embedding column genuinely absent (pgvector not
    // installed / gated DDL skipped) never sees a 42703 on the common,
    // no-provider-configured path (the byte-identical-SQL case every
    // pre-existing test exercises). When a vector WAS produced but the
    // column is unexpectedly absent (a live but pgvector-degraded DB with a
    // provider configured anyway), the 42703 is reclassified to a named
    // EmbeddingColumnAbsentError below, same as decisions.
    const hasEmbedding = embedResult.vectorLiteral !== null;
    const insertSql = hasEmbedding
      ? `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source, session_id,
            last_reinforced, valid_at, tier, consolidated_at, corroboration_count,
            embedding, embedded_by_provider_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, ${consolidatedAtSql}, $9, $10::halfvec, $11)
         RETURNING id`
      : `INSERT INTO assertions
           (project_id, subject, predicate, object, confidence, source, session_id,
            last_reinforced, valid_at, tier, consolidated_at, corroboration_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, ${consolidatedAtSql}, $9)
         RETURNING id`;
    const insertParams = hasEmbedding
      ? [projectId, canonSubject, ass.predicate, ass.object, conf, source, sessionId,
         newTier, newCorrob, embedResult.vectorLiteral, embedResult.providerId]
      : [projectId, canonSubject, ass.predicate, ass.object, conf, source, sessionId,
         newTier, newCorrob];

    let insertResult;
    try {
      insertResult = await db.query(insertSql, insertParams);
    } catch (err) {
      const embedErr = classifyEmbeddingWriteError(err, 'assertions');
      if (embedErr) throw embedErr;
      throw err;
    }

    if (opts.returnRow) {
      const insertedId = insertResult && insertResult.rows && insertResult.rows[0]
        ? insertResult.rows[0].id : null;
      const { rows: inserted } = await db.query(
        `SELECT * FROM assertions WHERE id = $1`, [insertedId]
      );
      await db.query('COMMIT');
      return { inserted: true, row: inserted[0] || null };
    }

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }

  return true;
}

// Shared SQL fragment: excludes pinned rows from a match (pinned=false OR
// pinned IS NULL passes; pinned=true is excluded). Used by the auto-retire
// query below AND by scripts/lib/carryover-render.js's applyCarryoverDeltas
// (§7.1/S-12c) -- reused BY REFERENCE, never reimplemented, so both call
// sites can never drift out of sync on what "pinned" means for matching
// purposes. Pure string constant: exporting it changes no behavior here.
const PINNED_EXCLUSION_SQL = '(pinned = false OR pinned IS NULL)';

/**
 * cm#233: classify every entry of a `resolved_threads` payload array against
 * the project's currently-live `open_thread` rows. Read-only (one SELECT) —
 * used identically by writeExtraction's real auto-retire (which additionally
 * performs the suppression UPDATE for MATCHED-AND-RESOLVED entries) and by
 * cmdClose's --dry-run preview (which never mutates), so the two code paths
 * can never classify the same payload differently.
 *
 * Total classification, one verdict per entry:
 *   MATCHED-AND-RESOLVED — the entry's intentKey matches (intentKeyEquals)
 *     at least one live, non-pinned open_thread row's subject.
 *   UNMATCHED-REPORTED   — a valid key with no live-row match. Never silent
 *     — the caller must print it (see printResolvedThreadsClassification).
 *   INVALID-REJECTED     — the entry normalizes to an empty intentKey
 *     (blank/whitespace-only text). Never silent — printed and skipped.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {Array<string>} resolvedThreads - raw payload.resolved_threads
 * @returns {Promise<Array<{text:string, key:string, verdict:string, matchedIds:number[]}>>}
 */
async function classifyResolvedThreads(db, projectId, resolvedThreads) {
  const { rows: liveRows } = await db.query(
    `SELECT id, subject FROM assertions
     WHERE project_id = $1 AND predicate = 'open_thread'
       AND suppressed = false AND invalid_at IS NULL
       AND ${PINNED_EXCLUSION_SQL}`,
    [projectId]
  );
  const results = [];
  for (const raw of (resolvedThreads || [])) {
    const text = String(raw == null ? '' : raw).trim();
    const key = intentKey(text);
    if (!key) {
      results.push({ text, key, verdict: 'INVALID-REJECTED', matchedIds: [] });
      continue;
    }
    const matchedIds = liveRows
      .filter((r) => intentKeyEquals(r.subject, key))
      .map((r) => r.id);
    results.push({
      text,
      key,
      matchedIds,
      verdict: matchedIds.length > 0 ? 'MATCHED-AND-RESOLVED' : 'UNMATCHED-REPORTED',
    });
  }
  return results;
}

/**
 * Print (console.log) the non-silent verdicts from classifyResolvedThreads —
 * UNMATCHED-REPORTED and INVALID-REJECTED (cm#233 spec: "never silent").
 * MATCHED-AND-RESOLVED entries are not printed here; the auto-retire UPDATE
 * site logs its own suppression count via stderr, and the dry-run preview
 * prints its own "would suppress N" summary line.
 *
 * @returns {string[]} the lines printed, in entry order (for tests — avoids
 *   needing to intercept console.log to assert on classification output).
 */
function printResolvedThreadsClassification(results) {
  const lines = [];
  for (const r of (results || [])) {
    let line = null;
    if (r.verdict === 'UNMATCHED-REPORTED') {
      line = `  UNMATCHED resolved_thread: "${r.text.slice(0, 80)}"`;
    } else if (r.verdict === 'INVALID-REJECTED') {
      line = `  INVALID resolved_thread (empty after normalization, skipped): "${r.text.slice(0, 80)}"`;
    }
    if (line) {
      console.log(line);
      lines.push(line);
    }
  }
  return lines;
}

/**
 * cm#233: collapse `open_thread` entries that normalize to the SAME
 * intentKey within one payload (DUPLICATE-COLLAPSED) — the FIRST occurrence
 * of a key is kept, later ones are reported and dropped rather than each
 * racing writeAssertionWithSupersession's own suppress-then-reinsert for an
 * identical subject (which would waste a row and muddy last_reinforced/
 * corroboration bookkeeping). Pure/read-only (no DB access) so BOTH the
 * real close write path (persistSessionIntent) and the --dry-run preview
 * share this SAME classification, never two independently-maintained
 * dedup implementations.
 *
 * @param {Array<string>} rawTexts - payload.open_threads, unfiltered.
 * @returns {{ kept: Array<{key:string, text:string}>, duplicates: Array<{key:string, text:string}> }}
 */
function dedupOpenThreadIntents(rawTexts) {
  const kept = [];
  const duplicates = [];
  for (const raw of (rawTexts || [])) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue; // blank entries: silently dropped (unchanged pre-cm#233 behavior)
    const key = intentKey(text);
    if (!key) continue; // normalizes to empty (should not happen once text is non-blank)
    // intentKeyEquals (case-insensitive), matching the SAME equality every
    // other cm#233 matcher uses — NOT a strict/case-sensitive Set lookup.
    // payload.open_threads is capped at 200 entries elsewhere (payload-
    // schema.js), so an O(n^2) scan here is negligible.
    const isDup = kept.some((k) => intentKeyEquals(k.key, key));
    if (isDup) {
      duplicates.push({ key, text });
      continue;
    }
    kept.push({ key, text });
  }
  return { kept, duplicates };
}

/**
 * Print (console.log) DUPLICATE-COLLAPSED entries from dedupOpenThreadIntents.
 * Never silent (cm#233 spec item 5: "DUPLICATE visible in captured output
 * for both dry-run and live").
 *
 * @returns {string[]} the lines printed, in entry order.
 */
function printOpenThreadDuplicates(duplicates) {
  const lines = [];
  for (const dup of (duplicates || [])) {
    const line = `  DUPLICATE-COLLAPSED open_thread: "${dup.text.slice(0, 80)}" (same key as an earlier entry this close — one row written)`;
    console.log(line);
    lines.push(line);
  }
  return lines;
}

/**
 * Persist session-driving intent (open_threads, tldr, quick_references) as
 * queryable assertion rows in the `assertions` table.
 *
 * Called from writeExtraction after edges are written.
 *
 * Provenance: source='user_stated', confidence=8, tier='probationary' on birth.
 * Cardinality: all three predicates are 1:1 — one live row per (projectId, subject, predicate).
 *
 * Persistence: each intent row is written through writeAssertionWithSupersession
 * (the SAME gated path payload.assertions uses), so tier is set ONLY at INSERT by the
 * L0/L2 consolidation gate — never via an UPDATE. This honors the no-tier-UPDATE
 * anti-forge invariant (test-l0/l2 T13): cross-session restatement of identical intent
 * is corroboration routed through the gate (it consolidates only when a genuine quality
 * corroborator exists — reality_check='verified' OR pinned), NOT an auto-forge. A changed
 * thread on the same subject supersedes the prior via the 1:1 path.
 *
 * cm#227: returns the list of intents that FAILED to persist (previously
 * only logged to stderr and swallowed — a long TL;DR could silently vanish
 * while close still printed "Done"). Callers surface this list as
 * `DIVERGENCE: <predicate> NOT PERSISTED — <db error first line>` lines in
 * both the close/checkpoint console summary and the handoff.md thin
 * pointer's Degraded section — see writeExtraction's return shape and
 * cmdClose/cmdCheckpoint below. This is DELIBERATELY a separate channel
 * from the `_degradedSubsystems` array cmdClose uses for its strict-mode
 * exit-code gate: a session-intent persistence failure stays non-fatal
 * (exit code unchanged) even under close_degraded_exit_mode='strict' — only
 * VISIBILITY changes, not the exit contract.
 *
 * @param {object} db         - StoragePort adapter (Postgres or SQLite).
 * @param {string} projectId  - project UUID.
 * @param {object} payload    - close payload (tldr, open_threads, quick_references, session_id).
 * @param {string} [projectBasename] - path.basename(root) for tldr/quick_reference subjects.
 * @returns {Promise<Array<{predicate: string, subject: string, message: string}>>}
 */
async function persistSessionIntent(db, projectId, payload, projectBasename, opts) {
  opts = opts || {};
  const divergences = [];
  const sessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
    ? payload.session_id
    : null;

  const basename = projectBasename || 'project';
  const intents = [];

  // open_threads — one row per thread, subject = intentKey(text) (cm#233).
  // Two entries that normalize to the SAME key within this one payload
  // collapse to a single written row (DUPLICATE-COLLAPSED) — see
  // dedupOpenThreadIntents's header comment.
  const { kept: openThreadIntents, duplicates: openThreadDuplicates } =
    dedupOpenThreadIntents(payload.open_threads || []);
  printOpenThreadDuplicates(openThreadDuplicates);
  for (const { key, text } of openThreadIntents) {
    intents.push({
      subject: key,
      predicate: 'open_thread',
      object: text,
    });
  }

  // tldr — one row, subject = project basename
  if (payload.tldr && String(payload.tldr).trim()) {
    intents.push({
      subject: basename,
      predicate: 'session_tldr',
      object: String(payload.tldr).trim(),
    });
  }

  // quick_references — one row, subject = project basename
  if (payload.quick_references && String(payload.quick_references).trim()) {
    intents.push({
      subject: basename,
      predicate: 'quick_reference',
      object: String(payload.quick_references).trim(),
    });
  }

  // Persist each intent item through the SAME gated write path payload.assertions
  // uses (writeAssertionWithSupersession). Tier is set ONLY at INSERT by the L0/L2
  // consolidation gate — never via an UPDATE — so this honors the no-tier-UPDATE
  // anti-forge invariant (test-l0/l2 T13). 1:1 supersession handles a changed thread;
  // identical cross-session restatement is corroboration through the gate (consolidates
  // only with a genuine quality corroborator), never an auto-forge.
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');
  for (const intent of intents) {
    // Re-author guard: skip open_thread intents whose subject was previously retired
    // (suppressed=superseded). Prevents a resolved thread from re-entering as live.
    if (intent.predicate === 'open_thread') {
      let skipWrite = false;
      try {
        const { rows: retiredRows } = await db.query(
          `SELECT 1 FROM assertions
           WHERE project_id = $1 AND predicate = 'open_thread'
             AND LOWER(TRIM(subject)) = LOWER(TRIM($2))
             AND suppressed = true AND suppression_kind = 'superseded'
           LIMIT 1`,
          [projectId, intent.subject]
        );
        if (retiredRows.length > 0) {
          skipWrite = true;
          process.stderr.write(
            `[handoff] re-author guard: skipped open_thread "${intent.subject}" — previously retired (suppressed=superseded)\n`
          );
        }
      } catch (guardErr) {
        // Non-fatal: on query error fall through and write normally.
        process.stderr.write(
          `[handoff] re-author guard query failed for "${intent.subject}" (non-fatal, writing anyway): ${guardErr.message}\n`
        );
      }
      if (skipWrite) continue;
    }

    try {
      await writeAssertionWithSupersession(
        db,
        projectId,
        {
          subject:    intent.subject,
          predicate:  intent.predicate,
          object:     intent.object,
          confidence: 8,
          source:     'user_stated',
        },
        sessionId,
        registryMode,
        { embeddingsOptedOut: opts.embeddingsOptedOut }
      );
    } catch (err) {
      process.stderr.write(
        `[handoff] persistSessionIntent failed for predicate "${intent.predicate}" (non-fatal): ${err.message}\n`
      );
      divergences.push({
        predicate: intent.predicate,
        subject: intent.subject,
        message: err.message,
      });
    }
  }

  return divergences;
}

/**
 * Write entities/assertions/edges from a JSON payload.
 * Returns { entitiesWritten, assertionsWritten, edgesWritten }.
 *
 * Payload shape (all arrays optional):
 * {
 *   entities: [{name, entity_type, description}],
 *   assertions: [{subject, predicate, object, confidence, source}],
 *   edges: [{from_entity, edge_type, to_entity, weight}],
 *   contract: { queries: [...] },
 *   tldr: "...",
 *   open_threads: ["..."],
 *   quick_references: "...",
 *   session_id: "..."
 * }
 *
 * opts.projectBasename — path.basename(root), used by persistSessionIntent for
 *   the tldr and quick_reference subject keys. If absent, defaults to 'project'.
 */
async function writeExtraction(db, projectId, payload, opts) {
  // Resolve session id: payload.session_id takes precedence.
  // Fallback: session_in_progress marker from project_settings.
  // STALENESS GUARD: session_in_progress stores an ISO timestamp set at session start
  // (see cmdLoaderHook). If the stored marker is older than staleness_days, treat it
  // as absent to avoid binding this extraction to a stale prior session. A marker from
  // an abnormally-ended prior session (e.g., process kill before cmdClose ran) would
  // otherwise silently associate new writes with the wrong session.
  let sessionId = (typeof payload.session_id === 'string' && payload.session_id.length > 0)
    ? payload.session_id
    : null;
  if (!sessionId) {
    // S3: session_in_progress is now a JSON array of per-session markers — resolve
    // to the single most-recently-written one (see latestSessionMarker's header comment).
    const markers = await getSessionMarkers(db, projectId);
    const latest  = latestSessionMarker(markers);
    if (latest) {
      const sipMs = Date.parse(latest.ts);
      if (!Number.isNaN(sipMs)) {
        const stalenessDays = parseInt(
          await getSetting(db, projectId, 'staleness_days', '7'),
          10
        );
        const staleMs = (Number.isFinite(stalenessDays) && stalenessDays > 0 ? stalenessDays : 7)
          * 24 * 60 * 60 * 1000;
        if (Date.now() - sipMs <= staleMs) {
          sessionId = latest.session_id || latest.ts; // marker is fresh — use it (real id when available)
        }
        // else: marker is stale (abnormally-ended prior session) — leave sessionId=null
      } else {
        // Not a parseable timestamp — legacy opaque marker, used as-is for backward compat.
        sessionId = latest.session_id || latest.ts;
      }
    }
  }
  let entitiesWritten   = 0;
  let assertionsWritten = 0;
  let edgesWritten      = 0;

  // Entities
  for (const ent of (payload.entities || [])) {
    if (!ent.name || !ent.entity_type) continue;
    await db.query(
      `INSERT INTO entities (project_id, name, entity_type, description, session_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, name) DO UPDATE
         SET entity_type = EXCLUDED.entity_type,
             description = EXCLUDED.description`,
      [projectId, ent.name, ent.entity_type, ent.description || null, sessionId]
    );
    entitiesWritten++;
  }

  // Assertions — 4A: cardinality-aware two-step supersession via writeAssertionWithSupersession.
  // Each assertion is processed through suppress+INSERT within an explicit transaction
  // (atomicity requirement I-A mechanism-a).  Predicate cardinality is looked up via
  // classifyPredicate(predicate, registryMode); 1:1 predicates suppress any prior live row
  // for the same (project_id, subject, predicate); 1:N predicates suppress only exact
  // (project_id, subject, predicate, object) duplicates.
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  // init-embeddability: an operator who ran `init --no-embeddings` (or had a
  // prior opt-out auto-honored) gets NO per-write degraded warnings at all —
  // see isEmbeddingsOptedOut's own header for why this is distinct from
  // cm#230's existing "no provider configured" decisions[] contract, which
  // is intentionally unaffected by this flag (that scenario is a live
  // default row temporarily absent, not an operator opt-out).
  const embeddingsOptedOut = await isEmbeddingsOptedOut(db, projectId);

  // init-embeddability A2, corrected per markdown-thin-pointer review: the
  // spec's own wording is "fail-soft to NULL with a counted WARN on the
  // close summary line" — a COUNT on stdout, never a per-row line persisted
  // into handoff.md. An earlier revision of this code routed assertion
  // embed-degraded warnings through the SAME channel decisions[]'s
  // pre-existing (and intentionally unchanged) embed-degraded contract
  // uses (formatIntentDivergenceLines -> handoff.md's "## Degraded"
  // section) — assertions are written far more densely than decisions in
  // ordinary sessions, and on any DB with no default embedding provider
  // configured (the common case for a project that has never opted into
  // embeddings via `init`) that put ONE full-length DIVERGENCE line per
  // assertion into the persisted markdown body, blowing the 512-byte
  // thin-pointer budget (test/north-star/test-retrieval-economy.js INV5a,
  // test/north-star/test-lifecycle-roundtrip.js test B — both fixtures
  // bootstrap via ns-harness.js's applySchemas(), never `cmdInit`, so no
  // embeddings_opt_out row is ever stamped for them). Fixed: an
  // embed-degraded warning now ONLY increments a count (assertionEmbedWarnCount,
  // surfaced solely via the stdout Done-line's embed_warnings figure below)
  // — it is NEVER pushed into intentDivergences/the markdown body. A
  // GENUINE write failure (the row did not persist at all — a real DB
  // error, e.g. EmbeddingColumnAbsentError on a pgvector-degraded target
  // with a provider configured anyway) is a categorically different,
  // comparatively rare event and still surfaces via the existing
  // NOT-PERSISTED divergence channel, matching persistSessionIntent's own
  // established convention for the same class of failure. The per-item
  // try/catch here is itself a NEW safety net (writeAssertionWithSupersession
  // could previously only throw on a genuine DB error, which — pre-existing
  // behavior — was never caught in this specific loop): with embedding
  // columns now sometimes referenced, a genuinely pgvector-degraded target
  // must degrade this ONE assertion, never abort the rest of
  // entities/edges/decisions/session-intent processing still to come.
  const assertionWriteFailures = [];
  let assertionEmbedWarnCount = 0;
  for (const ass of (payload.assertions || [])) {
    if (!ass.subject || !ass.predicate || !ass.object) continue;
    try {
      const embedWarnSink = [];
      const inserted = await writeAssertionWithSupersession(
        db, projectId, ass, sessionId, registryMode,
        { warnSink: embedWarnSink, embeddingsOptedOut }
      );
      if (inserted) assertionsWritten++;
      assertionEmbedWarnCount += embedWarnSink.length;
    } catch (err) {
      process.stderr.write(
        `[handoff] assertion write failed for predicate "${ass.predicate}" subject "${ass.subject}" (non-fatal): ${err.message}\n`
      );
      // No `kind` — renders as a standard "NOT PERSISTED" divergence line
      // (this row genuinely failed to write — a real, comparatively rare
      // operational failure worth surfacing in the markdown body, unlike
      // the routine embed-degraded case above which is counted, not quoted).
      assertionWriteFailures.push({
        predicate: ass.predicate,
        subject: ass.subject,
        message: err.message,
      });
    }
  }

  // Edges
  for (const edge of (payload.edges || [])) {
    if (!edge.from_entity || !edge.edge_type || !edge.to_entity) continue;
    const weight = parseFloat(edge.weight) || 1.0;
    await db.query(
      `INSERT INTO edges (project_id, from_entity, edge_type, to_entity, weight, session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, edge.from_entity, edge.edge_type, edge.to_entity, weight, sessionId]
    );
    edgesWritten++;
  }

  // Decisions — cm#230: payload.decisions[] persisted through the SAME
  // decisions-writer.js write path scripts/handoff-mcp.mjs's persist_decisions
  // MCP tool uses (persistDecisionRow). Before this fix, payload.decisions[]
  // was schema-validated (readStdin/validatePayload) but NEVER written here —
  // the intended write path (persist_decisions) was a separate, unconnected
  // tool. Per-row fault isolation, matching entities'/edges' own
  // skip-malformed-item behavior above: one row that fails validation, hits
  // a genuine write error (including a missing `decisions` table on a DB
  // that has not yet run ensureSchemaCurrent — e.g. the async queue-drain
  // path, which does not call it), or degrades its embedding (fail-soft,
  // per write-time-embed.js's own header) never blocks the rest of this
  // decisions[] array OR the rest of the close. Genuine NOT-PERSISTED
  // failures are collected into decisionDivergences and merged into the
  // SAME intentDivergences channel cm#227 built for session-intent
  // persistence failures below — one DIVERGENCE-line mechanism, not two.
  //
  // markdown-thin-pointer fix (same bug class the assertions loop above was
  // just fixed for): an embed-degraded warning is an OPERATIONAL signal
  // (the row persisted fine; only its embedding is NULL), not a content
  // divergence — it must never be rendered as a per-row DIVERGENCE line
  // into handoff.md's body. This previously ALSO routed through
  // decisionDivergences/formatIntentDivergenceLines exactly like
  // assertions did, and is the identical bug: a close with several
  // decisions[] rows on a project with no default embedding provider
  // configured blows the 512-byte thin-pointer budget the same way (a
  // real pipeline_judge close with 5 decisions did exactly this). Fixed
  // identically: embed-degraded now only increments a count
  // (decisionEmbedWarnCount, folded into the SAME stdout embed_warnings
  // figure assertions already contribute to) — never pushed into
  // decisionDivergences. Genuine write/validation failures are unchanged.
  let decisionsWritten = 0;
  let decisionEmbedWarnCount = 0;
  const decisionDivergences = [];
  for (const row of (payload.decisions || [])) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const topicForMessage = (typeof row.topic === 'string' && row.topic) ? row.topic : '(no topic)';
    const rowErrors = validateDecisionRows([row]);
    if (rowErrors.length > 0) {
      decisionDivergences.push({
        predicate: `decision:${topicForMessage}`,
        subject: topicForMessage,
        message: `validation failed — ${rowErrors.join('; ')}`,
        kind: 'not_persisted',
      });
      continue;
    }
    try {
      const { warning } = await persistDecisionRow(db, projectId, row);
      decisionsWritten++;
      if (warning) decisionEmbedWarnCount++;
    } catch (err) {
      process.stderr.write(`[handoff] decision write failed for topic "${topicForMessage}" (non-fatal): ${err.message}\n`);
      decisionDivergences.push({
        predicate: `decision:${topicForMessage}`,
        subject: topicForMessage,
        message: err.message,
        kind: 'not_persisted',
      });
    }
  }

  // Retrieval contract change — versioned and history-recorded (non-fatal).
  if (payload.contract && typeof payload.contract === 'object') {
    const changeNote = `close session=${payload.session_id || 'unknown'}`;
    try {
      await recordContractChange(db, projectId, 'default', payload.contract, changeNote);
    } catch (contractErr) {
      process.stderr.write(`[handoff] contract history record failed (non-fatal): ${contractErr.message}\n`);
    }
  }

  // Auto-retire resolved open_thread rows BEFORE persistSessionIntent so the re-author
  // guard in persistSessionIntent sees the freshly-suppressed rows in this same close.
  // cm#233: classified via classifyResolvedThreads (intentKey/intentKeyEquals) —
  // MATCHED-AND-RESOLVED entries are suppressed here; UNMATCHED-REPORTED and
  // INVALID-REJECTED are printed (never silent) via
  // printResolvedThreadsClassification, the SAME function the --dry-run
  // preview below uses on the identical classification shape.
  const resolvedClassifications = await classifyResolvedThreads(db, projectId, payload.resolved_threads || []);
  printResolvedThreadsClassification(resolvedClassifications);
  for (const rc of resolvedClassifications) {
    if (rc.verdict !== 'MATCHED-AND-RESOLVED') continue;
    try {
      const { rowCount } = await db.query(
        `UPDATE assertions
         SET suppressed = true, invalid_at = now(), suppression_kind = 'superseded'
         WHERE project_id = $1 AND predicate = 'open_thread'
           AND LOWER(TRIM(subject)) = LOWER(TRIM($2))
           AND suppressed = false AND invalid_at IS NULL
           AND ${PINNED_EXCLUSION_SQL}`,
        [projectId, rc.key]
      );
      const n = rowCount != null ? Number(rowCount) : 0;
      if (n > 0) {
        process.stderr.write(`[handoff] auto-retire: suppressed ${n} open_thread row(s) for resolved subject "${rc.key}"\n`);
      }
    } catch (retireErr) {
      process.stderr.write(`[handoff] auto-retire failed for subject "${rc.key}" (non-fatal): ${retireErr.message}\n`);
    }
  }

  // Persist session-driving intent (open_threads, tldr, quick_references) as queryable PG rows.
  // Non-fatal: any error inside persistSessionIntent is caught and logged per-row.
  // cm#227: per-row failures are also collected and surfaced to the caller as
  // intentDivergences — see persistSessionIntent's own header comment.
  let intentDivergences = [];
  try {
    const projectBasename = (opts && opts.projectBasename) ? opts.projectBasename : null;
    intentDivergences = await persistSessionIntent(db, projectId, payload, projectBasename, { embeddingsOptedOut });
  } catch (intentErr) {
    process.stderr.write(`[handoff] persistSessionIntent outer error (non-fatal): ${intentErr.message}\n`);
    intentDivergences = [{ predicate: '(unknown)', subject: '(unknown)', message: intentErr.message }];
  }

  // cm#230: decision-row divergences share the SAME channel session-intent
  // divergences use (formatIntentDivergenceLines, below) — one DIVERGENCE-line
  // mechanism for the whole close/checkpoint summary and handoff.md Degraded
  // section, not a second parallel one. decisionsWritten is additionally
  // returned on its own for any caller that wants the raw count.
  return {
    entitiesWritten, assertionsWritten, edgesWritten, decisionsWritten,
    intentDivergences: [...intentDivergences, ...decisionDivergences, ...assertionWriteFailures],
    // Count-only (never rendered into handoff.md — see the header comments
    // above assertionWriteFailures/assertionEmbedWarnCount and
    // decisionEmbedWarnCount for why).
    assertionEmbedWarnCount,
    decisionEmbedWarnCount,
  };
}

/**
 * cm#227: build the `DIVERGENCE: <predicate> NOT PERSISTED — <first line>` lines
 * for a list of persistSessionIntent divergences, shared by the close/checkpoint
 * console summary and the handoff.md Degraded section.
 *
 * cm#230: also formats decisions-writer divergences (writeExtraction's
 * decisionDivergences, merged into the same array this function receives).
 * An earlier revision routed embed-degraded warnings (assertions and
 * decisions alike) into this same array with `d.kind === 'embed_degraded'`,
 * rendering a DISTINCT "EMBEDDING DEGRADED" line below. Fixed
 * (init-embeddability A2, PR #260): embed-degraded is counted only —
 * assertionEmbedWarnCount/decisionEmbedWarnCount, folded into the Done
 * line's `embed_warnings` figure — and is NEVER pushed into
 * decisionDivergences/intentDivergences, so no caller passes
 * `kind: 'embed_degraded'` into this function anymore; the branch below is
 * kept as a defensive no-op (removing it would be a code-behavior change,
 * out of scope for this doc fix) rather than because it is still reachable.
 * Any divergence with no `kind` (every existing session-intent divergence,
 * cm#227, plus decision write/validation failures) renders EXACTLY as
 * before.
 * @param {Array<{predicate:string, subject:string, message:string, kind?:string}>} divergences
 * @returns {string[]}
 */
function formatIntentDivergenceLines(divergences) {
  return (divergences || []).map((d) => {
    const firstLine = String(d.message || '').split('\n')[0];
    if (d.kind === 'embed_degraded') {
      return `DIVERGENCE: ${d.predicate} EMBEDDING DEGRADED (row persisted, embedding=NULL) — ${firstLine}`;
    }
    return `DIVERGENCE: ${d.predicate} NOT PERSISTED — ${firstLine}`;
  });
}

/** Run reranker precision@5 gate check. Informational — never blocking. */
async function runRerankerGate(db, projectId, root) {
  const minChunksStr = await getSetting(db, projectId, 'precision_at_5_gate_min_chunks', '1000');
  const minChunks = parseInt(minChunksStr, 10);
  // memory_entry_chunks links to memory_entries via entry_id; no direct project_id column.
  // Count via join to memory_entries which does have project_id (mem_type scoped by entry).
  // Fallback: if no project_id column on memory_entries either, count all chunks as proxy.
  let chunkCount = 0;
  try {
    const { rows: chunkRows } = await db.query(
      `SELECT COUNT(c.*) AS n
       FROM memory_entry_chunks c
       JOIN memory_entries e ON e.id = c.entry_id
       WHERE e.source_file IS NOT NULL`
    );
    chunkCount = parseInt(chunkRows[0].n, 10);
  } catch (_) {
    // Table may not exist or schema differs — skip gate
    console.log('\n  Reranker gate: SKIPPED — could not count chunks');
    return;
  }

  if (chunkCount < minChunks) {
    console.log(`\n  Reranker gate: SKIPPED — corpus n=${chunkCount} below threshold=${minChunks}`);
    return;
  }

  // Corpus is above threshold — run eval harness in both modes.
  console.log(`\n  Reranker gate: corpus n=${chunkCount} >= threshold=${minChunks} — running eval...`);
  const evalScript = path.join(root, 'test', 'eval', 'eval-retrieval.js');
  if (!fs.existsSync(evalScript)) {
    console.log('  Reranker gate: SKIPPED — eval script not found at ' + evalScript);
    return;
  }

  let vectorP5 = null;
  let rerankP5 = null;

  const runEval = (extraArgs) => {
    try {
      const out = execFileSync(process.execPath, [evalScript, '--quiet', ...extraArgs], {
        cwd: root,
        env: { ...process.env, PROJECT_ROOT: root },
        encoding: 'utf8',
        timeout: 120000,
      });
      // Parse precision@5 from output — look for "precision@5: 0.NN" or "P@5: 0.NN"
      const m = out.match(/(?:precision@5|P@5)[^\d]+([\d.]+)/i);
      return m ? parseFloat(m[1]) : null;
    } catch (_) {
      return null;
    }
  };

  vectorP5 = runEval([]);
  rerankP5 = runEval(['--rerank']);

  if (vectorP5 === null || rerankP5 === null) {
    console.log('  Reranker gate: could not parse precision@5 from eval output — skipping gate');
    return;
  }

  const delta = rerankP5 - vectorP5;
  console.log(`  Reranker gate: vector P@5=${vectorP5.toFixed(3)}, reranker P@5=${rerankP5.toFixed(3)}, Δ=${delta.toFixed(3)}`);
  if (delta < 0.05) {
    console.log(`  WARNING: Δ < 0.05 — reranker is not providing a meaningful lift.`);
    console.log(`    Suggestion: (a) defer next reranker re-tune, or (b) inspect for corpus drift.`);
  } else {
    console.log(`  Reranker gate: PASS (Δ >= 0.05)`);
  }
}

// ── checkpoint ───────────────────────────────────────────────────────────────

async function cmdCheckpoint(args) {
  console.log('Running: handoff:checkpoint');

  // ── --note shortcut: single-line mid-session capture ──────────────────────
  //
  // checkpoint --note "<text>" writes ONE assertion through the normal gated
  // write path and exits without requiring a full JSON payload.  The note uses:
  //   subject:    project basename (same as session_tldr and quick_reference)
  //   predicate:  session_note  (1:N — multiple notes accumulate over time)
  //   object:     the note text
  //   confidence: 8  (same as other session-intent rows)
  //   source:     'user_stated'  (manual entry by user/agent)
  //
  // The JSON path (--json flag) is mutually exclusive with --note.
  const noteIdx = args.indexOf('--note');
  if (noteIdx !== -1) {
    const noteText = args[noteIdx + 1];
    if (!noteText || noteText.startsWith('--')) {
      console.error('checkpoint --note requires a text argument, e.g.: checkpoint --note "discovered session_id threading issue"');
      process.exit(2);
    }

    const projectId = resolveProjectId();
    const root      = findProjectRoot();
    const basename  = path.basename(root);

    let db;
    try {
      db = await connectHandoff();
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }

    const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

    let written = false;
    try {
      written = await writeAssertionWithSupersession(
        db,
        projectId,
        {
          subject:    basename,
          predicate:  'session_note',
          object:     noteText,
          confidence: 8,
          source:     'user_stated',
        },
        null,
        registryMode
      );
    } catch (err) {
      console.error(`checkpoint --note: write failed: ${err.message}`);
      await db.end();
      process.exit(1);
    }

    // Every Done line carries embedding: <state> (PR #273 review gap) — read
    // BEFORE db.end() below, non-fatal on any probe failure.
    let noteEmbeddingState = 'UNKNOWN';
    try {
      noteEmbeddingState = await computeEmbeddingReadiness(db, projectId);
    } catch (_) { /* non-fatal — Done line still prints */ }

    await db.end();

    if (written) {
      console.log(`\n  note captured: ${noteText}`);
      console.log(`\nDone: handoff:checkpoint --note — project=${basename} marker=${projectId} — session_note written, embedding: ${noteEmbeddingState} (session marker preserved)`);
    } else {
      console.log(`\n  note skipped (predicate not recognized in strict mode): ${noteText}`);
      console.log(`\nDone: handoff:checkpoint --note — project=${basename} marker=${projectId} — session_note skipped, embedding: ${noteEmbeddingState}`);
    }
    return;
  }

  // Accept --json alone OR the legacy --json - form (backward compatible).
  const useJson    = args.includes('--json');
  const allowEmpty = args.includes('--allow-empty');
  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);
  const root        = findProjectRoot();

  // A3: an empty checkpoint (no --note, no --json, no explicit opt-in) is a
  // no-op that looks like it did something — the same failure shape as the
  // close incident. Reject it up front, before any DB connection, unless
  // the caller explicitly opts in with --allow-empty.
  let payload = {};
  if (useJson) {
    if (process.stdin.isTTY) {
      if (!allowEmpty) {
        console.error('--json - requires a payload on stdin');
        process.exit(2);
      }
      payload = {};
    } else {
      payload = await readStdin({ allowEmpty });
    }
  } else if (!allowEmpty) {
    console.error('checkpoint requires --note "<text>", --json (with a payload piped on stdin), or an explicit --allow-empty opt-in');
    process.exit(2);
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── Async extraction gate (opt-in, default OFF = synchronous as before) ──────
  // When extraction_async_enabled='true', validate the payload and enqueue it for
  // the deterministic background worker (queue-drain subcommand) instead of writing
  // synchronously. Default ('false') is fully unchanged from prior behavior.
  const asyncMode      = await getSetting(db, projectId, 'extraction_async_enabled', 'false');
  const registryMode   = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  let entitiesWritten   = 0;
  let assertionsWritten = 0;
  let edgesWritten      = 0;
  let decisionsWritten  = 0;

  if (asyncMode === 'true') {
    // Async path: validate then enqueue; do NOT write assertions/entities/edges now.
    const validation = validatePayload(payload, registryMode);

    // Emit warnings to stderr (permissive mode).
    for (const w of validation.warnings) {
      process.stderr.write(`[handoff] checkpoint async: ${w}\n`);
    }

    // In strict mode, filter out assertions with errors; emit each skipped assertion to stderr.
    // We skip-and-continue — never abort the checkpoint.
    let payloadToEnqueue = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[handoff] checkpoint async strict: skipping assertion — ${e}\n`);
      }
      // Build a filtered payload with only clean assertions.
      const badIndices = _badAssertionIndices(validation.errors);
      payloadToEnqueue = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    const sourceRef = payload.session_id || null;
    await db.query(
      `INSERT INTO extraction_queue (project_id, payload, source_ref, status, enqueued_at)
       VALUES ($1, $2::jsonb, $3, 'pending', now())`,
      [projectId, JSON.stringify(payloadToEnqueue), sourceRef]
    );

    const assertionCount = (payloadToEnqueue.assertions || []).length;
    const entityCount    = (payloadToEnqueue.entities   || []).length;
    const edgeCount      = (payloadToEnqueue.edges      || []).length;
    const decisionCount  = (payloadToEnqueue.decisions  || []).length;
    console.log(
      `\n  queued for async extraction: ${entityCount} entities, ${assertionCount} assertions, ${edgeCount} edges, ${decisionCount} decisions`
    );
    if (validation.warnings.length > 0) {
      console.log(`  predicate warnings: ${validation.warnings.length} (see stderr)`);
    }
    if (registryMode === 'strict' && validation.errors.length > 0) {
      console.log(`  predicate strict-mode skips: ${validation.errors.length} (see stderr)`);
    }

    // Update handoff.md (reflects enqueue, not yet written to DB)
    const stamp = new Date().toISOString();
    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          stamp,
      CONTRACT:            payload.contract ? 'default' : (readHandoffFrontmatter(handoffPath).contract || 'default'),
      ENTITIES_WRITTEN:    '0 (queued)',
      ASSERTIONS_WRITTEN:  '0 (queued)',
      EDGES_WRITTEN:       '0 (queued)',
      PROJECT_NAME:        path.basename(root),
      TLDR:                payload.tldr || '(checkpoint — async queued)',
      OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
      QUICK_REFERENCES:    payload.quick_references || '(none)',
      DEGRADED_SECTION:    '',
      RECONCILIATION_SECTION: '',
    });

    // Do NOT clear session_in_progress here.  The SessionEnd hook's implicit close
    // (loader-stop path) is responsible for clearing the marker at true session end.
    // Clearing it at checkpoint time kills C2 attribution for any work done after
    // the checkpoint, defeating the entire purpose of mid-session saves.

    let queuedEmbeddingState = 'UNKNOWN';
    try {
      queuedEmbeddingState = await computeEmbeddingReadiness(db, projectId);
    } catch (_) { /* non-fatal — Done line still prints */ }

    await db.end();

    console.log(`\nDone: handoff:checkpoint — project=${path.basename(root)} marker=${projectId} — payload queued for async extraction, embedding: ${queuedEmbeddingState} (session marker preserved for continued attribution)`);
    return;
  }

  // ── Synchronous path (default) — unchanged behavior ──────────────────────────
  const extraction = await writeExtraction(db, projectId, payload, { projectBasename: path.basename(root) });
  entitiesWritten   = extraction.entitiesWritten;
  assertionsWritten = extraction.assertionsWritten;
  edgesWritten      = extraction.edgesWritten;
  decisionsWritten  = extraction.decisionsWritten;

  // cm#227: surface any session-intent (session_tldr/open_thread/quick_reference)
  // persistence failure as a DIVERGENCE line — both in the console summary below
  // and in handoff.md's Degraded section. Non-fatal: exit code is unchanged.
  const intentDivergences     = extraction.intentDivergences || [];
  const divergenceLines       = formatIntentDivergenceLines(intentDivergences);
  // A3: counted WARN on the summary Done line (stdout only — never rendered
  // into handoff.md; see writeExtraction's own header comments on
  // assertionEmbedWarnCount/decisionEmbedWarnCount for why embed-degraded
  // warnings for BOTH assertions and decisions are counts here, never
  // per-row markdown DIVERGENCE lines — that was the exact body-budget bug
  // this figure's computation used to reintroduce for decisions).
  const embedWarnCount = (extraction.assertionEmbedWarnCount || 0) + (extraction.decisionEmbedWarnCount || 0);
  const embedWarnSuffix = embedWarnCount > 0 ? `, embed_warnings: ${embedWarnCount}` : '';
  const checkpointDegradedSection = divergenceLines.length > 0
    ? '\n\n## Degraded\n' + divergenceLines.map((l) => `- ${l}`).join('\n')
    : '';

  // Update handoff.md
  const stamp = new Date().toISOString();
  writeHandoffMd(handoffPath, {
    PROJECT_ID:          projectId,
    LAST_CLOSE:          stamp,
    CONTRACT:            payload.contract ? 'default' : (readHandoffFrontmatter(handoffPath).contract || 'default'),
    ENTITIES_WRITTEN:    String(entitiesWritten),
    ASSERTIONS_WRITTEN:  String(assertionsWritten),
    EDGES_WRITTEN:       String(edgesWritten),
    PROJECT_NAME:        path.basename(root),
    TLDR:                payload.tldr || '(checkpoint)',
    OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
    QUICK_REFERENCES:    payload.quick_references || '(none)',
    DEGRADED_SECTION:    checkpointDegradedSection,
    RECONCILIATION_SECTION: '',
  });

  // Do NOT clear session_in_progress here.  The SessionEnd hook's implicit close
  // (loader-stop path) is responsible for clearing the marker at true session end.
  // Clearing it at checkpoint time kills C2 attribution for any work done after
  // the checkpoint, defeating the entire purpose of mid-session saves.

  // Run reranker gate (informational)
  await runRerankerGate(db, projectId, root);

  // E3: append the classifier's own verbatim state to the Done line — read
  // BEFORE db.end() (below), non-fatal on any probe failure.
  let checkpointEmbeddingState = 'UNKNOWN';
  try {
    checkpointEmbeddingState = await computeEmbeddingReadiness(db, projectId);
  } catch (_) { /* non-fatal — Done line still prints */ }

  await db.end();

  console.log(`\n  entities written:    ${entitiesWritten}`);
  console.log(`  assertions written:  ${assertionsWritten}`);
  console.log(`  edges written:       ${edgesWritten}`);
  console.log(`  decisions written:   ${decisionsWritten}`);
  for (const line of divergenceLines) {
    console.log(`  ${line}`);
  }
  console.log(`\nDone: handoff:checkpoint — project=${path.basename(root)} marker=${projectId} — ${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written, decisions: ${decisionsWritten}${embedWarnSuffix}, embedding: ${checkpointEmbeddingState} (session marker preserved for continued attribution)`);
}

// ── resolveSessionId ──────────────────────────────────────────────────────────
//
// Resolve the session id for cmdClose attribution in priority order:
//   1. payload.session_id  — explicit value supplied by the skill
//   2. resolveSessionIdFromEnv(null) — CLAUDE_CODE_SESSION_ID, then
//      CODEX_THREAD_ID (this call site never receives --host: the MCP server
//      shells out `node handoff-mcp.mjs` identically regardless of host, so
//      host is always treated as absent here — see resolveSessionIdFromEnv)
//   3. DB marker 'session_in_progress'  — seeded by cmdResume / SessionStart hook
//
// The env var fallback exists because the heredoc pattern used in close.md is
// single-quoted (<<'EOF') which suppresses shell expansion, so a
// "$CLAUDE_CODE_SESSION_ID" literal in the payload JSON would arrive as the
// literal string rather than the resolved value.  Reading process.env on the
// engine side is clean and requires no skill change.
async function resolveSessionId(db, projectId, payload) {
  if (typeof payload.session_id === 'string' && payload.session_id.length > 0) {
    return payload.session_id;
  }
  const envSessionId = resolveSessionIdFromEnv(null);
  if (envSessionId) return envSessionId;
  // S3: session_in_progress is now a JSON array of per-session markers —
  // resolveSessionIdFromMarker (./lib/session-identity.js) resolves to the
  // single most-recently-written one (see latestSessionMarker's header
  // comment there) — same query/selection this function has always used,
  // now shared verbatim with scripts/handoff-mcp.mjs's usage_record default
  // (fix/usage-record-marker-fallback). No behavior change here.
  return resolveSessionIdFromMarker(db, projectId);
}

/**
 * S4: clear THIS session's own marker on an explicit /handoff:close — never a
 * sibling session's. Uses the TRUE session identity (payload.session_id,
 * trimmed, then resolveClearSessionId's host-independent env fallback — see
 * PR4: this call site never threaded --host through, by design (MCP-invoked
 * close never receives it), and now the ambiguous-env case is also refused
 * rather than defaulted, matching the strict clear-time rule everywhere
 * else). If no marker belongs to this session, nothing is cleared — a
 * sibling session's marker is left in place
 * (see clearSessionMarkerForClose's own doc comment below for the full
 * branch-by-branch classification of every outcome, fix(close)).
 * Lock-guarded (withSessionMarkerLock) — same read-modify-write race as
 * every other marker mutation site.
 *
 * loader-stop verifiability (cm#263): when an explicit close actually clears
 * a marker for THIS session, also stamp a single project_settings breadcrumb
 * row ('last_explicit_close' = {session_id, ts}) — the ONLY signal that lets
 * a later SessionEnd (loader-stop) distinguish "no marker because an explicit
 * close already ran this session" (outcome explicit_close_present) from "no
 * marker because none was ever set" (outcome no_marker). One overwritten row,
 * not one row per session — no unbounded growth. Fail-soft: a failure to
 * stamp the breadcrumb never blocks or fails the close itself.
 */
/**
 * fix(close): dedupe (exact string equality) + cap a list of session ids for
 * display, so a "left in place (owned by ...)" text never grows unbounded
 * when many sibling sessions are live. Order preserved (first-seen); capped
 * at 5 with a "+<k> more" suffix naming how many additional UNIQUE owners
 * were elided.
 */
function formatOwnerIds(ids) {
  const unique = [];
  for (const id of ids) {
    if (id && !unique.includes(id)) unique.push(id);
  }
  if (unique.length <= 5) return unique.join(', ');
  return `${unique.slice(0, 5).join(', ')} +${unique.length - 5} more`;
}

/**
 * fix(close), narrowed by PR4 §3: total classification of the close-time
 * marker-clear outcome, over S (the resolved current session id — explicit
 * payload.session_id first, trimmed; else resolveClearSessionId's
 * host-independent env fallback, which now refuses an ambiguous env pair
 * rather than defaulting) and M (the parsed marker list —
 * parseSessionMarkersDetailed's `markers`, IDENTICAL to what every other
 * caller of parseSessionMarkers sees; see that function's header comment for
 * the dropped/coerced distinction, which is close-only reporting and never
 * changes which entries are in `markers`).
 * Exactly one branch fires; every branch returns a TRUE outcome — the two
 * Done-line call sites print result.text verbatim instead of a hardcoded
 * "session marker cleared" string, so a close from a session that does NOT
 * own the live marker can never claim it cleared one.
 *
 *   A. S non-null, >=1 exact session_id match       -> delete ALL exact matches.
 *   B. S non-null, no exact, list is the legacy
 *      single-entry null-id shape (length===1)      -> delete that one entry
 *      (the pre-S3 single-session format carries no identity at all — "any
 *      session closing" is provably correct here, since there is no sibling
 *      to misattribute against; a coerced-to-null entry is indistinguishable
 *      from a true legacy marker here, matching main).
 *   C. S non-null, no exact, list not the legacy
 *      single-entry shape, non-empty                -> delete nothing;
 *      report owners. PR4 §3: when a null-session_id entry is ALSO present
 *      among >=2 total entries, this is real multi-session concurrency
 *      colliding with a legacy marker — the null entry is NEVER
 *      auto-claimed here (no wildcard); text additionally reports
 *      "unresolved legacy marker present".
 *   D. S null, list is the legacy single-entry
 *      null-id shape (length===1)                   -> delete that one entry.
 *   E. S null, list not the legacy single-entry
 *      shape, non-empty                              -> delete nothing;
 *      report owners (same "unresolved legacy marker present" addendum as C
 *      when a null entry is present among >=2 total entries).
 *   F. list empty (after excluding dropped entries)  -> nothing to clear.
 *   G. the marker store itself is unreadable (a real DB/read error, not a
 *      value-level parse outcome — those are all handled inside
 *      parseSessionMarkersDetailed's own fail-open total classification)
 *      -> delete nothing, report the error, never throw out of close.
 *
 * Read-modify-write happens ENTIRELY inside withSessionMarkerLock (branch
 * decision and delete share one lock acquisition) — deciding the branch
 * from a read taken outside the lock would reopen the exact TOCTOU race the
 * lock exists to close.
 *
 * Returns { branch, deleted, ownedBy, dropped, coerced, text } — never throws.
 */
async function clearSessionMarkerForClose(db, projectId, payload) {
  const currentSessionId = resolveClearSessionId(payload);

  let result;
  try {
    result = await withSessionMarkerLock(db, projectId, async () => {
      const raw = await getSetting(db, projectId, 'session_in_progress', null);
      const { markers, dropped, coerced } = parseSessionMarkersDetailed(raw);
      const suffix =
        (dropped > 0 ? `; ${dropped} malformed marker entr${dropped === 1 ? 'y' : 'ies'} ignored` : '') +
        (coerced > 0 ? `; ${coerced} marker entr${coerced === 1 ? 'y' : 'ies'} had a non-string session id (treated as no id)` : '');

      if (markers.length === 0) {
        return { branch: 'F', deleted: 0, ownedBy: [], dropped, coerced, text: `no session marker present${suffix}` };
      }

      const exactMatches   = currentSessionId ? markers.filter((m) => m.session_id === currentSessionId) : [];
      // PR4 §3: a null-session_id marker is only ever auto-claimed when it is
      // the SOLE entry in the entire list (the true pre-S3 legacy shape).
      // Two-or-more entries with a null present is never a wildcard match —
      // see findMatchingMarkerIndex's identical rule for cmdLoaderStop.
      const isSingleLegacy = markers.length === 1 && markers[0].session_id === null;
      const hasUnclaimedLegacyEntry = !isSingleLegacy && markers.some((m) => m.session_id === null);
      const legacyNote = hasUnclaimedLegacyEntry ? '; unresolved legacy marker present' : '';

      let branch, toDelete, ownedBy = [], text;
      if (currentSessionId && exactMatches.length > 0) {
        branch = 'A';
        toDelete = exactMatches;
        text = `session marker cleared (session ${currentSessionId})${suffix}`;
      } else if (currentSessionId && isSingleLegacy) {
        branch = 'B';
        toDelete = markers;
        text = `legacy session marker cleared (marker had no session id)${suffix}`;
      } else if (currentSessionId) {
        branch = 'C';
        toDelete = [];
        ownedBy = formatOwnerIds(markers.map((m) => m.session_id));
        text = `session marker left in place (owned by ${ownedBy}${legacyNote})${suffix}`;
      } else if (isSingleLegacy) {
        branch = 'D';
        toDelete = markers;
        text = `session marker cleared (session id unresolved; marker had no session id)${suffix}`;
      } else {
        branch = 'E';
        toDelete = [];
        ownedBy = formatOwnerIds(markers.map((m) => m.session_id));
        text = `session marker left in place (session id unresolved; owned by ${ownedBy}${legacyNote})${suffix}`;
      }

      if (toDelete.length > 0) {
        const remaining = markers.filter((m) => !toDelete.includes(m));
        await setSessionMarkers(db, projectId, remaining);
      }

      return { branch, deleted: toDelete.length, ownedBy, dropped, coerced, text };
    });
  } catch (err) {
    result = {
      branch: 'G',
      deleted: 0,
      ownedBy: [],
      dropped: 0,
      coerced: 0,
      text: `session marker unreadable (${err && err.message ? err.message : 'read failed'}); left as-is`,
    };
  }

  if (result.deleted > 0) {
    try {
      await setSetting(db, projectId, 'last_explicit_close', JSON.stringify({
        session_id: currentSessionId || null,
        ts: new Date().toISOString(),
      }));
    } catch (_) { /* fail-soft: breadcrumb loss never blocks close */ }
  }

  return result;
}

// ── close ─────────────────────────────────────────────────────────────────────

async function cmdClose(args) {
  console.log('Running: handoff:close');

  // ── --dry-run: rehearse without mutating anything ─────────────────────────
  //
  // When --dry-run is set:
  //   - Payload is parsed and validated (same predicate-registry + validatePayload checks).
  //   - L3 authoritative reality-check probes run (read-only: they compute results,
  //     but DB writes are suppressed — reality_check column is NOT updated).
  //   - Contradiction gate and pointer-staleness gate both run (read-only).
  //   - CLAUDE.md promotion candidates are computed.
  //   - A summary of WHAT WOULD HAPPEN is printed: rows to write, rows to supersede,
  //     pointer rewrite findings, degraded subsystems, promotion candidates.
  //   - ZERO DB mutations. handoff.md is NOT written. session_in_progress is NOT cleared.
  //   - C2 / C3 passes are SKIPPED (they require DB writes + idempotency markers).
  //     This is flagged clearly in the dry-run output.
  //   - L4 degraded-close record is NOT written.
  //
  const dryRun = args.includes('--dry-run');

  // Accept --json alone OR the legacy --json - form (backward compatible).
  const useJson    = args.includes('--json');
  const allowEmpty = args.includes('--allow-empty');

  // A3: this is the exact incident shape (close --help silently ignored the
  // unknown flag, useJson stayed false, payload stayed {} default, and a
  // real extraction-empty close ran). Reject up front, before any DB
  // connection, unless the caller explicitly opts in with --allow-empty --
  // OR --dry-run is set. --dry-run is exempt by construction: it performs
  // ZERO DB mutations regardless of payload content (see the --dry-run
  // doc comment above: no writes, handoff.md untouched, session marker
  // untouched), so an empty/missing payload under --dry-run carries none of
  // the incident's risk (a real write with no extraction data) -- it is
  // just a preview of "nothing would be written", which is itself a
  // legitimate, tested invocation (test/handoff/test-write-path-params.js:
  // "close --dry-run: works without --json (empty payload)").
  // The SessionEnd loader-stop implicit-close path does NOT go through
  // cmdClose/this argv path at all (it calls writeImplicitClose() directly),
  // so it is unaffected by this gate — see PR body "blind spots".
  let payload = {};
  if (useJson) {
    if (process.stdin.isTTY) {
      if (!allowEmpty && !dryRun) {
        console.error('--json - requires a payload on stdin');
        process.exit(2);
      }
      payload = {};
    } else {
      payload = await readStdin({ allowEmpty: allowEmpty || dryRun });
    }
  } else if (!allowEmpty && !dryRun) {
    console.error('close requires --json (with a payload piped on stdin) or an explicit --allow-empty opt-in');
    process.exit(2);
  }

  // ── Extraction-empty detection snapshot ───────────────────────────────────
  // Captured immediately after parsing, BEFORE any code-side mutation of
  // `payload` (e.g. the L3 has_unpackaged_state authoritative-assertion
  // injection below, which always adds at least one assertion regardless of
  // what the caller supplied). Reflects what the CALLER actually authored —
  // used later to warn on a close whose extraction was entirely empty
  // (zero entities, zero assertions, zero edges) even though intent rows
  // (tldr/open_threads/quick_references) may still have been written.
  const extractionEmptyAtEntry =
    (!Array.isArray(payload.entities)   || payload.entities.length   === 0) &&
    (!Array.isArray(payload.assertions) || payload.assertions.length === 0) &&
    (!Array.isArray(payload.edges)      || payload.edges.length      === 0);

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── Identity resolution (MUST run before ensureSchemaCurrent) ────────────
  // Ordering constraint: project_id (which keys the schema_fingerprint row)
  // cannot be known until identity is resolved. ensureProjectIdentity is
  // the FIRST internal-check step; ensureSchemaCurrent follows immediately.
  let projectId;
  let root;
  try {
    const identity = await ensureProjectIdentity(db, { silent: false });
    projectId = identity.projectId;
    root      = identity.root;
  } catch (idErr) {
    // ensureProjectIdentity calls process.exit(1) on fatal errors.
    process.stderr.write('[handoff] identity resolution failed (unexpected): ' + idErr.message + '\n');
    process.exit(1);
  }

  // ── S4 (codex-host-adapter): resolve the durable-facts promotion path ONCE
  // here, at entry, and thread it as a parameter into every write site below
  // (the --dry-run preview branch AND the real write branch) — rather than
  // each branch independently re-calling resolvePromotionFilePath(). Uses the
  // SAME shared resolvePromotionTarget() as cmdInit/cmdPromote so host and
  // filename are always mutually consistent (HANDOFF_HOST=codex with
  // HANDOFF_PROMOTION_FILE unset resolves to AGENTS.md here too, not
  // CLAUDE.md). Claude's own behavior is unaffected: with neither env var
  // set this still resolves the historical default (CLAUDE.md).
  const promotionTargetResult = resolvePromotionTarget(root, process.env);
  if (!promotionTargetResult.ok) {
    process.stderr.write(`[handoff] ${promotionTargetResult.reason}\n`);
    process.exit(1);
  }
  if (promotionTargetResult.warning) {
    process.stderr.write(promotionTargetResult.warning + '\n');
  }
  const promotionPath     = promotionTargetResult.filePath;
  const promotionFilename = promotionTargetResult.filename;

  // ── Item 6: Idempotent legacy-settings reconciliation ────────────────────
  // Remove orphaned project_settings rows keyed to the legacy encodeCwd(root) id
  // for this project ONLY — strictly scoped, idempotent, snapshot-first.
  // Non-fatal: any error is logged and ignored so close can proceed.
  // Skipped under --dry-run (DELETE is a mutation; dry-run must be zero-mutation).
  if (!dryRun) {
    try {
      const { encodeCwd: _encodeCwd } = require('./lib/encoded-cwd');
      const legacyIdForReconcile = _encodeCwd(root);
      await reconcileLegacySettings(db, legacyIdForReconcile, projectId, { silent: true });
    } catch (reconcileErr) {
      process.stderr.write('[handoff] legacy reconcile (non-fatal): ' + reconcileErr.message + '\n');
    }
  }

  const handoffPath = resolveHandoffMdPath(projectId);

  // Deliverable A: auto-apply additive schema on drift (non-fatal).
  // Runs immediately after identity resolution, before payload processing.
  // Any error here must NOT abort close — wrap and continue.
  try {
    await ensureSchemaCurrent(db, projectId, { silent: false });
  } catch (schemaErr) {
    process.stderr.write('[handoff] schema auto-apply failed (non-fatal): ' + schemaErr.message + '\n');
  }

  // ── L3: Reality-check registry — authoritative pass ──────────────────────────
  //
  // Replaces the former "Deliverable B" hard-coded has_unpackaged_state block.
  // Behavior is fully generalized through the REALITY_CHECKS registry (see
  // scripts/lib/reality-checks.js) while preserving byte-identical output for
  // the existing has_unpackaged_state authoritative injection (golden test).
  //
  // Authoritative mode: for each registered 'authoritative' entry whose
  //   subjectMatch fires on at least one assertion (or unconditionally), strip
  //   ALL model-supplied assertions for that predicate and inject a single
  //   code-computed canonical one.  Applies to BOTH the async (enqueue) path
  //   and the synchronous (writeExtraction) path.
  //
  // The subject, confidence, and source of each injected assertion are determined
  // by the registry entry's probe and the canonical injection shape below.
  {
    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'authoritative') continue;

      // Strip model-supplied rows for this predicate.
      const originalCount = (payload.assertions || []).length;
      const filtered = (payload.assertions || []).filter((a) => {
        if (typeof a.predicate === 'string' &&
            a.predicate.trim().toLowerCase() === check.predicate.toLowerCase()) {
          process.stderr.write(
            `[handoff] discarded model-supplied ${check.predicate} assertion — ${check.predicate} state is computed authoritatively\n`
          );
          return false;
        }
        return true;
      });
      if (filtered.length < originalCount) {
        payload = Object.assign({}, payload, { assertions: filtered });
      }

      // Run the probe and inject the canonical assertion.
      // Probe is fail-soft: null return → skip injection (non-fatal).
      try {
        const probeResult = check.probe(root);
        if (probeResult !== null) {
          // Canonical injection shape — byte-identical to the pre-L3 hard-coded block
          // for has_unpackaged_state (golden-test invariant):
          //   subject:    path.basename(root)
          //   predicate:  check.predicate
          //   object:     probe result string
          //   confidence: 9
          //   source:     'user_stated'
          const canonicalAssertion = {
            subject:    path.basename(root),
            predicate:  check.predicate,
            object:     probeResult,
            confidence: 9,
            source:     'user_stated',
          };
          payload = Object.assign({}, payload, {
            assertions: (payload.assertions || []).concat([canonicalAssertion]),
          });
        }
      } catch (probeErr) {
        // Non-fatal: probe threw unexpectedly — skip injection and continue.
        process.stderr.write(
          `[handoff] ${check.predicate} authoritative probe failed (non-fatal): ${probeErr.message}\n`
        );
      }
    }
  }

  // ── Deliverable B2: suppress legacy-subject has_unpackaged_state orphans ──────
  //
  // Prior to PR-1, the packaging assertion was written via writeAssertionWithSupersession
  // using subject "<basename> working tree" (source=model_extracted, confidence=8).
  // PR-1 changed the canonical subject to "<basename>" (source=user_stated, confidence=9).
  // Because the subjects differ, canonicalization differs, so the new canonical write does
  // NOT suppress the old row — leaving a stale contradictory orphan.
  //
  // Fix: after injecting the canonical assertion, suppress any live (suppressed=false)
  // has_unpackaged_state row in this project whose subject is NOT the canonical subject.
  // Uses the existing buildSupersessionUpdate port method (dialect-neutral, zero new SQL).
  // Idempotent: once suppressed, subsequent closes are a no-op on the legacy row.
  // Non-fatal: mirrors the surrounding ensureSchemaCurrent error semantics.
  // Skipped under --dry-run (suppression UPDATE is a mutation; dry-run must be zero-mutation).
  if (!dryRun) {
    try {
      const canonBasename = path.basename(root);
      const { rows: legacyPackRows } = await db.query(
        `SELECT DISTINCT subject FROM assertions
         WHERE project_id = $1
           AND predicate  = $2
           AND suppressed = false
           AND invalid_at IS NULL`,
        [projectId, 'has_unpackaged_state']
      );
      for (const row of legacyPackRows) {
        if (row.subject !== canonBasename) {
          // This is a legacy/non-canonical subject row — suppress it.
          const suppressStmt = db.buildSupersessionUpdate('1:1', projectId, row.subject, 'has_unpackaged_state', null);
          await db.query(suppressStmt.sql, suppressStmt.params);
        }
      }
    } catch (legacyCleanupErr) {
      process.stderr.write('[handoff] legacy has_unpackaged_state cleanup failed (non-fatal): ' + legacyCleanupErr.message + '\n');
    }
  }

  // ── Async extraction gate (opt-in, default OFF = synchronous as before) ──────
  // When extraction_async_enabled='true', validate the payload and enqueue it for
  // the deterministic background worker (queue-drain subcommand). The whole payload
  // (entities + assertions + edges + contract) goes on the queue; the worker calls
  // writeExtraction() so behavior is equivalent, just deferred.
  // Default ('false') is fully unchanged from prior behavior.
  const asyncMode    = await getSetting(db, projectId, 'extraction_async_enabled', 'false');
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  if (asyncMode === 'true') {
    // Async path: validate then enqueue; skip synchronous writeExtraction().
    const validation = validatePayload(payload, registryMode);

    // Emit warnings to stderr (permissive mode).
    for (const w of validation.warnings) {
      process.stderr.write(`[handoff] close async: ${w}\n`);
    }

    // Strict mode: filter out assertions that fail vocabulary check; skip-and-continue.
    let payloadToEnqueue = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[handoff] close async strict: skipping assertion — ${e}\n`);
      }
      const badIndices = _badAssertionIndices(validation.errors);
      payloadToEnqueue = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    const sourceRef = payload.session_id || null;
    await db.query(
      `INSERT INTO extraction_queue (project_id, payload, source_ref, status, enqueued_at)
       VALUES ($1, $2::jsonb, $3, 'pending', now())`,
      [projectId, JSON.stringify(payloadToEnqueue), sourceRef]
    );

    const assertionCount = (payloadToEnqueue.assertions || []).length;
    const entityCount    = (payloadToEnqueue.entities   || []).length;
    const edgeCount      = (payloadToEnqueue.edges      || []).length;
    const decisionCount  = (payloadToEnqueue.decisions  || []).length;
    console.log(
      `\n  queued for async extraction: ${entityCount} entities, ${assertionCount} assertions, ${edgeCount} edges, ${decisionCount} decisions`
    );
    if (validation.warnings.length > 0) {
      console.log(`  predicate warnings: ${validation.warnings.length} (see stderr)`);
    }
    if (registryMode === 'strict' && validation.errors.length > 0) {
      console.log(`  predicate strict-mode skips: ${validation.errors.length} (see stderr)`);
    }

    // Update handoff.md (reflects enqueue, not yet written to DB)
    const queueStamp = new Date().toISOString();
    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          queueStamp,
      CONTRACT:            'default',
      ENTITIES_WRITTEN:    '0 (queued)',
      ASSERTIONS_WRITTEN:  '0 (queued)',
      EDGES_WRITTEN:       '0 (queued)',
      PROJECT_NAME:        path.basename(root),
      TLDR:                payload.tldr || '(closed — async queued)',
      OPEN_THREADS:        (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
      QUICK_REFERENCES:    payload.quick_references || '(none)',
      DEGRADED_SECTION:    '',
      RECONCILIATION_SECTION: '',
    });

    // Clear this session's session_in_progress marker (S4). No divergence signal
    // exists at enqueue time (the payload's own persistence happens later, in
    // queue-drain) — always safe to attempt here. fix(close): the outcome is
    // reported verbatim on the Done line below, not assumed.
    const markerOutcome = await clearSessionMarkerForClose(db, projectId, payload);

    let queuedCloseEmbeddingState = 'UNKNOWN';
    try {
      queuedCloseEmbeddingState = await computeEmbeddingReadiness(db, projectId);
    } catch (_) { /* non-fatal — Done line still prints */ }

    await db.end();

    console.log(`\n  entities:    0 (queued)`);
    console.log(`  assertions:  0 (queued)`);
    console.log(`  edges:       0 (queued)`);
    console.log(`  decisions:   0 (queued)`);
    console.log(`  contract:    queued`);

    // Extraction-empty warning (non-fatal). Uses the pre-injection snapshot
    // captured at entry — see extractionEmptyAtEntry above.
    if (extractionEmptyAtEntry) {
      console.log(
        '\n  WARNING: extraction-empty close — payload carried no entities/assertions/edges. ' +
        'The close contract expects the full extraction in one pass (see commands/handoff/close.md §1-§5). ' +
        'Queued for async extraction anyway.'
      );
    }

    console.log(`\nDone: handoff:close — project=${path.basename(root)} marker=${projectId} — payload queued for async extraction, embedding: ${queuedCloseEmbeddingState}, ${markerOutcome.text}`);
    return;
  }

  // ── Step 5: Pre-write verify refresh (L2 stale-trust fix) ───────────────────
  //
  // L2's hasQualityCorroborator check (inside writeAssertionWithSupersession)
  // reads reality_check from PRIOR rows to decide whether a corroborating row is
  // independently trustworthy.  Those values may be stale from a previous session's
  // close verify pass that tagged them 'verified'.  Between close→close without an
  // intervening resume (which would have run the serve-time re-probe), the values
  // are never refreshed — a stale 'verified' on a row whose probe now returns a
  // mismatch could grant unearned L2 trust to an incoming assertion.
  //
  // Fix: run a quick verify refresh on all live rows whose predicate has a
  // mode:'verify' registry entry BEFORE writeExtraction runs.  Only reality_check
  // is written (§7 no-backfill).  Fully non-fatal: any error here must not abort
  // close — we simply continue with potentially stale values (same as pre-fix).
  //
  // This closes the close→close edge case.  Serve-time re-probe covers the
  // resume→close path (user does resume before next close — already covered).
  //
  // Skipped entirely under --dry-run: the UPDATE assertions SET reality_check
  // write is a DB mutation.  The dry-run summary does not use these results, so
  // skipping the whole block is correct and keeps dry-run zero-mutation.
  if (!dryRun) {
    try {
      const preWriteRoot = root;
      const preWriteSessionId = payload.session_id || null;
      const verifyPredicates = [...new Set(
        REALITY_CHECKS.filter((c) => c.mode === 'verify' && !c.annotateOnly).map((c) => c.predicate)
      )];
      if (verifyPredicates.length > 0) {
        // Fetch all live rows for verify predicates in one query.
        // confidence is included so the reconcile step can preserve it in any
        // superseding row (§7: only suppressed/invalid_at/suppression_kind may change).
        const placeholders = verifyPredicates.map((_, i) => `$${i + 2}`).join(', ');
        let preWriteRows;
        try {
          const { rows } = await db.query(
            `SELECT id, subject, predicate, object, confidence FROM assertions
             WHERE project_id = $1
               AND predicate  IN (${placeholders})
               AND suppressed = false
               AND invalid_at IS NULL`,
            [projectId, ...verifyPredicates]
          );
          preWriteRows = rows;
        } catch (_fetchErr) {
          preWriteRows = [];
        }

        if (preWriteRows.length > 0) {
          // Build id→confidence map for the reconcile step.
          const preWriteConfById = new Map();
          for (const r of preWriteRows) preWriteConfById.set(r.id, r.confidence);

          let preWriteResults;
          try {
            preWriteResults = await runVerifyDispatch(db, projectId, preWriteRoot, preWriteRows);
          } catch (_dispatchErr) {
            preWriteResults = [];
          }
          for (const res of preWriteResults) {
            // Tag the reality_check column.
            try {
              await db.query(
                `UPDATE assertions SET reality_check = $1 WHERE id = $2`,
                [res.tag, res.id]
              );
            } catch (_tagErr) {
              // Non-fatal — proceed with next row.
            }

            // Reconcile mismatched pre-existing rows so they stop re-alarming.
            // This runs BEFORE writeExtraction, ensuring only pre-existing rows are
            // affected (newly written rows are not yet present and are never reconciled
            // away immediately after being written).
            if (res.tag === 'mismatch') {
              try {
                const rowConf = preWriteConfById.get(res.id) || 5;
                const cls     = classifyPredicate(res.predicate, registryMode);

                if (cls.cardinality === '1:1') {
                  // 1:1: insert a reality-correct successor; suppress the stale row.
                  await writeAssertionWithSupersession(
                    db, projectId,
                    {
                      subject:    res.subject,
                      predicate:  res.predicate,
                      object:     res.probeResult,
                      confidence: rowConf,
                      source:     'model_extracted',
                    },
                    preWriteSessionId,
                    registryMode
                  );
                } else {
                  // 1:N (e.g. in_file): directly suppress the stale row.
                  await db.query(
                    `UPDATE assertions
                     SET suppressed       = true,
                         invalid_at       = now(),
                         suppression_kind = 'reality_reconciled'
                     WHERE id = $1`,
                    [res.id]
                  );
                }

                process.stderr.write(
                  `[handoff] L3 reality reconciled: ${res.predicate} subject="${res.subject}" ` +
                  `asserted "${res.object}" -> reality "${res.probeResult}"; superseded stale row\n`
                );
              } catch (_reconcileErr) {
                // Fail-soft: log but do not abort the close.
                process.stderr.write(
                  `[handoff] L3 reconcile failed for ${res.predicate} id=${res.id} (non-fatal): ${_reconcileErr.message}\n`
                );
              }
            }
          }
        }
      }
    } catch (_preWriteErr) {
      // Fully non-fatal: L2 sees potentially stale reality_check (same as pre-fix behavior).
      process.stderr.write(`[handoff] pre-write verify refresh failed (non-fatal): ${_preWriteErr.message}\n`);
    }
  }

  // ── Dry-run short-circuit ─────────────────────────────────────────────────────
  //
  // When --dry-run is set, print a summary of what WOULD be written and exit.
  // ZERO mutations occur.  The following mutating passes are all guarded with
  // if (!dryRun) above and do NOT execute on this path:
  //   - legacy-settings reconciliation (DELETE project_settings)
  //   - Deliverable B2 legacy has_unpackaged_state suppression (UPDATE assertions)
  //   - pre-write verify refresh (UPDATE assertions SET reality_check)
  // We do NOT call writeExtraction, do NOT update handoff.md, do NOT clear
  // session_in_progress.
  //
  // What this dry-run does NOT rehearse:
  //   - C2 (retrieval outcome bias feedback) — requires DB writes + idempotency markers.
  //   - C3 (contract evolution) — same.
  //   - L4 degraded-close record — only written on real close.
  //   - CLAUDE.md auto-promotion write — computed and shown but not written.
  //
  if (dryRun) {
    console.log('\n  ── DRY-RUN: nothing will be written ──');

    // Count what WOULD be written.
    const wouldWriteEntities   = (payload.entities   || []).length;
    const wouldWriteAssertions = (payload.assertions || []).length;
    const wouldWriteEdges      = (payload.edges      || []).length;
    const wouldWriteDecisions  = (payload.decisions  || []).length;
    const wouldWriteContract   = payload.contract ? 'yes' : 'no';

    console.log(`\n  payload validation:`);
    const dryRegistryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');
    const dryValidation   = (function() {
      try { return require('./lib/payload-schema').validatePayload(payload, dryRegistryMode); }
      catch (_) { return { warnings: [], errors: [] }; }
    })();
    if (dryValidation.errors.length > 0) {
      for (const e of dryValidation.errors) console.log(`    [ERROR] ${e}`);
    }
    if (dryValidation.warnings.length > 0) {
      for (const w of dryValidation.warnings) console.log(`    [WARN]  ${w}`);
    }
    if (dryValidation.errors.length === 0 && dryValidation.warnings.length === 0) {
      console.log('    OK — all predicates recognized');
    }

    console.log(`\n  rows that WOULD be written:`);
    console.log(`    entities:   ${wouldWriteEntities}`);
    console.log(`    assertions: ${wouldWriteAssertions}`);
    console.log(`    edges:      ${wouldWriteEdges}`);
    console.log(`    decisions:  ${wouldWriteDecisions}`);
    console.log(`    contract:   ${wouldWriteContract}`);

    // Preview decision topics that WOULD be written (topic only — no full row
    // detail; mirrors the entity/assertion/edge counts above with the same
    // read-only, zero-mutation guarantee as the rest of dry-run).
    if (wouldWriteDecisions > 0) {
      console.log(`\n  decisions that WOULD be written:`);
      for (const row of (payload.decisions || [])) {
        const topic = (row && typeof row === 'object' && typeof row.topic === 'string' && row.topic)
          ? row.topic
          : '(no topic)';
        console.log(`    - ${topic}`);
      }
    }

    // Extraction-empty warning (non-fatal, read-only — dry-run framing).
    // See the matching warning at the real-close and async-queue summary
    // sites below; detection uses the pre-mutation snapshot captured at
    // entry so the code-injected has_unpackaged_state assertion never
    // masks a caller payload that carried no real extraction.
    if (extractionEmptyAtEntry) {
      console.log(
        '\n  WARNING: extraction-empty close — payload carries no entities/assertions/edges. ' +
        'The close contract expects the full extraction in one pass (see commands/handoff/close.md §1-§5). ' +
        'Intent rows (if any) would still be written on a real close.'
      );
    }

    // Show which assertions would be superseded (1:1 predicates that have live rows).
    const assertionsToCheck = (payload.assertions || []).filter((a) => {
      try {
        const cls = classifyPredicate(a.predicate, 'permissive');
        return cls.cardinality === '1:1';
      } catch (_) { return false; }
    });
    if (assertionsToCheck.length > 0) {
      let supersededCount = 0;
      for (const a of assertionsToCheck) {
        try {
          const { rows: liveRows } = await db.query(
            `SELECT id, object FROM assertions
             WHERE project_id = $1 AND predicate = $2
               AND LOWER(TRIM(subject)) = LOWER(TRIM($3))
               AND suppressed = false AND invalid_at IS NULL
             LIMIT 3`,
            [projectId, a.predicate, a.subject]
          );
          if (liveRows.length > 0) {
            supersededCount += liveRows.length;
            for (const lr of liveRows) {
              console.log(`    [supersede] id=${lr.id} ${a.subject} ${a.predicate} "${lr.object}" → "${a.object}"`);
            }
          }
        } catch (_) {}
      }
      if (supersededCount === 0) {
        console.log('    (no 1:1 supersessions detected for payload assertions)');
      }
    }

    // Preview resolved_threads classification (read-only — no mutations in
    // dry-run). cm#233: SAME classifyResolvedThreads + printResolvedThreads-
    // Classification the real close's auto-retire block uses above — the
    // two paths can never classify the same payload differently.
    if ((payload.resolved_threads || []).length > 0) {
      const previewClassifications = await classifyResolvedThreads(db, projectId, payload.resolved_threads);
      printResolvedThreadsClassification(previewClassifications);
      let totalWouldSuppress = 0;
      const matchedKeys = [];
      for (const rc of previewClassifications) {
        if (rc.verdict === 'MATCHED-AND-RESOLVED') {
          totalWouldSuppress += rc.matchedIds.length;
          matchedKeys.push(rc.key);
        }
      }
      console.log(`\n  resolved_threads:   would suppress ${totalWouldSuppress} open_thread row(s): [${matchedKeys.join(', ')}]`);
    }

    // Session-intent rows that would be written.
    if (payload.tldr)            console.log(`\n  session_tldr:       would write (subject=${path.basename(root)})`);
    if ((payload.open_threads || []).length > 0) {
      // cm#233: SAME dedupOpenThreadIntents the real close's persistSessionIntent
      // uses — DUPLICATE-COLLAPSED entries are printed here too (never silent).
      const { kept: previewKept, duplicates: previewDuplicates } = dedupOpenThreadIntents(payload.open_threads);
      printOpenThreadDuplicates(previewDuplicates);
      console.log(`  open_thread rows:   would write ${previewKept.length} row(s)`);
    }
    if (payload.quick_references) console.log(`  quick_reference:    would write (subject=${path.basename(root)})`);

    // Durable-facts promotion candidates (same query as real close — read-only).
    // Target filename resolved once above (`promotionFilename`) — never
    // re-derived here (S4: single ambient-env read per process).
    try {
      const dryMultiSessionPred = db.buildEpochSecondsDiffPredicate('last_reinforced', 'created_at', '>', 86400);
      const { rows: dryCandidates } = await db.query(
        `SELECT id, subject, predicate, object, confidence, tier
         FROM assertions
         WHERE project_id = $1
           AND suppressed = false
           AND confidence >= 9
           AND source = 'user_stated'
           AND tier = 'consolidated'
           AND ${dryMultiSessionPred}
         ORDER BY confidence DESC`,
        [projectId]
      );
      if (dryCandidates.length > 0) {
        console.log(`\n  ${promotionFilename} promotion candidates (would be surfaced — NOT written in dry-run):`);
        for (const r of dryCandidates) {
          console.log(`    [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`);
        }
      }
    } catch (_) {}

    // Pointer-gate (read-only pass — just show findings, write nothing).
    try {
      await _backfillMissingAnchors(db, projectId, root);
      const dryGateResult = await runPointerGate(
        {
          tldr:            payload.tldr || '(none)',
          openThreads:     (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)',
          quickReferences: payload.quick_references || '(none)',
        },
        root, db, projectId, 'dry-run'
      );
      if (dryGateResult.findings.length > 0) {
        console.log(`\n  pointer-staleness gate findings (informational — not written):`);
        for (const f of dryGateResult.findings) {
          console.log(`    [${f.rule}] ${f.message}`);
        }
      }
    } catch (_) {}

    // Skipped subsystems.
    console.log('\n  skipped in dry-run: writeExtraction, handoff.md render, session_in_progress clear, C2, C3, L4 degraded record');

    let dryRunEmbeddingState = 'UNKNOWN';
    try {
      dryRunEmbeddingState = await computeEmbeddingReadiness(db, projectId);
    } catch (_) { /* non-fatal — Done line still prints */ }

    await db.end();
    console.log(`\nDone: handoff:close --dry-run — project=${path.basename(root)} marker=${projectId} — no mutations performed, embedding: ${dryRunEmbeddingState} (dry-run)`);
    return;
  }

  // ── Synchronous path (default) — unchanged behavior ──────────────────────────
  const { entitiesWritten, assertionsWritten, edgesWritten, decisionsWritten, intentDivergences, assertionEmbedWarnCount, decisionEmbedWarnCount } =
    await writeExtraction(db, projectId, payload, { projectBasename: path.basename(root) });
  // cm#227: DIVERGENCE lines for any session_tldr/open_thread/quick_reference
  // persistence failure — surfaced below in the Done summary AND rendered into
  // handoff.md's Degraded section. Kept separate from _degradedSubsystems (below)
  // on purpose: this must never affect close_degraded_exit_mode='strict' — only
  // visibility changes, never the exit code.
  const intentDivergenceLines = formatIntentDivergenceLines(intentDivergences);
  // A3: counted WARN on the summary Done line (stdout only — never rendered
  // into handoff.md) — see cmdCheckpoint's identical computation for rationale.
  const embedWarnCount  = (assertionEmbedWarnCount || 0) + (decisionEmbedWarnCount || 0);
  const embedWarnSuffix = embedWarnCount > 0 ? `, embed_warnings: ${embedWarnCount}` : '';

  // Surface CLAUDE.md promotion candidates (conf >= 9, user_stated, multi-session).
  // Hole A fix: col-minus-col epoch difference now goes through a port method so both
  // Postgres (EXTRACT) and SQLite (julianday) produce identical results.
  //
  // Candidate-query bug fix (L2): SELECT was missing id and tier columns. Later code
  // reads r.id (for the source_assertion annotation) and r.tier (for L2 transitive
  // binding). Without these columns, r.id is undefined and the annotation is corrupted.
  //
  // L2 transitive binding: only gate-consolidated rows are eligible for CLAUDE.md
  // promotion. A self-stamped row that is merely source='user_stated' but tier='probationary'
  // (because it did not satisfy the L2 gate) is NOT eligible — this closes the transitive
  // forge where a self-stamped row both self-consolidates and self-promotes into CLAUDE.md.
  // When consolidation_gate_mode='disabled' or 'report', tier='consolidated' rows are those
  // produced by the L0 gate (post-L0 main behavior); under 'enforce', only L2-consolidated
  // rows have tier='consolidated'. In all modes, the tier='consolidated' filter is the
  // gate — CLAUDE.md eligibility is always transitively bound to the active gate decision.
  const multiSessionPred = db.buildEpochSecondsDiffPredicate(
    'last_reinforced', 'created_at', '>', 86400
  );
  const { rows: candidates } = await db.query(
    `SELECT id, subject, predicate, object, confidence, tier
     FROM assertions
     WHERE project_id = $1
       AND suppressed = false
       AND confidence >= 9
       AND source = 'user_stated'
       AND tier = 'consolidated'
       AND ${multiSessionPred}
     ORDER BY confidence DESC`,
    [projectId]
  );
  // promotionPath / promotionFilename resolved once above (S4).
  if (candidates.length > 0) {
    console.log(`\n  ${promotionFilename} promotion candidates (confidence >= 9, user_stated, consolidated, multi-session):`);
    for (const row of candidates) {
      console.log(`    [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`);
    }
    console.log(`  Review and run /handoff:close with confirm_claude_md_promotion=true to write to ${promotionFilename}.`);
  }

  // Write to the promotion file if requested and candidates exist.
  if (payload.confirm_claude_md_promotion && candidates.length > 0) {
    const claudeMdPath = promotionPath;
    if (fs.existsSync(claudeMdPath)) {
      // heal-on-touch: heal a legacy/absolute "## Key paths" section before the
      // Durable-facts rewrite below — close writes the file anyway, so fold
      // the heal (if any) into that same write rather than skipping it.
      const rawExisting = fs.readFileSync(claudeMdPath, 'utf8');
      const healResult  = healKeyPathsSection(rawExisting, process.env);
      for (const note of healResult.notes) {
        process.stderr.write(`handoff: ${promotionFilename} Key paths: ${note}\n`);
      }
      if (healResult.outcome === 'healed') {
        console.log(`  ${promotionFilename}: healed absolute Key paths bullet(s).`);
      }
      const existing  = healResult.text;
      const today     = new Date().toISOString().slice(0, 10);
      const sessionId = payload.session_id || 'unknown';
      const additions = candidates.map((r) => {
        const annotation = `<!-- promoted: session=${sessionId}, conf=${r.confidence}, date=${today}, source_assertion=${r.id} -->`;
        const factLine   = `- [conf=${r.confidence}] ${r.subject} ${r.predicate} ${r.object}`;
        return `${annotation}\n${factLine}`;
      }).join('\n');
      const durableFacts = existing.includes('## Durable facts')
        ? existing.replace(/## Durable facts\n.*?\n- \(No durable facts.*?\)\n/s,
            `## Durable facts\n${additions}\n`)
        : existing + `\n## Durable facts\n${additions}\n`;
      fs.writeFileSync(claudeMdPath, durableFacts, 'utf8');
      console.log(`\n  ${promotionFilename} updated with ${candidates.length} durable fact(s).`);
    }
  }

  // Multi-author detection — inform once per invocation; no behavior change today.
  const closeAuthorCount = detectMultiAuthor(root);
  if (closeAuthorCount > 1) {
    try {
      await setSetting(db, projectId, 'multi_author_detected', 'true');
    } catch (_) { /* non-fatal */ }
    process.stderr.write(
      `[handoff] multi-author repo detected — see README#trust-model before relying on ${promotionFilename} auto-promotion\n`
    );
  }

  // L4: Accumulate degraded-close records for C2/C3 unresolvable-session skips.
  // Written to project_settings and surfaced in the close summary / handoff.md
  // by the writeHandoffMd call below (after C2 and C3 complete).
  const stamp = new Date().toISOString();
  const _degradedSubsystems = [];

  // ── L3: Reality-check registry — verify pass (post-write tag) ────────────────
  //
  // Tags newly written rows with reality_check='verified'|'mismatch'|'unverifiable'.
  // Reconciliation of pre-existing stale rows was already done in the pre-write pass
  // above (before writeExtraction) — those rows are now suppressed and will not
  // appear here.  This pass only sees rows written this close.
  //
  // Mismatch on a freshly written row (unusual — author wrote a bad assertion) falls
  // back to the legacy degraded-close surface so it is visible on resume.
  //
  // DESIGN-OF-RECORD INVARIANTS:
  //   - confidence, source, and tier are NEVER modified on any row.
  //   - Only the reality_check column is written.
  //   - is_at_commit is NOT included.
  try {
    const verifySessionId = payload.session_id || null;

    for (const check of REALITY_CHECKS) {
      if (check.mode !== 'verify') continue;
      // annotateOnly entries are serve-time only — skip both close-time passes.
      if (check.annotateOnly) continue;

      let verifyRows;
      try {
        const { rows } = await db.query(
          `SELECT id, subject, predicate, object FROM assertions
           WHERE project_id = $1
             AND predicate  = $2
             AND suppressed = false
             AND invalid_at IS NULL`,
          [projectId, check.predicate]
        );
        verifyRows = rows;
      } catch (queryErr) {
        process.stderr.write(
          `[handoff] L3 verify query for "${check.predicate}" failed (non-fatal): ${queryErr.message}\n`
        );
        continue;
      }

      let dispatchResults;
      try {
        dispatchResults = await runVerifyDispatch(db, projectId, root, verifyRows);
      } catch (_dispatchErr) {
        dispatchResults = [];
      }

      for (const res of dispatchResults) {
        try {
          await db.query(
            `UPDATE assertions SET reality_check = $1 WHERE id = $2`,
            [res.tag, res.id]
          );
        } catch (updateErr) {
          process.stderr.write(
            `[handoff] L3 reality_check tag write failed for assertion ${res.id} (non-fatal): ${updateErr.message}\n`
          );
          continue;
        }

        if (res.tag === 'mismatch') {
          const reason =
            `${res.predicate} subject="${res.subject}": ` +
            `asserted "${res.object}" but probe returned "${res.probeResult}"`;
          try {
            await recordDegradedClose(db, projectId, verifySessionId, 'reality_verify', reason);
            _degradedSubsystems.push({ subsystem: 'reality_verify', reason });
            process.stderr.write(`[handoff] L3 reality mismatch (non-fatal): ${reason}\n`);
          } catch (_degradeErr) {
            process.stderr.write(`[handoff] L3 degraded-close record failed (non-fatal): ${_degradeErr.message}\n`);
          }
        }
      }
    }
  } catch (verifyPassErr) {
    // Fully non-fatal: any error in the verify dispatch must not abort close.
    process.stderr.write(`[handoff] L3 verify pass failed (non-fatal): ${verifyPassErr.message}\n`);
  }

  // ── Retrieval outcome capture (non-fatal) ─────────────────────────────────────
  // Must run BEFORE session_in_progress is cleared (we need the session id).
  // Order: self-report first, then timeout-decay sweep (so just-reported rows are
  // not also swept).
  try {
    // 1. Resolve session id (priority: payload → env var → DB marker).
    const closeSessionId = await resolveSessionId(db, projectId, payload);

    // 2. Agent self-report: update pending events for this session.
    if (payload.retrieval_outcome) {
      if (closeSessionId) {
        const selfRes = await db.query(
          `UPDATE retrieval_events
           SET outcome = $2, outcome_at = now(), outcome_signal = 'agent_self_report',
               notes = COALESCE($3, notes)
           WHERE project_id = $1 AND outcome = 'pending' AND session_id = $4`,
          [projectId, payload.retrieval_outcome, payload.retrieval_outcome_notes || null, closeSessionId]
        );
        console.log(`  retrieval outcome: marked ${selfRes.rowCount} pending event(s) ${payload.retrieval_outcome} (signal=agent_self_report)`);
      } else {
        process.stderr.write('[handoff] retrieval_outcome set but no session id resolvable — self-report skipped\n');
      }
    }

    // 3. Timeout-decay sweep: flip stale pending events to irrelevant.
    const timeoutDays = parseInt(await getSetting(db, projectId, 'retrieval_outcome_timeout_days', '14'), 10);
    const decayRes = await db.query(
      `UPDATE retrieval_events
       SET outcome = 'irrelevant', outcome_at = now(), outcome_signal = 'timeout_decay'
       WHERE project_id = $1 AND outcome = 'pending'
         AND retrieved_at < now() - ($2 || ' days')::interval`,
      [projectId, String(timeoutDays)]
    );
    if (decayRes.rowCount > 0) {
      console.log(`  retrieval outcome: ${decayRes.rowCount} stale pending event(s) decayed to irrelevant (signal=timeout_decay)`);
    }
  } catch (outcomeErr) {
    process.stderr.write(`[handoff] retrieval outcome capture failed (non-fatal): ${outcomeErr.message}\n`);
  }

  // ── C2: Outcome→bias feedback application (non-fatal, gated, batch at close) ────────────────
  //
  // Formula:
  //   delta = sum(success_count * success_delta
  //             + failure_count * failure_delta
  //             + irrelevant_count * irrelevant_delta)
  //   new_bias = CLAMP(old_bias + delta, -clamp, +clamp)
  //
  // Idempotency guard: we only consider retrieval_events that were outcome-set
  // (outcome != 'pending') for THIS session. We use a processed-marker in
  // project_settings keyed as 'feedback_applied:<sessionId>' to detect re-runs.
  // On re-run the marker already exists → we skip silently (true idempotency).
  // The marker is only written after a successful feedback application pass.
  //
  // Session resolution: same logic as the outcome capture block above — payload.session_id
  // takes precedence, then the DB marker. Both are read before session_in_progress is cleared.
  try {
    const feedbackEnabled = await getSetting(db, projectId, 'feedback_loop_enabled', 'enabled');
    if (feedbackEnabled === 'enabled') {
      // Re-resolve session id (priority: payload → env var → DB marker).
      const fbSessionId = await resolveSessionId(db, projectId, payload);

      if (!fbSessionId) {
        // No session id — skip silently (nothing to attribute).
        // L4: Record degraded close — C2 skipped because session id is unresolvable.
        // Persists to project_settings so the resume path can surface a warning banner.
        process.stderr.write('[handoff] C2 feedback: no session id resolvable — skipping bias update\n');
        await recordDegradedClose(db, projectId, null, 'C2', 'no session id resolvable — skipping bias update');
        _degradedSubsystems.push({ subsystem: 'C2', reason: 'no session id resolvable — skipping bias update' });
      } else {
        // Idempotency check: if we have already applied feedback for this session, skip.
        const markerKey = `feedback_applied:${fbSessionId}`;
        const alreadyApplied = await getSetting(db, projectId, markerKey, null);
        if (alreadyApplied !== null) {
          console.log(`  C2 feedback: already applied for session ${fbSessionId} — skipping (idempotent)`);
        } else {
          // Read tunable deltas and clamp.
          const successDelta    = parseFloat(await getSetting(db, projectId, 'feedback_success_delta',    '0.5'));
          const failureDelta    = parseFloat(await getSetting(db, projectId, 'feedback_failure_delta',    '-0.75'));
          const irrelevantDelta = parseFloat(await getSetting(db, projectId, 'feedback_irrelevant_delta', '-0.25'));
          const biasClamp       = parseFloat(await getSetting(db, projectId, 'feedback_bias_clamp',       '3.0'));

          // Aggregate per assertion: count outcomes across this session's events.
          // Join: retrieval_events (session, non-pending) → retrieval_event_assertions → assertions.
          const aggRes = await db.query(
            `SELECT
               rea.assertion_id,
               SUM(CASE WHEN re.outcome = 'success'    THEN 1 ELSE 0 END)    AS success_count,
               SUM(CASE WHEN re.outcome = 'failure'    THEN 1 ELSE 0 END)    AS failure_count,
               SUM(CASE WHEN re.outcome = 'irrelevant' THEN 1 ELSE 0 END)    AS irrelevant_count
             FROM retrieval_events re
             JOIN retrieval_event_assertions rea ON rea.event_id = re.id
             WHERE re.project_id = $1
               AND re.session_id = $2
               AND re.outcome != 'pending'
             GROUP BY rea.assertion_id`,
            [projectId, fbSessionId]
          );

          if (aggRes.rows.length > 0) {
            // PR-B: C2 feedback now distinguishes suppression_kind and respects pinned exemption.
            //
            // Downvote thresholds (hardcoded conservative values):
            //   Net delta < -1.5 over this session → downvoted_probation (soft, recoverable).
            //   Net delta < -3.0 over this session → downvoted_terminal  (terminal, not auto-revivable).
            // Positive net delta → REHABILITATION: if a row is in downvoted_probation,
            //   clear it back to live (clears suppressed, invalid_at, suppression_kind).
            //
            // Pinned rows (pinned = true/1): NEVER auto-suppressed/downvoted by this path.
            //   The filter is applied via a WHERE pinned = false guard on all downvote UPDATEs.
            //
            // outcome_bias update is applied REGARDLESS of whether suppression fires —
            //   bias reflects retrieval quality signal even on live rows.
            const DOWNVOTE_PROBATION_THRESHOLD = -1.5;
            const DOWNVOTE_TERMINAL_THRESHOLD  = -3.0;

            let biasAdjusted = 0;
            let downvotedProbation = 0;
            let downvotedTerminal  = 0;
            let rehabilitated      = 0;

            for (const row of aggRes.rows) {
              const delta =
                row.success_count    * successDelta +
                row.failure_count    * failureDelta +
                row.irrelevant_count * irrelevantDelta;

              // 1. Update outcome_bias (CLAMP via GREATEST/LEAST in SQL for atomicity).
              await db.query(
                `UPDATE assertions
                 SET outcome_bias = GREATEST($2::float, LEAST($3::float, outcome_bias + $4::float))
                 WHERE id = $1`,
                [row.assertion_id, -biasClamp, biasClamp, delta]
              );
              biasAdjusted++;

              // 2. Determine downvote / rehabilitation action based on net delta.
              if (delta > 0) {
                // Positive signal → attempt rehabilitation for probation rows.
                const rehabStmt = db.buildProbationRehabUpdate([row.assertion_id]);
                if (rehabStmt) {
                  const rehabResult = await db.query(rehabStmt.sql, rehabStmt.params);
                  if (rehabResult.rowCount > 0) rehabilitated++;
                }
              } else if (delta <= DOWNVOTE_TERMINAL_THRESHOLD) {
                // Strong negative → terminal downvote (not auto-revivable; pinned exempt).
                // Only fires on currently live rows (suppressed=false, invalid_at IS NULL).
                await db.query(
                  `UPDATE assertions
                   SET suppressed = true, invalid_at = now(), suppression_kind = 'downvoted_terminal'
                   WHERE id = $1
                     AND suppressed = false
                     AND invalid_at IS NULL
                     AND (pinned = false OR pinned IS NULL)`,
                  [row.assertion_id]
                );
                downvotedTerminal++;
              } else if (delta <= DOWNVOTE_PROBATION_THRESHOLD) {
                // Moderate negative → probation downvote (recoverable via rehabilitation).
                // Only fires on currently live rows (suppressed=false, invalid_at IS NULL).
                await db.query(
                  `UPDATE assertions
                   SET suppressed = true, invalid_at = now(), suppression_kind = 'downvoted_probation'
                   WHERE id = $1
                     AND suppressed = false
                     AND invalid_at IS NULL
                     AND (pinned = false OR pinned IS NULL)`,
                  [row.assertion_id]
                );
                downvotedProbation++;
              }
              // else: delta between 0 and DOWNVOTE_PROBATION_THRESHOLD → bias adjustment only.
            }
            const parts = [`adjusted outcome_bias for ${biasAdjusted} assertion(s)`];
            if (downvotedProbation > 0) parts.push(`${downvotedProbation} → downvoted_probation`);
            if (downvotedTerminal  > 0) parts.push(`${downvotedTerminal} → downvoted_terminal`);
            if (rehabilitated      > 0) parts.push(`${rehabilitated} probation row(s) rehabilitated`);
            console.log(`  C2 feedback: ${parts.join('; ')} (session=${fbSessionId})`);
          } else {
            console.log(`  C2 feedback: no attributed outcomes found for session ${fbSessionId} — nothing to adjust`);
          }

          // Write idempotency marker — keyed per session so it does not collide across sessions.
          // Value is the ISO timestamp of this application pass.
          await setSetting(db, projectId, markerKey, new Date().toISOString());
        }
      }
    }
  } catch (feedbackErr) {
    // Fully non-fatal: any error here must not break cmdClose.
    process.stderr.write(`[handoff] C2 feedback application failed (non-fatal): ${feedbackErr.message}\n`);
  }

  // ── C3: Learnable contracts — auto-evolve retrieval_contract from outcome patterns ─────────────
  //
  // Rules engine executed at close (non-fatal, fully gated). Fires only when
  // contract_evolution_enabled='enabled'. When not 'enabled', zero contract mutation occurs
  // and cmdClose output/behavior is byte-identical to pre-C3.
  //
  // Gate is INDEPENDENT of feedback_loop_enabled: contract evolution is driven purely by
  // retrieval_events.outcome aggregated per query kind, not by assertions.outcome_bias.
  // This means evolution can be evaluated even when the C2 bias feedback loop is off.
  //
  // Evolution rule set (deterministic, documented):
  //
  //   RULE 1 — UNDERPERFORMING KIND BUDGET REDUCTION:
  //     For each kind present in recent retrieval events (within the rolling window):
  //       If kind's (failure + irrelevant) rate > failure_threshold
  //         AND sample count >= min_events:
  //       → Reduce that kind's token_budget by budget_step (bounded below by budget_floor).
  //       Applied to at most one kind per pass (the worst performer) — gradual, recoverable.
  //
  //   RULE 2 — REALLOCATION TO BEST PERFORMER:
  //     Simultaneously with Rule 1, if a reduction was made:
  //       The best-performing kind (lowest failure+irrelevant rate, >= min_events) gains
  //       the budget that was removed from the underperformer, capped so total budget stays
  //       within the original contract envelope (sum of all kind budgets unchanged).
  //
  //   INVARIANTS:
  //     - No kind is ever deleted (min budget floor enforced, not zero).
  //     - Total token budget stays within the original envelope (±budget_step rounding).
  //     - At most one budget reduction per close pass (gradual — bad signal is recoverable via rollback CLI).
  //     - If the worst performer's kind is not present in the live contract, no evolution occurs.
  //     - Evolution is skipped when any kind has fewer than min_events in the window (thin data guard).
  //
  // Idempotency: marker key 'contract_evolved:<sessionId>' in project_settings prevents
  // re-evaluation for a session that has already been processed.
  //
  // Non-fatal: any failure inside this block is caught and logged to stderr; cmdClose continues.
  // Rollback: use `node scripts/bundleb-w4-contract.js rollback <prior_version>` to revert.
  try {
    const evolutionEnabled = await getSetting(db, projectId, 'contract_evolution_enabled', 'disabled');
    if (evolutionEnabled === 'enabled') {
      // Resolve session id (priority: payload → env var → DB marker).
      const evolSessionId = await resolveSessionId(db, projectId, payload);

      if (!evolSessionId) {
        // L4: Record degraded close — C3 skipped because session id is unresolvable.
        // Persists to project_settings so the resume path can surface a warning banner.
        process.stderr.write('[handoff] C3 evolution: no session id resolvable — skipping\n');
        await recordDegradedClose(db, projectId, null, 'C3', 'no session id resolvable — skipping');
        _degradedSubsystems.push({ subsystem: 'C3', reason: 'no session id resolvable — skipping' });
      } else {
        // Idempotency check: skip if we already processed this session.
        const evolMarkerKey   = `contract_evolved:${evolSessionId}`;
        const alreadyEvolved  = await getSetting(db, projectId, evolMarkerKey, null);
        if (alreadyEvolved !== null) {
          console.log(`  C3 evolution: already applied for session ${evolSessionId} — skipping (idempotent)`);
        } else {
          // Read tunable parameters.
          const windowDays        = parseInt(await getSetting(db, projectId, 'contract_evolution_window_days',        '30'),  10);
          const minEvents         = parseInt(await getSetting(db, projectId, 'contract_evolution_min_events',         '10'),  10);
          const failureThreshold  = parseFloat(await getSetting(db, projectId, 'contract_evolution_failure_threshold', '0.5'));
          const budgetFloor       = parseInt(await getSetting(db, projectId, 'contract_evolution_budget_floor',       '200'), 10);
          const budgetStep        = parseInt(await getSetting(db, projectId, 'contract_evolution_budget_step',         '200'), 10);

          // Read the active contract name from handoff.md frontmatter (mirrors loader logic).
          const evolFm       = readHandoffFrontmatter(resolveHandoffMdPath(projectId));
          const contractName = evolFm.contract || 'default';

          // Load the live contract.
          const { rows: rcRows } = await db.query(
            `SELECT queries, version FROM retrieval_contract
             WHERE project_id = $1 AND name = $2`,
            [projectId, contractName]
          );
          if (rcRows.length === 0) {
            process.stderr.write(`[handoff] C3 evolution: contract '${contractName}' not found — skipping\n`);
          } else {
            const liveContract = rcRows[0].queries;
            const liveQueries  = Array.isArray(liveContract) ? liveContract : (liveContract.queries || []);

            // Only proceed if the contract has at least one query with a token_budget.
            const queriesWithBudget = liveQueries.filter((q) => typeof q.token_budget === 'number');
            if (queriesWithBudget.length === 0) {
              process.stderr.write(`[handoff] C3 evolution: contract '${contractName}' has no queries with token_budget — skipping\n`);
            } else {
              // Aggregate outcome counts per kind from retrieval_events in the rolling window.
              // query_text encodes kinds as 'loader:contract=<name>;kinds=<k1,k2,...>;sections=<n>'.
              // We extract individual kind tokens by splitting on commas and semicolons.
              // Hole B fix: >= interval predicate now goes through a port method so
              // both Postgres and SQLite produce identical row selection results.
              const withinWindowPred = db.buildWithinDaysPredicate('retrieved_at', '>=', 2);
              const { rows: evtRows } = await db.query(
                `SELECT query_text, outcome
                 FROM retrieval_events
                 WHERE project_id = $1
                   AND outcome IN ('success', 'failure', 'irrelevant')
                   AND ${withinWindowPred}`,
                [projectId, String(windowDays)]
              );

              // Parse per-kind outcome counts from query_text.
              // Format: 'loader:contract=<name>;kinds=<k1,k2,...>;sections=<n>'
              const kindStats = {};  // kind → { success, failure, irrelevant, total }
              for (const row of evtRows) {
                const kindsMatch = (row.query_text || '').match(/kinds=([^;]+)/);
                if (!kindsMatch) continue;
                const kinds = kindsMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
                for (const kind of kinds) {
                  if (!kindStats[kind]) kindStats[kind] = { success: 0, failure: 0, irrelevant: 0, total: 0 };
                  if (row.outcome === 'success')    kindStats[kind].success++;
                  if (row.outcome === 'failure')    kindStats[kind].failure++;
                  if (row.outcome === 'irrelevant') kindStats[kind].irrelevant++;
                  kindStats[kind].total++;
                }
              }

              // Identify kinds that meet the minimum event threshold.
              const qualifyingKinds = Object.entries(kindStats).filter(([, s]) => s.total >= minEvents);

              if (qualifyingKinds.length === 0) {
                console.log(`  C3 evolution: insufficient data (all kinds below min_events=${minEvents} in ${windowDays}d window) — no evolution`);
              } else {
                // Compute failure rate per qualifying kind.
                const ratedKinds = qualifyingKinds.map(([kind, s]) => ({
                  kind,
                  total:       s.total,
                  failureRate: (s.failure + s.irrelevant) / s.total,
                }));

                // Sort descending by failure rate (worst first).
                ratedKinds.sort((a, b) => b.failureRate - a.failureRate);
                const worstKind = ratedKinds[0];
                const bestKind  = ratedKinds[ratedKinds.length - 1];

                if (worstKind.failureRate <= failureThreshold) {
                  console.log(`  C3 evolution: no kind exceeds failure threshold ${failureThreshold} (worst: ${worstKind.kind} @ ${worstKind.failureRate.toFixed(2)}) — no evolution`);
                } else if (worstKind.kind === bestKind.kind) {
                  console.log(`  C3 evolution: only one qualifying kind; cannot reallocate — no evolution`);
                } else {
                  // Find the underperformer and best performer in the live contract queries.
                  const worstIdx = liveQueries.findIndex((q) => (q.kind || q.type) === worstKind.kind);
                  const bestIdx  = liveQueries.findIndex((q) => (q.kind || q.type) === bestKind.kind);

                  if (worstIdx === -1) {
                    process.stderr.write(`[handoff] C3 evolution: worst kind '${worstKind.kind}' not in live contract — skipping\n`);
                  } else {
                    // Clone queries for mutation.
                    const newQueries = liveQueries.map((q) => Object.assign({}, q));

                    const currentBudget = typeof newQueries[worstIdx].token_budget === 'number'
                      ? newQueries[worstIdx].token_budget : 0;
                    const actualReduction = Math.min(budgetStep, Math.max(0, currentBudget - budgetFloor));

                    if (actualReduction === 0) {
                      console.log(`  C3 evolution: '${worstKind.kind}' already at budget floor (${budgetFloor}) — no evolution`);
                    } else {
                      // Apply reduction to worst kind.
                      newQueries[worstIdx] = Object.assign({}, newQueries[worstIdx], {
                        token_budget: currentBudget - actualReduction,
                      });

                      // Reallocate gained budget to best kind (if in contract and different from worst).
                      if (bestIdx !== -1 && bestIdx !== worstIdx) {
                        const bestCurrent = typeof newQueries[bestIdx].token_budget === 'number'
                          ? newQueries[bestIdx].token_budget : 0;
                        newQueries[bestIdx] = Object.assign({}, newQueries[bestIdx], {
                          token_budget: bestCurrent + actualReduction,
                        });
                      }

                      const newQueriesObj = { queries: newQueries };
                      const changeNote = [
                        `auto-evolve: reduced '${worstKind.kind}' by ${actualReduction}`,
                        bestIdx !== -1 && bestIdx !== worstIdx
                          ? ` → reallocated to '${bestKind.kind}'`
                          : '',
                        ` (failureRate=${worstKind.failureRate.toFixed(2)}>threshold=${failureThreshold},`,
                        ` window=${windowDays}d, n=${worstKind.total})`,
                      ].join('');

                      await recordContractChange(db, projectId, contractName, newQueriesObj, changeNote);
                      console.log(`  C3 evolution: applied — ${changeNote}`);

                      // Write idempotency marker.
                      await setSetting(db, projectId, evolMarkerKey, new Date().toISOString());
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (evolutionErr) {
    // Fully non-fatal: any error here must not break cmdClose.
    process.stderr.write(`[handoff] C3 contract evolution failed (non-fatal): ${evolutionErr.message}\n`);
  }

  // ── L4: Write handoff.md (after C2/C3) with DEGRADED_SECTION ─────────────────
  //
  // This is the single authoritative handoff.md write for the synchronous close path.
  // When _degradedSubsystems is empty (clean close), DEGRADED_SECTION is '' and the
  // rendered output is byte-identical to the pre-L4 template output.
  // When any subsystem is degraded, a ## Degraded section is appended.
  //
  // The reconciliation gate (detectCloseContradictions) runs after the degraded list
  // is final. It never blocks close — it soft-injects a ## Reconciliation notice
  // section into handoff.md and emits warnings to stderr/stdout.
  // When no contradictions are detected, RECONCILIATION_SECTION is '' and the
  // rendered output is byte-identical to what it would be without the gate.
  {
    // cm#227: intentDivergenceLines are appended to the SAME rendered ## Degraded
    // section text but are deliberately NOT added to _degradedSubsystems itself —
    // _degradedSubsystems drives the close_degraded_exit_mode='strict' exit-code
    // gate below, and a session-intent persistence failure must remain non-fatal
    // (visibility only, exit code unchanged) regardless of exit mode.
    const degradedLines = [
      ..._degradedSubsystems.map((d) => `- ${d.subsystem} ${d.reason}`),
      ...intentDivergenceLines.map((l) => `- ${l}`),
    ];
    const degradedSection = degradedLines.length > 0
      ? '\n\n## Degraded\n' + degradedLines.join('\n')
      : '';

    // Contradiction gate — soft-inject only; never blocks close.
    let contradictions = [];
    try {
      contradictions = detectCloseContradictions(payload, _degradedSubsystems, root);
    } catch (reconcileErr) {
      // Fully non-fatal: any error here must not break cmdClose.
      process.stderr.write(`[handoff] reconciliation gate failed (non-fatal): ${reconcileErr.message}\n`);
    }

    // Pointer-staleness gate — peer to the contradiction gate; never blocks close.
    // Rewrites stale line numbers in TL;DR/open_threads/quick_references, persists
    // anchor corrections back to assertion rows, and returns findings that feed into
    // the same ## Reconciliation notice section as the contradiction gate.
    let pointerFindings = [];
    let rewrittenTldr         = payload.tldr || '(closed)';
    let rewrittenOpenThreads  = (payload.open_threads || []).map((t) => `- ${t}`).join('\n') || '- (none)';
    let rewrittenQuickRefs    = payload.quick_references || '(none)';
    try {
      // Run anchor backfill for any legacy assertion rows before validating.
      await _backfillMissingAnchors(db, projectId, root);
      // Sub-deliverable #2: suppress legacy stale-pointer rows via prose-vs-content check.
      // Runs only at close time (never at resume — §7 no-backfill invariant).
      await _suppressStaleLegacyPointers(db, projectId, root);

      const gateResult = await runPointerGate(
        {
          tldr:            rewrittenTldr,
          openThreads:     rewrittenOpenThreads,
          quickReferences: rewrittenQuickRefs,
        },
        root,
        db,
        projectId,
        'close'
      );
      rewrittenTldr        = gateResult.rewrittenFields.tldr;
      rewrittenOpenThreads = gateResult.rewrittenFields.openThreads;
      rewrittenQuickRefs   = gateResult.rewrittenFields.quickReferences;
      pointerFindings      = gateResult.findings;
    } catch (ptrErr) {
      // Fully non-fatal: any error here must not break cmdClose.
      process.stderr.write(`[handoff] pointer-gate failed (non-fatal): ${ptrErr.message}\n`);
    }

    // Combine contradiction and pointer-staleness findings into a single Reconciliation section.
    const allReconciliationFindings = [
      ...contradictions.map((c) => ({ rule: c.rule, message: c.message })),
      ...pointerFindings,
    ];
    const reconciliationSection = allReconciliationFindings.length > 0
      ? '\n\n## Reconciliation notice\n' +
        'The following issues were detected between the LLM-authored TL;DR/references\n' +
        'and engine-verified state. The engine-verified state is authoritative.\n\n' +
        allReconciliationFindings.map((c) => `- **[${c.rule}]** ${c.message}`).join('\n')
      : '';

    writeHandoffMd(handoffPath, {
      PROJECT_ID:          projectId,
      LAST_CLOSE:          stamp,
      CONTRACT:            'default',
      ENTITIES_WRITTEN:    String(entitiesWritten),
      ASSERTIONS_WRITTEN:  String(assertionsWritten),
      EDGES_WRITTEN:       String(edgesWritten),
      PROJECT_NAME:        path.basename(root),
      TLDR:                rewrittenTldr,
      OPEN_THREADS:        rewrittenOpenThreads,
      QUICK_REFERENCES:    rewrittenQuickRefs,
      DEGRADED_SECTION:    degradedSection,
      RECONCILIATION_SECTION: reconciliationSection,
    });

    // Surface degraded subsystems in the close summary (operator-visible).
    for (const d of _degradedSubsystems) {
      console.log(`  ${d.subsystem} skipped: ${d.reason}`);
    }

    // Surface reconciliation findings (contradictions + pointer staleness) as operator-visible output.
    if (allReconciliationFindings.length > 0) {
      process.stderr.write(
        `[handoff] close-reconciliation gate: ${allReconciliationFindings.length} finding(s) detected ` +
        `(${contradictions.length} contradiction(s), ${pointerFindings.length} stale pointer(s)) ` +
        `(see handoff.md ## Reconciliation notice)\n`
      );
      for (const c of allReconciliationFindings) {
        console.log(`  RECONCILIATION [${c.rule}]: ${c.message}`);
      }
    }
  }

  // ── Part 2: degraded_close retention prune ────────────────────────────────────
  //
  // Keep the 100 most-recent degraded_close:* records; delete only the oldest
  // excess beyond that limit.  This bounds unbounded growth while preserving
  // the append-only audit trail — successive degraded closes always accumulate
  // as distinct rows until the corpus exceeds 100 entries.
  //
  // Fail-soft: errors are logged to stderr and never abort close.
  await pruneDegradedClose(db, projectId);

  // ── Packaging-honesty display (non-fatal, synchronous close path only) ────────
  //
  // Detects whether the session's work is already committed and pushed, and
  // displays the result.  The has_unpackaged_state assertion is now written
  // authoritatively via payload.assertions (injected above, before writeExtraction)
  // so no separate writeAssertionWithSupersession call is needed here.
  // NEVER blocks, commits, stashes, pushes, or mutates the repository.
  try {
    const packState = detectUnpackagedState(root);
    if (packState.unpackaged) {
      console.log(`\n  packaging:           UNPACKAGED — ${packState.label}`);
      console.log('  (session work is not fully committed/pushed; close record reflects actual state)');
    } else {
      console.log(`\n  packaging:           clean`);
    }
  } catch (packErr) {
    process.stderr.write(`[handoff] packaging-honesty probe failed (non-fatal): ${packErr.message}\n`);
  }

  // S4/F-6: clear this session's session_in_progress marker (never a sibling
  // session's — see clearSessionMarkerForClose) ONLY on a clean close. A close
  // that surfaced a DIVERGENCE (cm#227/#229 — a session_tldr/open_thread/
  // quick_reference persistence failure) leaves the marker in place as a
  // safety net: this session's work was not fully persisted, so the implicit-
  // close paths (SessionEnd / late-close) get a chance to catch it later
  // rather than the close silently declaring itself done.
  let markerOutcome;
  if (intentDivergenceLines.length === 0) {
    markerOutcome = await clearSessionMarkerForClose(db, projectId, payload);
  } else {
    process.stderr.write(
      `[handoff] close: session_in_progress marker NOT cleared — ${intentDivergenceLines.length} DIVERGENCE line(s) present\n`
    );
    markerOutcome = {
      branch: 'DIVERGENCE',
      deleted: 0,
      ownedBy: [],
      dropped: 0,
      coerced: 0,
      text: `session marker left in place (${intentDivergenceLines.length} DIVERGENCE line(s) present)`,
    };
  }

  // Run reranker gate (informational)
  await runRerankerGate(db, projectId, root);

  // L4: Read close_degraded_exit_mode BEFORE closing the DB connection.
  // Values: 'warn' (default, exit 0) | 'strict' (exit 3 on any degraded subsystem).
  const closeDegradedExitMode = await getSetting(db, projectId, 'close_degraded_exit_mode', 'warn');

  // E3: append the classifier's own verbatim state to the Done line — read
  // BEFORE db.end() (below), non-fatal on any probe failure.
  let closeEmbeddingState = 'UNKNOWN';
  try {
    closeEmbeddingState = await computeEmbeddingReadiness(db, projectId);
  } catch (_) { /* non-fatal — Done line still prints */ }

  await db.end();

  console.log(`\n  entities written:    ${entitiesWritten}`);
  console.log(`  assertions written:  ${assertionsWritten}`);
  console.log(`  edges written:       ${edgesWritten}`);
  console.log(`  decisions written:   ${decisionsWritten}`);
  console.log(`  contract:            updated`);

  // cm#227: any session_tldr/open_thread/quick_reference persistence failure —
  // non-fatal (exit code unchanged), but must never be silently invisible in
  // the close summary (see also the ## Degraded section in handoff.md above).
  for (const line of intentDivergenceLines) {
    console.log(`  ${line}`);
  }

  // Extraction-empty warning (non-fatal, does not block the close or change
  // the exit code). Detection uses extractionEmptyAtEntry — the snapshot
  // taken before the L3 has_unpackaged_state authoritative-assertion
  // injection, so a close whose caller-supplied payload was empty still
  // reads as empty even though the engine itself added one assertion.
  if (extractionEmptyAtEntry) {
    console.log(
      '\n  WARNING: extraction-empty close — payload carried no entities/assertions/edges. ' +
      'The close contract expects the full extraction in one pass (see commands/handoff/close.md §1-§5). ' +
      'Intent rows were still written.'
    );
  }

  console.log(`\nDone: handoff:close — project=${path.basename(root)} marker=${projectId} — ${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written, decisions: ${decisionsWritten}${embedWarnSuffix}, embedding: ${closeEmbeddingState}, ${markerOutcome.text}`);

  // L4: Exit-code gate — 'strict' mode exits 3 when any subsystem ran degraded.
  if (_degradedSubsystems.length > 0 && closeDegradedExitMode === 'strict') {
    process.stderr.write(
      `[handoff] close_degraded_exit_mode=strict — exiting 3 (${_degradedSubsystems.length} degraded subsystem(s))\n`
    );
    process.exit(3);
  }
}

// ── purge ─────────────────────────────────────────────────────────────────────

async function cmdPurge(args) {
  console.log('Running: handoff:purge');

  const projectId   = resolveProjectId();
  const handoffPath = resolveHandoffMdPath(projectId);

  const skipConfirm = args.includes('--yes');
  const dryRun      = args.includes('--dry-run');

  // ── Dry-run: count rows that WOULD be deleted, then exit without touching anything ──
  if (dryRun) {
    let db;
    try {
      db = await connectHandoff();
    } catch (err) {
      console.error(`DB connection failed: ${err.message}`);
      process.exit(1);
    }

    const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings'];
    console.log(`\n  Dry-run — rows that WOULD be deleted for project_id="${projectId}":`);
    for (const tbl of tables) {
      const { rows } = await db.query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE project_id = $1`, [projectId]);
      console.log(`    ${tbl}: ${rows[0].n}`);
    }
    const handoffExists = fs.existsSync(handoffPath);
    console.log(`    handoff.md: ${handoffExists ? 'exists (would be deleted)' : '(not found)'}`);
    console.log('\n  (Dry-run — no rows deleted, no files removed.)');

    await db.end();
    console.log('\nDone: handoff:purge — dry-run complete (no changes made)');
    return;
  }

  if (!skipConfirm) {
    // Interactive confirmation via stdin
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(
        `\n  WARNING: This will permanently delete ALL memory rows for project_id="${projectId}".\n  Type "yes" to confirm: `,
        (a) => { rl.close(); resolve(a.trim()); }
      );
    });
    if (answer.toLowerCase() !== 'yes') {
      console.log('\n  Purge cancelled.');
      console.log('\nDone: handoff:purge — cancelled (no changes made)');
      return;
    }
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Hard delete in dependency order
  const tables = ['edges', 'assertions', 'entities', 'retrieval_contract', 'project_settings'];
  for (const tbl of tables) {
    await db.query(`DELETE FROM ${tbl} WHERE project_id = $1`, [projectId]);
  }

  // Delete handoff.md
  if (fs.existsSync(handoffPath)) {
    fs.unlinkSync(handoffPath);
  }

  await db.end();

  console.log(`\n  All rows deleted for project_id="${projectId}".`);
  console.log(`  handoff.md removed.`);
  console.log(`\nDone: handoff:purge — all project memory permanently deleted`);
}

// ── loader-stop (SessionEnd hook entry point) ────────────────────────────────

/**
 * SessionEnd hook for implicit session close.
 *
 * Historically wired under the Claude Code Stop hook, which fires at EVERY
 * turn end — that fired an implicit close at the first turn end of every
 * session, clobbering the session TLDR and leaving the rest of the session
 * unprotected. Wired under SessionEnd instead (fires once, at true session
 * end): checks whether /handoff:close or /handoff:checkpoint ran during this
 * session (via this session's own session_in_progress marker, set by
 * cmdLoaderHook). If not, writes an implicit close record to handoff.md and
 * clears the marker.
 *
 * S1 (total classification, zero I/O before it): hook_event_name is read from
 * stdin with a permissive, fail-open parser (readHookStdinPermissive) BEFORE
 * any file or DB I/O. Anything other than hook_event_name === 'SessionEnd' —
 * 'Stop', any other value, missing, empty, or malformed stdin — exits 0
 * immediately with no I/O at all. This is the entire point of the fix: a
 * Stop-shaped invocation (or any leftover wiring from before this PR) must
 * never pay a DB round trip.
 *
 * S4: clears only the CURRENT session's own marker (an exact session_id
 * match, or a legacy bare marker — see findMatchingMarkerIndex). A sibling
 * session's marker is left untouched; cmdLoaderHook's late-close sweep is
 * responsible for eventually reconciling an abandoned sibling marker.
 *
 * Defensive contract: ALWAYS exits 0. Any error is logged to stderr and the
 * hook exits silently — we must never break session teardown.
 *
 * cm#263 (loader-stop verifiability): SessionEnd firing was previously
 * invisible except via stderr, which the harness swallows — there was no
 * persisted evidence it ran. Every exit path AFTER the S1 filter above (i.e.
 * every real SessionEnd-shaped invocation — a Stop-shaped or malformed
 * invocation still pays zero I/O, per S1, and records nothing) now upserts
 * one project_settings row, key 'last_loader_stop', value
 * {ts, session_id, outcome}, outcome in one of:
 *   'implicit_close_recorded'  — this session's marker matched; implicit
 *                                 close ran.
 *   'explicit_close_present'   — no marker matched, and the last recorded
 *                                 clearSessionMarkerForClose breadcrumb
 *                                 (project_settings 'last_explicit_close')
 *                                 names THIS session — an explicit close (or
 *                                 checkpoint-queue enqueue) already ran.
 *   'no_marker'                — no marker matched and no matching explicit-
 *                                 close breadcrumb either (loader-hook never
 *                                 fired for this session, project not
 *                                 provisioned, or implicit_close=disabled).
 *   'session_id_unresolved'    — PR4: the hook payload carried no usable
 *                                 session_id AND CLAUDE_CODE_SESSION_ID /
 *                                 CODEX_THREAD_ID were both set and
 *                                 DIFFERED — resolveClearSessionId refused
 *                                 to guess (see its header comment). Distinct
 *                                 from no_marker: here identity itself could
 *                                 not be established, so no marker lookup
 *                                 was even meaningful, vs. no_marker's
 *                                 "identity known, nothing matched it".
 *   'error:<short>'            — an exception was caught before an outcome
 *                                 could be determined.
 * Persistence is fail-soft end to end (see persistOutcome): a failure to
 * write the row NEVER changes this hook's exit code or behavior. It also
 * cannot happen at all when there is no DB connection or no project id to
 * key the row on — see BLIND SPOTS in the PR description.
 */
async function cmdLoaderStop(args) {
  // codex-host-adapter --host total classification — BEFORE any other I/O.
  // Codex's SessionEnd hooks.json entry invokes this with a trailing
  // ` --host codex` (see scripts/lib/host-target.js / install.js S3); a
  // malformed value is a refusal (exit 2), never silently ignored.
  let host = 'claude';
  {
    const hostResult = resolveHost(args || [], process.env);
    if (!hostResult.ok) {
      process.stderr.write(`handoff loader-stop: refusing — ${hostResult.reason}\n`);
      process.exit(2);
    }
    host = hostResult.host;
  }
  // S1 — total classification BEFORE any file or DB I/O.
  const hookPayload = readHookStdinPermissive();
  if (!hookPayload || hookPayload.hook_event_name !== 'SessionEnd') {
    process.exit(0);
  }

  // PR4 R1: strict, host-independent clear-time resolution — `host` (used
  // only for the earlier --host argv gate above) is never consulted here.
  // See resolveClearSessionId's header comment for the reproduced defect
  // this replaces (a nested child inheriting an ancestor's CODEX_THREAD_ID
  // under --host codex, misattributed to the parent's real identity).
  const currentSessionId = resolveClearSessionId(hookPayload);

  let db = null;
  let projectId = null;
  let dbEnded = false;

  async function persistOutcome(outcome) {
    if (!db || !projectId || dbEnded) return;
    try {
      await setSetting(db, projectId, 'last_loader_stop', JSON.stringify({
        ts: new Date().toISOString(),
        session_id: currentSessionId || null,
        outcome,
      }));
    } catch (_) { /* fail-soft: persistence failure never changes exit code */ }
  }

  async function endDb() {
    if (db && !dbEnded) {
      dbEnded = true;
      try { await db.end(); } catch (_) { /* ignore */ }
    }
  }

  try {
    projectId = resolveProjectId();
    const handoffPath = resolveHandoffMdPath(projectId);

    try {
      db = await connectHandoff();
    } catch (err) {
      // No DB connection means the outcome row cannot be persisted either —
      // there is nowhere to write it. Still fail-soft: exit 0 regardless.
      process.stderr.write(`handoff loader-stop: DB connection failed (${err.message}) — skipping\n`);
      process.exit(0);
    }

    // Defensive: handoff.md absent means project is not provisioned — no-op.
    if (!fs.existsSync(handoffPath)) {
      await persistOutcome('no_marker');
      await endDb();
      process.exit(0);
    }

    // Check project-level implicit_close gate (default enabled). S6: 'disabled' is
    // a full no-op here.
    const implicitClose = await getSetting(db, projectId, 'implicit_close', 'enabled');
    if (implicitClose === 'disabled') {
      await persistOutcome('no_marker');
      await endDb();
      process.exit(0);
    }

    // Check for THIS session's own marker, and — if matched — write the
    // implicit close and clear it, all under one advisory-locked transaction
    // (see withSessionMarkerLock) so a concurrent SessionStart/SessionEnd for
    // the same project cannot race the read-modify-write and lose a marker.
    //   No match → close already ran (or loader hook never fired for this
    //              session). No-op — a sibling session's marker is not ours
    //              to act on here.
    //   Match    → no explicit close ran this session. Run implicit close.
    const acted = await withSessionMarkerLock(db, projectId, async () => {
      const markers = await getSessionMarkers(db, projectId);
      const matchIdx = findMatchingMarkerIndex(markers, currentSessionId);
      if (matchIdx === -1) return false;

      process.stderr.write('Running: handoff SessionEnd hook — implicit close...\n');
      writeImplicitClose(handoffPath, projectId, findProjectRoot());

      // Clear only the matched marker — leave any sibling session's marker alone.
      const remaining = markers.filter((_, i) => i !== matchIdx);
      await setSessionMarkers(db, projectId, remaining);
      return true;
    });

    if (!acted) {
      // PR4 R3: an ambiguous env pair (CLAUDE_CODE_SESSION_ID and
      // CODEX_THREAD_ID both set and differing, with no usable payload
      // session_id) resolved currentSessionId to null via
      // resolveClearSessionId — distinct from "no marker was ever set".
      // Truthfully record that resolution failed rather than folding it
      // into no_marker (fix(close)'s truthfulness rule, PR #278).
      const payloadHadId = !!(hookPayload
        && typeof hookPayload.session_id === 'string'
        && hookPayload.session_id.trim().length > 0);
      if (currentSessionId === null && !payloadHadId && isAmbiguousSessionEnvPair()) {
        await persistOutcome('session_id_unresolved');
        await endDb();
        process.exit(0);
      }

      // Disambiguate "explicit close already ran this session" from "no
      // marker was ever set" via the clearSessionMarkerForClose breadcrumb.
      let outcome = 'no_marker';
      try {
        const lastExplicitRaw = await getSetting(db, projectId, 'last_explicit_close', null);
        if (lastExplicitRaw && currentSessionId) {
          const lastExplicit = JSON.parse(lastExplicitRaw);
          if (lastExplicit && lastExplicit.session_id === currentSessionId) {
            outcome = 'explicit_close_present';
          }
        }
      } catch (_) { /* malformed breadcrumb — fall back to no_marker */ }
      await persistOutcome(outcome);
      await endDb();
      process.exit(0);
    }

    await persistOutcome('implicit_close_recorded');
    await endDb();

    const projectName = path.basename(findProjectRoot());
    process.stderr.write(`Done: handoff SessionEnd hook — project=${projectName} marker=${projectId} — implicit close written, session marker cleared\n`);
    process.exit(0);

  } catch (err) {
    // Catch-all: log to stderr, never break session teardown.
    process.stderr.write(`handoff loader-stop error: ${err.message}\n`);
    await persistOutcome(`error:${String(err.message || err).slice(0, 80)}`);
    await endDb();
    process.exit(0);
  }
}

// ── promote ───────────────────────────────────────────────────────────────────

/**
 * `promote --regenerate [--dry-run]` — rewrite the promotion file (CLAUDE.md /
 * AGENTS.md) from the template, without running `init --force-promotion`
 * (which bundles ~9 unrelated DB/FS writes).
 *
 * Preconditions (checked before anything is touched): the project marker
 * must be resolvable, and the DB must be reachable. Either failing exits 1
 * with nothing written — no backup, no regenerated file.
 *
 * Target-state total classification (via classifyPromotionRegenerateTarget):
 *   'absent'                    → write fresh, no backup.
 *   'file'                      → back up, then write fresh (with carry-forward).
 *   'directory'/'symlink'/'other' → exit 1, nothing written.
 *
 * Carry-forward: when the target is a regular file, its "## Durable facts"
 * section (if parseable) is re-inserted into the fresh render, replacing the
 * placeholder line. An unparseable section still regenerates the file (the
 * old content is fully preserved in the backup) but prints a warning that
 * nothing was carried forward.
 *
 * --dry-run performs reads only: no backup is made, no file is written, and
 * (since this path never touches assertion rows) no DB row is ever mutated
 * either way — only the reachability precondition connects to the DB at all.
 */
async function cmdPromoteRegenerate({ dryRun, projectName }) {
  // ── Preconditions ────────────────────────────────────────────────────────
  const root = findProjectRoot();

  const startDir  = process.env.PROJECT_ROOT || process.cwd();
  let markerOk = false;
  try {
    const markerRoot = findProjectRootByMarker(startDir);
    if (markerRoot) {
      const marker = readMarker(markerRoot);
      markerOk = !!(marker && marker.uuid);
    }
  } catch (_) {
    markerOk = false; // corrupt/dual marker — not resolvable, not fatal to detect
  }
  if (!markerOk) {
    console.error(
      `promote --regenerate: project marker not resolvable (no ${MARKER_FILENAME} found above ${startDir}) — nothing written`
    );
    process.exit(1);
  }

  // Shared resolution (same as cmdInit/cmdClose/cmdPromote's own top) — host
  // resolved first, then the filename default derived from that host, so
  // HANDOFF_HOST=codex with HANDOFF_PROMOTION_FILE unset targets AGENTS.md
  // here too, never CLAUDE.md.
  const promotionTargetResult = resolvePromotionTarget(root, process.env);
  if (!promotionTargetResult.ok) {
    // Same failure shape/exit code as cmdInit's own resolvePromotionTarget() gate.
    console.error(`promote --regenerate: ${promotionTargetResult.reason}`);
    process.exit(2);
  }
  if (promotionTargetResult.warning) {
    process.stderr.write(promotionTargetResult.warning + '\n');
  }
  const claudeMdPath       = promotionTargetResult.filePath;
  const promotionFilename  = promotionTargetResult.filename;
  const promotionTemplate  = promotionTargetResult.host === 'codex' ? PROJECT_AGENTS_MD_TEMPLATE : PROJECT_CLAUDE_MD_TEMPLATE;

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`promote --regenerate: DB connection failed: ${err.message} — nothing written`);
    process.exit(1);
  }
  await db.end(); // reachability is the only thing this command needs the DB for

  // ── Target-state classification ─────────────────────────────────────────
  const targetKind = classifyPromotionRegenerateTarget(claudeMdPath);

  if (targetKind === 'directory' || targetKind === 'symlink' || targetKind === 'other') {
    console.error(
      `promote --regenerate: ${claudeMdPath} is a ${targetKind}, not a regular file or absent — refusing to write. Nothing written.`
    );
    process.exit(1);
  }

  let eol = '\n';
  let factLines = [];
  let sectionParseable = true;
  let existingContentForName;

  if (targetKind === 'file') {
    const existingContent = fs.readFileSync(claudeMdPath, 'utf8');
    existingContentForName = existingContent;
    eol = detectDominantEol(existingContent);
    const parsed = parseDurableFactsSection(existingContent);
    if (parsed === null) {
      sectionParseable = false;
    } else {
      factLines = parsed;
    }
  }

  const carriedCount = factLines.filter((l) => !/^<!--/.test(l.trim())).length;

  // Project display name — SAME shared resolver cmdInit uses (see PR #290:
  // this call site used to fall back to `path.basename(root)` directly,
  // which is exactly what leaked a worktree's disposable directory name
  // into a fresh CLAUDE.md's H1 when regenerate ran from
  // `.claude/worktrees/agent-<hex>`).
  const nameResolution = resolveProjectDisplayName({
    root,
    explicitName: projectName,
    existingFileContent: existingContentForName,
  });

  // Normalize to LF regardless of the template file's own on-disk EOL (which
  // varies by checkout platform — e.g. core.autocrlf on Windows — since
  // .gitattributes only pins *.sql to LF, not *.tpl). insertCarriedDurableFacts'
  // heading/placeholder match is LF-literal, so it must run on normalized text;
  // convertEol() re-emits the actually-desired EOL afterward.
  const freshRaw    = renderFreshPromotionContent({ root, projectName: nameResolution.name, promotionTemplate, host: promotionTargetResult.host, env: process.env });
  const freshLf     = freshRaw.replace(/\r\n/g, '\n');
  const withFacts   = insertCarriedDurableFacts(freshLf, factLines);
  const finalContent = convertEol(withFacts, eol);
  const bytes         = Buffer.byteLength(finalContent, 'utf8');

  if (dryRun) {
    console.log(`promote --regenerate (dry-run): would target ${claudeMdPath}`);
    console.log(`  target-state:      ${targetKind}`);
    console.log(`  project name:      ${nameResolution.name} (branch ${nameResolution.branch})`);
    console.log(`  would back up:     ${targetKind === 'file' ? 'yes' : 'no'}`);
    console.log(`  would-be bytes:    ${bytes}`);
    console.log(`  facts that would carry: ${carriedCount}`);
    if (targetKind === 'file' && !sectionParseable) {
      console.log(
        `  [WARN]  existing ${promotionFilename} has no parseable "## Durable facts" section — ` +
        `prior content would NOT be carried forward (it would remain recoverable in the backup).`
      );
    }
    console.log(`\nDone: handoff:promote --regenerate (dry-run) — no changes written`);
    return;
  }

  let backupPath = null;
  if (targetKind === 'file') {
    backupPath = `${claudeMdPath}.bak-${Date.now()}-${process.hrtime.bigint()}-${process.pid}`;
    fs.copyFileSync(claudeMdPath, backupPath);
  }

  writePromotionFileAtomic(claudeMdPath, finalContent);

  if (targetKind === 'file' && !sectionParseable) {
    console.log(
      `  [WARN]  existing ${promotionFilename} had no parseable "## Durable facts" section — ` +
      `prior content was NOT carried forward; it is preserved in the backup: ${backupPath}`
    );
  }
  console.log(`  path:          ${claudeMdPath}`);
  console.log(`  bytes:         ${bytes}`);
  console.log(`  backup:        ${backupPath || 'none'}`);
  console.log(`  facts carried: ${carriedCount}`);
  console.log(`\nDone: handoff:promote --regenerate — ${promotionFilename} regenerated`);
}

/**
 * Explicitly promote a single assertion to the durable-facts promotion file
 * (default CLAUDE.md; configurable via HANDOFF_PROMOTION_FILE).
 * Idempotent: re-running on an already-promoted assertion prints a notice and exits 0.
 *
 * Usage: node scripts/handoff.js promote <assertion_id>
 *   assertion_id — integer primary key from the assertions table.
 */
async function cmdPromote(args) {
  // ── Parse flags ─────────────────────────────────────────────────────────────
  //
  // Four invocation forms:
  //   promote <id>                          — promote by integer id (original)
  //   promote --subject S [--predicate P] [--object O]  — promote by content
  //   promote --demote <id>                 — reverse a prior promote
  //   promote --regenerate [--dry-run] [--project-name <name>]
  //                                          — rewrite the promotion file from
  //                                            the template (no `init --force-promotion`
  //                                            DB/FS side effects)

  // ── --regenerate [--dry-run] [--project-name <name>] ─────────────────────
  //
  // TOTAL classification of this branch's own argument space: once
  // `--regenerate` is present, the ONLY other tokens this command recognizes
  // are `--dry-run` and `--project-name <name>` (that flag's value token
  // consumed with it). Anything else — a positional (bare id), a flag that
  // belongs to one of the other three invocation forms (--demote, --subject,
  // --predicate, --object), or a genuinely unknown flag — is rejected the
  // same way (exit 2). This is deliberately not an allow-list of "known
  // other-form flags to reject": every non-{--regenerate,--dry-run,
  // --project-name,<its value>} token is rejected, so a future flag added to
  // another form never silently slips through here uncaught.
  if (args.includes('--regenerate')) {
    const projectNameIdx = args.indexOf('--project-name');
    let explicitProjectName;
    if (projectNameIdx !== -1) {
      explicitProjectName = args[projectNameIdx + 1];
      if (!explicitProjectName || explicitProjectName.startsWith('--')) {
        console.error(
          `promote --regenerate --project-name requires a value. ` +
          `Usage: node scripts/handoff.js promote --regenerate [--dry-run] [--project-name <name>]`
        );
        process.exit(2);
      }
    }
    const extra = args.filter((a, i) => {
      if (a === '--regenerate' || a === '--dry-run') return false;
      if (projectNameIdx !== -1 && (i === projectNameIdx || i === projectNameIdx + 1)) return false;
      return true;
    });
    if (extra.length > 0) {
      console.error(
        `promote --regenerate takes no other arguments except --project-name <name> (got: ${extra.join(' ')}). ` +
        `Usage: node scripts/handoff.js promote --regenerate [--dry-run] [--project-name <name>]`
      );
      process.exit(2);
    }
    await cmdPromoteRegenerate({ dryRun: args.includes('--dry-run'), projectName: explicitProjectName });
    return;
  }

  const root        = findProjectRoot();
  const projectId   = resolveProjectId();
  // Shared resolution (same as cmdInit/cmdClose) — host resolved first, then
  // the filename default is derived from that host, so HANDOFF_HOST=codex
  // with HANDOFF_PROMOTION_FILE unset targets AGENTS.md here too.
  const promotionTargetResult = resolvePromotionTarget(root, process.env);
  if (!promotionTargetResult.ok) {
    console.error(`promote: ${promotionTargetResult.reason}`);
    process.exit(2);
  }
  if (promotionTargetResult.warning) {
    process.stderr.write(promotionTargetResult.warning + '\n');
  }
  const claudeMdPath = promotionTargetResult.filePath;
  const promoteFilename = promotionTargetResult.filename;

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── --demote <id> ────────────────────────────────────────────────────────────
  const demoteIdx = args.indexOf('--demote');
  if (demoteIdx !== -1) {
    const demoteIdArg = args[demoteIdx + 1];
    if (!demoteIdArg || demoteIdArg.startsWith('--')) {
      await db.end();
      console.error('promote --demote requires an assertion_id argument');
      process.exit(2);
    }
    const demoteId = parseInt(demoteIdArg, 10);
    if (isNaN(demoteId)) {
      await db.end();
      console.error(`promote --demote: invalid assertion_id "${demoteIdArg}" — must be an integer`);
      process.exit(2);
    }

    // Fetch the row.
    const { rows: demoteRows } = await db.query(
      `SELECT id, subject, predicate, object, confidence, promoted, promoted_at
       FROM assertions WHERE id = $1 AND project_id = $2`,
      [demoteId, projectId]
    );
    if (demoteRows.length === 0) {
      await db.end();
      console.error(`promote --demote: assertion id=${demoteId} not found in this project`);
      process.exit(2);
    }
    const demoteRow = demoteRows[0];

    if (!demoteRow.promoted) {
      await db.end();
      console.log(`promote --demote: assertion id=${demoteId} is not currently promoted — nothing to demote`);
      process.exit(0);
    }

    // Clear the promoted flag in the DB.
    await db.query(
      `UPDATE assertions SET promoted = false, promoted_at = NULL WHERE id = $1`,
      [demoteId]
    );

    // Remove the matching lines from the promotion file.
    // We look for the annotation line (source_assertion=<id>) and the fact line that follows it.
    if (fs.existsSync(claudeMdPath)) {
      const claudeContent = fs.readFileSync(claudeMdPath, 'utf8');
      // Match the annotation line (HTML comment) and the fact line immediately after it.
      const annotationPattern = new RegExp(
        `<!-- promoted:[^>]*source_assertion=${demoteId}[^>]*-->\\n- \\[conf=[^\\]]+\\] [^\\n]+\\n?`,
        'g'
      );
      const demoted = claudeContent.replace(annotationPattern, '');
      if (demoted !== claudeContent) {
        fs.writeFileSync(claudeMdPath, demoted, 'utf8');
        console.log(`  removed ${promoteFilename} entry for assertion id=${demoteId}`);
      } else {
        console.log(`  note: no matching ${promoteFilename} line found for assertion id=${demoteId} (may have been manually edited)`);
      }
    }

    await db.end();

    const factLine = `- [conf=${demoteRow.confidence}] ${demoteRow.subject} ${demoteRow.predicate} ${demoteRow.object}`;
    console.log(`demoted: ${factLine}`);
    console.log(`\nDone: handoff:promote --demote — assertion id=${demoteId} demotion complete`);
    return;
  }

  // ── Promote by content: --subject/--predicate/--object ──────────────────────
  const hasSubjectFlag = args.includes('--subject');
  if (hasSubjectFlag) {
    const subjectIdx   = args.indexOf('--subject');
    const predicateIdx = args.indexOf('--predicate');
    const objectIdx    = args.indexOf('--object');

    const subjectVal   = subjectIdx   !== -1 ? args[subjectIdx + 1]   : null;
    const predicateVal = predicateIdx !== -1 ? args[predicateIdx + 1] : null;
    const objectVal    = objectIdx    !== -1 ? args[objectIdx + 1]    : null;

    if (!subjectVal || subjectVal.startsWith('--')) {
      await db.end();
      console.error('promote --subject requires a value, e.g.: promote --subject "vLLM" --predicate "is_model" --object "Qwen3-Embedding-8B"');
      process.exit(2);
    }

    // Build the query dynamically based on which filters were supplied.
    let filterSql   = 'project_id = $1 AND suppressed = false AND invalid_at IS NULL AND LOWER(TRIM(subject)) = LOWER(TRIM($2))';
    const filterParams = [projectId, subjectVal];
    let paramIndex = 3;

    if (predicateVal && !predicateVal.startsWith('--')) {
      filterSql += ` AND predicate = $${paramIndex++}`;
      filterParams.push(predicateVal);
    }
    if (objectVal && !objectVal.startsWith('--')) {
      filterSql += ` AND object = $${paramIndex++}`;
      filterParams.push(objectVal);
    }

    const { rows: contentRows } = await db.query(
      `SELECT id, subject, predicate, object, confidence, source, promoted, promoted_at
       FROM assertions WHERE ${filterSql} ORDER BY id`,
      filterParams
    );

    if (contentRows.length === 0) {
      await db.end();
      console.error(`promote: no live assertion matches subject="${subjectVal}"${predicateVal ? ` predicate="${predicateVal}"` : ''}${objectVal ? ` object="${objectVal}"` : ''}`);
      console.error(`  Hint: check spelling with /handoff:status or query the assertions table directly.`);
      process.exit(2);
    }

    if (contentRows.length > 1) {
      await db.end();
      console.error(`promote: ${contentRows.length} live assertions match — disambiguate by id:`);
      for (const r of contentRows) {
        console.error(`  id=${r.id}  ${r.subject} ${r.predicate} ${r.object}  [conf=${r.confidence}|${r.source}]`);
      }
      console.error(`  Re-run: promote <id>   or add --predicate/--object to narrow the match.`);
      process.exit(2);
    }

    // Exactly one match — delegate to the promote-by-id path using the resolved id.
    args = [String(contentRows[0].id)];
    // Fall through to promote-by-id path below.
  }

  // ── Original promote-by-id path ─────────────────────────────────────────────
  const idArg = args[0];
  if (!idArg) {
    await db.end();
    console.error('Usage: node scripts/handoff.js promote <assertion_id>');
    console.error('       node scripts/handoff.js promote --subject <s> [--predicate <p>] [--object <o>]');
    console.error('       node scripts/handoff.js promote --demote <id>');
    process.exit(2);
  }
  const assertionId = parseInt(idArg, 10);
  if (isNaN(assertionId)) {
    await db.end();
    console.error(`promote: invalid assertion_id "${idArg}" — must be an integer`);
    process.exit(2);
  }

  // Look up the assertion.
  const { rows } = await db.query(
    `SELECT id, project_id, subject, predicate, object, confidence, source, promoted, promoted_at
     FROM assertions WHERE id = $1`,
    [assertionId]
  );

  if (rows.length === 0) {
    await db.end();
    console.error(`promote: assertion id=${assertionId} not found`);
    process.exit(2);
  }

  const row = rows[0];

  // Idempotent: already promoted.
  if (row.promoted) {
    await db.end();
    const promotedDate = row.promoted_at
      ? new Date(row.promoted_at).toISOString().slice(0, 10)
      : '(unknown date)';
    console.log(`already promoted on ${promotedDate}: [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`);
    process.exit(0);
  }

  // Build the annotation + fact line using the same template as cmdClose auto-promotion.
  const today     = new Date().toISOString().slice(0, 10);
  const annotation = `<!-- promoted: session=explicit, conf=${row.confidence}, date=${today}, source_assertion=${row.id} -->`;
  const factLine   = `- [conf=${row.confidence}] ${row.subject} ${row.predicate} ${row.object}`;

  // Append to the promotion file under ## Durable facts.
  if (!fs.existsSync(claudeMdPath)) {
    await db.end();
    console.error(`promote: ${promoteFilename} not found at ${claudeMdPath} — run /handoff:init first`);
    process.exit(1);
  }

  const existing = fs.readFileSync(claudeMdPath, 'utf8');
  let updated;
  if (existing.includes('## Durable facts')) {
    // Insert before the closing of the Durable facts section.
    updated = existing.replace(
      /(## Durable facts\n)([\s\S]*?)(\n(?=##)|$)/,
      (_, heading, body, tail) => `${heading}${body}\n${annotation}\n${factLine}${tail}`
    );
  } else {
    updated = existing + `\n## Durable facts\n${annotation}\n${factLine}\n`;
  }
  fs.writeFileSync(claudeMdPath, updated, 'utf8');

  // Mark assertion as promoted and graduate to consolidated tier.
  // Two-tier durability: explicit promote is the sanctioned graduation arm (not a §7 violation —
  // §7 forbids auto-mutating the existing corpus; explicit /handoff:promote of one targeted row
  // is an intentional user-driven action, not a backfill).  Sets tier='consolidated',
  // consolidated_at=now() in addition to the existing promoted/promoted_at columns.
  await db.query(
    `UPDATE assertions
     SET promoted = true, promoted_at = now(),
         tier = 'consolidated', consolidated_at = now()
     WHERE id = $1`,
    [assertionId]
  );

  await db.end();

  console.log(`promoted: ${annotation}`);
  console.log(`          ${factLine}`);
  console.log(`\nDone: handoff:promote — assertion id=${assertionId} promoted to ${promoteFilename}`);
}

// ── resurrect ────────────────────────────────────────────────────────────────

/**
 * /handoff:resurrect <topic> [--revive|-r] [--limit=N]
 *
 * Manually surface (dry-run) or un-suppress (--revive) dormant notes matching
 * a topic seed. Backed by runResurrectQuery — the same engine used by the
 * contract-driven loader branch, with no token-budget ceiling in CLI mode.
 *
 * Usage:
 *   node scripts/handoff.js resurrect "auth bug"
 *   node scripts/handoff.js resurrect "auth bug" --revive
 *   node scripts/handoff.js resurrect "auth bug" --revive --limit=30
 *
 * Exit codes:
 *   0  success (matches or no matches both count as success)
 *   1  DB error (connect / query failure)
 *   2  bad usage (missing seed text)
 */
async function cmdResurrect(args) {
  console.log('Running: handoff:resurrect');

  // ── Parse flags ─────────────────────────────────────────────────────────────

  const helpFlag   = args.includes('--help') || args.includes('-h');
  const reviveFlag = args.includes('--revive') || args.includes('-r');
  const jsonFlag   = args.includes('--json');

  const limitArg = args.find((a) => a.startsWith('--limit='));
  let limit = 20;
  if (limitArg) {
    const parsed = parseInt(limitArg.slice('--limit='.length), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      process.stderr.write('resurrect: --limit must be a positive integer\n');
      process.exit(2);
    }
    limit = parsed;
  }

  // Usage / help
  const USAGE = [
    'Usage: node scripts/handoff.js resurrect <topic> [--revive|-r] [--limit=N] [--json]',
    '',
    '  <topic>      Topic seed text (required). Quoted phrases recommended.',
    '  --revive,-r  Un-suppress matching probationary rows (default: dry-run only).',
    '  --limit=N    Cap candidate subject set size (default 20).',
    '  --json       Emit structured JSON instead of prose.',
    '  --help,-h    Show this help and exit.',
    '',
    'Dry-run mode (default): prints a preview of what WOULD be resurrected.',
    'With --revive:          actually clears the suppressed flag on matched rows.',
    '',
    'Exit codes: 0 success, 1 DB error, 2 bad usage.',
  ].join('\n');

  if (helpFlag) {
    console.log(USAGE);
    process.exit(0);
  }

  // Positional arg: first non-flag argument is the seed text.
  // Exclude all flag tokens (starting with '-') from the seed.
  const seedText = args.filter((a) => !a.startsWith('-')).join(' ').trim();

  if (!seedText) {
    process.stderr.write('resurrect: seed text is required\n\n');
    process.stderr.write(USAGE + '\n');
    process.exit(2);
  }

  // ── Connect to DB ────────────────────────────────────────────────────────────

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    process.stderr.write(`DB connection failed: ${err.message}\n`);
    process.exit(1);
  }

  const projectId = resolveProjectId();

  // ── Run the resurrect engine ─────────────────────────────────────────────────

  // Read serve-time reality check gate (default 'enabled') before calling the engine.
  const cmdResurrectServeRcEnabled = await getSetting(db, projectId, 'serve_time_reality_check', 'enabled');

  let result;
  try {
    result = await runResurrectQuery(db, projectId, {
      type:   'resurrect',
      seed:   seedText,
      revive: reviveFlag,
      limit,
    }, {
      silent:               false,
      tokenBudget:          Infinity,  // no token ceiling in CLI mode
      serveTimeRcEnabled:   cmdResurrectServeRcEnabled,
      serveRoot:            findProjectRoot(),
    });
  } catch (err) {
    await db.end();
    process.stderr.write(`resurrect query failed: ${err.message}\n`);
    process.exit(1);
  }

  await db.end();

  // ── Output ───────────────────────────────────────────────────────────────────

  if (jsonFlag) {
    // Parse the candidate rows from sectionText into structured objects.
    // sectionText lines look like:
    //   - [source|conf=N|suppression_kind|timestamp] subject predicate object
    const candidates = [];
    if (result.sectionText) {
      const lines = result.sectionText.split('\n').filter((l) => l.startsWith('- ['));
      for (const line of lines) {
        const m = line.match(/^- \[([^\]]+)\] (.+)$/);
        if (!m) continue;
        const meta   = m[1];
        const rest2  = m[2];
        const parts  = meta.split('|');
        candidates.push({
          meta:       meta,
          source:     parts[0] || null,
          confidence: parts[1] ? parseInt(parts[1].replace('conf=', ''), 10) : null,
          suppression_kind: parts[2] || null,
          created_at: parts[3] || null,
          text:       rest2.trim(),
        });
      }
    }

    const jsonOut = {
      seed:            seedText,
      mode:            reviveFlag ? 'revived' : 'dry-run',
      candidate_count: result.candidateCount,
      candidates,
      revived_count:   reviveFlag ? result.revivedIds.length : 0,
      revived_ids:     reviveFlag ? result.revivedIds : [],
    };
    console.log(JSON.stringify(jsonOut, null, 2));
    const doneVerbJson = reviveFlag ? `${result.revivedIds.length} row(s) revived` : 'dry-run (no changes)';
    console.log(`\nDone: handoff:resurrect — ${doneVerbJson}`);
    return;
  }

  if (!result.sectionText) {
    console.log(`\nNo matching probationary rows found for seed: "${seedText}"`);
    console.log('\nDone: handoff:resurrect — no matches');
    process.exit(0);
  }

  // Replace the loader-style heading with a CLI-friendly heading.
  const heading = reviveFlag
    ? '### Resurrected (revived)'
    : '### Resurrected (preview — dry-run)';
  const bodyLines = result.sectionText.split('\n').slice(1).join('\n');
  console.log(`\n${heading}\n${bodyLines}`);

  if (reviveFlag) {
    const count = result.revivedIds.length;
    console.log(`\n  Revived: ${count} row(s) un-suppressed (suppressed cleared, suppression_kind cleared).`);
  } else {
    console.log('\n  (Dry-run — no rows modified. Pass --revive to un-suppress.)');
  }

  const doneVerb = reviveFlag ? `${result.revivedIds.length} row(s) revived` : 'dry-run (no changes)';
  console.log(`\nDone: handoff:resurrect — ${doneVerb}`);
}

// ── queue-drain ───────────────────────────────────────────────────────────────

/**
 * Deterministic background worker for the async extraction queue.
 *
 * Usage: node scripts/handoff.js queue-drain [--max=N]
 *
 * Selects pending rows from extraction_queue for the resolved project (oldest
 * first, optional row limit via --max=N). For each row:
 *   1. Re-runs validatePayload() as a defense-in-depth check.
 *   2. Calls writeExtraction() with the stored payload.
 *   3. Marks the row 'done' (processed_at = now()).
 *   On write error: marks the row 'error' with error_detail and continues —
 *   one bad row never blocks the queue.
 *
 * Pure script, deterministic, no model calls. Same input → same output every run.
 */
async function cmdQueueDrain(args) {
  console.log('Running: handoff:queue-drain');

  const projectId = resolveProjectId();

  // Parse --max=N flag (optional)
  const maxArg = args.find((a) => a.startsWith('--max='));
  const maxRows = maxArg ? parseInt(maxArg.slice(6), 10) : null;
  if (maxArg && (isNaN(maxRows) || maxRows < 1)) {
    console.error(`queue-drain: invalid --max value "${maxArg.slice(6)}" — must be a positive integer`);
    process.exit(2);
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // Read the registry mode from project_settings (default permissive for defense-in-depth).
  const registryMode = await getSetting(db, projectId, 'predicate_registry_mode', 'permissive');

  // Select pending rows — oldest first (FIFO). Optional row limit.
  let selectSql = `SELECT id, payload, source_ref FROM extraction_queue
     WHERE project_id = $1 AND status = 'pending'
     ORDER BY enqueued_at ASC`;
  const selectParams = [projectId];
  if (maxRows !== null) {
    selectSql += ` LIMIT $2`;
    selectParams.push(maxRows);
  }

  const { rows: pendingRows } = await db.query(selectSql, selectParams);

  if (pendingRows.length === 0) {
    console.log(`\n  No pending rows in extraction_queue for project ${projectId}.`);
    await db.end();
    console.log('\nDone: handoff:queue-drain — 0 rows processed');
    return;
  }

  console.log(`\n  Found ${pendingRows.length} pending row(s). Processing...`);

  let doneCount  = 0;
  let errorCount = 0;

  for (const row of pendingRows) {
    const rowId = row.id;
    const payload = row.payload;

    // Defense-in-depth: re-validate the payload before writing.
    // This catches any rows that were enqueued with a looser mode.
    const validation = validatePayload(payload, registryMode);

    // Emit warnings regardless of mode.
    for (const w of validation.warnings) {
      process.stderr.write(`[queue-drain] row ${rowId}: ${w}\n`);
    }

    // In strict mode, filter bad assertions before writing (skip-and-continue).
    let payloadToWrite = payload;
    if (registryMode === 'strict' && validation.errors.length > 0) {
      for (const e of validation.errors) {
        process.stderr.write(`[queue-drain] row ${rowId} strict: skipping — ${e}\n`);
      }
      const badIndices = _badAssertionIndices(validation.errors);
      payloadToWrite = Object.assign({}, payload, {
        assertions: (payload.assertions || []).filter((_, i) => !badIndices.has(i)),
      });
    }

    try {
      const { entitiesWritten, assertionsWritten, edgesWritten, decisionsWritten, intentDivergences } =
        await writeExtraction(db, projectId, payloadToWrite, {
          projectBasename: path.basename(findProjectRoot()),
        });

      // Mark done.
      await db.query(
        `UPDATE extraction_queue
         SET status = 'done', processed_at = now()
         WHERE id = $1`,
        [rowId]
      );

      const skipCount = (payload.assertions || []).length - (payloadToWrite.assertions || []).length;
      const skipNote  = skipCount > 0 ? ` (${skipCount} predicate-rejected)` : '';
      console.log(
        `  [done] row ${rowId} (source=${row.source_ref || 'null'}): ` +
        `${entitiesWritten}e/${assertionsWritten}a/${edgesWritten}ed written, decisions: ${decisionsWritten}${skipNote}`
      );
      // cm#227: surface session-intent persistence failures here too — this row's
      // close/checkpoint already reported "done" via queue-drain, so this is the
      // only place its DIVERGENCE would otherwise be visible.
      for (const line of formatIntentDivergenceLines(intentDivergences)) {
        console.log(`    ${line}`);
      }
      doneCount++;
    } catch (writeErr) {
      // Mark error; do not rethrow — one bad row never blocks the queue.
      const detail = writeErr.message.slice(0, 500);
      try {
        await db.query(
          `UPDATE extraction_queue
           SET status = 'error', processed_at = now(), error_detail = $2
           WHERE id = $1`,
          [rowId, detail]
        );
      } catch (markErr) {
        process.stderr.write(`[queue-drain] row ${rowId}: failed to mark error row: ${markErr.message}\n`);
      }
      process.stderr.write(`[queue-drain] row ${rowId} WRITE ERROR: ${detail}\n`);
      errorCount++;
    }
  }

  await db.end();

  console.log(`\n  Summary: ${doneCount} done, ${errorCount} error(s) out of ${pendingRows.length} processed`);
  console.log(`\nDone: handoff:queue-drain — ${doneCount}/${pendingRows.length} rows written`);

  // Non-zero exit if any errors occurred, so callers can detect partial failures.
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

// ── prune ─────────────────────────────────────────────────────────────────────

/**
 * Operator manual prune: surgically hard-delete selected assertion rows.
 *
 * Distinct from purge (hard-delete EVERYTHING) and drop (archive + fresh start).
 * Operates on assertions ONLY — entities and edges are out of scope for this command.
 * MANUAL / operator-invoked ONLY — never triggered automatically.
 *
 * Usage:
 *   node scripts/handoff.js prune [--suppressed] [--suppression-kind <kind>]
 *                                  [--subject <subject>] [--older-than <days>]
 *                                  [--include-pinned] [--apply]
 *
 *   At least ONE criterion flag is required (--suppressed, --suppression-kind,
 *   --subject, or --older-than). Running with no criteria is refused — that is
 *   what `purge` is for.
 *
 * Behavior:
 *   Dry-run (default, no --apply): prints counts and a sample of what WOULD be
 *     deleted; makes zero DB changes.
 *   --apply: performs the hard DELETE; second --apply is idempotent (no-op if
 *     nothing matches).
 *
 * Pinned safety:
 *   Pinned rows (pinned=true/1) are NEVER deleted unless --include-pinned is given.
 *   Pinned rows that match the criteria are counted and reported as skipped.
 *
 * Criteria (AND-combined):
 *   --suppressed                          rows where suppressed = true
 *   --suppression-kind <kind>             rows where suppression_kind = <kind>
 *                                         valid: superseded | downvoted_terminal |
 *                                                downvoted_probation | retired |
 *                                                reality_reconciled
 *   --subject <raw-or-canonical>          rows where subject = canonicalize(<arg>)
 *   --older-than <days>                   rows where last_reinforced < now()-N days
 *
 *   Criteria combine as AND. Always project-scoped (never touches other projects).
 */
async function cmdPrune(args) {
  console.log('Running: handoff:prune');

  // ── Parse flags ─────────────────────────────────────────────────────────────

  const applyMode    = args.includes('--apply');
  const includePinned = args.includes('--include-pinned');

  // --suppressed (boolean flag)
  const wantSuppressed = args.includes('--suppressed');

  // --suppression-kind <kind>
  const skIdx = args.indexOf('--suppression-kind');
  const suppressionKind = skIdx !== -1 ? args[skIdx + 1] : undefined;
  if (skIdx !== -1 && !suppressionKind) {
    console.error('prune: --suppression-kind requires a value (superseded | downvoted_terminal | downvoted_probation | retired | reality_reconciled)');
    process.exit(2);
  }
  const validKinds = ['superseded', 'downvoted_terminal', 'downvoted_probation', 'retired', 'reality_reconciled'];
  if (suppressionKind && !validKinds.includes(suppressionKind)) {
    console.error(`prune: invalid --suppression-kind "${suppressionKind}". Valid: ${validKinds.join(', ')}`);
    process.exit(2);
  }

  // --subject <raw-or-canonical>
  const subjectIdx = args.indexOf('--subject');
  let rawSubject = subjectIdx !== -1 ? args[subjectIdx + 1] : undefined;
  if (subjectIdx !== -1 && !rawSubject) {
    console.error('prune: --subject requires a value');
    process.exit(2);
  }
  // Canonicalize: trim + lowercase + collapse whitespace + alias-map lookup
  const canonSubject = rawSubject != null ? canonicalize(rawSubject) : undefined;

  // --older-than <days>
  const otIdx = args.indexOf('--older-than');
  let olderThanDays;
  if (otIdx !== -1) {
    const rawDays = args[otIdx + 1];
    if (!rawDays) {
      console.error('prune: --older-than requires a value (number of days)');
      process.exit(2);
    }
    olderThanDays = Number(rawDays);
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      console.error(`prune: invalid --older-than value "${rawDays}" — must be a positive number`);
      process.exit(2);
    }
  }

  // ── At least one criterion required ─────────────────────────────────────────
  const hasCriteria = wantSuppressed || suppressionKind != null || canonSubject != null || olderThanDays != null;
  if (!hasCriteria) {
    console.error(
      'prune: at least one criterion is required (--suppressed, --suppression-kind, --subject, --older-than).\n' +
      'To delete ALL project memory, use: handoff purge'
    );
    process.exit(2);
  }

  // ── Build criteria object ────────────────────────────────────────────────────
  const criteria = {
    suppressed:      wantSuppressed    ? true          : undefined,
    suppressionKind: suppressionKind,
    subject:         canonSubject,
    olderThanDays:   olderThanDays,
    includePinned:   includePinned,
  };

  const projectId = resolveProjectId();

  console.log('');
  console.log(`  mode          : ${applyMode ? '--apply (DELETES ENABLED)' : 'dry-run (read-only, default)'}`);
  console.log(`  project_id    : ${projectId}`);
  if (criteria.suppressed)      console.log(`  criterion     : suppressed = true`);
  if (criteria.suppressionKind) console.log(`  criterion     : suppression_kind = '${criteria.suppressionKind}'`);
  if (criteria.subject != null) console.log(`  criterion     : subject = '${criteria.subject}' (canonicalized from '${rawSubject}')`);
  if (criteria.olderThanDays)   console.log(`  criterion     : last_reinforced < now() - ${criteria.olderThanDays} day(s)`);
  console.log(`  include-pinned: ${includePinned}`);
  console.log('');

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── SELECT: preview what matches ──────────────────────────────────────────────
  const { sql: selectSql, params: selectParams } = db.buildPruneSelect(criteria, projectId);
  const { rows: matchedRows } = await db.query(selectSql, selectParams);

  // Partition into pinned and non-pinned
  const pinnedRows    = matchedRows.filter((r) => r.pinned === true || r.pinned === 1);
  const nonPinnedRows = matchedRows.filter((r) => !(r.pinned === true || r.pinned === 1));

  // In dry-run, report what would be deleted (non-pinned) and what would be skipped (pinned)
  const toDeleteCount = includePinned ? matchedRows.length : nonPinnedRows.length;
  const skippedPinnedCount = includePinned ? 0 : pinnedRows.length;

  console.log(`  Matched rows        : ${matchedRows.length}`);
  console.log(`  Would delete        : ${toDeleteCount}`);
  if (skippedPinnedCount > 0) {
    console.log(`  Skipped (pinned)    : ${skippedPinnedCount} (use --include-pinned to include)`);
  }
  console.log('');

  if (matchedRows.length > 0) {
    // Print a sample of up to 10 rows for operator review
    const sampleSize = Math.min(10, toDeleteCount);
    const sampleRows = includePinned ? matchedRows.slice(0, sampleSize) : nonPinnedRows.slice(0, sampleSize);
    if (sampleRows.length > 0) {
      console.log(`  Sample of rows that ${applyMode ? 'will be' : 'would be'} deleted (up to 10):`);
      for (const row of sampleRows) {
        const pinnedNote = (row.pinned === true || row.pinned === 1) ? ' [PINNED]' : '';
        console.log(`    id=${row.id}  subject="${row.subject}"  predicate="${row.predicate}"  object="${String(row.object).slice(0, 60)}"${pinnedNote}`);
      }
      if (toDeleteCount > sampleSize) {
        console.log(`    ... and ${toDeleteCount - sampleSize} more`);
      }
      console.log('');
    }
    if (skippedPinnedCount > 0) {
      const pinnedSample = Math.min(5, pinnedRows.length);
      console.log(`  Skipped pinned rows (up to 5):`);
      for (const row of pinnedRows.slice(0, pinnedSample)) {
        console.log(`    id=${row.id}  subject="${row.subject}"  predicate="${row.predicate}"`);
      }
      if (pinnedRows.length > pinnedSample) {
        console.log(`    ... and ${pinnedRows.length - pinnedSample} more pinned rows skipped`);
      }
      console.log('');
    }
  }

  if (!applyMode) {
    await db.end();
    if (toDeleteCount === 0) {
      console.log('  No rows match the given criteria.');
    } else {
      console.log(`  Dry-run complete — no changes made.`);
      console.log(`  Run with --apply to perform the deletion.`);
    }
    console.log('\nDone: handoff:prune — dry-run (no changes)');
    return;
  }

  // ── APPLY: hard delete ────────────────────────────────────────────────────────
  if (toDeleteCount === 0) {
    await db.end();
    console.log('  No rows match the given criteria — nothing to delete.');
    console.log('\nDone: handoff:prune — 0 rows deleted (no-op)');
    return;
  }

  const { sql: deleteSql, params: deleteParams } = db.buildPruneDelete(criteria, projectId);
  const { rowCount: deletedCount } = await db.query(deleteSql, deleteParams);

  await db.end();

  console.log(`  Deleted ${deletedCount} assertion row(s).`);
  if (skippedPinnedCount > 0) {
    console.log(`  ${skippedPinnedCount} pinned row(s) protected from deletion (use --include-pinned to override).`);
  }
  console.log(`\nDone: handoff:prune — ${deletedCount} row(s) hard-deleted`);
}

// ─── cmdRetire ────────────────────────────────────────────────────────────────
//
// Operator-only non-destructive retirement of live directive rows (L5).
// Usage: node scripts/handoff.js retire --subject <s> --predicate <p> [--object <o>] [--apply]
//
// Dry-run by default (no mutation without --apply), matching prune's contract.
// Sets suppressed=true/1, invalid_at=now(), suppression_kind='retired' on matched rows.
//
// Without --object: retires ALL live rows for (subject, predicate).
//   Only permitted when isDirective(predicate) === true ("rescind the whole rule").
//   For non-directive predicates, --object is required.
// With --object: retires only the exact (subject, predicate, object) live row(s).
//
// NOT wired into cmdClose or any automated path.  Operator invocation only.

async function cmdRetire(args) {
  console.log('Running: handoff:retire');

  // ── Parse flags ─────────────────────────────────────────────────────────────

  const applyMode = args.includes('--apply');

  // Guard: --replace-with is explicitly not supported (L5 spec: dropped).
  if (args.includes('--replace-with')) {
    console.error(
      'retire: --replace-with is not supported. ' +
      'retire only retires; write a replacement row separately if needed.'
    );
    process.exit(2);
  }

  // --subject <raw>
  const subjectIdx = args.indexOf('--subject');
  let rawSubject = subjectIdx !== -1 ? args[subjectIdx + 1] : undefined;
  if (subjectIdx !== -1 && (!rawSubject || rawSubject.startsWith('--'))) {
    console.error('retire: --subject requires a value');
    process.exit(2);
  }
  if (!rawSubject) {
    console.error('retire: --subject is required');
    process.exit(2);
  }
  const canonSubject = canonicalize(rawSubject);

  // --predicate <pred>
  const predicateIdx = args.indexOf('--predicate');
  const rawPredicate = predicateIdx !== -1 ? args[predicateIdx + 1] : undefined;
  if (predicateIdx !== -1 && (!rawPredicate || rawPredicate.startsWith('--'))) {
    console.error('retire: --predicate requires a value');
    process.exit(2);
  }
  if (!rawPredicate) {
    console.error('retire: --predicate is required');
    process.exit(2);
  }
  const predicate = rawPredicate.trim();

  // --object <obj>  (optional)
  const objectIdx = args.indexOf('--object');
  let rawObject = objectIdx !== -1 ? args[objectIdx + 1] : undefined;
  if (objectIdx !== -1 && (!rawObject || rawObject.startsWith('--'))) {
    console.error('retire: --object requires a value');
    process.exit(2);
  }
  const withObject = rawObject != null;
  const objectVal  = withObject ? rawObject.trim() : undefined;

  // Without --object: only directive predicates may do mass-retirement.
  if (!withObject && !isDirective(predicate)) {
    console.error(
      `retire: --object is required for predicate "${predicate}" — ` +
      'only directive predicates (depends_on, must_do, never_uses, should, ' +
      'policy, enforces, is_constraint) may be retired without specifying --object. ' +
      'To retire a specific value, add --object <value>.'
    );
    process.exit(2);
  }

  const projectId = resolveProjectId();

  console.log('');
  console.log(`  mode       : ${applyMode ? '--apply (MUTATIONS ENABLED)' : 'dry-run (read-only, default)'}`);
  console.log(`  project_id : ${projectId}`);
  console.log(`  subject    : ${canonSubject} (canonicalized from '${rawSubject}')`);
  console.log(`  predicate  : ${predicate}`);
  if (withObject) {
    console.log(`  object     : ${objectVal}`);
  } else {
    console.log(`  object     : (all live rows for this predicate)`);
  }
  console.log('');

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── SELECT: preview what would be retired ────────────────────────────────────

  let selectSql, selectParams;
  if (withObject) {
    selectSql = `SELECT id, subject, predicate, object, pinned, suppression_kind
                 FROM assertions
                 WHERE project_id = $1
                   AND subject    = $2
                   AND predicate  = $3
                   AND object     = $4
                   AND suppressed = false
                   AND invalid_at IS NULL`;
    selectParams = [projectId, canonSubject, predicate, objectVal];
  } else {
    selectSql = `SELECT id, subject, predicate, object, pinned, suppression_kind
                 FROM assertions
                 WHERE project_id = $1
                   AND subject    = $2
                   AND predicate  = $3
                   AND suppressed = false
                   AND invalid_at IS NULL`;
    selectParams = [projectId, canonSubject, predicate];
  }

  const { rows: matchedRows } = await db.query(selectSql, selectParams);

  console.log(`  Matched live rows  : ${matchedRows.length}`);
  if (matchedRows.length > 0) {
    const sampleSize = Math.min(10, matchedRows.length);
    console.log(`  Sample of rows that ${applyMode ? 'will be' : 'would be'} retired (up to 10):`);
    for (const row of matchedRows.slice(0, sampleSize)) {
      const pinnedNote = (row.pinned === true || row.pinned === 1) ? ' [PINNED]' : '';
      console.log(`    id=${row.id}  subject="${row.subject}"  predicate="${row.predicate}"  object="${String(row.object).slice(0, 60)}"${pinnedNote}`);
    }
    if (matchedRows.length > sampleSize) {
      console.log(`    ... and ${matchedRows.length - sampleSize} more`);
    }
  }
  console.log('');

  if (!applyMode) {
    await db.end();
    if (matchedRows.length === 0) {
      console.log('  No live rows match the given criteria.');
    } else {
      console.log(`  Dry-run complete — no changes made.`);
      console.log(`  Run with --apply to perform the retirement.`);
    }
    console.log('\nDone: handoff:retire — dry-run (no changes)');
    return;
  }

  // ── APPLY: non-destructive retirement ────────────────────────────────────────

  if (matchedRows.length === 0) {
    await db.end();
    console.log('  No live rows match the given criteria — nothing to retire.');
    console.log('\nDone: handoff:retire — 0 rows retired (no-op)');
    return;
  }

  const { sql: updateSql, params: updateParams } =
    db.buildRetirementUpdate(projectId, canonSubject, predicate, objectVal, withObject);

  const { rowCount: retiredCount } = await db.query(updateSql, updateParams);

  await db.end();

  console.log(`  Retired ${retiredCount} assertion row(s).`);
  console.log(`  Rows are suppressed (suppression_kind='retired') and excluded from retrieval.`);
  console.log(`  They are NOT deleted and remain recoverable.`);
  console.log(`\nDone: handoff:retire — ${retiredCount} row(s) retired`);
}

// ── backfill-embeddings ───────────────────────────────────────────────────────

/**
 * cmdBackfillEmbeddings — init-embeddability spec: dry-run by default,
 * `--apply` performs writes. Thin CLI wrapper around
 * scripts/lib/backfill-embeddings.js's runBackfillEmbeddings — ALL actual
 * logic (column-shape gate, mixed-provider refusal, keyset-paginated batches,
 * SQLite N/A branch) lives there, reused by the thinned
 * scripts/dev/backfill-assertion-embeddings.js pointer too.
 *
 * Usage:
 *   node scripts/handoff.js backfill-embeddings [--apply] [--table=assertions|decisions|all]
 *       [--batch-size=N] [--project-id=<id>] [--force-mixed-provider]
 */
async function cmdBackfillEmbeddings(args) {
  console.log('Running: handoff:backfill-embeddings\n');

  const apply = args.includes('--apply');
  const forceMixedProvider = args.includes('--force-mixed-provider');
  const tableFlag = (args.find((a) => a.startsWith('--table=')) || '').slice('--table='.length) || 'all';
  const batchFlag = (args.find((a) => a.startsWith('--batch-size=')) || '').slice('--batch-size='.length);
  const batchSize = batchFlag ? parseInt(batchFlag, 10) : 10;
  const projectIdFlag = (args.find((a) => a.startsWith('--project-id=')) || '').slice('--project-id='.length) || null;

  if (batchFlag && (isNaN(batchSize) || batchSize < 1)) {
    console.error('  --batch-size must be a positive integer');
    process.exit(2);
  }

  let db;
  try {
    db = await connectHandoff();
  } catch (err) {
    console.error(`DB connection failed: ${err.message}`);
    process.exit(1);
  }

  // cm#185-schema-heal (S3): heal BEFORE classifying columns — this command
  // was previously read-only w.r.t. schema drift (it just probed
  // information_schema and refused loudly on `missing_embedding_columns`),
  // which is exactly the pipeline_judge failure mode the PROBLEM statement
  // names: a stale fingerprint + a stale degraded row can leave the gated
  // columns permanently unhealed even after an operator fixes the extension,
  // because nothing ever re-touches the schema before backfill classifies.
  // Best-effort: resolveProjectId() requires a project marker/.git root,
  // which this CLI has never required before (it can run against a raw
  // HANDOFF_DB with no project context at all) — a resolution failure here
  // skips the heal attempt rather than turning a previously-working
  // invocation into a hard failure.
  let backfillProjectId = null;
  try { backfillProjectId = resolveProjectId(); } catch (_) { /* no project context resolvable */ }
  if (backfillProjectId) {
    try {
      const healResult = await ensureSchemaCurrent(db, backfillProjectId, { silent: false });
      if (healResult && healResult.reason === 'applied') {
        const applied = (healResult.detail && healResult.detail.appliedUnits) || [];
        console.log(`  [heal]  schema drift applied before backfill: ${applied.join(', ') || '(no units listed)'}`);
      } else if (healResult && healResult.reason === 'degraded') {
        console.log(`  [heal]  schema still degraded (${healResult.detail ? JSON.stringify(healResult.detail) : 'see status for detail'})`);
      }
    } catch (healErr) {
      console.error(`  [heal]  schema heal check failed (non-fatal): ${healErr.message}`);
    }
  } else {
    console.log('  [heal]  no project context resolved — skipping schema-heal check (backfill proceeds against the connected DB as-is)');
  }

  let result;
  try {
    result = await runBackfillEmbeddings({
      db,
      projectId: projectIdFlag,
      table: tableFlag,
      apply,
      batchSize,
      forceMixedProvider,
      log: (line) => console.log(line),
    });
  } catch (err) {
    await db.end();
    console.error(`  backfill-embeddings failed: ${err.message}`);
    process.exit(1);
  }
  await db.end();

  if (!result.ok) {
    console.log(`  [FAIL]  ${result.refusal.reason}: ${result.refusal.detail}`);
    console.log(`\nDone: handoff:backfill-embeddings — refused (${result.refusal.reason})`);
    process.exit(1);
  }

  for (const t of result.tables) {
    if (t.embeddableRows === 0 && t.note) {
      console.log(`  ${t.table}: 0 embeddable rows (${t.note})`);
      continue;
    }
    if (result.dryRun) {
      console.log(`  ${t.table}: ${t.actionableNull} to embed, ${t.noTextNull} no-embeddable-text (expected, never actionable), ${t.alreadyEmbedded} already embedded, ${t.total} total`);
      if (t.sampleSubjects && t.sampleSubjects.length > 0) {
        console.log(`    sample subjects (up to 5):`);
        for (const s of t.sampleSubjects) console.log(`      ${String(s).slice(0, 120)}`);
      }
    } else {
      console.log(`  ${t.table}: embedded=${t.embedded} already-embedded=${t.alreadyEmbedded} errors=${t.errors} elapsed=${(t.elapsedMs / 1000).toFixed(1)}s (provider="${t.providerName}" id=${t.providerId})`);
    }
  }

  console.log(`\nDone: handoff:backfill-embeddings — ${result.dryRun ? 'dry-run (no changes)' : 'apply complete'}`);
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

async function main() {
  const [, , sub, ...rest] = process.argv;

  const subcommands = {
    init:            () => cmdInit(rest),
    status:          () => cmdStatus(rest),
    resume:          () => cmdResume(),
    'loader-load':   () => cmdLoaderLoad(),
    'loader-hook':   () => cmdLoaderHook(rest),
    'loader-stop':   () => cmdLoaderStop(rest),
    drop:            () => cmdDrop(),
    checkpoint:      () => cmdCheckpoint(rest),
    close:           () => cmdClose(rest),
    purge:           () => cmdPurge(rest),
    promote:         () => cmdPromote(rest),
    resurrect:       () => cmdResurrect(rest),
    'queue-drain':   () => cmdQueueDrain(rest),
    prune:           () => cmdPrune(rest),
    retire:          () => cmdRetire(rest),
    'backfill-embeddings': () => cmdBackfillEmbeddings(rest),
  };

  if (!sub || !subcommands[sub]) {
    const available = Object.keys(subcommands).join(', ');
    console.error(`Usage: node scripts/handoff.js <subcommand> [args]`);
    console.error(`Subcommands: ${available}`);
    process.exit(2);
  }

  // Total-classification argv check for write subcommands (scripts/lib/cli-args.js).
  // MUST run before subcommands[sub]() is invoked — this is what guarantees
  // "reject before any DB connection or file write" for every write command,
  // regardless of where inside that command's own body it happens to connect
  // (e.g. cmdPromote connects to the DB before parsing its own flags).
  // See incident: `close --help` silently ignored the unknown flag and ran a
  // real close. --help / an unknown flag is now caught HERE, first.
  const { enforceTotalClassification } = require('./lib/cli-args');
  enforceTotalClassification(sub, rest);

  try {
    await subcommands[sub]();
  } catch (err) {
    console.error(`\nhandoff:${sub} failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

// ─── EXPORTS (for tests and CLI scripts) ─────────────────────────────────────
// When required as a module, export helpers without running the CLI router.
if (require.main === module) {
  main();
} else {
  module.exports = {
    queriesEqual,
    recordContractChange,
    pruneDegradedClose,
    // §7.1/S-12c shared exports (reused by reference, never reimplemented,
    // by scripts/lib/carryover-render.js). Pure additions -- no existing
    // export changed, no behavior change to any existing call site.
    // cm#233: deriveIntentSubject REMOVED (not aliased) — replaced by
    // intentKey/intentKeyEquals (scripts/lib/intent-key.js, re-exported here
    // for convenience) plus the classification helpers below.
    intentKey,
    intentKeyEquals,
    classifyResolvedThreads,
    printResolvedThreadsClassification,
    dedupOpenThreadIntents,
    printOpenThreadDuplicates,
    PINNED_EXCLUSION_SQL,
    connectHandoff,
    // heal-on-touch: exposed for test/test-claude-md-key-paths.js so its
    // literal legacy-CLAUDE.md fixture is rendered through the SAME
    // {{KEY}}-substitution renderTemplate() used by cmdInit, not a re-typed
    // mirror of it.
    renderTemplate,
    // Pointer-staleness gate internals (exposed for test-pointer-gate.js)
    _extractPointers,
    _deriveAnchor,
    _findSymbolRange,
    _findSnippetLine,
    _resolvePointerPath,
    _extractIdentifierTokens,
    _extractProseTokens,
    _proseVsContentOverlap,
    _suppressStaleLegacyPointers,
    validatePointers,
    runPointerGate,
    // cm#185 schema bring-forward exports — the real engine functions, no
    // test-side reimplementation (S-18: the former test-both-backends.js
    // mirrors are deleted; those tests now require() these).
    applyAdditiveSchema,
    ensureSchemaCurrent,
    _computeSchemaFingerprint,
    _hashSchemaFileNormalized,
    _parseSchemaFingerprint,
    _compareSchemaFingerprint,
    _extractIntegrityIndexOps,
    recordSchemaDegradation,
    clearSchemaDegradation,
    checkPgvectorGatedObjects,
    reportPgvectorGatedDegradation,
    SCHEMA_EPOCH,
    // cm#185-schema-heal FK extension — exposed for test/test-schema-heal.js
    // (no test-side reimplementation of the FK identity/classification rules).
    _collectExpectedFks,
    _classifyExpectedFks,
    _healExpectedFks,
    _collectExpectedUniques,
    _classifyExpectedUniques,
    _healExpectedUniques,
    _collectExpectedNotNulls,
    _classifyExpectedNotNulls,
    _healExpectedNotNulls,
    _collectExpectedChecks,
    _classifyExpectedChecks,
    _healExpectedChecks,
    _collectExpectedIndexDefs,
    _classifyExpectedIndexDefs,
    _healExpectedIndexDefs,
    // cm#185-schema-heal — exposed for test/test-schema-heal.js (no test-side
    // reimplementation of the fingerprint-persistence or readiness-reuse logic).
    recordSchemaFingerprint,
    _gatedOkFromSchemaHealResult,
    // cm#233: exposed for test coverage of the intent-key migration cutover
    // gate (ensureSchemaCurrentCore is the pre-wrapper core, for tests that
    // need to assert the wrapper's added side effect never changes the
    // core's own return contract).
    ensureSchemaCurrentCore,
    runIntentKeyMigrationIfNeeded,
    INTENT_KEY_MIGRATION_SETTING_KEY,
    // cm#230: exposed for test/lib/test-decisions-writer.js — no test-side
    // reimplementation of writeExtraction's decisions[] handling or the
    // DIVERGENCE-line formatter.
    writeExtraction,
    formatIntentDivergenceLines,
    // cm#231: shared write-path exports — entity-graph-crud.js's assertionCreate/
    // assertionUpdate route through these so the MCP write path applies the SAME
    // tier/valid_at/session_id defaults as the seed/close path, instead of
    // duplicating default-setting logic per entry point.
    writeAssertionWithSupersession,
    getSetting,
    resolveSessionId,
    // codex-host-adapter hardening: CODEX_THREAD_ID/CLAUDE_CODE_SESSION_ID
    // fallback-chain classification — exported for scripts/test-loader-stop-
    // gate.js's direct unit coverage of every branch (no subprocess spawn
    // needed to exercise the pure classification logic).
    resolveHookSessionId,
    resolveSessionIdFromEnv,
    resolveClearSessionId,
    isAmbiguousSessionEnvPair,
    ASSERTION_TIER_PROBATIONARY,
    ASSERTION_TIER_CONSOLIDATED,
    // Session-marker concurrency hardening — exposed for
    // scripts/test-loader-stop-gate.js-adjacent concurrency coverage (no
    // test-side reimplementation of the advisory-lock read-modify-write).
    getSessionMarkers,
    setSessionMarkers,
    addSessionMarker,
    withSessionMarkerLock,
    findMatchingMarkerIndex,
    latestSessionMarker,
    // fix(close): close-marker-outcome-truthful — exposed for
    // scripts/test-close-marker-outcome.js's direct unit coverage of every
    // branch (no test-side reimplementation of the lock/read-modify-write or
    // the total classification's branch logic).
    parseSessionMarkers,
    parseSessionMarkersDetailed,
    clearSessionMarkerForClose,
    formatOwnerIds,
    setSetting,
    // init-embeddability spec — exposed for test/test-init-embeddability.js
    // and test/test-embed-endpoint-classify.js (no test-side reimplementation
    // of the readiness/opt-out/backfill logic).
    computeEmbeddingReadiness,
    computeEmbeddingNullCounts,
    _shouldWarnOnResume,
    _cachedProbeProvider,
    _embedProbeCache,
    isEmbeddingsOptedOut,
    cmdBackfillEmbeddings,
  };
}
