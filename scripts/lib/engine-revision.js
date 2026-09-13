'use strict';

/**
 * scripts/lib/engine-revision.js — feat/status-engine-revision.
 *
 * OWNER RULING (2026-09-13): `handoff_status` reports the engine revision
 * and schema epoch three ways — LOADED (captured once at module import: the
 * SCHEMA_EPOCH literal plus a revision stamp computed at import), DISK
 * (recomputed on every call from the engine checkout on disk), and DB (the
 * project DB's stored epoch) — and reports both loaded and disk, never one.
 * This module supplies the pure, root-parameterized half of that (LOADED +
 * the function cmdStatus calls again for DISK); the DB half and the drift
 * verdict are cmdStatus's own job, via schema-epoch-guard.js's
 * classifyEpochDrift (reused, never forked — see that module's own header).
 *
 * readDiskRevision(engineRoot) never throws — every failure mode (unreadable
 * manifest, no git checkout, git binary missing, no VERSION file) degrades
 * to a "we don't know" value instead of propagating an exception, matching
 * schema-epoch-guard.js's own never-throws contract for the same reason:
 * this is read by a long-lived MCP server process on every status call, and
 * a thrown exception there must never crash the server over an engine
 * checkout that merely isn't a git repo.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readDiskSchemaEpoch } = require('./schema-epoch-guard.js');

const GIT_TIMEOUT_MS = 5000;

/**
 * @param {string} engineRoot
 * @returns {{schema_epoch: number|null, revision: string, source: 'git'|'version-file'|'unknown'}}
 *
 * Total classification of `revision`/`source`, in order:
 *   1. `git rev-parse --short HEAD` (spawned via execFileSync with an argv
 *      array — never a shell string) succeeds inside engineRoot and yields
 *      a non-empty trimmed value -> { revision: <short sha>, source: 'git' }.
 *   2. git absent/not-a-checkout/failed/timed-out/empty-output AND
 *      <engineRoot>/VERSION exists and reads to a non-empty trimmed string
 *      -> { revision: <file contents, trimmed>, source: 'version-file' }.
 *   3. both of the above fail -> { revision: 'unknown', source: 'unknown' }.
 *
 * `schema_epoch` is read via schema-epoch-guard.js's own
 * readDiskSchemaEpoch(engineRoot) — the SAME "what does
 * scripts/sql/schema-manifest.json say, right now" read every other
 * engine-identity check in this codebase already uses (fix/mcp-stale-engine-
 * gate) — never a second, independently-parsed copy of that file. `null`
 * when the manifest is missing/unreadable/malformed.
 */
function readDiskRevision(engineRoot) {
  let schema_epoch = null;
  try {
    const epochResult = readDiskSchemaEpoch(engineRoot);
    schema_epoch = epochResult.ok ? epochResult.epoch : null;
  } catch (_err) {
    schema_epoch = null;
  }

  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: engineRoot,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.toString('utf8').trim();
    if (trimmed.length > 0) {
      return { schema_epoch, revision: trimmed, source: 'git' };
    }
  } catch (_err) {
    // Not a git checkout, git not on PATH, no commits yet, spawn failed, or
    // the 5s timeout fired — fall through to the VERSION-file check. Never
    // rethrown: this function's whole contract is "never throws".
  }

  try {
    const versionPath = path.join(engineRoot, 'VERSION');
    const raw = fs.readFileSync(versionPath, 'utf8').trim();
    if (raw.length > 0) {
      return { schema_epoch, revision: raw, source: 'version-file' };
    }
  } catch (_err) {
    // Absent, unreadable, or empty-after-trim — fall through to unknown.
  }

  return { schema_epoch, revision: 'unknown', source: 'unknown' };
}

// LOADED's own engineRoot: mirrors scripts/handoff.js's `_ENGINE_ROOT`
// derivation (CLAUDE_PLUGIN_ROOT override, else the checkout root implied by
// this file's own location) computed INDEPENDENTLY here rather than via
// `require('./handoff.js')` — handoff.js requires THIS module for cmdStatus,
// so a back-reference would be circular. Same pattern/reasoning as
// scripts/handoff-mcp.mjs's own `deriveSpawnEngineRoot` (see that function's
// comment). handoff.js's `__dirname` is `<root>/scripts`, one hop from
// `<root>`; this file's `__dirname` is `<root>/scripts/lib`, two hops from
// `<root>`.
const _MODULE_ENGINE_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? process.env.CLAUDE_PLUGIN_ROOT
  : path.resolve(__dirname, '..', '..');

// Captured once, at module import — deliberately never re-evaluated. This is
// the "LOADED" half of the owner ruling above; cmdStatus calls
// readDiskRevision(_ENGINE_ROOT) again, itself, to get a fresh "DISK" read
// on every status call.
const LOADED = Object.freeze(readDiskRevision(_MODULE_ENGINE_ROOT));

module.exports = {
  readDiskRevision,
  LOADED,
};
