'use strict';

/**
 * init-config.js — Interactive bootstrap: write .claude/pipeline.yml
 *
 * Prompts the user for Postgres connection details and writes a minimal
 * pipeline.yml that loadConfig() in scripts/lib/shared.js can consume.
 *
 * Usage:
 *   node scripts/init-config.js [--force] [--non-interactive] [--help|-h]
 *
 * Flags:
 *   --force            Overwrite an existing .claude/pipeline.yml without asking.
 *   --non-interactive  Write all defaults silently (useful for CI / scripted setups).
 *   --help, -h         Print usage and exit 0.
 *
 * Exit codes: 0 success, 1 error or refused overwrite, 2 usage.
 */

const fs   = require('node:fs/promises');
const path = require('node:path');

// ─── USAGE ───────────────────────────────────────────────────────────────────

const USAGE = `
Usage: node scripts/init-config.js [--force] [--non-interactive] [--help|-h]

Writes .claude/pipeline.yml with your Postgres connection settings.
Claude reads this file to know which database to talk to.

Flags:
  --force            Overwrite an existing config file without asking.
  --non-interactive  Accept all defaults silently (for CI / scripted setups).
  --help, -h         Print this message and exit.
`.trim();

// ─── ARG PARSING ─────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const showHelp      = args.includes('--help') || args.includes('-h');
const force         = args.includes('--force');
const nonInteract   = args.includes('--non-interactive');

if (showHelp) { console.log(USAGE); process.exit(0); }

// ─── DEFAULTS ────────────────────────────────────────────────────────────────

const defaults = {
  projectName: path.basename(process.cwd()),
  user:        'postgres',
  database:    'claude_memory',
  host:        'localhost',
  port:        '5432',
};

// ─── VALIDATION ──────────────────────────────────────────────────────────────

function validateProjectName(v) {
  const t = v.trim();
  if (!t) return 'Project name cannot be empty.';
  return null;
}

function validateIdentifier(v, label) {
  const t = v.trim();
  if (!t)               return `${label} cannot be empty.`;
  if (/\s/.test(t))     return `${label} must not contain whitespace.`;
  if (/[^A-Za-z0-9_-]/.test(t)) return `${label} must only contain letters, digits, hyphens, or underscores.`;
  return null;
}

function validatePort(v) {
  const n = parseInt(v, 10);
  if (isNaN(n) || n < 1 || n > 65535) return 'Port must be an integer between 1 and 65535.';
  return null;
}

// ─── INTERACTIVE PROMPT HELPERS ──────────────────────────────────────────────

async function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function ask(rl, label, defaultVal, validate) {
  while (true) {                              // eslint-disable-line no-constant-condition
    const raw  = await prompt(rl, `  ${label} [${defaultVal}]: `);
    const val  = raw.trim() || defaultVal;
    const err  = validate ? validate(val) : null;
    if (!err) return val;
    console.error(`  ! ${err}`);
  }
}

// ─── YAML BUILDER ────────────────────────────────────────────────────────────

function buildYaml({ projectName, host, port, database, user }) {
  return [
    'project:',
    `  name: ${projectName}`,
    '',
    'knowledge:',
    '  tier: postgres',
    `  host: ${host}`,
    `  port: ${port}`,
    `  database: ${database}`,
    `  user: ${user}`,
    '',           // trailing newline
  ].join('\n');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const configDir  = path.join(process.cwd(), '.claude');
  const configPath = path.join(configDir, 'pipeline.yml');

  // Check for existing file unless --force
  let exists = false;
  try { await fs.access(configPath); exists = true; } catch { /* not found */ }

  if (exists && !force && !nonInteract) {
    // Need readline for the overwrite question — import lazily so --non-interactive
    // never touches readline at all.
    const { createInterface } = require('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await prompt(rl, `  .claude/pipeline.yml already exists. Overwrite? (y/N): `);
    rl.close();
    if (ans.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  let values = { ...defaults };

  if (!nonInteract) {
    const { createInterface } = require('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nConfigure .claude/pipeline.yml (press Enter to accept defaults)\n');

    values.projectName = await ask(rl, 'project name', defaults.projectName, validateProjectName);
    values.user        = await ask(rl, 'postgres user', defaults.user, (v) => validateIdentifier(v, 'User'));
    values.database    = await ask(rl, 'database name', defaults.database, (v) => validateIdentifier(v, 'Database'));
    values.host        = await ask(rl, 'host',          defaults.host,     (v) => validateIdentifier(v.replace(/\./g, ''), 'Host'));
    values.port        = await ask(rl, 'port',          defaults.port,     validatePort);

    rl.close();
    console.log('');
  }

  // Coerce port to string for YAML (already a string from prompt; ensure for defaults path)
  values.port = String(values.port);

  const yaml = buildYaml(values);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, yaml, { encoding: 'utf8' });

  console.log(`Wrote .claude/pipeline.yml:`);
  console.log(`  project name: ${values.projectName}`);
  console.log(`  database:     ${values.database}@${values.host}:${values.port}`);
  console.log(`  user:         ${values.user}`);
  console.log('');
  console.log(`Next: node scripts/handoff.js init`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
