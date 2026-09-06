'use strict';

/**
 * install.js — Copy slash commands and wire session hooks
 *
 * Does two things so you don't have to do them by hand:
 *   1. Copies every *.md file from <repo>/commands/handoff/ to
 *      ~/.claude/commands/handoff/ so Claude Code can find them.
 *   2. Merges SessionStart and SessionEnd hooks into a Claude Code settings
 *      file — preserving every hook already there. Claude Code's real hooks
 *      schema is matcher-wrapped three levels deep:
 *        hooks.<Event>: [ { matcher?: string, hooks: [ { type: "command",
 *          command, timeout?, statusMessage? } ] } ]
 *      mergeHooks() walks that shape (never a flat `{command}` array), finds
 *      any pre-existing loader-hook/loader-stop entry by an anchored command
 *      match (never substring), re-points it to this checkout's engine path,
 *      and places it under the correct event (loader-hook -> SessionStart,
 *      loader-stop -> SessionEnd) without disturbing sibling hooks or any
 *      other tool's entries.
 *
 * Usage:
 *   node scripts/install.js [--dry-run] [--force] [--non-interactive]
 *                            [--hooks-scope user|project|auto] [--help|-h]
 *
 * Flags:
 *   --dry-run          Print what would be done but write nothing (also
 *                       prints a unified diff of the hooks file).
 *   --force            Skip confirmation prompt; also overwrites existing
 *                       command files.
 *   --non-interactive  Same as --force (useful in CI).
 *   --hooks-scope      user | project | auto (default: auto). auto checks
 *                       the user-scope file (~/.claude/settings.json) for an
 *                       existing loader-hook/loader-stop entry first; if
 *                       found, hooks are merged there; otherwise the
 *                       project-scope file (.claude/settings.local.json in
 *                       the current directory) is used.
 *   --help, -h         Print usage and exit 0.
 *
 * Exit codes: 0 success, 1 error or user abort, 2 refused (malformed input,
 * unsafe engine-path context — see mergeHooks()/validateHooksSection()).
 *
 * Testability: mergeHooks(), isOurs(), normalizeCommand(),
 * validateHooksSection(), scanEntries(), detectIndent(), detectOursPresent(),
 * serializeSettings(), diffLines(), reconcileFormatting(), and unifiedDiff()
 * are exported for unit testing (see
 * scripts/test-install-sessionend-migration.js) against in-memory objects —
 * requiring this module never touches argv/cwd/process.exit; resolveConfig()
 * and main() only run when this file is executed directly.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// ─── USAGE ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/install.js [--dry-run] [--force] [--non-interactive]
                                [--hooks-scope user|project|auto] [--help|-h]

Copies /handoff:* slash commands to ~/.claude/commands/handoff/ and wires
SessionStart + SessionEnd hooks into a Claude Code settings file. Existing
hooks are preserved — the script only adds/re-points its own loader-hook and
loader-stop entries, and never touches anyone else's hooks.

Flags:
  --dry-run          Show what would happen without writing anything; prints
                      a unified diff of the hooks file.
  --force            Skip confirmation; overwrite existing command files.
  --non-interactive  Same as --force (for CI / scripted setups).
  --hooks-scope      user | project | auto (default: auto).
  --help, -h         Print this message and exit.
`.trim();

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

/** Print a refusal reason to stderr and exit 2. Never used for ordinary errors (those exit 1). */
function refuse(reason) {
  console.error(`Refusing: ${reason}`);
  process.exit(2);
}

/**
 * Parse argv + resolve every path/flag the CLI needs, refusing (exit 2) on
 * an invalid --hooks-scope, a --engine-path used without --dry-run, or a
 * worktree engine path. Pure w.r.t. module load: only called from the
 * require.main guard at the bottom of this file — requiring this module for
 * its exported functions (tests) never touches argv, cwd, or process.exit.
 */
