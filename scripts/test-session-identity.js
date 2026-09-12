'use strict';

/**
 * test-session-identity.js — unit coverage for scripts/lib/session-identity.js
 * directly (no subprocess, no handoff.js indirection), mirroring the SID1-11
 * fixtures in scripts/test-loader-stop-gate.js (which cover the SAME function
 * re-exported through handoff.js after the lift into this shared module).
 * Kept in a separate file so the shared module has its own direct test, per
 * the fix/mcp-usage-codex-identity PR task — test-loader-stop-gate.js's
 * SID1-11 continue to cover the handoff.js re-export unchanged.
 *
 * CodeQL js/clear-text-logging (alerts #21, #22): the resolved session id
 * (`r` below) is derived from process.env.CLAUDE_CODE_SESSION_ID /
 * process.env.CODEX_THREAD_ID. No string built from `r` — by comparison,
 * length, type inspection, or any other operation — may ever reach a
 * logging sink. check() takes only a pre-computed boolean (the comparison
 * result itself) plus a fixed literal label; it never logs `r`, a
 * description of `r`, or any interpolation of either.
 *
 * Usage: node scripts/test-session-identity.js
 * Exit codes: 0 = all pass, 1 = any failure.
 */

const assert = require('node:assert');
const { resolveSessionIdFromEnv } = require('./lib/session-identity');

let passed = 0;
let failed = 0;

/** label must be a literal string; condition must be a boolean computed by comparison. */
function check(label, condition) {
  try {
    assert.ok(condition, label);
    console.log(`PASS  ${label}`);
    passed++;
  } catch {
    console.log(`FAIL  ${label}`);
    failed++;
  }
}

/** process.env.X = undefined coerces to the literal string "undefined" — always delete instead. */
function restoreEnvVar(key, savedValue) {
  if (savedValue === undefined) delete process.env[key];
  else process.env[key] = savedValue;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { fn(); } finally { for (const k of Object.keys(vars)) restoreEnvVar(k, saved[k]); }
}

withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI1: neither CLAUDE_CODE_SESSION_ID nor CODEX_THREAD_ID set -> null', r === null);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess-1', CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI2: only CLAUDE_CODE_SESSION_ID set -> that value', r === 'claude-sess-1');
});

withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: '01a0884c-306e-7182-851c-74d81482720b' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI3: only CODEX_THREAD_ID set -> that value', r === '01a0884c-306e-7182-851c-74d81482720b');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'same-id', CODEX_THREAD_ID: 'same-id' }, () => {
  const r = resolveSessionIdFromEnv('codex');
  check('SI4: both set and EQUAL -> that value, no ambiguity', r === 'same-id');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv('codex');
  check("SI5: both set, DIFFERENT, host='codex' -> CODEX_THREAD_ID", r === 'codex-thread');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv('claude');
  check("SI6: both set, DIFFERENT, host='claude' -> CLAUDE_CODE_SESSION_ID", r === 'claude-sess');
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI7: both set, DIFFERENT, host absent/null -> CLAUDE_CODE_SESSION_ID (default)', r === 'claude-sess');
});

withEnv({ CLAUDE_CODE_SESSION_ID: '   ', CODEX_THREAD_ID: 'codex-thread-2' }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI8: a whitespace-only CLAUDE_CODE_SESSION_ID is trimmed to absent, falls through to CODEX_THREAD_ID', r === 'codex-thread-2');
});

withEnv({ CLAUDE_CODE_SESSION_ID: '  claude-sess-padded  ', CODEX_THREAD_ID: undefined }, () => {
  const r = resolveSessionIdFromEnv(null);
  check('SI9: a padded CLAUDE_CODE_SESSION_ID value is trimmed before being returned', r === 'claude-sess-padded');
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
