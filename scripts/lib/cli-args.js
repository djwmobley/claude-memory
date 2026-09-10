'use strict';

// ─── Total-classification CLI argument validation ────────────────────────────
//
// Incident (2026-09-07): `node scripts/handoff.js close --help` was not
// recognized as a flag by cmdClose's ad-hoc `args.includes('--json')` check.
// The unknown "--help" token was silently ignored, `useJson` stayed false,
// and cmdClose ran FOR REAL with an empty default payload — writing an
// extraction-empty close, clearing the session marker, and overwriting
// handoff.md. A write command silently ignoring an unknown argument is an
// allow-list failure mode (silent escape).
//
// Fix: every write subcommand's argv is checked here, BEFORE the subcommand
// function is ever invoked (see main() in scripts/handoff.js) and therefore
// BEFORE any DB connection or file write. Every token must classify as one
// of: a known boolean flag, a known "--flag value" flag (the value token is
// consumed without further validation — that is the subcommand's job), a
// known "--flag=value" inline flag, a declared positional, or --help/-h.
// Anything else is REJECTED with exit code 2 and zero side effects.
//
// This module intentionally does NOT validate flag *values* (e.g. "does
// --older-than look like a number") — that remains each subcommand's own
// job, unchanged. This module only answers: is this token something the
// command declares it understands at all?