function resolveConfig() {
  const args     = process.argv.slice(2);
  const showHelp = args.includes('--help') || args.includes('-h');
  const dryRun   = args.includes('--dry-run');
  const force    = args.includes('--force') || args.includes('--non-interactive');

  if (showHelp) { console.log(USAGE); process.exit(0); }

  const scopeFlagIdx = args.indexOf('--hooks-scope');
  let hooksScopeArg = 'auto';
  if (scopeFlagIdx !== -1) {
    hooksScopeArg = args[scopeFlagIdx + 1];
    if (!['user', 'project', 'auto'].includes(hooksScopeArg)) {
      refuse(`--hooks-scope must be one of: user, project, auto (got ${JSON.stringify(hooksScopeArg)})`);
    }
  }

  // Hidden flag, dry-run-only: lets a worktree checkout of install.js itself
  // (which would otherwise refuse per the worktree guard below) prove out the
  // hooks diff against an arbitrary engine path without ever writing anything.
  const engineOverrideIdx = args.indexOf('--engine-path');
  const engineOverride = engineOverrideIdx !== -1 ? args[engineOverrideIdx + 1] : null;
  if (engineOverride && !dryRun) {
    refuse('--engine-path may only be used together with --dry-run.');
  }

  // Repo root — this script lives in <repo>/scripts/, so go one level up.
  const repoRoot    = path.resolve(__dirname, '..');
  const repoRootFwd = repoRoot.replace(/\\/g, '/');
  const srcDir      = path.join(repoRoot, 'commands', 'handoff');
  const destDir     = path.join(os.homedir(), '.claude', 'commands', 'handoff');

  // ── GUARD: refuse a worktree engine path ──────────────────────────────────
  // A worktree checkout's scripts/handoff.js is a temporary, disposable path —
  // wiring hooks against it would point the owner's real config at a checkout
  // that gets pruned. Bypassed only by the hidden --engine-path + --dry-run
  // combination used to prove out the diff logic (S9).
  const worktreeMatch = repoRootFwd.match(/^(.*)\/\.claude\/worktrees\/[^/]+\/?$/i);
  if (worktreeMatch && !(dryRun && engineOverride)) {
    refuse(
      `install.js is running from a git worktree checkout (${repoRoot}).\n` +
      `  Run it from the main checkout instead, e.g.:\n` +
      `    node ${worktreeMatch[1]}/scripts/install.js`
    );
  }

  // Engine path used to build the hook commands. Normally derived from this
  // checkout's own location; overridable (dry-run only) via --engine-path.
  const enginePathFwd = engineOverride
    ? engineOverride.replace(/\\/g, '/')
    : `${repoRootFwd}/scripts/handoff.js`;

  // Hook commands — forward slashes everywhere (Claude Code settings files
  // accept them on all platforms and avoid JSON back-slash escape headaches).
  const hookLoaderCmd = `node ${enginePathFwd} loader-hook`;
  const hookStopCmd   = `node ${enginePathFwd} loader-stop`;

  // Engine path recorded for standalone installs so command files can find the
  // engine without CLAUDE_PLUGIN_ROOT. Always derived from THIS checkout (the
  // --engine-path override only affects the hooks-diff proof, never this file).
  const enginePathFile    = path.join(destDir, '.engine-path');
  const enginePathContent = `${repoRootFwd}/scripts/handoff.js`;

  // Candidate settings files for the two hook scopes.
  const userSettingsPath    = path.join(os.homedir(), '.claude', 'settings.json');
  const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.local.json');

  // ── GUARD: source dir must exist ──────────────────────────────────────────
  if (!fs.existsSync(srcDir)) {
    console.error(
      `Error: commands/handoff/ not found at:\n  ${srcDir}\n\n` +
      `This usually means the script is being run from the wrong location.\n` +
      `Run it with the full path to this repo's install.js, e.g.:\n` +
      `  node /path/to/claude-memory/scripts/install.js`
    );
    process.exit(1);
  }

  return {
    dryRun, force, hooksScopeArg, engineOverride,
    repoRoot, repoRootFwd, srcDir, destDir,
    enginePathFwd, hookLoaderCmd, hookStopCmd,
    enginePathFile, enginePathContent,
    userSettingsPath, projectSettingsPath,
  };
}

// ─── HELPERS: SOURCE FILE LISTING ────────────────────────────────────────────

/** Return all *.md files (non-dotfiles) in srcDir. */
function listSourceFiles(srcDir) {
  return fs.readdirSync(srcDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.')
  );
}

// ─── IDENTITY: normalizeCommand / isOurs ─────────────────────────────────────

/**
 * Normalize a command string for identity comparison only (never written
 * back verbatim). Trims, collapses internal whitespace runs to a single
 * space, converts backslashes to forward slashes, and case-folds ONLY a
 * leading drive-letter prefix (e.g. `C:/` -> `c:/`) wherever one appears at
 * the start of the string, after whitespace, or after a quote — path
 * segments elsewhere are left case-sensitive (they may matter on a
 * non-Windows checkout).
 */
function normalizeCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let s = cmd.trim().replace(/\s+/g, ' ').replace(/\\/g, '/');
  s = s.replace(/(^|[\s"'])([A-Za-z]):\//g, (m, pre, d) => `${pre}${d.toLowerCase()}:/`);
  return s;
}

// Anchored identity pattern (S2): optional `HANDOFF_ENGINE=<nonspace> `
// prefix, `node`/`node.exe`, a path token (optionally double-quoted) ending
// in exactly `scripts/handoff.js`, then exactly `loader-hook` or
// `loader-stop`, then end of string. No substring matching anywhere.
const OURS_RE = /^(?:HANDOFF_ENGINE=(\S+) )?node(?:\.exe)? (?:"((?:[^"\\]|\\.)*)"|(\S+)) (loader-hook|loader-stop)$/;

/**
 * Return { verb: 'loader-hook' | 'loader-stop' } if `rawCommand` is one of
 * OUR hooks, else null. Exported for tests and reused by scope detection.
 */
function isOurs(rawCommand) {
  if (typeof rawCommand !== 'string') return null;
  const cmd = normalizeCommand(rawCommand);
  const m = cmd.match(OURS_RE);
  if (!m) return null;
  const pathToken = m[2] !== undefined ? m[2] : m[3];
  if (typeof pathToken !== 'string' || pathToken.length === 0) return null;
  // Last two segments must be literally "scripts/handoff.js" — not merely a
  // string ending in "handoff.js" (excludes vendor/handoff.js, and
  // wrapper-for-handoff.js-notifier.js which doesn't even end there).
  if (!/(^|\/)scripts\/handoff\.js$/.test(pathToken)) return null;
  return { verb: m[4] };
}

// ─── VALIDATION (S5 total classification) ────────────────────────────────────

/**
 * Validate the shape of settings.hooks per S5's total classification.
 * Returns { ok: true } or { ok: false, reason }. Never mutates.
 */
function validateHooksSection(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, reason: 'top-level JSON must be an object' };
  }
  if (!('hooks' in settings)) return { ok: true };
  const h = settings.hooks;
  if (h === null || typeof h !== 'object' || Array.isArray(h)) {
    return {
      ok: false,
      reason: `hooks must be an object, got ${h === null ? 'null' : Array.isArray(h) ? 'an array' : typeof h}`,
    };
  }
  for (const event of Object.keys(h)) {
    const arr = h[event];
    if (!Array.isArray(arr)) {
      return {
        ok: false,
        reason: `hooks.${event} must be an array, got ${arr === null ? 'null' : typeof arr}`,
      };
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return {
          ok: false,
          reason: `hooks.${event}[${i}] must be an object, got ${
            entry === null ? 'null' : Array.isArray(entry) ? 'an array' : typeof entry
          }`,
        };
      }
    }
  }
  return { ok: true };
}

// ─── mergeHooks (schema-aware, S1-S3) ────────────────────────────────────────

const EVENT_FOR_VERB = { 'loader-hook': 'SessionStart', 'loader-stop': 'SessionEnd' };

/**
 * Scan settings.hooks once (no mutation) and classify every entry.
 * Returns { candidates: { 'loader-hook': [...], 'loader-stop': [...] },
 *           unrecognizedShape: [{ event, index }] }.
 * Candidate shape:
 *   grouped: { kind:'grouped', event, groupRef, innerRef }
 *   flat:    { kind:'flat', event, ref }
 */
function scanEntries(hooks) {
  const candidates = { 'loader-hook': [], 'loader-stop': [] };
  const unrecognizedShape = [];

  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue; // defensive; validateHooksSection already refused this case

    arr.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        unrecognizedShape.push({ event, index });
        return;
      }
      if (Array.isArray(entry.hooks)) {
        // Matcher-wrapped group — inspect each inner hook, never the group itself.
        entry.hooks.forEach((inner) => {
          if (inner && typeof inner === 'object' && typeof inner.command === 'string') {
            const id = isOurs(inner.command);
            if (id) {
              candidates[id.verb].push({ kind: 'grouped', event, groupRef: entry, innerRef: inner });
            }
          }
        });
        return;
      }
      if (typeof entry.command === 'string' && entry.hooks === undefined) {
        // Legacy flat entry.
        const id = isOurs(entry.command);
        if (id) {
          candidates[id.verb].push({ kind: 'flat', event, ref: entry });
        } else {
          unrecognizedShape.push({ event, index });
        }
        return;
      }
      // Neither a matcher-wrapped group nor a flat {command} entry.
      unrecognizedShape.push({ event, index });
    });
  }

  return { candidates, unrecognizedShape };
}

