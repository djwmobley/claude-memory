#!/usr/bin/env node
// handoff-mcp — MCP server wrapping the claude-memory handoff engine
// (scripts/handoff.js) and the policy-framework decisions pipeline
// (dev/pipeline/scripts/upsert-decisions.js + pipeline-embed.js).
//
// Transport: stdio (one process per Claude Code session). The engine needs
// host filesystem paths (project root, ~/.claude/projects/<uuid>/handoff.md),
// real git checkouts, and localhost Postgres — all of which a host-run child
// process gets for free by inheriting the parent's cwd/env. See ADO #4566
// for the full transport rationale (containerizing would need volume mounts,
// git safe.directory entries, and Windows<->Linux path translation).
//
// Every tool spawns the target script as a child process — never imports
// engine internals — so this server tracks the engine's CLI contract, not
// its implementation details.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Ground-truth paths (verified 2026-07-11; overridable via env for other hosts) ──

const ENGINE_PATH = process.env.HANDOFF_MCP_ENGINE_PATH || path.join(__dirname, 'handoff.js');

const PIPELINE_SCRIPTS_DIR =
  process.env.HANDOFF_MCP_PIPELINE_SCRIPTS_DIR || 'C:/Users/djwmo/dev/pipeline/scripts';
const UPSERT_DECISIONS_PATH = path.join(PIPELINE_SCRIPTS_DIR, 'upsert-decisions.js');
const PIPELINE_EMBED_PATH = path.join(PIPELINE_SCRIPTS_DIR, 'pipeline-embed.js');

// The decisions pipeline resolves its target DB (claude_policy_framework) from
// <PROJECT_ROOT>/.claude/pipeline.yml — this is NOT the caller's projectRoot,
// it is always the policy-framework repo itself. See ground truth in ADO #4566.
const DECISIONS_PROJECT_ROOT =
  process.env.HANDOFF_MCP_DECISIONS_PROJECT_ROOT || 'C:/claudecode/policy-framework';

// ── Child-process runner ─────────────────────────────────────────────────────

/**
 * Spawns `node <scriptPath> ...args` with PROJECT_ROOT (and any extra env) set,
 * optionally piping `stdin` text into the child, and collects stdout/stderr.
 * Never uses shell:true (static invariant elsewhere in this repo forbids it).
 */
