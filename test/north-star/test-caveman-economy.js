'use strict';

/**
 * test-caveman-economy.js — North-star suite: CAVEMAN MODE DOGFOODING HARNESS.
 *
 * Defends the caveman/telegraphic authoring standard for close payloads.
 *
 * Caveman mode: prose persisted to the memory DB (tldr, open_threads,
 * quick_references) is authored telegraphically — function words stripped
 * (articles, copulas, most prepositions/conjunctions), every load-bearing token
 * kept (identifiers, file paths, line refs, PR numbers, commit SHAs, decisions,
 * names, numbers). Goal: minimize bootstrap tokens with zero load-bearing loss.
 * The engine stores prose verbatim (no engine-side compression).
 *
 * This harness is a GREEN regression guard (not a RED-by-design TDD spec). It
 * uses the real close→resume subprocess round-trip (runClose + runResume) to
 * prove three invariants that must hold on every commit:
 *
 *   ARM 1 — ECONOMY: caveman resume token count < verbose resume token count,
 *     both at the true bootstrap (trueServedTokens) and at the intent channel
 *     (### Assertions section alone), with a clear, documented margin.
 *
 *   ARM 2 — FIDELITY / NO-REGRESSION: every load-bearing token that surfaces in
 *     the verbose resume also surfaces in the caveman resume. Leaner cannot be
 *     bought with lost fidelity. Both verbose and caveman must surface ALL tokens
 *     in LOAD_BEARING (apples-to-apples sanity + regression guard).
 *
 *   ARM 3 — FUNCTION-WORD DENSITY: the caveman intent section has a measurably
 *     lower function-word ratio than the verbose intent section. Directly proves
 *     telegraphic compression.
 *
 * Fixtures (test/north-star/fixtures/):
 *   caveman-payload.json  — telegraphic prose; identical load-bearing tokens.
 *   verbose-payload.json  — full grammatical sentences; same load-bearing tokens.
 *
 * CommonJS, US English. namespace 'caveman'. No vLLM required.
 * Exit codes (via H.run): 0 all-pass, 1 any failure, 2 infrastructure error.
 */

const assert = require('assert');
const H      = require('./lib/ns-harness.js');

// ── LOAD-BEARING TOKEN MANIFEST ───────────────────────────────────────────────
//
// Tokens that MUST appear verbatim in BOTH fixture payloads and MUST surface in
// BOTH resumes (verbose AND caveman). Adding a token here tightens the fidelity
// contract: the caveman fixture must preserve it telegraphically, and the engine
// must surface it through the close→resume round-trip.
//
// These are realistic tokens from the caveman-payload / verbose-payload fixtures.
const LOAD_BEARING = [
  'PR #93',
  'bb3e8c2',
  'scripts/lib/reality-checks.js',
  'runVerifyDispatch',
  'trueServedTokens',
  'halfvec(4000)',
  'handoff.js:3030',
  'vector(1024)',
  'fix_schema_then_embed',
  'circuit-breaker',
  'north-star inversion',
  'smoketest depends',
];

// ── FUNCTION-WORD STOPLIST ────────────────────────────────────────────────────
//
// Common English function words stripped in caveman mode. Used to compute
// function-word ratio on served intent lines. Not exhaustive — a representative
// set sufficient to distinguish grammatical prose from telegraphic prose.
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'for', 'and', 'or', 'but',
  'with', 'that', 'this', 'it', 'as', 'at', 'on', 'by',
  'we', 'he', 'she', 'they', 'i',
  'have', 'has', 'had', 'do', 'does', 'did',
  'not', 'no', 'if', 'so', 'its', 'our',
  'from', 'also', 'about', 'after', 'where', 'which', 'who',
  'there', 'when', 'than', 'into', 'up',
]);

// ── LOCAL HELPERS ─────────────────────────────────────────────────────────────

/**
 * Extract the "### Assertions" block text from a resume stdout — the decay-ranked
 * PG-sourced section. Returns '' if absent. Mirrors the assertionLines approach in
 * test-retrieval-economy.js but returns the raw section text rather than split
 * lines, so token-count and word-count computations work on the full block.
 */
function assertionSectionText(stdout) {
  const text = String(stdout || '');
  const idx  = text.indexOf('### Assertions');
  if (idx < 0) return '';
  const after = text.slice(idx + '### Assertions'.length);
  const lines  = [];
  for (const raw of after.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('### ') || line.startsWith('=== ')) break;
    lines.push(raw);
  }
  return lines.join('\n');
}

/**
 * Tokenize text into lower-case word tokens (split on non-alphanumeric, keep
 * tokens of length >= 1). Used for function-word density calculation only.
 */
function wordTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Compute function-word ratio: functionWords / totalWords. Returns 0 if empty.
 */
