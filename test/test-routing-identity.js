'use strict';

/**
 * test-routing-identity.js — pure unit tests (no DB) for
 * scripts/lib/routing-identity.js, the §17 B1 ONE normalization engine
 * (adversary finding F-1). Covers the specific attack shapes the adversary
 * pass named: NFD vs NFC, trailing whitespace, internal double-space
 * collapse, case-preservation, and the whitespace-only reject.
 *
 * Usage: node test/test-routing-identity.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const routingIdentity = require('../scripts/lib/routing-identity.js');

let passed = 0;
let failed = 0;

function run(label, fn) {
  try {
    fn();
    console.log(`[PASS] ${label}`);
    passed++;
  } catch (err) {
    console.log(`[FAIL] ${label}: ${err && err.message ? err.message : err}`);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertThrows(fn, msgRegex, label) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (threw === null) throw new Error(`${label || 'expected a throw'} — nothing was thrown`);
  if (!msgRegex.test(threw.message)) {
    throw new Error(`${label || 'error message mismatch'}: "${threw.message}" did not match ${msgRegex}`);
  }
}

// ── normLabel / normRole ────────────────────────────────────────────────

run('normLabel: NFD and NFC forms of the same visual string normalize identically', () => {
  const nfc = 'café'; // precomposed é
  const nfd = 'café'; // e + combining acute accent
  assertEq(routingIdentity.normLabel(nfc), routingIdentity.normLabel(nfd), 'NFD input must normalize to the same byte-exact string as NFC input');
});

run('normLabel: trailing and leading whitespace trimmed', () => {
  assertEq(routingIdentity.normLabel('  claude-sonnet  '), 'claude-sonnet');
});

run('normLabel: internal double-space (and tab/newline runs) collapse to a single space', () => {
  assertEq(routingIdentity.normLabel('claude  sonnet'), 'claude sonnet');
  assertEq(routingIdentity.normLabel('claude\t\tsonnet'), 'claude sonnet');
  assertEq(routingIdentity.normLabel('claude \n sonnet'), 'claude sonnet');
});

run('normLabel: case is PRESERVED — no case-folding', () => {
  assertEq(routingIdentity.normLabel('Claude Sonnet'), 'Claude Sonnet');
  const upper = routingIdentity.normLabel('Claude Sonnet');
  const lower = routingIdentity.normLabel('claude sonnet');
  if (upper === lower) throw new Error('case must remain distinct after normalization — this is NOT case-folding');
});

run('normLabel: combination of NFD + trailing space + internal double space all normalize together', () => {
  const messy = '  café  model  \n';
  assertEq(routingIdentity.normLabel(messy), 'café model');
});

run('normRole is the same function as normLabel (role and label share one rule)', () => {
  assertEq(routingIdentity.normRole, routingIdentity.normLabel);
});

// ── normId ───────────────────────────────────────────────────────────────

run('normId: trims but does NOT NFC-normalize or collapse internal whitespace', () => {
  assertEq(routingIdentity.normId('  sess-123  '), 'sess-123');
  assertEq(routingIdentity.normId('sess  123'), 'sess  123', 'normId must preserve internal whitespace runs verbatim (opaque identifier, not a human-typed label)');
});

run('normId: non-string input passed through unchanged (validation is requireNormalizedNonEmpty\'s job, not normId\'s)', () => {
  assertEq(routingIdentity.normId(123), 123);
  assertEq(routingIdentity.normId(null), null);
});

// ── requireNormalizedNonEmpty ────────────────────────────────────────────

run('requireNormalizedNonEmpty: non-empty string normalizes and returns', () => {
  assertEq(routingIdentity.requireNormalizedNonEmpty('  foo  ', 'x', routingIdentity.normId), 'foo');
});

run('requireNormalizedNonEmpty: raw empty string rejected before normalization', () => {
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty('', 'myField', routingIdentity.normLabel),
    /myField.*must be a non-empty string/,
    'empty string must reject naming the field'
  );
});

run('requireNormalizedNonEmpty: non-string input rejected', () => {
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty(42, 'myField', routingIdentity.normLabel),
    /myField.*must be a non-empty string/,
    'numeric input must reject naming the field'
  );
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty(undefined, 'myField', routingIdentity.normLabel),
    /myField/,
    'undefined input must reject'
  );
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty(null, 'myField', routingIdentity.normLabel),
    /myField/,
    'null input must reject'
  );
});

run('requireNormalizedNonEmpty: whitespace-only string rejected AFTER normalization (never silently stored as "")', () => {
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty('   ', 'myField', routingIdentity.normLabel),
    /myField.*after normalization/,
    'whitespace-only input must reject with a distinct post-normalization message'
  );
  assertThrows(
    () => routingIdentity.requireNormalizedNonEmpty('\t\n', 'myField', routingIdentity.normId),
    /myField.*after normalization/,
    'whitespace-only input must reject under normId too'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