function runNode({ scriptPath, args, cwd, env, stdin }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: cwd || path.dirname(scriptPath),
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `spawn failed: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + `\nchild process error: ${err.message}` });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdin !== undefined) {
      child.stdin.write(stdin, 'utf8');
    }
    child.stdin.end();
  });
}

function stderrTail(stderr, n = 25) {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join('\n');
}

function writeTempJson(prefix, data) {
  const file = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function cleanupTemp(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // best-effort; leaked temp files are harmless (no secrets, OS temp dir)
  }
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── MCP result helpers ───────────────────────────────────────────────────────

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function toolError(message, { stdout, stderr } = {}) {
  let detail = message;
  if (stderr) detail += `\n\n-- stderr tail --\n${stderrTail(stderr)}`;
  if (stdout) detail += `\n\n-- stdout tail --\n${stdout.split(/\r?\n/).filter(Boolean).slice(-15).join('\n')}`;
  return { content: [{ type: 'text', text: detail }], isError: true };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `${err.message}${err.stack ? '\n' + err.stack : ''}` }], isError: true };
}

// ── Engine output parsing ────────────────────────────────────────────────────

/** Extracts the JSON object handoff.js prints (after a "Running: ..." banner
 * line and before a trailing "Done: ..." summary line) from raw stdout. */
function extractJsonBlock(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Could not locate a JSON object in engine stdout.');
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

/** Parses the "entities written: N / assertions written: N / edges written: N"
 * + "Done: handoff:<sub> — ..." summary block emitted by checkpoint/close. */
function parseWriteSummary(stdout) {
  const entities = /entities written:\s*(\d+)/.exec(stdout);
  const assertions = /assertions written:\s*(\d+)/.exec(stdout);
  const edges = /edges written:\s*(\d+)/.exec(stdout);
  const done = /Done:\s*handoff:\S+\s*—\s*(.+)/.exec(stdout);
  return {
    entitiesWritten: entities ? Number(entities[1]) : null,
    assertionsWritten: assertions ? Number(assertions[1]) : null,
    edgesWritten: edges ? Number(edges[1]) : null,
    summary: done ? done[1].trim() : null,
  };
}

/** Parses the "[OK] ..." / "[NOTE] ..." / "Done: ..." provisioning report
 * emitted by init. */
function parseInitReport(stdout) {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const report = lines.filter((l) => l.startsWith('[OK]') || l.startsWith('[NOTE]') || l.startsWith('Done:'));
  const done = /Done:\s*handoff:init\s*—\s*(.+)/.exec(stdout);
  return { report, summary: done ? done[1].trim() : null };
}

/** Parses per-row "INSERT topic="..." (new id=N)" / "UPDATE topic="..." (id=N, ...)"
 * lines from upsert-decisions.js stdout. */
function parseUpsertOutput(stdout) {
  const rows = [];
  const re = /^(INSERT|UPDATE)\s+topic="([^"]+)"\s*\((?:new id=(\d+)|id=(\d+)[^)]*)\)/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    rows.push({ op: m[1], topic: m[2], id: Number(m[3] ?? m[4]) });
  }
  return rows;
}

/** Parses the per-table "Done. <table>: N embedded, M truncated, K failed."
 * lines plus the "Total: N entries embedded across all tables." line from
 * pipeline-embed.js index output (ANSI-stripped first). */
function parseEmbedIndexOutput(stdout) {
  const clean = stripAnsi(stdout);
  const perTable = [];
  const tableRe = /Done\.\s*(\S+):\s*(\d+)\s*embedded,\s*(\d+)\s*truncated[^,]*,\s*(\d+)\s*failed\./g;
  let m;
  while ((m = tableRe.exec(clean)) !== null) {
    perTable.push({ table: m[1], embedded: Number(m[2]), truncated: Number(m[3]), failed: Number(m[4]) });
  }
  const totalMatch = /Total:\s*(\d+)\s*entries embedded/.exec(clean);
  return { perTable, totalEmbedded: totalMatch ? Number(totalMatch[1]) : null };
}

/** Parses the numbered "N. label (XX.X%)" hit lines from pipeline-embed.js
 * hybrid output (ANSI-stripped first), scoped to the "── decisions ──" table
 * section specifically. pipeline-embed.js prints a global numbering across
 * a "memory (chunked: memory + sessions + policy)" section FIRST, followed by
 * one "── <table> ──" section per table with data — a naive global top-N would
 * almost always be dominated by the much larger chunked-memory corpus and
 * never surface the decisions row a caller just wrote. Scoping to the
 * decisions section is what makes this a meaningful round-trip verification. */
function parseHybridOutput(stdout) {
  const clean = stripAnsi(stdout);
  const lines = clean.split(/\r?\n/);
  const sectionRe = /^──\s*(.+?)\s*──$/;
  const startIdx = lines.findIndex((l) => sectionRe.test(l.trim()) && /^decisions$/.test(l.trim().replace(/^──\s*/, '').replace(/\s*──$/, '')));
  if (startIdx === -1) return [];
  let endIdx = lines.findIndex((l, i) => i > startIdx && sectionRe.test(l.trim()));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx).join('\n');

  const hits = [];
  const hitRe = /^\s*(\d+)\.\s+(.+?)\s+\((\d+\.\d+)%\)\s*$/gm;
  let m;
  while ((m = hitRe.exec(section)) !== null) {
    hits.push({ rank: Number(m[1]), label: m[2].trim(), scorePct: Number(m[3]) });
  }
  return hits;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function toolHandoffStatus({ projectRoot }) {
  const { code, stdout, stderr } = await runNode({
    scriptPath: ENGINE_PATH,
    args: ['status', '--json'],
    env: { PROJECT_ROOT: projectRoot },
  });
  if (code !== 0) {
    return toolError(`handoff status exited with code ${code}`, { stdout, stderr });
  }
  let parsed;
  try {
    parsed = extractJsonBlock(stdout);
  } catch (err) {
    return toolError(`handoff status: ${err.message}`, { stdout, stderr });
  }
  return textResult(parsed);
}

async function runPayloadSubcommand(subcommand, { projectRoot, payload }) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return toolError(`payload must be a plain JSON object (not array or primitive) for handoff ${subcommand}.`);
  }

  const tempFile = writeTempJson(`handoff-mcp-${subcommand}`, payload);
  try {
    const stdinText = fs.readFileSync(tempFile, 'utf8');
    const { code, stdout, stderr } = await runNode({
      scriptPath: ENGINE_PATH,
      args: [subcommand, '--json', '-'],
      env: { PROJECT_ROOT: projectRoot },
      stdin: stdinText,
    });
    if (code !== 0) {
      return toolError(`handoff ${subcommand} exited with code ${code}`, { stdout, stderr });
    }
    const summary = parseWriteSummary(stdout);
    return textResult({ ...summary, tempFile, stdoutTail: stdout.split(/\r?\n/).filter(Boolean).slice(-10) });
  } finally {
    cleanupTemp(tempFile);
  }
}

async function toolHandoffCheckpoint(args) {
  return runPayloadSubcommand('checkpoint', args);
}

async function toolHandoffClose(args) {
  return runPayloadSubcommand('close', args);
}

async function toolHandoffInit({ projectRoot, name }) {
  const args = name ? ['init', name, '-y'] : ['init', '-y'];
  const { code, stdout, stderr } = await runNode({
    scriptPath: ENGINE_PATH,
    args,
    env: { PROJECT_ROOT: projectRoot },
  });
  const { report, summary } = parseInitReport(stdout);
  if (code !== 0) {
    return toolError(`handoff init exited with code ${code}`, { stdout, stderr });
  }
  return textResult({ success: true, summary, report });
}

const TOPIC_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

function validateDecisionRows(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push('rows must be a non-empty array.');
    return errors;
  }
  rows.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push(`rows[${i}]: must be an object.`);
      return;
    }
    if (typeof row.topic !== 'string' || !TOPIC_RE.test(row.topic)) {
      errors.push(`rows[${i}].topic: required, must be a lowercase kebab-case string with at least one hyphen (e.g. "ppm-monolith-foo"); got ${JSON.stringify(row.topic)}.`);
    }
    if (typeof row.decision !== 'string' || row.decision.trim() === '') {
      errors.push(`rows[${i}].decision: required non-empty string.`);
    }
    if (typeof row.reason !== 'string' || row.reason.trim() === '') {
      errors.push(`rows[${i}].reason: required non-empty string.`);
    }
    if (row.session_num !== undefined && row.session_num !== null && typeof row.session_num !== 'number') {
      errors.push(`rows[${i}].session_num: must be a number or null if present.`);
    }
  });
  return errors;
}

async function toolPersistDecisions({ rows, verifyQuery }) {
  const validationErrors = validateDecisionRows(rows);
  if (validationErrors.length > 0) {
    return toolError(`persist_decisions: row validation failed — no database writes were made.\n${validationErrors.join('\n')}`);
  }
  if (typeof verifyQuery !== 'string' || verifyQuery.trim() === '') {
    return toolError('persist_decisions: verifyQuery is required (non-empty string).');
  }

  const decisionsEnv = { PROJECT_ROOT: DECISIONS_PROJECT_ROOT };
  const tempFile = writeTempJson('handoff-mcp-decisions', rows);

  try {
    // Step 1 — upsert
    const upsert = await runNode({
      scriptPath: UPSERT_DECISIONS_PATH,
      args: [tempFile],
      env: decisionsEnv,
    });
    if (upsert.code !== 0) {
      return toolError('persist_decisions: upsert-decisions.js failed', upsert);
    }
    const upsertRows = parseUpsertOutput(upsert.stdout);

    // Step 2 — embed index
    const embed = await runNode({
      scriptPath: PIPELINE_EMBED_PATH,
      args: ['index'],
      env: decisionsEnv,
    });
    if (embed.code !== 0) {
      return toolError('persist_decisions: pipeline-embed.js index failed', embed);
    }
    const embedResult = parseEmbedIndexOutput(embed.stdout);

    // Step 3 — hybrid verify
    const verify = await runNode({
      scriptPath: PIPELINE_EMBED_PATH,
      args: ['hybrid', verifyQuery],
      env: decisionsEnv,
    });
    if (verify.code !== 0) {
      return toolError('persist_decisions: pipeline-embed.js hybrid failed', verify);
    }
    const hits = parseHybridOutput(verify.stdout).slice(0, 3);

    return textResult({
      upsert: upsertRows,
      embed: embedResult,
      verify: { query: verifyQuery, topHits: hits },
    });
  } finally {
    cleanupTemp(tempFile);
  }
}

// ── Shared extraction-payload contract doc (checkpoint + close) ─────────────
//
// Both handoff_checkpoint and handoff_close accept the SAME extraction payload
// shape. This text is the MCP-path substitute for reading commands/handoff/
// close.md by hand — a caller on the MCP path never opens that file, so the
// full contract (field types, caveman authoring mandate, probe-able volatile
// predicates) has to live here, in the tool description itself. Keep this in
// sync with commands/handoff/close.md and the stdin validator in
// scripts/handoff.js (readStdin(): ALLOWED_KEYS / STRING_FIELDS).
const EXTRACTION_PAYLOAD_FIELD_CONTRACT =
  'Allowed top-level payload keys: tldr, open_threads, quick_references, entities, assertions, edges, ' +
  'decisions, contract, session_id, confirm_claude_md_promotion, retrieval_outcome, retrieval_outcome_notes, ' +
  'resolved_threads.\n\n' +
  'Field types (engine-enforced; a violation surfaces as a tool error with the engine\'s stderr tail):\n' +
  '- tldr: string, <=4000 chars.\n' +
  '- open_threads: array of strings, each <=4000 chars, array length <=200.\n' +
  '- quick_references: a SINGLE STRING, NOT an array. Sending an array fails with ' +
  '`stdin JSON: "quick_references" must be a string` — join multiple references into one string.\n' +
  '- entities: array of { name: string, entity_type: "person"|"system"|"concept"|"decision"|"file", description: string }.\n' +
  '- assertions: array of { subject: string, predicate: string (MUST be a value from ' +
  'scripts/lib/predicate-registry.json — do not invent one; unknown predicates are flagged (permissive mode) ' +
  'or rejected (strict mode)), object: string, confidence: integer 1-10, source: "user_stated"|"model_extracted"|' +
  '"doc_quoted"|"retrieved_from_prior" }.\n' +
  '- edges: array of { from_entity: string, edge_type: "depends_on"|"implements"|"blocks"|"owns"|"calls"|"produces", ' +
  'to_entity: string }.\n' +
  '- contract: { queries: [...] } — a next-session retrieval contract; supported query types are entity/assertion/' +
  'recency/vector (see commands/handoff/close.md §4 for the exact shape of each).\n\n' +
  'Caveman/telegraphic authoring is MANDATORY for tldr, open_threads, and quick_references: strip function words ' +
  '(a/an/the, is/are/was/were, of/to/in/for/and/or/but, with/that/this/it/as/at/on/by/be) while keeping every ' +
  'load-bearing token verbatim — identifiers, file paths, line refs, PR numbers, commit SHAs, names, numbers, ' +
  'decisions. All three are persisted verbatim as queryable Postgres rows (session_tldr/open_thread/quick_reference) ' +
  '— the engine does not compress them, so leaner authoring directly reduces next-resume bootstrap tokens.\n\n' +
  'Volatile now-state facts (anything whose truth may change between sessions) should be authored with a predicate ' +
  'that has a mode:\'verify\' entry in scripts/lib/reality-checks.js, so the next resume\'s reality re-probe can ' +
  'verify and annotate them automatically: `in_file` (object = file path — checks existence on disk), ' +
  '`branch_exists` (subject = branch name, object = "exists"), `commit_merged` (object = "<sha>" or ' +
  '"<sha> on <branch>"), `pr_state` (object = "open"|"closed"|"merged", subject must contain the PR number). Do NOT ' +
  'use these predicates for historical then-state — use is_at_commit/shipped_at/is_status for that instead.';

// ── Server wiring ────────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: 'handoff-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.registerTool(
    'handoff_status',
    {
      title: 'Read-only handoff project memory status',
      description:
        'Runs `handoff.js status --json` for the given project and returns the parsed result: project_id, ' +
        'entity/assertion/edge counts, handoff.md path, last_close/days_since, contracts, session_active, ' +
        'session_id, and packaging state (e.g. "UNPACKAGED (dirty working tree)" or "clean"). Read-only — makes no writes.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root (the directory containing .claude-memory / .git).'),
      },
    },
    async (args) => {
      try {
        return await toolHandoffStatus(args);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'handoff_checkpoint',
    {
      title: 'Mid-session handoff checkpoint (full extraction payload)',
      description:
        'Writes a mid-session extraction payload to the handoff store WITHOUT ending the session. Payload is ' +
        'validated to be a plain JSON object, written to a temp file, and piped to `handoff.js checkpoint --json -`. ' +
        'Checkpoint payloads MAY be partial — there is no completeness bar here (contrast with handoff_close, which ' +
        'is single-pass and MUST carry the full extraction). Use a checkpoint at a natural decision point in a long ' +
        'session; the session stays open.\n\n' +
        EXTRACTION_PAYLOAD_FIELD_CONTRACT +
        '\n\nReturns entitiesWritten/assertionsWritten/edgesWritten and the engine summary line.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        payload: z.record(z.string(), z.any()).describe('Extraction payload object — see description for allowed keys and field types.'),
      },
    },
    async (args) => {
      try {
        return await toolHandoffCheckpoint(args);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'handoff_close',
    {
      title: 'End-of-session handoff close (full extraction payload — SINGLE-PASS, must be complete)',
      description:
        'Ends the session: clears the session_in_progress marker, runs close-time reality reconciliation, and ' +
        'archives handoff.md. Payload is validated to be a plain JSON object, written to a temp file, and piped ' +
        'to `handoff.js close --json -`.\n\n' +
        '**CLOSE IS SINGLE-PASS.** Author the COMPLETE extraction — entities, assertions, edges, contract, and the ' +
        'caveman-authored tldr/open_threads/quick_references — in ONE call. An intent-only close (no entities, no ' +
        'assertions, no edges) is INCOMPLETE: the engine still writes the intent rows and reports success, but it ' +
        'now also prints a non-fatal "WARNING: extraction-empty close" line in the close output, because the close ' +
        'contract was not met. Never plan a supplementary second close to backfill a thin first one — if this call ' +
        'is about to omit entities/assertions/edges, that is the signal to go re-read the conversation and extract ' +
        'them now, not to close thin and patch later.\n\n' +
        EXTRACTION_PAYLOAD_FIELD_CONTRACT +
        '\n\n`has_unpackaged_state` is CODE-OWNED: `handoff.js` computes it authoritatively at close time via a ' +
        'live git probe. If the payload includes a `has_unpackaged_state` assertion, it is silently discarded and ' +
        'replaced by the code-computed value — do not author one.\n\n' +
        'Returns entitiesWritten/assertionsWritten/edgesWritten and the engine summary line. `--dry-run` has no ' +
        'dedicated parameter here yet — use the CLI form (commands/handoff/close.md) for a preview-only pass.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        payload: z.record(z.string(), z.any()).describe(
          'COMPLETE extraction payload object — same field shapes as handoff_checkpoint, but close is single-pass: ' +
          'entities/assertions/edges should be populated in this one call, not deferred to a follow-up close.'
        ),
      },
    },
    async (args) => {
      try {
        return await toolHandoffClose(args);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'handoff_init',
    {
      title: 'First-run handoff provisioning for a project',
      description:
        'Runs `handoff.js init [name] -y` for the given project root: applies schema migrations, ensures ' +
        'project_settings defaults, creates handoff.md and CLAUDE.md if absent, and mints the .claude-memory ' +
        'marker. Always passes -y (non-interactive bypass) since this runs over a non-TTY stdio pipe. Safe to ' +
        're-run — idempotent. Returns the structured [OK]/[NOTE] provisioning report lines and the summary line.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root to provision.'),
        name: z.string().optional().describe('Optional human-readable project name (defaults to the directory basename).'),
      },
    },
    async (args) => {
      try {
        return await toolHandoffInit(args);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'persist_decisions',
    {
      title: 'Persist and embed roadmap decisions to the policy-framework decisions table',
      description:
        'Upserts rows into the `decisions` table in the claude_policy_framework database (by topic), then runs ' +
        'the embedding index pass, then runs a hybrid (FTS + vector) search with verifyQuery to confirm the rows ' +
        'are retrievable. This is a SEPARATE store from the handoff engine — used for durable cross-session ' +
        'roadmap/architecture decisions (topics like "ppm-monolith-*"). Each row requires: topic (lowercase ' +
        'kebab-case with at least one hyphen, e.g. "ppm-monolith-handoff-mcp-decision"), decision (non-empty ' +
        'string), reason (non-empty string), and optional session_num. Rows are validated BEFORE any database ' +
        'writes — if any row fails validation, the whole call is rejected with no writes made. Returns per-row ' +
        'INSERT/UPDATE ids, embed counts per table, and the top-3 hybrid-search hits with scores for verifyQuery.',
      inputSchema: {
        rows: z
          .array(
            z.object({
              topic: z.string(),
              decision: z.string(),
              reason: z.string(),
              session_num: z.number().nullable().optional(),
            })
          )
          .describe('Rows to upsert into the decisions table, keyed by topic.'),
        verifyQuery: z.string().describe('Query text to run through hybrid search after embedding, to confirm the rows are retrievable.'),
      },
    },
    async (args) => {
      try {
        return await toolPersistDecisions(args);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('handoff-mcp: fatal error:', err);
  process.exit(1);
});
