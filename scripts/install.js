'use strict';

/**
 * install.js — Copy slash commands and wire session hooks
 *
 * Does two things so you don't have to do them by hand:
 *   1. Copies every *.md file from <repo>/commands/handoff/ to
 *      ~/.claude/commands/handoff/ so Claude Code can find them.
 *   2. Merges SessionStart and Stop hooks into .claude/settings.local.json
 *      in your CURRENT project directory — preserving any hooks already there.
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
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

// ─── USAGE ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/install.js [--dry-run] [--force] [--non-interactive] [--help|-h]

Copies /handoff:* slash commands to ~/.claude/commands/handoff/ and wires
SessionStart + Stop hooks into .claude/settings.local.json in your current project.
Existing hooks in settings.local.json are preserved — the script only adds entries
that aren't already there.

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
 * Mutates in place; also returns { addedStart, addedStop }.
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

  // Stop
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  const hasStop = settings.hooks.Stop.some(
    (e) => typeof e.command === 'string' && e.command.includes('handoff.js loader-stop')
  );
  const addedStop = !hasStop;
  if (addedStop) settings.hooks.Stop.push({ command: hookStop });

  return { addedStart, addedStop };
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
  console.log(`  ${settingsExists ? 'Merge hooks into' : 'Create'} ${settingsPath}`);
  console.log(`    SessionStart → ${hookLoader}`);
  console.log(`    Stop         → ${hookStop}`);
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

  // ── Step 2: Wire hooks ────────────────────────────────────────────────────
  let addedStart  = false;
  let addedStop   = false;
  let hooksAction = '';

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

    const result = mergeHooks(settings);
    addedStart   = result.addedStart;
    addedStop    = result.addedStop;
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
    const result = mergeHooks(settings);
    addedStart   = result.addedStart;
    addedStop    = result.addedStop;
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('  Slash commands:');
  for (const f of copied)  console.log(`    copied   ${f}`);
  for (const f of skipped) console.log(`    skipped  ${f} (already exists — use --force to overwrite)`);
  console.log('');
  console.log(`  Hooks (${hooksAction} ${settingsPath}):`);
  console.log(`    SessionStart: ${addedStart ? 'added' : 'already present — skipped'}`);
  console.log(`    Stop:         ${addedStop  ? 'added' : 'already present — skipped'}`);
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Re-run without --dry-run to apply.');
  } else {
    console.log('Done. Restart Claude Code or open a fresh session to pick up the changes.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