function functionWordRatio(text) {
  const words = wordTokens(text);
  if (words.length === 0) return 0;
  const fw = words.filter((w) => FUNCTION_WORDS.has(w)).length;
  return fw / words.length;
}

// ── TESTS ─────────────────────────────────────────────────────────────────────

H.run(async () => {
  // PREFLIGHT — must pass on a healthy box; failure here is infra (exit 2).
  const pf = await H.preflight({ needVllm: false });
  if (pf.skip) {
    console.log(`SKIP — ${pf.reason}`);
    process.exit(0);
  }
  console.log('preflight OK — DB reachable, schemas applied.');

  // ── ARM 1 — ECONOMY ──────────────────────────────────────────────────────────
  //
  // Close the verbose payload into one project, the caveman payload into another.
  // Resume each. Assert:
  //   (A) caveman trueServedTokens < verbose trueServedTokens (true bootstrap cost).
  //   (B) caveman ### Assertions section token count < verbose by a clear margin
  //       (intent-channel isolated proof, robust to OPERATING_CANON dilution).
  await H.test(
    'ARM1 economy: caveman resume has fewer tokens than verbose (true bootstrap + intent channel)',
    async () => {
      const verbose = await H.setupNs({ namespace: 'caveman-v' });
      const caveman = await H.setupNs({ namespace: 'caveman-c' });
      try {
        const verboseFixture = H.loadFixture('verbose-payload');
        const cavemanFixture = H.loadFixture('caveman-payload');

        H.runClose(verbose.fakeRoot, verboseFixture);
        H.runClose(caveman.fakeRoot, cavemanFixture);

        const verboseOut = H.runResume(verbose.fakeRoot);
        const cavemanOut = H.runResume(caveman.fakeRoot);

        // (A) True bootstrap token cost.
        const verboseTokens = H.parseTokensUsed(verboseOut);
        const cavemanTokens = H.parseTokensUsed(cavemanOut);

        assert.notStrictEqual(verboseTokens, null,
          'ARM1(A): verbose resume must report a "tokens used: ~N" line');
        assert.notStrictEqual(cavemanTokens, null,
          'ARM1(A): caveman resume must report a "tokens used: ~N" line');

        console.log(
          `  ARM1(A) trueServedTokens — verbose: ~${verboseTokens}, ` +
          `caveman: ~${cavemanTokens}, ` +
          `saving: ${verboseTokens - cavemanTokens} (~${
            verboseTokens > 0
              ? Math.round((verboseTokens - cavemanTokens) / verboseTokens * 100)
              : 0
          }%)`
        );

        assert.ok(
          cavemanTokens < verboseTokens,
          `ARM1(A): caveman trueServedTokens (~${cavemanTokens}) must be strictly ` +
          `less than verbose (~${verboseTokens}) — caveman mode must reduce bootstrap ` +
          `token cost (north-star (2): lean decay-ranked resume).`
        );

        // (B) Intent-channel isolation — ### Assertions section.
        const verboseSection = assertionSectionText(verboseOut);
        const cavemanSection = assertionSectionText(cavemanOut);

        const verboseSectionTokens = H.estimateTokens(verboseSection);
        const cavemanSectionTokens = H.estimateTokens(cavemanSection);

        console.log(
          `  ARM1(B) ### Assertions section — verbose: ~${verboseSectionTokens}, ` +
          `caveman: ~${cavemanSectionTokens}, ` +
          `saving: ${verboseSectionTokens - cavemanSectionTokens}`
        );

        // Minimum absolute saving of 20 tokens on the intent section alone.
        // This is the robust margin: the verbose fixture has ~10 full-sentence open
        // threads; the caveman fixture strips most function words, so the saving
        // on the intent rows (object strings stored verbatim in PG) must be clear.
        const INTENT_SECTION_MIN_SAVING = 20;

        assert.ok(
          cavemanSectionTokens < verboseSectionTokens,
          `ARM1(B): caveman ### Assertions section tokens (~${cavemanSectionTokens}) ` +
          `must be strictly less than verbose (~${verboseSectionTokens}) — telegraphic ` +
          `open-thread objects must be shorter in PG storage than grammatical prose.`
        );

        assert.ok(
          verboseSectionTokens - cavemanSectionTokens >= INTENT_SECTION_MIN_SAVING,
          `ARM1(B): caveman intent section saving must be >= ${INTENT_SECTION_MIN_SAVING} ` +
          `tokens (got ${verboseSectionTokens - cavemanSectionTokens}) — the margin must ` +
          `be robust and non-flaky, not a single-token rounding artifact.`
        );
      } finally {
        try { await verbose.db.end(); } catch (_) {}
        try { await caveman.db.end(); } catch (_) {}
        await verbose.cleanup();
        await caveman.cleanup();
      }
    }
  );

  // ── ARM 2 — FIDELITY / NO-REGRESSION ────────────────────────────────────────
  //
  // Every token in LOAD_BEARING that surfaces in the verbose resume MUST also
  // surface in the caveman resume. Assert verbose surfaces them all (sanity) AND
  // caveman surfaces them all (regression guard). Leaner cannot be bought with
  // lost fidelity.
  await H.test(
    'ARM2 fidelity: every load-bearing token surfaces in caveman resume (no regression vs verbose)',
    async () => {
      const verbose = await H.setupNs({ namespace: 'caveman-fv' });
      const caveman = await H.setupNs({ namespace: 'caveman-fc' });
      try {
        const verboseFixture = H.loadFixture('verbose-payload');
        const cavemanFixture = H.loadFixture('caveman-payload');

        H.runClose(verbose.fakeRoot, verboseFixture);
        H.runClose(caveman.fakeRoot, cavemanFixture);

        const verboseOut = H.runResume(verbose.fakeRoot);
        const cavemanOut = H.runResume(caveman.fakeRoot);

        // Sanity: verbose must surface all load-bearing tokens.
        H.assertSurfaced(
          verboseOut,
          LOAD_BEARING,
          'ARM2 sanity: verbose resume must surface all load-bearing tokens (apples-to-apples baseline)'
        );

        // Regression guard: caveman must also surface all load-bearing tokens.
        H.assertSurfaced(
          cavemanOut,
          LOAD_BEARING,
          'ARM2 regression: caveman resume must surface all load-bearing tokens — ' +
          'caveman mode must drop NO load-bearing token that verbose keeps ' +
          '(north-star (1): lossless fidelity)'
        );
      } finally {
        try { await verbose.db.end(); } catch (_) {}
        try { await caveman.db.end(); } catch (_) {}
        await verbose.cleanup();
        await caveman.cleanup();
      }
    }
  );

  // ── ARM 3 — FUNCTION-WORD DENSITY ────────────────────────────────────────────
  //
  // Compute function-word ratio (FW / total words) of the served intent lines
  // (### Assertions section) for caveman vs verbose. Assert caveman density is
  // measurably lower. Directly proves telegraphic compression in the served output.
  await H.test(
    'ARM3 function-word density: caveman intent section has measurably lower function-word ratio',
    async () => {
      const verbose = await H.setupNs({ namespace: 'caveman-dv' });
      const caveman = await H.setupNs({ namespace: 'caveman-dc' });
      try {
        const verboseFixture = H.loadFixture('verbose-payload');
        const cavemanFixture = H.loadFixture('caveman-payload');

        H.runClose(verbose.fakeRoot, verboseFixture);
        H.runClose(caveman.fakeRoot, cavemanFixture);

        const verboseOut = H.runResume(verbose.fakeRoot);
        const cavemanOut = H.runResume(caveman.fakeRoot);

        const verboseSection = assertionSectionText(verboseOut);
        const cavemanSection = assertionSectionText(cavemanOut);

        const verboseRatio = functionWordRatio(verboseSection);
        const cavemanRatio = functionWordRatio(cavemanSection);

        console.log(
          `  ARM3 FW density — verbose: ${(verboseRatio * 100).toFixed(1)}%, ` +
          `caveman: ${(cavemanRatio * 100).toFixed(1)}%, ` +
          `delta: ${((verboseRatio - cavemanRatio) * 100).toFixed(1)}pp`
        );

        // The caveman intent section must have a strictly lower function-word ratio.
        assert.ok(
          cavemanRatio < verboseRatio,
          `ARM3: caveman FW ratio (${(cavemanRatio * 100).toFixed(1)}%) must be ` +
          `strictly lower than verbose (${(verboseRatio * 100).toFixed(1)}%) — ` +
          `telegraphic authoring must produce fewer function words in the served output.`
        );

        // Minimum delta of 3 percentage points — robust, non-flaky margin.
        // Full-sentence prose typically has FW ratio ~30-45%; telegraphic text ~15-25%.
        const MIN_DELTA_PP = 0.03; // 3 percentage points
        assert.ok(
          verboseRatio - cavemanRatio >= MIN_DELTA_PP,
          `ARM3: FW ratio delta must be >= ${(MIN_DELTA_PP * 100).toFixed(0)}pp ` +
          `(got ${((verboseRatio - cavemanRatio) * 100).toFixed(1)}pp) — the margin ` +
          `must be robust enough to detect function-word regression, not a rounding artifact.`
        );
      } finally {
        try { await verbose.db.end(); } catch (_) {}
        try { await caveman.db.end(); } catch (_) {}
        await verbose.cleanup();
        await caveman.cleanup();
      }
    }
  );
});