// kind: 'boolean' (no value), 'value' (next token is its value, space-separated),
// 'inline' (must be written as --flag=value, single token)
const SPECS = {
  init: {
    summary: 'First-run provisioning: project identity, schema, handoff.md, seed marker.',
    flags: {
      '--seed-provider':     { kind: 'boolean', desc: 'Standalone local-embedding-provider seeding pass on an already-initialized project.' },
      '--allow-remote-embed': { kind: 'boolean', desc: 'Permit a non-local embedding provider during seeding.' },
      '-y':                  { kind: 'boolean', desc: 'Skip the confirmation prompt (alias of --yes).' },
      '--yes':                { kind: 'boolean', desc: 'Skip the confirmation prompt.' },
      '--force':              { kind: 'boolean', desc: 'Skip the confirmation prompt (alias of --yes).' },
      '--no-embeddings':      { kind: 'boolean', desc: 'Opt this project out of embedding backfill.' },
      '--clear-opt-out':      { kind: 'boolean', desc: 'Clear a previously-set embeddings opt-out.' },
      '--force-promotion':    { kind: 'boolean', desc: 'Backup and unconditionally regenerate the durable-facts promotion file (CLAUDE.md/AGENTS.md) from its template.' },
    },
    // scripts/handoff.js:4273 — `args.find((a) => !a.startsWith('-'))`: the
    // first non-flag token is an OPTIONAL project-name override (falls back
    // to path.basename(root) when absent). Order-independent relative to
    // the boolean flags above (e.g. `init myname -y` and `init -y myname`
    // both work against the real function), so this is a genuine positional,
    // not a value bound to a specific flag. scripts/handoff-mcp.mjs:366's
    // toolHandoffInit emits exactly `['init', name, '-y']` when a name is
    // given.
    positionals: { max: 1, desc: 'project name override (optional) — scripts/handoff.js:4273.' },
  },
  drop: {
    summary: 'Archive prior session memory and start fresh.',
    flags: {},
  },
  checkpoint: {
    summary: 'Mid-session save without ending the session.',
    flags: {
      '--note':        { kind: 'value',   desc: 'Write a single session_note assertion (no JSON payload required).' },
      '--json':         { kind: 'boolean', desc: 'Read a full extraction payload from stdin as JSON.' },
      '--allow-empty':  { kind: 'boolean', desc: 'Explicitly permit a checkpoint with no --note and no --json payload (writes nothing extraction-wise; opt-in only).' },
    },
    // Legacy `--json -` form: '-' is an accepted positional marker meaning
    // "read from stdin" (stdin is always where the payload comes from; the
    // dash is a conventional placeholder, not a file path).
    allowDashPositional: true,
  },
  close: {
    summary: 'End-of-session extraction: entities, assertions, edges, contract update.',
    flags: {
      '--json':         { kind: 'boolean', desc: 'Read the extraction payload from stdin as JSON.' },
      '--dry-run':       { kind: 'boolean', desc: 'Validate and print a summary; perform zero DB mutations.' },
      '--allow-empty':  { kind: 'boolean', desc: 'Explicitly permit a close with no payload / empty stdin (writes an extraction-empty close; opt-in only).' },
    },
    allowDashPositional: true,
  },
  purge: {
    summary: 'Hard delete all project memory (confirmation required).',
    flags: {
      '--yes':     { kind: 'boolean', desc: 'Skip the confirmation prompt.' },
      '--dry-run': { kind: 'boolean', desc: 'Show what would be deleted without deleting anything.' },
    },
  },
  promote: {
    summary: 'Explicitly promote (or --demote) an assertion to durable-facts (CLAUDE.md); or --regenerate the promotion file from its template.',
    flags: {
      '--demote':      { kind: 'value',   desc: 'Reverse a prior promote for assertion_id.' },
      '--subject':     { kind: 'value',   desc: 'Promote by subject (optionally narrowed by --predicate/--object).' },
      '--predicate':   { kind: 'value',   desc: 'Narrow --subject lookup by predicate.' },
      '--object':      { kind: 'value',   desc: 'Narrow --subject lookup by object.' },
      // Declared here only so the token classifies as a KNOWN promote flag —
      // this module never validates flag *combinations*. cmdPromote's own
      // total classification (scripts/handoff.js, top of cmdPromote) is what
      // rejects --regenerate combined with any of the flags above, or with a
      // positional; this gate would otherwise accept e.g. `--regenerate
      // --demote 5` as two individually-known flags.
      '--regenerate':  { kind: 'boolean', desc: 'Rewrite the promotion file from the template (no init --force-promotion DB/FS side effects). Exclusive of every other promote flag/positional except --dry-run and --project-name.' },
      '--dry-run':     { kind: 'boolean', desc: 'With --regenerate: report what would change; write nothing.' },
      // With --regenerate only: explicit project display name override, fed
      // to resolveProjectDisplayName() (scripts/lib/claude-md-key-paths.js)
      // as its N0 branch — skips the H1/worktree/basename inference chain
      // entirely. Declared here only so the token classifies as KNOWN;
      // cmdPromoteRegenerate's own combination check (scripts/handoff.js,
      // top of cmdPromote's --regenerate branch) is what actually accepts
      // it alongside --regenerate/--dry-run and rejects it everywhere else.
      '--project-name': { kind: 'value', desc: 'With --regenerate: explicit project display name override.' },
    },
    positionals: { max: 1, desc: 'assertion_id (integer) — original promote-by-id form.' },
  },
  'queue-drain': {
    summary: 'Drain pending rows from the async extraction_queue.',
    flags: {
      '--max': { kind: 'inline', desc: 'Cap the number of rows processed, e.g. --max=50.' },
    },
  },
  prune: {
    summary: 'Hard-delete suppressed rows past retention (dry-run by default; --apply to execute).',
    flags: {
      '--apply':            { kind: 'boolean', desc: 'Execute the prune (default is dry-run/report-only).' },
      '--include-pinned':   { kind: 'boolean', desc: 'Include pinned rows in the candidate set.' },
      '--suppressed':       { kind: 'boolean', desc: 'Restrict to already-suppressed rows.' },
      '--suppression-kind': { kind: 'value',   desc: 'Filter by suppression kind (superseded | downvoted_terminal | downvoted_probation | retired | reality_reconciled).' },
      '--subject':          { kind: 'value',   desc: 'Filter by subject.' },
      '--older-than':       { kind: 'value',   desc: 'Filter to rows older than N days.' },
    },
  },
  retire: {
    summary: 'Retire (suppress) an assertion by subject/predicate/object (dry-run by default; --apply to execute).',
    flags: {
      '--apply':        { kind: 'boolean', desc: 'Execute the retire (default is dry-run/report-only).' },
      // scripts/handoff.js:10124-10130 — cmdRetire checks presence via
      // `args.includes('--replace-with')` (so, from cmdRetire's own body
      // alone, this reads as boolean). BUT the real invocation
      // (scripts/test-l5-directive-retirement.js:561-563, T10) is
      // `--replace-with new-rule` -- the value token that follows is never
      // read by cmdRetire (it exits before reaching positional handling),
      // yet it is still a real token in a real invocation that this gate
      // must classify. Declaring it 'boolean' left "new-rule" unclassified
      // -> the gate rejected it as an extra positional with a GENERIC
      // "unknown argument" message, preempting cmdRetire's own specific
      // "--replace-with is not supported" error (T10 asserts stderr
      // mentions "--replace-with"). Declaring it 'value' here consumes
      // "new-rule" as this flag's value (unvalidated, per this module's
      // contract), lets the token classify successfully, and hands control
      // to cmdRetire, which then produces its own specific rejection.
      '--replace-with': { kind: 'value',   desc: 'Not supported — cmdRetire rejects with a specific error naming --replace-with (scripts/handoff.js:10124).' },
      '--subject':      { kind: 'value',   desc: 'Subject to retire (required).' },
      '--predicate':    { kind: 'value',   desc: 'Predicate to retire (required).' },
      '--object':       { kind: 'value',   desc: 'Object to retire (optional).' },
    },
  },
  'backfill-embeddings': {
    summary: 'Backfill NULL embedding vectors for assertions/entities.',
    flags: {
      '--apply':                 { kind: 'boolean', desc: 'Execute the backfill (default is dry-run/report-only).' },
      '--force-mixed-provider':  { kind: 'boolean', desc: 'Allow backfill even when rows span more than one embedding provider.' },
      '--table':                 { kind: 'inline', desc: 'Restrict to one table, e.g. --table=assertions (default: all).' },
      '--batch-size':             { kind: 'inline', desc: 'Rows per batch, e.g. --batch-size=25 (default 10).' },
      '--project-id':             { kind: 'inline', desc: 'Restrict to one project id, e.g. --project-id=<uuid>.' },
    },
  },
};

