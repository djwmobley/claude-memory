'use strict';

/**
 * test-payload-schema.js — Unit tests for scripts/lib/payload-schema.js
 *
 * Tests the two exports directly (no DB required):
 *   - buildPayloadSchema() — returns a JSON-Schema object
 *   - validatePayload()    — validates assertion predicates against the registry
 *
 * Coverage:
 *   T1  buildPayloadSchema() returns an object with expected top-level structure
 *   T2  valid minimal payload (empty arrays) is accepted
 *   T3  valid payload with recognized predicate — ok, no warnings, no errors
 *   T4  missing assertions array — treated as valid (nothing to validate)
 *   T5  assertions is not an array — error
 *   T6  assertion item is not a plain object — error
 *   T7  missing predicate (null) — skipped (not a vocabulary error)
 *   T8  predicate is wrong type (number) — error
 *   T9  unrecognized predicate in permissive mode — warning, ok=true
 *   T10 unrecognized predicate in strict mode — error, ok=false
 *   T11 recognized predicate in strict mode — no error, no warning
 *   T12 empty payload object — ok=true (no assertions key)
 *   T13 null payload — error (not a plain object)
 *   T14 array payload — error (not a plain object)
 *   T15 CRLF in string field values validates same as LF (line-ending invariant)
 *   T16 mixed CRLF/LF string values validate same as LF
 *   T17 buildPayloadSchema() assertions.predicate enum matches recognizedPredicates()
 *
 * Usage:
 *   node scripts/test-payload-schema.js
 *
 * No Postgres or Ollama required. Pure unit test.
 * Exit 0 = all tests passed. Exit 1 = any failure.
 */

const path = require('path');
const { buildPayloadSchema, validatePayload } = require(path.join(__dirname, 'lib', 'payload-schema'));
const { recognizedPredicates } = require(path.join(__dirname, 'lib', 'predicate-registry'));

// ── Tracking ──────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failures = [];