/**
 * Merge our loader-hook/loader-stop hooks into an already-validated settings
 * object (mutates `settings.hooks` in place; never rebuilds untouched keys).
 *
 * opts: { hookLoaderCmd, hookStopCmd } — the exact command strings to write.
 *
 * Returns a report:
 *   { upgraded:[{verb,event}], moved:[{verb,from,to}], removed:[{event}],
 *     added:[verb], deduped:[{verb,event}], repointed:[{verb,event}],
 *     unrecognizedShape:[{event,index}] }
 */
function mergeHooks(settings, opts) {
  opts = opts || {};
  const cmdFor = { 'loader-hook': opts.hookLoaderCmd, 'loader-stop': opts.hookStopCmd };

  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const hooks = settings.hooks;

  const report = {
    upgraded: [],
    moved: [],
    removed: [],
    added: [],
    deduped: [],
    repointed: [],
    unrecognizedShape: [],
  };

  const { candidates, unrecognizedShape } = scanEntries(hooks);
  report.unrecognizedShape = unrecognizedShape;

  const innerToRemove = new Set();
  const topToRemove = new Set();
  const groupsToCheckEmpty = new Set();
  const additions = []; // { event, newGroup }

  function preserveExtra(obj, excludeKeys) {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (!excludeKeys.includes(k)) out[k] = obj[k];
    }
    return out;
  }

  for (const verb of Object.keys(candidates)) {
    const targetEvent = EVENT_FOR_VERB[verb];
    const cmd = cmdFor[verb];
    const list = candidates[verb];

    if (list.length === 0) {
      // Nothing found anywhere for this verb — add fresh.
      additions.push({ event: targetEvent, newGroup: { hooks: [{ type: 'command', command: cmd }] } });
      report.added.push(verb);
      continue;
    }

    const keep = list.find((c) => c.event === targetEvent) || list[0];

    for (const c of list) {
      if (c === keep) continue;
      // Every other candidate is a duplicate — drop it wherever it lives.
      if (c.kind === 'flat') {
        topToRemove.add(c.ref);
      } else {
        innerToRemove.add(c.innerRef);
        groupsToCheckEmpty.add(c.groupRef);
      }
      report.deduped.push({ verb, event: c.event });
    }

    if (keep.event === targetEvent) {
      if (keep.kind === 'flat') {
        // Upgrade in place: same object reference, same array position.
        const preserved = preserveExtra(keep.ref, ['command']);
        for (const k of Object.keys(keep.ref)) delete keep.ref[k];
        keep.ref.hooks = [{ type: 'command', command: cmd, ...preserved }];
        report.upgraded.push({ verb, event: targetEvent });
      } else if (keep.innerRef.command !== cmd) {
        keep.innerRef.command = cmd;
        report.repointed.push({ verb, event: targetEvent });
      }
      continue;
    }

    // keep lives at the wrong event — move it.
    if (keep.kind === 'flat') {
      topToRemove.add(keep.ref);
      const preserved = preserveExtra(keep.ref, ['command']);
      additions.push({ event: targetEvent, newGroup: { hooks: [{ type: 'command', command: cmd, ...preserved }] } });
      report.upgraded.push({ verb, event: keep.event });
    } else {
      innerToRemove.add(keep.innerRef);
      groupsToCheckEmpty.add(keep.groupRef);
      const preserved = preserveExtra(keep.innerRef, ['command', 'type']);
      additions.push({ event: targetEvent, newGroup: { hooks: [{ type: 'command', command: cmd, ...preserved }] } });
    }
    report.moved.push({ verb, from: keep.event, to: targetEvent });
  }

  // Apply removals: (1) flat top-level entries, (2) inner hooks out of their
  // groups, (3) any group whose hooks[] is now empty. Each is a single
  // rebuild pass per event array — never a sequence of index-based splices.
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((e) => !topToRemove.has(e));
  }
  for (const groupRef of groupsToCheckEmpty) {
    groupRef.hooks = groupRef.hooks.filter((inner) => !innerToRemove.has(inner));
  }
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((entry) => {
      if (Array.isArray(entry.hooks) && groupsToCheckEmpty.has(entry) && entry.hooks.length === 0) {
        report.removed.push({ event });
        return false;
      }
      return true;
    });
  }

  for (const add of additions) {
    if (!Array.isArray(hooks[add.event])) hooks[add.event] = [];
    hooks[add.event].push(add.newGroup);
  }

  return report;
}

