'use strict';

/**
 * test-source-file-normalize.js -- Tests scripts/lib/source-file-normalize.js
 * (CONSOLIDATION-RUNBOOK.md section 6.1(d) amendment D3-2/D3-10, memory-manager#11(d)).
 *
 * Pure unit tests for normalize() (no DB required) plus a live-Postgres
 * cross-check that sqlExpr() produces the byte-identical result to
 * normalize() for the same input -- the property D3-2 depends on ("used
 * BOTH by the map-builder and the SQL-side matching", never two
 * independently-drifting implementations).
 *
 * Usage: node scripts/test-source-file-normalize.js
 * Exit 0 = all pass; nonzero = any failure.
 */

const { normalize, sqlExpr } = require('./lib/source-file-normalize');

let passed = 0;
let failed = 0;

function pass(id, label) { console.log(`[${id}] ${label} ... PASS`); passed++; }
function fail(id, label, reason) { console.log(`[${id}] ${label} ... FAIL: ${reason}`); failed++; }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function run(id, label, fn) {
  try {
    await fn();
    pass(id, label);
  } catch (err) {
    fail(id, label, err && err.message ? err.message : String(err));
  }
}

async function main() {
  // -- Pure unit tests -----------------------------------------------------

  await run('T1', 'backslash separator normalizes to the same key as forward-slash (D3-2 regression)', () => {
    assertEqual(normalize('memory\\FOO.md'), normalize('memory/FOO.md'), 'backslash vs forward-slash');
    assertEqual(normalize('memory\\FOO.md'), 'foo.md', 'expected canonical form');
  });

  await run('T2', 'optional memory/ prefix canonicalized (present vs absent fold to same key)', () => {
    assertEqual(normalize('memory/FOO.md'), normalize('FOO.md'), 'prefixed vs bare');
  });

  await run('T3', 'case-fold', () => {
    assertEqual(normalize('MEMORY/Foo.MD'), normalize('memory/foo.md'), 'case-insensitive fold');
  });

  await run('T4', 'Unicode NFC normalization', () => {
    // Built from explicit code points, deliberately never a source-literal
    // accented glyph (which a tool in this chain could silently
    // re-normalize on save and defeat the point of the fixture):
    // "e-acute" as a single precomposed codepoint (U+00E9) vs "e"
    // (U+0065) followed by a combining acute accent (U+0301) -- two
    // byte-distinct representations of the same visible glyph that must
    // fold to the identical normalized key.
    const precomposed = 'memory/caf' + String.fromCodePoint(0x00e9) + '.md';
    const decomposed = 'memory/caf' + String.fromCodePoint(0x0065, 0x0301) + '.md';
    if (precomposed === decomposed) throw new Error('test fixture bug: the two forms must be byte-distinct before normalization');
    assertEqual(normalize(precomposed), normalize(decomposed), 'NFC-equivalent forms fold to same key');
  });

  await run('T5', 'leading slash stripped defensively', () => {
    assertEqual(normalize('/memory/foo.md'), normalize('memory/foo.md'), 'leading slash');
  });

  await run('T6', 'duplicate slashes collapsed', () => {
    assertEqual(normalize('memory//foo.md'), normalize('memory/foo.md'), 'duplicate slash collapse');
  });

  await run('T7', 'leading/trailing whitespace trimmed', () => {
    assertEqual(normalize('  memory/foo.md  '), normalize('memory/foo.md'), 'whitespace trim');
  });

  await run('T8', 'null/undefined total-classified to null (never thrown)', () => {
    assertEqual(normalize(null), null, 'null input');
    assertEqual(normalize(undefined), null, 'undefined input');
  });

  await run('T9', 'non-string input throws TypeError (caller bug surfaced loudly)', () => {
    let threw = false;
    try { normalize(42); } catch (err) { threw = err instanceof TypeError; }
    if (!threw) throw new Error('expected a TypeError for numeric input');
  });

  await run('T10', 'a bare filename with no memory/ prefix and no path separators normalizes to itself, case-folded', () => {
    assertEqual(normalize('MEMORY.md'), 'memory.md', 'bare MEMORY.md');
  });

  await run('T11', 'distinct files remain distinct after normalization (non-collapsing sanity check)', () => {
    const a = normalize('memory/alpha.md');
    const b = normalize('memory/beta.md');
    if (a === b) throw new Error('two genuinely different files must not normalize to the same key');
  });

  await run('T12', 'sqlExpr rejects an empty colExpr', () => {
    let threw = false;
    try { sqlExpr(''); } catch (err) { threw = err instanceof TypeError; }
    if (!threw) throw new Error('expected a TypeError for an empty colExpr');
  });

  // -- Live-Postgres cross-check: sqlExpr() === normalize() ----------------
  // Skips gracefully if Postgres is unreachable (this file has no other DB
  // dependency; the cross-check is best-effort verification, not a hard
  // requirement for the pure-unit tests above to be meaningful).
  let pgAvailable = true;
  let Client;
  try {
    Client = require('pg').Client;
  } catch (_) {
    pgAvailable = false;
  }

  if (pgAvailable) {
    const client = new Client({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: 'postgres',
    });
    try {
      await client.connect();
    } catch (err) {
      pgAvailable = false;
      console.log(`[SKIP] Postgres unreachable (${err.message}) -- sqlExpr() cross-check skipped; pure-unit tests above still gate.`);
    }
    if (pgAvailable) {
      const accented = 'memory/caf' + String.fromCodePoint(0x00e9) + '.md';
      const fixtures = [
        'memory\\FOO.md', 'FOO.md', '/memory/Bar.MD', 'memory//baz.md',
        '  memory\\qux.md  ', null, 'MEMORY/mixed\\Case.md', accented, '',
      ];
      await run('T13', 'sqlExpr() produces the byte-identical result to normalize() for every fixture (live Postgres)', async () => {
        const expr = sqlExpr('$1::text');
        for (const f of fixtures) {
          const jsVal = normalize(f);
          const { rows } = await client.query(`SELECT ${expr} AS v`, [f]);
          const sqlVal = rows[0].v;
          if (jsVal !== sqlVal && !(jsVal === null && sqlVal === null)) {
            throw new Error(`mismatch for input ${JSON.stringify(f)}: js=${JSON.stringify(jsVal)} sql=${JSON.stringify(sqlVal)}`);
          }
        }
      });
      await client.end();
    }
  } else {
    console.log('[SKIP] pg module unavailable -- sqlExpr() cross-check skipped.');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