// The subset of SPECS that mutates DB/files. Every subcommand in this list
// gets the full total-classification treatment (A1). Read-only subcommands
// (status, resume, loader-load, loader-hook, loader-stop, resurrect) are not
// in SPECS above and are left to their own existing (unchanged) arg handling
// — --help/-h consistency for those is a non-mandatory nice-to-have, not
// retrofitted here to avoid regressing commands out of this task's scope.
const WRITE_SUBCOMMANDS = Object.keys(SPECS);

function printUsage(cmd) {
  const spec = SPECS[cmd];
  const lines = [`Usage: node scripts/handoff.js ${cmd} [flags]`, '', `  ${spec.summary}`, ''];
  const flagNames = Object.keys(spec.flags);
  if (flagNames.length > 0) {
    lines.push('Flags:');
    for (const name of flagNames) {
      const f = spec.flags[name];
      const shape = f.kind === 'value' ? `${name} <value>` : f.kind === 'inline' ? `${name}=<value>` : name;
      lines.push(`  ${shape.padEnd(28)} ${f.desc || ''}`);
    }
  }
  if (spec.positionals) {
    lines.push('');
    lines.push(`Positional: ${spec.positionals.desc}`);
  }
  lines.push('');
  lines.push('  --help, -h                   Show this message and exit 0 (no side effect).');
  console.log(lines.join('\n'));
}

/**
 * Total-classification check for a write subcommand's argv (the `rest`
 * array from process.argv, i.e. everything after the subcommand name).
 *
 * Every token must be one of: --help/-h, a known boolean flag, a known
 * "--flag value" flag (the following token is consumed as its value with
 * no further validation here), a known "--flag=value" inline flag, the
 * literal '-' positional IF the command declares allowDashPositional, or a
 * positional slot the command declares (spec.positionals.max).
 *
 * On --help: prints usage, exits 0, NO side effect (must be called before
 * any DB connection or file write — enforced by call-site placement in
 * main(), not by this function).
 *
 * On an unclassifiable token: prints the rejection message, exits 2, NO
 * side effect.
 *
 * Returns nothing on success (classification passed; caller proceeds to
 * invoke the subcommand). Never returns on --help or rejection (process.exit).
 */
function enforceTotalClassification(cmd, argv) {
  const spec = SPECS[cmd];
  if (!spec) return; // not a write subcommand covered by this module — no-op.

  // --help / -h short-circuits: scan for it FIRST, independent of position,
  // since it must win over any other (even malformed) argument.
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(cmd);
    process.exit(0);
  }

  const maxPositionals = spec.positionals ? spec.positionals.max : 0;
  let positionalCount = 0;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '-') {
      if (spec.allowDashPositional) continue;
      return reject(cmd, tok);
    }

    if (tok.startsWith('--') || (tok.startsWith('-') && tok !== '-')) {
      const eqIdx = tok.indexOf('=');
      const flagName = eqIdx !== -1 ? tok.slice(0, eqIdx) : tok;
      const f = spec.flags[flagName];
      if (!f) return reject(cmd, tok);

      if (f.kind === 'inline') {
        // Self-contained token; nothing further to consume. A bare
        // "--flag" with no "=" for an inline-only flag is still a known
        // flag name, so it is not rejected here — the subcommand's own
        // (unchanged) logic is responsible for requiring the value.
        continue;
      }
      if (f.kind === 'boolean') {
        if (eqIdx !== -1) return reject(cmd, tok);
        continue;
      }
      if (f.kind === 'value') {
        if (eqIdx !== -1) return reject(cmd, tok);
        i++; // consume the next token as this flag's value, unvalidated here
        continue;
      }
      continue;
    }

    // Positional token.
    positionalCount++;
    if (positionalCount > maxPositionals) return reject(cmd, tok);
  }
}

function reject(cmd, tok) {
  console.error(`unknown argument "${tok}" for ${cmd}; run "handoff.js ${cmd} --help"`);
  process.exit(2);
}

module.exports = {
  SPECS,
  WRITE_SUBCOMMANDS,
  enforceTotalClassification,
  printUsage,
};
