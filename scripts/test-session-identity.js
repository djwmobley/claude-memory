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
 * Usage: node scripts/test-session-identity.js
 * Exit codes: 0 = all pass, 1 = any failure.
 */

const { resolveSessionIdFromEnv } = require('./lib/session-identity');

let passed = 0;
let failed = 0;

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failed++; }

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
  const label = 'SI1: neither CLAUDE_CODE_SESSION_ID nor CODEX_THREAD_ID set -> null';
  const r = resolveSessionIdFromEnv(null);
  if (r !== null) fail(label, `expected null, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess-1', CODEX_THREAD_ID: undefined }, () => {
  const label = 'SI2: only CLAUDE_CODE_SESSION_ID set -> that value';
  const r = resolveSessionIdFromEnv(null);
  if (r !== 'claude-sess-1') fail(label, `expected claude-sess-1, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: '01a0884c-306e-7182-851c-74d81482720b' }, () => {
  const label = 'SI3: only CODEX_THREAD_ID set -> that value';
  const r = resolveSessionIdFromEnv(null);
  if (r !== '01a0884c-306e-7182-851c-74d81482720b') fail(label, `expected the codex thread id, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'same-id', CODEX_THREAD_ID: 'same-id' }, () => {
  const label = 'SI4: both set and EQUAL -> that value, no ambiguity';
  const r = resolveSessionIdFromEnv('codex');
  if (r !== 'same-id') fail(label, `expected same-id, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const label = "SI5: both set, DIFFERENT, host='codex' -> CODEX_THREAD_ID";
  const r = resolveSessionIdFromEnv('codex');
  if (r !== 'codex-thread') fail(label, `expected codex-thread, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const label = "SI6: both set, DIFFERENT, host='claude' -> CLAUDE_CODE_SESSION_ID";
  const r = resolveSessionIdFromEnv('claude');
  if (r !== 'claude-sess') fail(label, `expected claude-sess, got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: 'claude-sess', CODEX_THREAD_ID: 'codex-thread' }, () => {
  const label = 'SI7: both set, DIFFERENT, host absent/null -> CLAUDE_CODE_SESSION_ID (default)';
  const r = resolveSessionIdFromEnv(null);
  if (r !== 'claude-sess') fail(label, `expected claude-sess (default), got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: '   ', CODEX_THREAD_ID: 'codex-thread-2' }, () => {
  const label = 'SI8: a whitespace-only CLAUDE_CODE_SESSION_ID is trimmed to absent, falls through to CODEX_THREAD_ID';
  const r = resolveSessionIdFromEnv(null);
  if (r !== 'codex-thread-2') fail(label, `expected codex-thread-2 (whitespace-only treated as absent), got ${JSON.stringify(r)}`); else pass(label);
});

withEnv({ CLAUDE_CODE_SESSION_ID: '  claude-sess-padded  ', CODEX_THREAD_ID: undefined }, () => {
  const label = 'SI9: a padded CLAUDE_CODE_SESSION_ID value is trimmed before being returned';
  const r = resolveSessionIdFromEnv(null);
  if (r !== 'claude-sess-padded') fail(label, `expected trimmed value, got ${JSON.stringify(r)}`); else pass(label);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
