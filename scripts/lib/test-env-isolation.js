'use strict';

/**
 * test-env-isolation.js — shared helper isolating HANDOFF_BASE_DIR for
 * in-process calls into scripts/lib/embedding-provider.js's endpoint
 * resolution (resolveConfiguredEmbedEndpoint(Detailed), seedLocalEmbeddingProvider).
 *
 * Root cause this exists to prevent (PR #267, and the same bug recurring in
 * scripts/test-sqlite-seam.js + test/test-embed-endpoint-classify.js's
 * Section 3 "NONE" cases): resolveConfiguredEmbedEndpointDetailed's
 * precedence step (c) reads `${resolveBaseDir()}/handoff-embed.json`, and
 * resolveBaseDir() reads process.env.HANDOFF_BASE_DIR DIRECTLY — it has no
 * injectable env parameter, so passing `env: {}` to
 * seedLocalEmbeddingProvider/resolveConfiguredEmbedEndpoint does NOT stop it
 * from falling through to a developer machine's REAL
 * ~/.claude/handoff-embed.json. A test asserting classification 'NONE' with
 * an empty/VLLM_EMBED_URL-less env is only hermetic when HANDOFF_BASE_DIR
 * itself is pointed at a fresh, empty temp dir for the duration of the call.
 * Without this, "unconfigured" tests fail LOCALLY on any machine that has
 * that file (e.g. from init-embeddability's own seed-provider setup) while
 * passing in CI, which has no such file.
 *
 * Use for IN-PROCESS calls (mutates the real process.env.HANDOFF_BASE_DIR
 * for the duration of fn, then restores it). For SUBPROCESS calls
 * (execFileSync spawning `handoff.js init --seed-provider` etc.), isolate by
 * passing an explicit HANDOFF_BASE_DIR in the child's env object instead —
 * see test/handoff/test-handoff.js's runSeedProvider and
 * test/test-init-embeddability.js's makeTempDir-based env objects.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * withIsolatedHandoffBaseDir — runs fn() with process.env.HANDOFF_BASE_DIR
 * pointed at a fresh empty temp dir, then restores the prior value (deleted
 * entirely if it was previously unset) and removes the temp dir, whether fn
 * throws/rejects or not. fn may be sync or async — the return value is
 * always awaited, so cleanup never fires before an async fn settles.
 *
 * @param {() => any} fn
 * @returns {Promise<any>} fn's resolved return value
 */
async function withIsolatedHandoffBaseDir(fn) {
  const saved = process.env.HANDOFF_BASE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-base-isolate-'));
  process.env.HANDOFF_BASE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HANDOFF_BASE_DIR;
    else process.env.HANDOFF_BASE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { withIsolatedHandoffBaseDir };