// ─── FILE I/O HELPERS (S5) ───────────────────────────────────────────────────

/** Detect the indentation unit used by a JSON text (2sp/4sp/tab; one-line -> 2sp). */
function detectIndent(text) {
  const lines = text.split(/\r\n|\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m = lines[i].match(/^(\t+| +)/);
    if (m) return m[1][0] === '\t' ? '\t' : ' '.repeat(m[1].length);
  }
  return '  ';
}

/**
 * Read + parse + validate a settings file. Never returns on failure — exits
 * 2 via refuse(). Returns { settings, existed, hadBOM, eol, indent, raw,
 * jsonTextLF } — jsonTextLF is the BOM-stripped, LF-normalized JSON text,
 * suitable as reconcileFormatting()'s "original" side regardless of the
 * file's actual EOL style. A non-existent file returns a fresh empty object
 * with sane defaults.
 */
function readSettingsFileOrRefuse(filePath) {
  if (!fs.existsSync(filePath)) {
    return { settings: {}, existed: false, hadBOM: false, eol: '\n', indent: '  ', raw: null, jsonTextLF: null };
  }
  const buf = fs.readFileSync(filePath);
  const hadBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const raw = buf.toString('utf8');
  const jsonText = hadBOM ? raw.slice(1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    refuse(`${filePath} is not valid JSON (${e.message}). Fix the file by hand, then re-run.`);
  }

  const validation = validateHooksSection(parsed);
  if (!validation.ok) {
    refuse(`${filePath}: ${validation.reason}`);
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectIndent(jsonText);
  const jsonTextLF = jsonText.replace(/\r\n/g, '\n');
  return { settings: parsed, existed: true, hadBOM, eol, indent, raw, jsonTextLF };
}

/** Best-effort probe: does this file already contain one of our hook commands? Never refuses. */
function detectOursPresent(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const buf = fs.readFileSync(filePath);
    const hadBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const raw = buf.toString('utf8');
    const parsed = JSON.parse(hadBOM ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.hooks || typeof parsed.hooks !== 'object') return false;
    for (const event of Object.keys(parsed.hooks)) {
      const arr = parsed.hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        if (Array.isArray(entry.hooks)) {
          for (const inner of entry.hooks) {
            if (inner && typeof inner.command === 'string' && isOurs(inner.command)) return true;
          }
        } else if (typeof entry.command === 'string' && isOurs(entry.command)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false; // malformed/unreadable — treated as "nothing found here", not a refusal
  }
}

/** LCS-based line diff. Returns an array of { t: ' '|'-'|'+', l } ops. */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', l: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', l: a[i] });
      i++;
    } else {
      ops.push({ t: '+', l: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ t: '-', l: a[i] }); i++; }
  while (j < m) { ops.push({ t: '+', l: b[j] }); j++; }
  return ops;
}

/**
 * A full JSON.stringify() re-serializes every line from scratch, which
 * reformats any line whose ORIGINAL indentation didn't match the file's
 * dominant style (e.g. a stray tab among otherwise 2-space lines) even
 * though its content never changed — a real "never touched, reordered, or
 * reformatted" violation for untouched keys (S5). This walks the line diff
 * between the original text and the naive re-stringified text and, for any
 * adjacent removed/added pair whose TRIMMED content is identical (a pure
 * whitespace-only change on an untouched line), keeps the original line's
 * exact bytes instead of the reformatted one. Genuine content changes
 * (added/removed/modified hooks) are never affected — their trimmed content
 * differs, so the pairing test fails and the new content is kept.
 */
function reconcileFormatting(originalText, naiveText) {
  const a = originalText.split('\n');
  const b = naiveText.split('\n');
  const ops = diffLines(a, b);
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.t === ' ') { out.push(op.l); continue; }
    if (op.t === '-') {
      const next = ops[k + 1];
      if (next && next.t === '+' && next.l.trim() === op.l.trim()) {
        out.push(op.l);
        k++;
        continue;
      }
      continue;
    }
    out.push(op.l);
  }
  return out.join('\n');
}

