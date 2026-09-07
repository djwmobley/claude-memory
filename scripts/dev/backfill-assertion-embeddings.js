'use strict';

/**
 * backfill-assertion-embeddings.js — DEPRECATED pointer.
 *
 * init-embeddability spec (A3): this standalone script's logic has been
 * promoted to a first-class `scripts/handoff.js` subcommand,
 * `backfill-embeddings`, which generalizes this script's assertions-only
 * backfill to also cover `decisions`, adds a dry-run default, a
 * --force-mixed-provider guard (adversary finding #3), and a total
 * SQLite-seam classification (no embedding column on that backend).
 *
 * The implementation now lives in scripts/lib/backfill-embeddings.js
 * (runBackfillEmbeddings) — this file is kept ONLY as a thin,
 * backward-compatible pointer for any operator muscle-memory/script that
 * still invokes it directly.
 *
 * Use instead:
 *   node scripts/handoff.js backfill-embeddings [--apply] [--table=assertions|decisions|all]
 *       [--batch-size=N] [--project-id=<id>] [--force-mixed-provider]
 *
 * This pointer forwards ALL of its own recognized flags to the new
 * subcommand (translating --project-id/--dry-run/--batch-size/--verbose to
 * the new surface) and always scopes `--table=assertions` (this script's
 * original, narrower scope) unless the operator explicitly re-invokes the
 * new subcommand directly for `decisions`/`all`.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = path.resolve(__dirname, '..');
const HANDOFF_SCRIPT = path.join(SCRIPTS_DIR, 'handoff.js');

const ARGS = process.argv.slice(2);

if (ARGS.includes('--help') || ARGS.includes('-h')) {
  console.log(`
DEPRECATED — use instead:
  node scripts/handoff.js backfill-embeddings [--apply] [--table=assertions|decisions|all]
      [--batch-size=N] [--project-id=<id>] [--force-mixed-provider]

This script now forwards to that subcommand, scoped to --table=assertions
(its original behavior) for backward compatibility. See scripts/lib/backfill-embeddings.js
for the full implementation and scripts/handoff.js's own --help for the current flag set.
`.trimStart());
  process.exit(0);
}

function parseFlag(name) {
  const flag = ARGS.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : null;
}

const forwardedArgs = ['--table=assertions'];
if (!ARGS.includes('--dry-run')) forwardedArgs.push('--apply'); // this script's OWN default was live-apply, not dry-run
const batchSize = parseFlag('batch-size');
if (batchSize) forwardedArgs.push(`--batch-size=${batchSize}`);
const projectId = parseFlag('project-id');
if (projectId) forwardedArgs.push(`--project-id=${projectId}`);

process.stderr.write(
  '[backfill-assertion-embeddings] DEPRECATED — forwarding to `node scripts/handoff.js backfill-embeddings ' +
  forwardedArgs.join(' ') + '`. Update any calling script to invoke that subcommand directly.\n'
);

const result = spawnSync(process.execPath, [HANDOFF_SCRIPT, 'backfill-embeddings', ...forwardedArgs], {
  stdio: 'inherit',
});
process.exit(result.status === null ? 1 : result.status);
