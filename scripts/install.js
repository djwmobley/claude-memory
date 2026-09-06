'use strict';

/**
 * install.js — Copy slash commands and wire session hooks
 *
 * Does two things so you don't have to do them by hand:
 *   1. Copies every *.md file from <repo>/commands/handoff/ to
 *      ~/.claude/commands/handoff/ so Claude Code can find them.
 *   2. Merges SessionStart and SessionEnd hooks into .claude/settings.local.json
 *      in your CURRENT project directory — preserving any hooks already there.
 *      A re-run also migrates a pre-existing loader-stop entry OUT of the Stop
 *      array (its old, buggy home — Stop fires at every turn end) and into
 *      SessionEnd (fires once, at true session end). See mergeHooks().
 *
 * Usage:
 *   node scripts/install.js [--dry-run] [--force] [--non-interactive] [--help|-h]
 *
 * Flags:
 *   --dry-run          Print what would be done but write nothing.
 *   --force            Skip confirmation prompt; also overwrites existing command files.
 *   --non-interactive  Same as --force (useful in CI).
 *   --help, -h         Print usage and exit 0.
 *
 * Exit codes: 0 success, 1 error or user abort.
 *
 * Testability: mergeHooks() is exported for unit testing (see
 * scripts/test-install-sessionend-migration.js) against an in-memory hooks
 * object — main() only runs when this file is executed directly.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// ─── USAGE ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/install.js [--dry-run] [--force] [--non-interactive] [--help|-h]

Copies /handoff:* slash commands to ~/.claude/commands/handoff/ and wires
SessionStart + SessionEnd hooks into .claude/settings.local.json in your current
project. Existing hooks in settings.local.json are preserved — the script only
adds entries that aren't already there. A re-run also removes a loader-stop
entry left over in the Stop array by an older install (see README/CHANGELOG).

Flags:
  --dry-run          Show what would happen without writing anything.
  --force            Skip confirmation; overwrite existing command files.
  --non-interactive  Same as --force (for CI / scripted setups).
  --help, -h         Print this message and exit.
`.trim();

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const showHelp    = args.includes('--help') || args.includes('-h');
const dryRun      = args.includes('--dry-run');
const force       = args.includes('--force') || args.includes('--non-interactive');

if (showHelp) { console.log(USAGE); process.exit(0); }

// ─── PATHS ───────────────────────────────────────────────────────────────────

// Repo root — this script lives in <repo>/scripts/, so go one level up.
const repoRoot     = path.resolve(__dirname, '..');
const srcDir       = path.join(repoRoot, 'commands', 'handoff');
const destDir      = path.join(os.homedir(), '.claude', 'commands', 'handoff');

// Settings file lives in the USER'S current project, not in this repo.
const settingsDir  = path.join(process.cwd(), '.claude');
const settingsPath = path.join(settingsDir, 'settings.local.json');

// Hook commands — forward slashes everywhere (Claude Code settings.local.json
// accepts them on all platforms and avoids JSON back-slash escape headaches).
const repoRootFwd  = repoRoot.replace(/\\/g, '/');
const hookLoader   = `node ${repoRootFwd}/scripts/handoff.js loader-hook`;
const hookStop     = `node ${repoRootFwd}/scripts/handoff.js loader-stop`;

// Engine path recorded for standalone installs so command files can find the engine.
// Content: absolute forward-slash path to scripts/handoff.js in this repo.
const enginePathFile    = path.join(destDir, '.engine-path');
const enginePathContent = `${repoRootFwd}/scripts/handoff.js`;

// ─── GUARD: SOURCE DIR MUST EXIST ────────────────────────────────────────────

if (!fs.existsSync(srcDir)) {
  console.error(
    `Error: commands/handoff/ not found at:\n  ${srcDir}\n\n` +
    `This usually means the script is being run from the wrong location.\n` +
    `Run it with the full path to this repo's install.js, e.g.:\n` +
    `  node /path/to/claude-memory/scripts/install.js`
  );
  process.exit(1);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Return all *.md files (non-dotfiles) in srcDir. */
function listSourceFiles() {
  return fs.readdirSync(srcDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.')
  );
}

/**
 * Merge hook entries into an existing parsed settings object.
 * Mutates in place; also returns { addedStart, addedSessionEnd, removedStop }.
 *
 * loader-stop's home moved from the Stop hook (fires at EVERY turn end —
 * the bug this PR fixes) to SessionEnd (fires once, at true session end).
 * This function is idempotent across the migration:
 *   - A fresh install gets SessionStart + SessionEnd wired, nothing in Stop.
 *   - Re-running on an install from BEFORE this PR removes the old Stop
 *     entry (so it doesn't sit there forever paying a stdin-parse cost for
 *     nothing) and adds the new SessionEnd entry.
 *   - Re-running on an already-migrated install is a no-op (both addedStart
 *     and addedSessionEnd come back false, removedStop false).
 * Any OTHER entries a user has in Stop/SessionStart/SessionEnd are always
 * preserved untouched — only a loader-stop/loader-hook command string is
 * ever matched.
 */
function mergeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  // SessionStart
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
  const hasLoader = settings.hooks.SessionStart.some(
    (e) => typeof e.command === 'string' && e.command.includes('handoff.js loader-hook')
  );
  const addedStart = !hasLoader;
  if (addedStart) settings.hooks.SessionStart.push({ command: hookLoader });

  // Stop — migration: remove any pre-existing loader-stop entry. Everything
  // else in the Stop array (a user's own hooks, or other tools' hooks) is
  // left exactly as it was.
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  const stopLengthBefore = settings.hooks.Stop.length;
  settings.hooks.Stop = settings.hooks.Stop.filter(
    (e) => !(typeof e.command === 'string' && e.command.includes('handoff.js loader-stop'))
  );
  const removedStop = settings.hooks.Stop.length < stopLengthBefore;

  // SessionEnd — loader-stop's new (and only correct) home.
  if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];
  const hasSessionEnd = settings.hooks.SessionEnd.some(
    (e) => typeof e.command === 'string' && e.command.includes('handoff.js loader-stop')
  );
  const addedSessionEnd = !hasSessionEnd;
  if (addedSessionEnd) settings.hooks.SessionEnd.push({ command: hookStop });

  return { addedStart, addedSessionEnd, removedStop };
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

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const files          = listSourceFiles();
  const settingsExists = fs.existsSync(settingsPath);

  // ── Plan summary ─────────────────────────────────────────────────────────
  console.log('\nclaude-memory installer');
  if (dryRun) console.log('(dry-run — nothing will be written)');
  console.log('');
  console.log(`  Copy ${files.length} command file(s) to ${destDir}`);
  console.log(`  Record engine path: ${enginePathFile}`);
  console.log(`    → ${enginePathContent}`);
  console.log(`  ${settingsExists ? 'Merge hooks into' : 'Create'} ${settingsPath}`);
  console.log(`    SessionStart → ${hookLoader}`);
  console.log(`    SessionEnd   → ${hookStop}`);
  console.log('');

  // ── Confirm ───────────────────────────────────────────────────────────────
  if (!dryRun && !force) {
    const ok = await confirm(
      `About to copy ${files.length} command files to ~/.claude/commands/handoff/ ` +
      `and wire 2 hooks in .claude/settings.local.json.\nContinue?`
    );
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
    console.log('');
  }

  // ── Step 1: Copy slash commands ───────────────────────────────────────────
  const copied  = [];
  const skipped = [];

  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });

  for (const file of files) {
    const dest   = path.join(destDir, file);
    const exists = fs.existsSync(dest);

    if (exists && !force) {
      skipped.push(file);
    } else {
      if (!dryRun) fs.copyFileSync(path.join(srcDir, file), dest);
      copied.push(file);
    }
  }

  // ── Step 1b: Record engine path for standalone installs ───────────────────
  // Written as a plain text file containing the absolute forward-slash engine
  // path so that command files can find the engine without CLAUDE_PLUGIN_ROOT.
  if (!dryRun) {
    fs.writeFileSync(enginePathFile, enginePathContent + '\n', 'utf8');
  }

  // ── Step 2: Wire hooks ────────────────────────────────────────────────────
  let addedStart     = false;
  let addedSessionEnd = false;
  let removedStop    = false;
  let hooksAction    = '';

  if (!dryRun) {
    fs.mkdirSync(settingsDir, { recursive: true });

    let settings = {};
    if (settingsExists) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        console.warn(`  Warning: could not parse existing settings — starting fresh.`);
        console.warn(`  Parse error: ${e.message}`);
        settings = {};
      }
      hooksAction = 'merged into existing';
    } else {
      hooksAction = 'created';
    }

    const result   = mergeHooks(settings);
    addedStart     = result.addedStart;
    addedSessionEnd = result.addedSessionEnd;
    removedStop    = result.removedStop;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  } else {
    // Dry-run: preview without writing
    let settings = {};
    if (settingsExists) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /**/ }
      hooksAction = 'would merge into existing';
    } else {
      hooksAction = 'would create';
    }
    const result   = mergeHooks(settings);
    addedStart     = result.addedStart;
    addedSessionEnd = result.addedSessionEnd;
    removedStop    = result.removedStop;
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('  Slash commands:');
  for (const f of copied)  console.log(`    copied   ${f}`);
  for (const f of skipped) console.log(`    skipped  ${f} (already exists — use --force to overwrite)`);
  console.log('');
  if (dryRun) {
    console.log(`  Engine path: would write ${enginePathFile}`);
    console.log(`    → ${enginePathContent}`);
  } else {
    console.log(`  Engine path recorded: ${enginePathFile}`);
    console.log(`    → ${enginePathContent}`);
  }
  console.log('');
  console.log(`  Hooks (${hooksAction} ${settingsPath}):`);
  console.log(`    SessionStart: ${addedStart      ? 'added' : 'already present — skipped'}`);
  console.log(`    SessionEnd:   ${addedSessionEnd ? 'added' : 'already present — skipped'}`);
  if (removedStop) {
    console.log(`    Stop:         removed a pre-existing loader-stop entry (migrated to SessionEnd)`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Re-run without --dry-run to apply.');
  } else {
    console.log('Done. Restart Claude Code or open a fresh session to pick up the changes.');
  }
  console.log('');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { mergeHooks };