/** Serialize `settings` preserving detected indent/EOL/BOM, reconciling pure reformatting noise. */
function serializeSettings(settings, { indent, eol, hadBOM, originalJsonText }) {
  let jsonText = JSON.stringify(settings, null, indent) + '\n';
  if (typeof originalJsonText === 'string') {
    jsonText = reconcileFormatting(originalJsonText, jsonText);
  }
  let text = jsonText;
  if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (hadBOM) text = '\uFEFF' + text;
  return text;
}

/** Minimal unified-diff renderer (LCS-based line diff) — no external dep. */
function unifiedDiff(beforeText, afterText, label) {
  const ops = diffLines(beforeText.split('\n'), afterText.split('\n'));

  if (ops.every((o) => o.t === ' ')) return '';

  const CONTEXT = 3;
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    while (end < ops.length) {
      if (ops[end].t !== ' ') { end++; continue; }
      // look ahead: is this a run of >2*CONTEXT context lines separating hunks?
      let run = 0;
      let p = end;
      while (p < ops.length && ops[p].t === ' ') { run++; p++; }
      if (run > CONTEXT * 2 || p >= ops.length) { end += Math.min(run, CONTEXT); break; }
      end = p;
    }
    const hunk = ops.slice(start, end);
    let oldStart = 1;
    let newStart = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q].t !== '+') oldStart++;
      if (ops[q].t !== '-') newStart++;
    }
    const oldCount = hunk.filter((o) => o.t !== '+').length;
    const newCount = hunk.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) lines.push(`${o.t}${o.l}`);
    k = end;
  }
  return lines.join('\n') + '\n';
}

// ─── CONFIRM PROMPT ──────────────────────────────────────────────────────────