function pass(label)         { console.log(`PASS  ${label}`); passed++; }
function fail(label, reason) { console.log(`FAIL  ${label}: ${reason}`); failures.push({ label, reason }); failed++; }

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function assertTrue(v, msg) {
  if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`);
}

function assertFalse(v, msg) {
  if (v) throw new Error(msg || `expected falsy, got ${JSON.stringify(v)}`);
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTest(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── Helper: get a recognized predicate string (first entry in registry) ───────

function getRecognizedPredicate() {
  const list = recognizedPredicates();
  if (!list || list.length === 0) throw new Error('predicate registry is empty — cannot test recognized predicates');
  return list[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running: test-payload-schema\n');

  // T1 — buildPayloadSchema() returns expected top-level structure
  await runTest('T1: buildPayloadSchema returns schema object with expected top-level keys', () => {
    const schema = buildPayloadSchema();
    assertTrue(schema && typeof schema === 'object' && !Array.isArray(schema), 'schema must be a plain object');
    assertEqual(schema.type, 'object', 'schema.type must be "object"');
    assertTrue(schema.properties && typeof schema.properties === 'object', 'schema.properties must exist');
    assertTrue(schema.properties.entities, 'schema.properties.entities must exist');
    assertTrue(schema.properties.assertions, 'schema.properties.assertions must exist');
    assertEqual(schema.additionalProperties, false, 'additionalProperties must be false');
  });

  // T2 — valid payload with empty arrays accepted
  await runTest('T2: valid payload with empty arrays — ok=true, no warnings, no errors', () => {
    const result = validatePayload({ entities: [], assertions: [], edges: [] });
    assertTrue(result.ok, `ok should be true, got: ${JSON.stringify(result)}`);
    assertEqual(result.warnings.length, 0, 'no warnings expected');
    assertEqual(result.errors.length, 0, 'no errors expected');
  });

  // T3 — valid payload with a recognized predicate
  await runTest('T3: valid payload with recognized predicate — ok=true, no warnings, no errors', () => {
    const pred = getRecognizedPredicate();
    const payload = {
      entities: [],
      assertions: [{ subject: 'foo', predicate: pred, object: 'bar' }],
      edges: [],
    };
    const result = validatePayload(payload, 'permissive');
    assertTrue(result.ok, `ok should be true for recognized predicate "${pred}"`);
    assertEqual(result.warnings.length, 0, 'no warnings for recognized predicate');
    assertEqual(result.errors.length, 0, 'no errors for recognized predicate');
  });

  // T4 — no assertions key → treated as valid
  await runTest('T4: payload without assertions key — ok=true (nothing to validate)', () => {
    const result = validatePayload({ entities: [], tldr: 'no assertions' });
    assertTrue(result.ok, 'ok should be true when assertions key is absent');
    assertEqual(result.errors.length, 0, 'no errors when assertions absent');
  });

  // T5 — assertions is not an array → error
  await runTest('T5: assertions is a string, not an array — ok=false, error produced', () => {
    const result = validatePayload({ assertions: 'not-an-array' });
    assertFalse(result.ok, 'ok should be false when assertions is not an array');
    assertTrue(result.errors.length > 0, 'error array must be non-empty');
    assertTrue(result.errors[0].includes('assertions'), `error should mention "assertions": ${result.errors[0]}`);
  });

  // T6 — assertion item is not a plain object → error
  await runTest('T6: assertion item is a string, not a plain object — error produced', () => {
    const result = validatePayload({ assertions: ['not-an-object'] });
    // ok may be false because errors contain item type error
    assertTrue(result.errors.length > 0, 'error array must be non-empty for non-object item');
    assertTrue(result.errors[0].includes('assertions[0]'), `error should mention assertions[0]: ${result.errors[0]}`);
  });

  // T7 — missing predicate (null) — skipped, not a vocabulary error
  await runTest('T7: assertion with null predicate — skipped (not a vocabulary error), ok=true', () => {
    const result = validatePayload({ assertions: [{ subject: 'a', predicate: null, object: 'b' }] });
    // null predicate is skipped (missing-predicate guard in validatePayload)
    assertTrue(result.ok, 'ok should be true when predicate is null (skipped)');
    assertEqual(result.errors.length, 0, 'no errors when predicate is null');
  });

  // T8 — predicate is wrong type (number) → error
  await runTest('T8: assertion with numeric predicate — error produced', () => {
    const result = validatePayload({ assertions: [{ subject: 'a', predicate: 42, object: 'b' }] });
    assertTrue(result.errors.length > 0, 'error expected for numeric predicate');
    assertTrue(result.errors[0].includes('string'), `error should mention "string": ${result.errors[0]}`);
  });

  // T9 — unrecognized predicate, permissive mode → warning, ok=true
  await runTest('T9: unrecognized predicate in permissive mode — warning, ok=true', () => {
    const payload = { assertions: [{ subject: 'a', predicate: 'xyzzy_not_a_real_predicate', object: 'b' }] };
    const result = validatePayload(payload, 'permissive');
    assertTrue(result.ok, 'ok should be true in permissive mode for unrecognized predicate');
    assertTrue(result.warnings.length > 0, 'warning expected in permissive mode');
    assertEqual(result.errors.length, 0, 'no errors in permissive mode');
  });

  // T10 — unrecognized predicate, strict mode → error, ok=false
  await runTest('T10: unrecognized predicate in strict mode — error, ok=false', () => {
    const payload = { assertions: [{ subject: 'a', predicate: 'xyzzy_not_a_real_predicate', object: 'b' }] };
    const result = validatePayload(payload, 'strict');
    assertFalse(result.ok, 'ok should be false in strict mode for unrecognized predicate');
    assertTrue(result.errors.length > 0, 'error expected in strict mode');
  });

  // T11 — recognized predicate in strict mode → no error, no warning
  await runTest('T11: recognized predicate in strict mode — no error, no warning', () => {
    const pred = getRecognizedPredicate();
    const payload = { assertions: [{ subject: 'a', predicate: pred, object: 'b' }] };
    const result = validatePayload(payload, 'strict');
    assertTrue(result.ok, `ok should be true for recognized predicate "${pred}" in strict mode`);
    assertEqual(result.warnings.length, 0, 'no warnings for recognized predicate');
    assertEqual(result.errors.length, 0, 'no errors for recognized predicate');
  });

  // T12 — empty payload object → ok=true
  await runTest('T12: empty payload object — ok=true (no assertions key)', () => {
    const result = validatePayload({});
    assertTrue(result.ok, 'ok should be true for empty object');
  });

  // T13 — null payload → error
  await runTest('T13: null payload — ok=false, error about non-object', () => {
    const result = validatePayload(null);
    assertFalse(result.ok, 'ok should be false for null payload');
    assertTrue(result.errors.length > 0, 'error expected for null payload');
  });

  // T14 — array payload → error (arrays are not plain objects)
  await runTest('T14: array payload — ok=false, error about non-object', () => {
    const result = validatePayload([{ subject: 'a', predicate: 'x', object: 'b' }]);
    assertFalse(result.ok, 'ok should be false for array payload');
    assertTrue(result.errors.length > 0, 'error expected for array payload');
  });

  // T15 — CRLF in string values validates identically to LF
  await runTest('T15: CRLF in predicate string values — validation outcome identical to LF form', () => {
    // A recognized predicate is a pure ASCII word with no whitespace — CRLF won't
    // appear embedded in the predicate name itself, but may appear in string values
    // such as subject and object fields (model output). validatePayload only classifies
    // the predicate string: the test verifies that a payload whose string fields
    // contain CRLF does NOT crash or change the ok/error outcome.
    const pred = getRecognizedPredicate();

    // LF form
    const payloadLf = {
      assertions: [{ subject: 'foo\nbar', predicate: pred, object: 'baz\nqux' }],
    };
    // CRLF form — same content but with CRLF line endings in subject/object
    const payloadCrlf = {
      assertions: [{ subject: 'foo\r\nbar', predicate: pred, object: 'baz\r\nqux' }],
    };
    const resultLf   = validatePayload(payloadLf,   'permissive');
    const resultCrlf = validatePayload(payloadCrlf, 'permissive');

    // Both must have the same ok status, same error count, same warning count
    assertEqual(resultCrlf.ok,               resultLf.ok,               'ok must match between LF and CRLF forms');
    assertEqual(resultCrlf.errors.length,    resultLf.errors.length,    'error count must match');
    assertEqual(resultCrlf.warnings.length,  resultLf.warnings.length,  'warning count must match');

    // Test with lone-\r form as well
    const payloadCr = {
      assertions: [{ subject: 'foo\rbar', predicate: pred, object: 'baz\rqux' }],
    };
    const resultCr = validatePayload(payloadCr, 'permissive');
    assertEqual(resultCr.ok,              resultLf.ok,              'ok must match between LF and lone-CR forms');
    assertEqual(resultCr.errors.length,   resultLf.errors.length,   'error count must match for lone-CR');
    assertEqual(resultCr.warnings.length, resultLf.warnings.length, 'warning count must match for lone-CR');
  });

  // T16 — mixed CRLF/LF values validate same as LF
  await runTest('T16: mixed CRLF/LF string values — validation outcome identical to LF form', () => {
    const pred = getRecognizedPredicate();
    const payloadMixed = {
      assertions: [
        { subject: 'foo\r\nbar\nbaz', predicate: pred, object: 'qux\r\nquux' },
      ],
    };
    const payloadLf = {
      assertions: [
        { subject: 'foo\nbar\nbaz', predicate: pred, object: 'qux\nquux' },
      ],
    };
    const resultMixed = validatePayload(payloadMixed, 'permissive');
    const resultLf    = validatePayload(payloadLf,    'permissive');
    assertEqual(resultMixed.ok,              resultLf.ok,              'ok must match for mixed vs LF');
    assertEqual(resultMixed.errors.length,   resultLf.errors.length,   'error count must match');
    assertEqual(resultMixed.warnings.length, resultLf.warnings.length, 'warning count must match');
  });

  // T17 — schema predicate enum matches recognizedPredicates()
  await runTest('T17: buildPayloadSchema() predicate enum matches recognizedPredicates()', () => {
    const schema = buildPayloadSchema();
    const registryList = recognizedPredicates().slice().sort();
    const schemaEnum   = (schema.properties.assertions.items.properties.predicate.enum || []).slice().sort();
    assertEqual(JSON.stringify(schemaEnum), JSON.stringify(registryList), 'schema predicate enum must equal sorted recognizedPredicates()');
  });

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  FAIL  ${f.label}: ${f.reason}`);
    }
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