async function confirm(question) {
  const { createInterface } = require('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (Y/n): `);
  rl.close();
  const t = answer.trim().toLowerCase();
  return t === '' || t === 'y';
}

// ─── HOOKS SUMMARY PRINTING (S6) ─────────────────────────────────────────────

function printHooksSummary(report, scope, targetPath, backupPath) {
  console.log(`  Hooks scope: ${scope}`);
  console.log(`  Hooks file:  ${targetPath}`);
  if (backupPath) console.log(`  Backup:      ${backupPath}`);
  console.log(`    upgraded:  ${report.upgraded.length}`);
  console.log(`    moved:     ${report.moved.length}`);
  console.log(`    removed:   ${report.removed.length}`);
  console.log(`    added:     ${report.added.length}`);
  console.log(`    deduped:   ${report.deduped.length}`);
  console.log(`    repointed: ${report.repointed.length}`);
  if (report.unrecognizedShape.length > 0) {
    console.log(`    unrecognized_shape: ${report.unrecognizedShape.length}`);
    for (const u of report.unrecognizedShape) {
      console.log(`      - hooks.${u.event}[${u.index}]`);
    }
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main(cfg) {
  const {
    dryRun, force, hooksScopeArg,
    srcDir, destDir,
    hookLoaderCmd, hookStopCmd,
    enginePathFile, enginePathContent,
    userSettingsPath, projectSettingsPath,
  } = cfg;

  const files = listSourceFiles(srcDir);

  // ── Choose hooks scope ────────────────────────────────────────────────────
  let scope = hooksScopeArg;
  if (scope === 'auto') {
    scope = detectOursPresent(userSettingsPath)
      ? 'user'
      : detectOursPresent(projectSettingsPath)
      ? 'project'
      : 'project';
  }
  const targetSettingsPath = scope === 'user' ? userSettingsPath : projectSettingsPath;
  const settingsExists = fs.existsSync(targetSettingsPath);

  // ── Plan summary ─────────────────────────────────────────────────────────
  console.log('\nclaude-memory installer');
  if (dryRun) console.log('(dry-run — nothing will be written)');
  console.log('');
  console.log(`  Copy ${files.length} command file(s) to ${destDir}`);
  console.log(`  Record engine path: ${enginePathFile}`);
  console.log(`    → ${enginePathContent}`);
  console.log(`  Hooks scope: ${scope} → ${targetSettingsPath}`);
  console.log(`    SessionStart → ${hookLoaderCmd}`);
  console.log(`    SessionEnd   → ${hookStopCmd}`);
  console.log('');

  // ── Confirm ───────────────────────────────────────────────────────────────
  if (!dryRun && !force) {
    const ok = await confirm(
      `About to copy ${files.length} command files to ~/.claude/commands/handoff/ ` +
      `and wire hooks into ${targetSettingsPath}.\nContinue?`
    );
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
    console.log('');
  }

  // ── Read + validate the target hooks file (refuses on malformed input) ────
  const { settings: readSettings, hadBOM, eol, indent, raw, jsonTextLF } =
    readSettingsFileOrRefuse(targetSettingsPath);

  if (dryRun) {
    // Deep-clone so the diff reflects a hypothetical write, nothing is mutated.
    const clone = raw !== null ? JSON.parse(hadBOM ? raw.slice(1) : raw) : {};
    const report = mergeHooks(clone, { hookLoaderCmd, hookStopCmd });
    const beforeText = raw !== null ? raw : '';
    const afterText  = serializeSettings(clone, { indent, eol, hadBOM, originalJsonText: jsonTextLF });

    console.log('  Slash commands:');
    for (const f of files) console.log(`    would copy  ${f}`);
    console.log('');
    console.log(`  Engine path: would write ${enginePathFile}`);
    console.log(`    → ${enginePathContent}`);
    console.log('');
    console.log(`  Hooks (would ${settingsExists ? 'merge into' : 'create'} ${targetSettingsPath}):`);
    printHooksSummary(report, scope, targetSettingsPath, null);
    console.log('');
    const diff = unifiedDiff(beforeText, afterText, path.basename(targetSettingsPath));
    if (diff) {
      console.log('  Diff:');
      console.log(diff.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n'));
    } else {
      console.log('  Diff: (no changes)');
    }
    console.log('');
    console.log('Dry-run complete. Re-run without --dry-run to apply.');
    console.log('');
    return;
  }

  // ── Step 1: Copy slash commands ───────────────────────────────────────────
  const copied  = [];
  const skipped = [];

  fs.mkdirSync(destDir, { recursive: true });

  for (const file of files) {
    const dest   = path.join(destDir, file);
    const exists = fs.existsSync(dest);

    if (exists && !force) {
      skipped.push(file);
    } else {
      fs.copyFileSync(path.join(srcDir, file), dest);
      copied.push(file);
    }
  }

  // ── Step 1b: Record engine path for standalone installs ───────────────────
  fs.writeFileSync(enginePathFile, enginePathContent + '\n', 'utf8');

  // ── Step 2: Wire hooks (backup + atomic write) ────────────────────────────
  fs.mkdirSync(path.dirname(targetSettingsPath), { recursive: true });

  let backupPath = null;
  if (settingsExists) {
    const ts = new Date().toISOString().replace(/:/g, '-');
    backupPath = `${targetSettingsPath}.bak-${ts}`;
    fs.copyFileSync(targetSettingsPath, backupPath);
  }

  const report = mergeHooks(readSettings, { hookLoaderCmd, hookStopCmd });
  const outText = serializeSettings(readSettings, { indent, eol, hadBOM, originalJsonText: jsonTextLF });

  const tmpPath = `${targetSettingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, outText, 'utf8');
  fs.renameSync(tmpPath, targetSettingsPath);

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('  Slash commands:');
  for (const f of copied)  console.log(`    copied   ${f}`);
  for (const f of skipped) console.log(`    skipped  ${f} (already exists — use --force to overwrite)`);
  console.log('');
  console.log(`  Engine path recorded: ${enginePathFile}`);
  console.log(`    → ${enginePathContent}`);
  console.log('');
  console.log(`  Hooks (${settingsExists ? 'merged into' : 'created'} ${targetSettingsPath}):`);
  printHooksSummary(report, scope, targetSettingsPath, backupPath);
  console.log('');
  console.log('Done. Restart Claude Code or open a fresh session to pick up the changes.');
  console.log('');
}

if (require.main === module) {
  const cfg = resolveConfig();
  main(cfg).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  mergeHooks,
  isOurs,
  normalizeCommand,
  validateHooksSection,
  detectIndent,
  detectOursPresent,
  serializeSettings,
  unifiedDiff,
  scanEntries,
  diffLines,
  reconcileFormatting,
};
