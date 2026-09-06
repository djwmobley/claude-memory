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
import { createRequire } from 'node:module';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── §8 direct-pg tool libraries (CommonJS — loaded via createRequire since
// this server is ESM). Every new §8 tool below shares ONE connection-
// resolution path (mcp-db-connect.js) and ONE project-identity-resolution
// path (project-identity.js's ensureProjectIdentity, M-19) — no tool below
// implements its own DB connection or project_id lookup. ──────────────────
const require = createRequire(import.meta.url);
const { connectForRoot } = require('./lib/mcp-db-connect.js');
const { ensureProjectIdentity } = require('./lib/project-identity.js');
// cm#224 (decisions canon fix): the SAME ensureSchemaCurrent handoff.js itself
// calls from cmdLoaderLoad/cmdClose/cmdInit — never a second implementation.
// Requiring handoff.js here does NOT run its CLI router: handoff.js's own
// `if (require.main === module)` guard is false when it is require()'d
// (CJS, via createRequire) from this ESM server process, so only its
// module.exports object is evaluated — verified empirically (see the PR
// body for the probe transcript).
const { ensureSchemaCurrent } = require('./handoff.js');
const memoryUpsertLib = require('./lib/memory-upsert.js');
const memorySearchLib = require('./lib/memory-search.js');
const entityCrudLib = require('./lib/entity-graph-crud.js');
const memoryViewLib = require('./lib/memory-view.js');
const memoryLintLib = require('./lib/memory-lint.js');
const exchangeLogLib = require('./lib/exchange-log.js');
const routeResolveLib = require('./lib/route-resolve.js');
const routingProfileLib = require('./lib/routing-profile.js');
const routingWriteSurfaceLib = require('./lib/routing-write-surface.js');
const usageTelemetryLib = require('./lib/usage-telemetry.js');
const { writeRowWithProvenanceRetry } = require('./lib/write-time-embed.js');
// cm#230: validateDecisionRows/persistDecisionRow moved to decisions-writer.js
// so scripts/handoff.js's writeExtraction (payload.decisions[] from a close/
// checkpoint stdin payload) can share the SAME write path — never a second
// implementation of decisions-row validation or the embed+upsert chain.
const decisionsWriterLib = require('./lib/decisions-writer.js');

// ── Ground-truth paths (verified 2026-07-11; overridable via env for other hosts) ──

const ENGINE_PATH = process.env.HANDOFF_MCP_ENGINE_PATH || path.join(__dirname, 'handoff.js');

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

// ── §8 direct-pg tool plumbing ───────────────────────────────────────────
//
// withProjectDb: the ONE call site every new §8 tool below uses to (a)
// connect (mcp-db-connect.js:connectForRoot, root-parameterized — safe for
// a long-lived server handling different projectRoots across calls, unlike
// mutating process.env.PROJECT_ROOT) and (b) resolve project_id via
// ensureProjectIdentity (M-19 — "the SAME ensureProjectIdentity library
// path handoff.js uses ... no duplicate resolution implementation").
// ensureProjectIdentity is migration-capable (not a pure read) — a
// projectRoot with legacy-encoded rows and no marker yet will run the
// one-shot identity migration inline, exactly as handoff.js's own
// cmdLoaderLoad/cmdClose do. Always closes the connection in `finally`.
async function withProjectDb(projectRoot, fn) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new Error('projectRoot is required and must be a non-empty string');
  }
  const db = await connectForRoot(projectRoot);
  try {
    const identity = await ensureProjectIdentity(db, { cwd: projectRoot, silent: true });
    // cm#224: bring the schema forward for MCP-only sessions on pre-existing
    // project DBs — before this fix, an MCP client that never runs `handoff.js
    // init`/`resume` on this projectRoot could hit an every-§8-tool DB whose
    // schema was fingerprinted current at an OLDER epoch (e.g. missing
    // `decisions`/`audit_log`/the decisions_audit trigger canonized by this
    // same fix) and every §8 tool touching it would 42P01 with no actionable
    // remedy. ensureSchemaCurrent has NO interactive confirmation gate of its
    // own (that gate is cmdInit's DB-*creation* prompt only — see handoff.js's
    // "Confirmation gate — BEFORE any DDL" comment) and never throws by
    // contract (every failure path returns {applied:false, reason, detail}),
    // so this call always attempts the additive apply. The total behavior:
    //   - reason 'current' or applied:true  -> proceed silently (the common case).
    //   - reason 'degraded' (cm#224 follow-up, PR #225 independent review
    //     finding) -> a pgvector-gated column/index (e.g. decisions.embedding,
    //     assertions.embedding) was silently skipped at apply time -- the
    //     REST of the schema is fine, so this is allowed to PROCEED (a tool
    //     that never touches a gated column must not be blocked by an
    //     unrelated degradation) but schemaResult.detail is attached to the
    //     tool's own error below whenever it later fails specifically on a
    //     gated column, so the MCP caller sees the full degradation record,
    //     not just a bare error.
    //   - anything else (manifest_error, classification_error, ahead, unknown,
    //     lock_acquire_failed, apply_failed, integrity_index_failed,
    //     verification_failed) -> FAIL LOUD here, never silently skip. This is
    //     a deliberate divergence from cmdLoaderLoad/cmdClose's own non-fatal
    //     stderr-only swallow of the same call (documented in docs/mcp-tools.md)
    //     — an MCP caller has no stderr to read and no interactive prompt to
    //     answer, so surfacing the degradation as a hard tool error with an
    //     actionable remedy is strictly better than deferring to a more
    //     confusing SQL-layer failure inside the tool's own write.
    const schemaResult = await ensureSchemaCurrent(db, identity.projectId, { silent: true });
    if (!schemaResult.applied && schemaResult.reason !== 'current' && schemaResult.reason !== 'degraded') {
      throw new Error(
        `withProjectDb: schema is not current for this project DB and the automatic bring-forward did ` +
        `not succeed (reason: ${schemaResult.reason}` +
        `${schemaResult.detail ? `, detail: ${JSON.stringify(schemaResult.detail)}` : ''}). ` +
        `Remedy: run \`node scripts/handoff.js init\` (or \`resume\`) directly against this project root ` +
        `in an interactive terminal to resolve the degraded state, then retry this MCP tool call.`
      );
    }
    try {
      return await fn(db, identity.projectId);
    } catch (toolErr) {
      // cm#224 follow-up: only attach when this specific call was degraded
      // AND the tool's own failure is actually a gated-column failure (our
      // named EmbeddingColumnAbsentError, or a raw 42703 that slipped past
      // some future path not yet routed through classifyEmbeddingWriteError)
      // — never stamp an unrelated tool error with a degradation record
      // that has nothing to do with it.
      if (schemaResult.reason === 'degraded' && toolErr &&
          (toolErr.name === 'EmbeddingColumnAbsentError' || toolErr.code === '42703') &&
          !toolErr.schemaApplyDegraded) {
        toolErr.schemaApplyDegraded = schemaResult.detail;
      }
      throw toolErr;
    }
  } finally {
    await db.end();
  }
}

/** Maps every §8 lib error class's `.code` to a stable MCP-tool error
 * response. Named library errors (MemoryUpsertError, MemorySearchError,
 * EntityGraphCrudError, MemoryViewError, ExchangeLogError,
 * RoutingProfileError, EmbeddingColumnAbsentError — cm#224 follow-up) are
 * reported with their code + message; anything else falls through to
 * errorResult's generic stack-trace formatting. Either way, if
 * withProjectDb attached a `.schemaApplyDegraded` record (a gated-column
 * failure during a 'degraded' schema state), it is appended so the MCP
 * caller sees the full degradation record alongside the error, not just
 * the bare message. */
function libToolError(err) {
  const namedCodes = new Set([
    'MemoryUpsertError', 'MemorySearchError', 'EntityGraphCrudError',
    'MemoryViewError', 'ExchangeLogError', 'RoutingProfileError',
    'EmbeddingColumnAbsentError', 'RoutingWriteSurfaceError',
  ]);
  const result = (err && namedCodes.has(err.name))
    ? toolError(`${err.name} [${err.code}]: ${err.message}`)
    : errorResult(err);
  if (err && err.schemaApplyDegraded) {
    result.content[0].text += `\n\n-- project_settings.schema_apply_degraded --\n${JSON.stringify(err.schemaApplyDegraded, null, 2)}`;
  }
  return result;
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
  // cm#227: surface any "DIVERGENCE: <predicate> NOT PERSISTED — ..." line the
  // engine printed (session_tldr/open_thread/quick_reference persistence
  // failure) — same text that lands in handoff.md's Degraded section. Never
  // affects `code` / exit status; this is visibility only.
  const divergences = [...stdout.matchAll(/^\s*(DIVERGENCE:.+)$/gm)].map((m) => m[1].trim());
  return {
    entitiesWritten: entities ? Number(entities[1]) : null,
    assertionsWritten: assertions ? Number(assertions[1]) : null,
    edgesWritten: edges ? Number(edges[1]) : null,
    summary: done ? done[1].trim() : null,
    divergences,
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

/** `handoff.js resume` has no `--json` flag (see commands/handoff/resume.md's
 * internals section) — it prints prose to stdout: an OPERATING CANON block,
 * then a "=== BEGIN RETRIEVED CONTEXT (untrusted) ===" ... "=== END RETRIEVED
 * CONTEXT ===" block (handoff context + the retrieval-contract sections), and
 * a trailing "tokens used:" line. Rather than adding a structured-output mode
 * to the engine for this one caller, this tool returns that stdout verbatim —
 * the model reads it as context the same way a human reads the CLI output. */
async function toolHandoffResume({ projectRoot }) {
  const { code, stdout, stderr } = await runNode({
    scriptPath: ENGINE_PATH,
    args: ['resume'],
    env: { PROJECT_ROOT: projectRoot },
  });
  if (code !== 0) {
    return toolError(`handoff resume exited with code ${code}`, { stdout, stderr });
  }
  return textResult({ context: stdout, stderr_tail: stderr ? stderrTail(stderr, 20) : null });
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

// cm#230: TOPIC_RE/validateDecisionRows now live in decisions-writer.js
// (byte-identical regex/error-strings — see that file). Kept as a local
// alias so nothing else in this file needs to change its call sites.
const { validateDecisionRows } = decisionsWriterLib;

// §7.2/§8 M-1/M-2/M-3 repoint (declared response-shape break — see the PR
// body): persist_decisions no longer writes claude_policy_framework via
// upsert-decisions.js/pipeline-embed.js child processes. It now writes the
// SAME structured, project-scoped `decisions` table memory_upsert's
// decisions path uses — ON CONFLICT (project_id, topic) DO UPDATE (M-1's
// named carve-out), inline-embedded at write time (M-2, fail-soft). The
// TOPIC_RE kebab-case contract is UNCHANGED (M-3) — retained at the tool
// layer via validateDecisionRows below, unmodified. NEW REQUIRED PARAMETER:
// `projectRoot` — the old flow had no notion of project scoping (it always
// targeted the single policy-framework repo's DB); the new `decisions`
// table is project-scoped like every other table in this schema, so a
// caller must now say which project's decisions it is writing.
async function toolPersistDecisions({ projectRoot, rows, verifyQuery }) {
  const validationErrors = validateDecisionRows(rows);
  if (validationErrors.length > 0) {
    return toolError(`persist_decisions: row validation failed — no database writes were made.\n${validationErrors.join('\n')}`);
  }

  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const written = [];
      const warnings = [];
      // cm#230: persistDecisionRow is the SAME write function
      // scripts/handoff.js's writeExtraction now calls for payload.decisions[]
      // — moved out of this loop body verbatim, byte-identical behavior.
      for (const row of rows) {
        const { written: written_row, warning } = await decisionsWriterLib.persistDecisionRow(db, projectId, row);
        if (warning) warnings.push({ topic: row.topic, warning });
        written.push(written_row);
      }

      let topHits = null;
      if (typeof verifyQuery === 'string' && verifyQuery.trim()) {
        const search = await memorySearchLib.memorySearch(db, { projectId, query: verifyQuery, tables: ['decisions'], limit: 3 });
        topHits = search.hits;
      }

      return textResult({ projectId, written, embedWarnings: warnings, verify: verifyQuery ? { query: verifyQuery, topHits } : null });
    });
  } catch (err) {
    return libToolError(err);
  }
}

// ── §8 direct-pg tool implementations ────────────────────────────────────

async function toolMemorySearch({ projectRoot, query, tables, limit }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await memorySearchLib.memorySearch(db, { projectId, query, tables, limit });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolMemoryUpsert({ projectRoot, table, row }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rowWithProject = { ...row, project_id: projectId };
      const embedText = memoryUpsertLib.buildEmbedText(table, rowWithProject);
      const writeFn = (opts) => table === 'decisions'
        ? memoryUpsertLib.upsertDecisionRow(db, rowWithProject, opts)
        : memoryUpsertLib.writeMemoryRow(db, table, rowWithProject, opts);
      // cm#201: threads providerId alongside the vector (both-or-neither)
      // and classifies a race-window FK 23503 on embedded_by_provider_id
      // (re-resolve once, retry; degrade to neither on persistent failure).
      const { written, warning } = await writeRowWithProvenanceRetry(db, embedText, writeFn);
      return textResult({ row: written, embedWarning: warning });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolMemoryGet({ projectRoot, table, key }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await memoryUpsertLib.memoryGet(db, table, projectId, key);
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolMemoryLint({ projectRoot, checks }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const report = await memoryLintLib.memoryLint(db, projectId, checks);
      return textResult(report);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolMemoryViewSet({ projectRoot, name, queries }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await memoryViewLib.memoryViewSet(db, { projectId, name, queries });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolMemoryViewRun({ projectRoot, name }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await memoryViewLib.memoryViewRun(db, { projectId, name });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEntityCreate({ projectRoot, name, entityType, description, sourceModel, agentId }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await entityCrudLib.entityCreate(db, { projectId, name, entityType, description, sourceModel, agentId });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEntityRead({ projectRoot, id, name }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await entityCrudLib.entityRead(db, { projectId, id, name });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEntityUpdate({ projectRoot, id, entityType, description }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.entityUpdate(db, { projectId, id, entityType, description });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEntitySuppress({ projectRoot, id }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.entitySuppress(db, { projectId, id });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolAssertionCreate({ projectRoot, subject, predicate, object, confidence, source, sourceModel, agentId, sessionId }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await entityCrudLib.assertionCreate(db, { projectId, subject, predicate, object, confidence, source, sourceModel, agentId, sessionId });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolAssertionRead({ projectRoot, id, subject, predicate }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await entityCrudLib.assertionRead(db, { projectId, id, subject, predicate });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolAssertionUpdate({ projectRoot, id, subject, predicate, newObject, confidence, source, sourceModel, agentId, sessionId }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await entityCrudLib.assertionUpdate(db, { projectId, id, subject, predicate, newObject, confidence, source, sourceModel, agentId, sessionId });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolAssertionSuppress({ projectRoot, id }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.assertionSuppress(db, { projectId, id });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEdgeCreate({ projectRoot, fromEntity, edgeType, toEntity, weight, sourceModel, agentId }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.edgeCreate(db, { projectId, fromEntity, edgeType, toEntity, weight, sourceModel, agentId });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEdgeRead({ projectRoot, id, fromEntity, toEntity }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await entityCrudLib.edgeRead(db, { projectId, id, fromEntity, toEntity });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEdgeUpdate({ projectRoot, id, edgeType, weight }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.edgeUpdate(db, { projectId, id, edgeType, weight });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolEdgeSuppress({ projectRoot, id }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const row = await entityCrudLib.edgeSuppress(db, { projectId, id });
      return textResult(row);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolExchangeAppend({ projectRoot, agentId, kind, body, summary, sourceModel, toAgent, docketId, parentId, transition }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await exchangeLogLib.appendExchange(db, {
        projectId, agentId, kind, body, summary, sourceModel, toAgent, docketId, parentId, transition,
      });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolExchangeRead({ projectRoot, toAgent, afterCreatedAt, afterId, limit }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await exchangeLogLib.exchangeRead(db, { projectId, toAgent, afterCreatedAt, afterId, limit });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

// §8 M-10: route_resolve replay on an existing (project_id, session_id,
// turn_idx, role) key with a DIFFERENT override_model than recorded returns
// the recorded row UNCHANGED plus override_ignored:true + the ignored
// value — never silently, never an error. Implemented at the tool layer
// (not inside route-resolve.js itself): routeResolve's own replay branch
// already returns `replayed:true` + the RECORDED model regardless of what
// overrideModel this call passed — this wrapper simply compares the two and
// annotates the response, without touching route-resolve.js's proven
// idempotency/race-handling logic.
async function toolRouteResolve({ projectRoot, sessionId, turnIdx, role, capabilityTier, overrideModel }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await routeResolveLib.routeResolve(db, {
        projectId, sessionId, turnIdx, role, capabilityTier, overrideModel,
      });
      const overrideIgnored = Boolean(
        result.replayed && overrideModel !== undefined && overrideModel !== null && result.model !== overrideModel
      );
      return textResult({
        ...result,
        ...(overrideIgnored ? { override_ignored: true, ignored_override_model: overrideModel } : {}),
      });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolRoutingProfileSet({ projectRoot, role, capabilityTier, preferredModel, preferredProvider, sourceModel, agentId, notes }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await routingProfileLib.routingProfileSet(db, {
        projectId, role, capabilityTier, preferredModel, preferredProvider, sourceModel, agentId, notes,
      });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolRoutingProfileGet({ projectRoot, role }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await routingProfileLib.routingProfileGet(db, { projectId, role });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

// §17 B1: model_registry_set / routing_session_override_set / _get / _clear
// — see scripts/lib/routing-write-surface.js for the total-classification
// tables and F-1..F-11 adversary-finding dispositions. projectRoot resolves
// projectId via withProjectDb exactly like every other §8/§17 tool above;
// model_registry_set still requires projectRoot (to get a DB connection)
// even though model_registry itself carries no project_id column — see
// routing-write-surface.js's header for why a project_id filter must never
// be added to that table by analogy with the session-override table below.

async function toolModelRegistrySet(args) {
  const { projectRoot, ...rest } = args;
  try {
    return await withProjectDb(projectRoot, async (db) => {
      const result = await routingWriteSurfaceLib.modelRegistrySet(db, rest);
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolRoutingSessionOverrideSet({ projectRoot, sessionId, role, label, provider, setBy }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await routingWriteSurfaceLib.routingSessionOverrideSet(db, {
        projectId, sessionId, role, label, provider, setBy,
      });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolRoutingSessionOverrideGet({ projectRoot, sessionId, role }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await routingWriteSurfaceLib.routingSessionOverrideGet(db, { projectId, sessionId, role });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolRoutingSessionOverrideClear({ projectRoot, sessionId, role }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await routingWriteSurfaceLib.routingSessionOverrideClear(db, { projectId, sessionId, role });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolUsageRecord(args) {
  const { projectRoot, sessionId, turnIdx, agentRole, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costUsd, modelId, provider, outcome, sourceModel, agentId } = args;
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const result = await usageTelemetryLib.usageRecord(db, {
        projectId, sessionId, turnIdx, agentRole, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens,
        costUsd, modelId, provider, outcome, sourceModel, agentId,
      });
      return textResult(result);
    });
  } catch (err) {
    return libToolError(err);
  }
}

async function toolUsageQuery({ projectRoot, sessionId, groupBy, granularity }) {
  try {
    return await withProjectDb(projectRoot, async (db, projectId) => {
      const rows = await usageTelemetryLib.usageQuery(db, { projectId, sessionId, groupBy, granularity });
      return textResult({ rows });
    });
  } catch (err) {
    return libToolError(err);
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
  'recency/vector (see commands/handoff/close.md §5 for the exact shape of each).\n' +
  '- decisions: array of { topic: string (REQUIRED, lowercase kebab-case with >=1 hyphen, e.g. "vllm-embedding-default", ' +
  '<=2000 bytes UTF-8), decision: string (REQUIRED, non-empty), reason: string (REQUIRED, non-empty), ' +
  'session_num: number (optional) }, array length <=200. cm#230: persisted through the SAME write path the ' +
  'standalone persist_decisions tool uses — ON CONFLICT (project_id, topic) DO UPDATE (re-closing with the same ' +
  'topic UPDATES that row, never a duplicate), inline-embedded at write time (fail-soft: a down embedding provider ' +
  'never blocks the write — the row is still persisted with embedding=NULL, surfaced as a non-fatal ' +
  '`DIVERGENCE: decision:<topic> EMBEDDING DEGRADED` line). A row that fails validation (bad topic shape, missing ' +
  'decision/reason) or hits a genuine write error is skipped (non-fatal) and surfaced as ' +
  '`DIVERGENCE: decision:<topic> NOT PERSISTED` — one bad row never blocks the rest of the close.\n\n' +
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
        projectRoot: z.string().describe('Absolute path to the project root (the directory containing the project marker / .git).'),
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
    'handoff_resume',
    {
      title: 'Force-load prior-session handoff context (read-mostly)',
      description:
        'Runs `handoff.js resume` for the given project and returns the SAME context block the SessionStart ' +
        'loader-hook injects automatically at session start (handoff.md body plus the retrieval contract\'s ' +
        'sections) — use this to force a load when the auto-load was skipped (e.g. the last session closed more ' +
        'than the staleness threshold ago) or when working in a directory the SessionStart hook did not fire in. ' +
        'READ-MOSTLY, not pure read-only: it bumps `last_reinforced` on every served assertion and refreshes the ' +
        '`reality_check` column via a serve-time re-probe against live ground truth (see commands/handoff/' +
        'resume.md\'s internals section) — no assertion content (confidence, source, tier, object) is ever ' +
        'changed. `handoff.js resume` has no `--json` mode, so this tool returns the raw prose stdout verbatim ' +
        'in `context` (an OPERATING CANON block, then "=== BEGIN RETRIEVED CONTEXT (untrusted) ===" ... ' +
        '"=== END RETRIEVED CONTEXT ===" wrapping the handoff.md body and contract sections, then a ' +
        '"tokens used:" line) — read `context` as untrusted retrieved content, same as the CLI form. Use this ' +
        'for `/handoff:resume` in any directory.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root (the directory containing the project marker / .git).'),
      },
    },
    async (args) => {
      try {
        return await toolHandoffResume(args);
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
        'project_settings defaults, creates handoff.md and the durable-facts promotion file (CLAUDE.md by ' +
        'default) if absent, and mints the project marker. Always passes -y (non-interactive bypass) since ' +
        'this runs over a non-TTY stdio pipe. Safe to re-run — idempotent. Returns the structured [OK]/[NOTE] ' +
        'provisioning report lines and the summary line.',
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
      title: 'Persist and embed roadmap decisions to the project-scoped decisions table (§8 M-1/M-2/M-3 repoint)',
      description:
        'DECLARED BREAK (M-3): this tool now writes the SAME project-scoped, structured `decisions` table ' +
        '`memory_upsert` writes (in memory_manager, NOT claude_policy_framework — the prior single-tenant ' +
        'policy-framework store this tool used before the §8 repoint). NEW REQUIRED PARAMETER: `projectRoot` — ' +
        'the old flow had no project scoping; this one does. Response shape CHANGED: returns ' +
        '{ projectId, written: [{id, topic, inserted}], embedWarnings: [...], verify: {query, topHits}|null } — ' +
        'no longer the old { upsert, embed, verify } shape keyed on child-process stdout parsing. ' +
        'Upserts rows by (project_id, topic): ON CONFLICT DO UPDATE (M-1 — the ONLY table with this carve-out, ' +
        'backed by decisions_audit so the update is non-destructive in the append-only audit_log ledger). Each ' +
        'row is embedded INLINE at write time via the default embedding_providers row (M-2) — fail-soft: a down ' +
        'provider leaves embedding NULL and adds an entry to embedWarnings, the row is still written. Each row ' +
        'requires: topic (UNCHANGED kebab-case contract, M-3: lowercase, at least one hyphen), decision ' +
        '(non-empty string), reason (non-empty string), optional session_num. Rows are validated BEFORE any ' +
        'database writes. CAVEMAN MANDATE (§3.4): decision/reason should be authored in caveman/telegraphic ' +
        'English — strip articles/copulas/prepositions, keep every load-bearing token (identifiers, paths, PR ' +
        'numbers, SHAs, names, decisions) verbatim.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root whose decisions table this writes.'),
        rows: z
          .array(
            z.object({
              topic: z.string(),
              decision: z.string(),
              reason: z.string(),
              session_num: z.number().nullable().optional(),
            })
          )
          .describe('Rows to upsert into the decisions table, keyed by (project_id, topic).'),
        verifyQuery: z.string().optional().describe('Optional query text to run through memory_search (decisions table only) after writing, to confirm the rows are retrievable.'),
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

  // ── §8: memory_search / memory_upsert / memory_get ──────────────────────

  server.registerTool(
    'memory_search',
    {
      title: 'Hybrid vector+FTS search across the generalized memory store, project-scoped',
      description:
        'Runs the §10.3 hybrid scoring formula (ts_rank * 0.3 + cosine * 0.7, per-table — a table with no ' +
        'fts_vec column contributes a structurally-zero FTS term, never a NULL) against a project-scoped CLOSED ' +
        'enum of tables: assertions, agent_exchange, decisions, gotchas, findings, research, incidents, ' +
        'code_index, tasks, checklist_items, corpus_files, workflow_discovery, agent_rewrites, policy_sections, ' +
        'session_chunks (M-14). memory_entry_chunks is DELIBERATELY EXCLUDED — its embedding column is a ' +
        'different pgvector type/dimension (vector(1024), a legacy provider) incompatible with every other ' +
        'table\'s halfvec(4000) column. An unknown table name is a hard tool error. `tables` omitted searches ' +
        'ALL 15 allowed tables. Returns the top `limit` hits (default 10) merged and re-sorted across every ' +
        'searched table.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        query: z.string().describe('Free-text query.'),
        tables: z.array(z.enum(memorySearchLib.ALLOWED_TABLES)).optional().describe('Subset of the closed table enum to search; omitted = search all.'),
        limit: z.number().int().positive().optional().describe('Max hits to return (default 10).'),
      },
    },
    async (args) => toolMemorySearch(args)
  );

  server.registerTool(
    'memory_upsert',
    {
      title: 'Typed, project-scoped write to one §5.3 seam table (including decisions\' M-1 ON CONFLICT carve-out)',
      description:
        memoryUpsertLib.MEMORY_UPSERT_TOOL_DESCRIPTION +
        '\n\nWrite semantics: INSERT-ONLY for every table EXCEPT `decisions`, which uses ON CONFLICT ' +
        '(project_id, topic) DO UPDATE (M-1 — the ONLY table with this carve-out; every other table\'s PK/unique ' +
        'collision is a loud tool error, never a silent overwrite). Every row is embedded INLINE at write time ' +
        '(M-2, fail-soft — a down provider leaves embedding NULL + a returned warning, the row is still written).',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        table: z.enum(memoryUpsertLib.ALLOWED_TABLES).describe('Closed table enum — see description.'),
        row: z.record(z.string(), z.any()).describe('Column values for the row (project_id is filled in automatically from projectRoot — do not pass it).'),
      },
    },
    async (args) => toolMemoryUpsert(args)
  );

  server.registerTool(
    'memory_get',
    {
      title: 'Direct lookup by table + natural key',
      description:
        'Looks up rows in one §5.3 seam table by an explicit {column: value} key (e.g. `decisions` by ' +
        '{topic: "..."}, `findings` by {id: "..."}). Every table also accepts {id: <n>} as an implicit lookup ' +
        'key even where `id` is server-generated (absent from memory_upsert\'s writable column set). Unknown ' +
        'table or unknown lookup column is a hard tool error.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        table: z.enum(memoryUpsertLib.ALLOWED_TABLES).describe('Closed table enum.'),
        key: z.record(z.string(), z.any()).describe('Natural-key {column: value} pairs to look up by.'),
      },
    },
    async (args) => toolMemoryGet(args)
  );

  server.registerTool(
    'memory_lint',
    {
      title: 'Read-only, periodic store-wide health sweep (§7.8)',
      description:
        'Runs one or more of the four §7.8 checks (orphan_entities, contradicting_assertions, ' +
        'stale_unreconciled, unlinked_mentions) against the project. Read-only — never mutates. `checks` ' +
        'omitted runs all four; an unrecognized check name is a hard error.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        checks: z.array(z.enum(memoryLintLib.ALL_CHECKS)).optional().describe('Subset of checks to run; omitted = all four.'),
      },
    },
    async (args) => toolMemoryLint(args)
  );

  // ── §8: memory_view_set / memory_view_run (M-15/M-16) ──────────────────

  server.registerTool(
    'memory_view_set',
    {
      title: 'Create or update a saved retrieval view (retrieval_contract kind=\'view\')',
      description:
        'Saves a named, reusable set of structured §4 query-type queries (entity/assertion/recency/vector) for ' +
        'later execution via memory_view_run. Guards against a cross-kind name collision — refuses to silently ' +
        'convert an existing kind=\'contract\' row (a next-session retrieval contract) into a view, or vice ' +
        'versa. Versioned: an update to an existing view increments its version, never mutates queries in place ' +
        'without a version bump.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        name: z.string().describe('View name, unique within the project.'),
        queries: z.array(z.record(z.string(), z.any())).describe('Array of structured §4 query objects (type: entity|assertion|recency|vector).'),
      },
    },
    async (args) => toolMemoryViewSet(args)
  );

  server.registerTool(
    'memory_view_run',
    {
      title: 'Execute a saved retrieval view',
      description:
        'Executes a saved view\'s queries and returns structured JSON results, one entry per saved query. M-16: ' +
        'interprets ONLY the structured §4 query-type JSON (entity/assertion/recency/vector) — NEVER raw SQL. ' +
        'An unsupported query type saved in a view (should not happen — memoryViewSet validates at save time) ' +
        'or a missing/wrong-kind view name is a hard tool error.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        name: z.string().describe('View name to execute.'),
      },
    },
    async (args) => toolMemoryViewRun(args)
  );

  // ── §8: entity/assertion/edge CRUD ──────────────────────────────────────

  server.registerTool(
    'entity_create',
    {
      title: 'Create an entity, with near-match surfacing and suppressed-row revival',
      description:
        'M-12/M-13: ALWAYS runs an exact normalizeForCompare-equal check first, PLUS a trigram fuzzy pass ' +
        '(similarity >= 0.4) — candidates shorter than 4 characters after normalization get the exact check ' +
        'ONLY (flood guard). Every query is explicitly project-scoped. Near-matches are returned as WARNINGS, ' +
        'NEVER auto-merged. M-4: if an exact-normalized match exists among SUPPRESSED rows, this un-suppresses ' +
        'and updates that row (revival) instead of inserting a second row.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        name: z.string().describe('Entity name.'),
        entityType: z.string().describe('Entity type (free text, e.g. "system", "concept", "file").'),
        description: z.string().optional(),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
      },
    },
    async (args) => toolEntityCreate(args)
  );

  server.registerTool(
    'entity_read',
    {
      title: 'Read entities by id or name',
      description: 'Looks up entity rows by id and/or name, project-scoped. Either id or name is required.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().optional(),
        name: z.string().optional(),
      },
    },
    async (args) => toolEntityRead(args)
  );

  server.registerTool(
    'entity_update',
    {
      title: 'Update an entity in place',
      description: 'Plain in-place UPDATE of entity_type/description (entities have no bi-temporal design — see scripts/lib/entity-graph-crud.js\'s header comment). Forensically visible via the entities_audit trigger.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().describe('Target entity id.'),
        entityType: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async (args) => toolEntityUpdate(args)
  );

  server.registerTool(
    'entity_suppress',
    {
      title: 'Suppress (retract) an entity',
      description: 'Sets suppressed=true. Non-destructive — a later entity_create with the same normalized name revives it (M-4).',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().describe('Target entity id.'),
      },
    },
    async (args) => toolEntitySuppress(args)
  );

  server.registerTool(
    'assertion_create',
    {
      title: 'Create one assertion, outside the checkpoint/close batch flow',
      description:
        'Runs the §7.3 ingest-time contradiction check (same (project_id, subject, predicate) with a ' +
        'materially different object) before writing, and the result carries a contradictionWarning when a ' +
        'conflict is found — but the write itself (cm#231) now routes through the SAME supersession engine ' +
        '(writeAssertionWithSupersession) the /handoff:close and /handoff:checkpoint payload path uses: a prior ' +
        'live row for the same (subject, predicate) [1:1 predicates] or an exact (subject, predicate, object) ' +
        'duplicate [1:N predicates] is superseded (suppressed=true, invalid_at=now(), suppression_kind=' +
        '\'superseded\') rather than left live alongside a second row, and an exact same-session repeat is a ' +
        'no-op touch (last_reinforced bumped only — see the touchOnly field on the result). tier, valid_at, ' +
        'session_id, and last_reinforced are set with the same defaults the close/seed path uses (cm#231 — ' +
        'previously tier and valid_at were left NULL on this path). predicate MUST be a value from ' +
        'scripts/lib/predicate-registry.json.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        subject: z.string(),
        predicate: z.string(),
        // cm#227: same 4000-char cap as the checkpoint/close payload schema's
        // tldr/object fields — a bare INSERT via this tool bypasses readStdin's
        // structural caps entirely, so this is the only gate on this path.
        object: z.string().max(4000, 'object exceeds max length (4000 chars)'),
        confidence: z.number().int().min(1).max(10),
        source: z.enum(['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior']),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
        sessionId: z.string().optional().describe(
          'cm#231: explicit session id for attribution/corroboration matching. Defaults to ' +
          'handoff.js\'s own resolveSessionId (CLAUDE_CODE_SESSION_ID env var, then the DB\'s ' +
          'session_in_progress marker) when omitted.'
        ),
      },
    },
    async (args) => toolAssertionCreate(args)
  );

  server.registerTool(
    'assertion_read',
    {
      title: 'Read live assertions by id, subject, and/or predicate',
      description: 'Returns live (suppressed=false, invalid_at IS NULL) assertion rows matching the given filters, project-scoped.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().optional(),
        subject: z.string().optional(),
        predicate: z.string().optional(),
      },
    },
    async (args) => toolAssertionRead(args)
  );

  server.registerTool(
    'assertion_update',
    {
      title: 'Supersede an assertion (suppress-old + insert-new, one transaction, optimistic guard)',
      description:
        'M-5/M-6: supersede = suppress the old row (suppressed=true, invalid_at=now(), suppression_kind=' +
        '\'superseded\') THEN insert a new row with the corrected object, inside ONE transaction with an ' +
        'optimistic row-count guard (a stale/already-superseded target rolls the whole call back, never a ' +
        'partial write). `id` is the explicit target row — REQUIRED for any predicate whose registry ' +
        'cardinality is NOT 1:1 (an omitted id on a 1:N or unregistered predicate is a hard error, never a ' +
        'guess). For a 1:1 predicate, `id` may be omitted and is inferred from (subject, predicate). cm#231: ' +
        'the new row is written with tier=\'probationary\' (never auto-consolidated — this call has no cross-' +
        'session corroboration evidence to gate on), valid_at=now(), and session_id resolved the same way ' +
        'assertion_create does — previously all three were left unset/NULL on this path.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().optional().describe('Explicit target row id — required for non-1:1 predicates.'),
        subject: z.string().optional().describe('Used to infer the target id for a 1:1 predicate when id is omitted.'),
        predicate: z.string(),
        // cm#227: same 4000-char cap as assertion_create's object field.
        newObject: z.string().max(4000, 'newObject exceeds max length (4000 chars)'),
        confidence: z.number().int().min(1).max(10).optional(),
        source: z.enum(['user_stated', 'model_extracted', 'doc_quoted', 'retrieved_from_prior']).optional(),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
        sessionId: z.string().optional().describe(
          'cm#231: explicit session id for the new row. Defaults to handoff.js\'s own resolveSessionId ' +
          '(CLAUDE_CODE_SESSION_ID env var, then the DB\'s session_in_progress marker) when omitted.'
        ),
      },
    },
    async (args) => toolAssertionUpdate(args)
  );

  server.registerTool(
    'assertion_suppress',
    {
      title: 'Suppress an assertion (retract, no supersession)',
      description: 'Sets suppressed=true, invalid_at=now(), suppression_kind=\'retired\' (cm#231 — matches the ' +
        'seed/close path\'s own operator-retirement vocabulary) without inserting a replacement — use ' +
        'assertion_update to supersede-with-a-correction instead.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().describe('Target assertion id.'),
      },
    },
    async (args) => toolAssertionSuppress(args)
  );

  server.registerTool(
    'edge_create',
    {
      title: 'Create an edge between two entities',
      description: 'Plain INSERT (edges have no dedup/near-match surfacing — that is an entity-only concept, §5.1).',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        fromEntity: z.string(),
        edgeType: z.string(),
        toEntity: z.string(),
        weight: z.number().optional(),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
      },
    },
    async (args) => toolEdgeCreate(args)
  );

  server.registerTool(
    'edge_read',
    {
      title: 'Read live edges by id, from_entity, and/or to_entity',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().optional(),
        fromEntity: z.string().optional(),
        toEntity: z.string().optional(),
      },
    },
    async (args) => toolEdgeRead(args)
  );

  server.registerTool(
    'edge_update',
    {
      title: 'Update an edge in place',
      description: 'Plain in-place UPDATE of edge_type/weight (no bi-temporal design — same posture as entity_update). Forensically visible via the edges_audit trigger.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().describe('Target edge id.'),
        edgeType: z.string().optional(),
        weight: z.number().optional(),
      },
    },
    async (args) => toolEdgeUpdate(args)
  );

  server.registerTool(
    'edge_suppress',
    {
      title: 'Suppress (retract) an edge',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        id: z.number().int().describe('Target edge id.'),
      },
    },
    async (args) => toolEdgeSuppress(args)
  );

  // ── §8: exchange_append / exchange_read (A2A bus) ───────────────────────

  server.registerTool(
    'exchange_append',
    {
      title: 'Append one row to the append-only agent_exchange A2A log',
      description: exchangeLogLib.EXCHANGE_APPEND_TOOL_DESCRIPTION,
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        agentId: z.string().describe('Author identity — the SAME free-text string stamped as source_model/agent_id elsewhere.'),
        kind: z.string().describe('Speech-act hint (e.g. proposal|response|opinion|ruling|observation|research|handoff) — OPEN vocabulary, extend by convention, never a closed enum.'),
        body: z.string().describe('Full caveman-English reasoning text.'),
        summary: z.string().describe('Short digest, DISTINCT from body — this is what gets embedded, not the full body.'),
        sourceModel: z.string().optional(),
        toAgent: z.string().optional().describe('Omitted/null = broadcast.'),
        docketId: z.number().int().optional(),
        parentId: z.number().int().optional().describe('Thread linkage — id of the message being replied to/acked.'),
        transition: z.object({
          table: z.literal('tasks'),
          id: z.number().int(),
          fromStatus: z.string(),
          toStatus: z.string(),
        }).optional().describe('Optional ONE guarded atomic state transition in the SAME transaction as the append.'),
      },
    },
    async (args) => toolExchangeAppend(args)
  );

  server.registerTool(
    'exchange_read',
    {
      title: 'Poll the append-only agent_exchange A2A log via a compound watermark',
      description:
        'WHERE project_id=$1 AND (to_agent=$2 OR to_agent IS NULL) AND (created_at, id) > (afterCreatedAt, ' +
        'afterId) — a WATERMARK, not a status flag (append-only design has no status column). M-8: ' +
        'afterCreatedAt omitted = explicit no-floor branch (returns everything, not zero rows). M-9: the ' +
        'watermark is COMPOUND (created_at, id) so same-millisecond rows are never lost; afterId is REQUIRED ' +
        'whenever afterCreatedAt is given.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        toAgent: z.string().optional().describe('Poll this agent\'s inbox (messages addressed to it, plus broadcasts). Omitted = broadcasts only.'),
        afterCreatedAt: z.string().optional().describe('Watermark timestamp (ISO-8601). Omitted = no floor (M-8).'),
        afterId: z.number().int().optional().describe('Watermark id — REQUIRED when afterCreatedAt is given (M-9).'),
        limit: z.number().int().positive().optional().describe('Default 50.'),
      },
    },
    async (args) => toolExchangeRead(args)
  );

  // ── §8/§17: route_resolve / routing_profile_set / routing_profile_get ───

  server.registerTool(
    'route_resolve',
    {
      title: 'Resolve a model-routing decision (idempotent per turn)',
      description:
        'Resolves per §17\'s precedence ladder: explicit directive > session override > routing_profiles pin > ' +
        'cost-aware recommendation. Idempotent: a second call for the SAME (project_id, session_id, turn_idx, ' +
        'role) key returns the recorded row unchanged, never re-resolving. M-10: a replay called with a ' +
        'DIFFERENT override_model than what was recorded returns the recorded row PLUS ' +
        'override_ignored:true and ignored_override_model — never silently, never an error.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string(),
        turnIdx: z.number().int().min(0),
        role: z.string(),
        capabilityTier: z.enum(routeResolveLib.VALID_TIERS).optional(),
        overrideModel: z.string().optional(),
      },
    },
    async (args) => toolRouteResolve(args)
  );

  server.registerTool(
    'routing_profile_set',
    {
      title: 'Set a versioned routing profile pin for (project_id, role)',
      description:
        'M-18: ONE transaction — a transaction-scoped advisory lock keyed on (project_id, role) serializes ' +
        'concurrent calls (see scripts/lib/routing-profile.js\'s header comment for why this deviates from the ' +
        'runbook\'s literal "SELECT MAX(version) ... FOR UPDATE" pseudocode, which is not valid Postgres SQL) ' +
        '-> deactivate the current active row -> insert a NEW versioned active row. Never mutates an existing ' +
        'row\'s tier/model in place.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        role: z.string(),
        capabilityTier: z.enum(routingProfileLib.VALID_TIERS),
        preferredModel: z.string().optional(),
        preferredProvider: z.string().optional(),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => toolRoutingProfileSet(args)
  );

  server.registerTool(
    'routing_profile_get',
    {
      title: 'Get active routing profile(s) for a project',
      description: '`role` omitted returns every active profile for the project.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        role: z.string().optional(),
      },
    },
    async (args) => toolRoutingProfileGet(args)
  );

  // ── §17 B1: model_registry_set / routing_session_override_set / _get / _clear ──
  // See scripts/lib/routing-write-surface.js for full total-classification
  // tables. All four keys (label/role/session_id/project_id) are normalized
  // via scripts/lib/routing-identity.js identically to route-resolve.js's
  // read sites (F-1) — a value written through these tools is guaranteed
  // findable by route_resolve.

  server.registerTool(
    'model_registry_set',
    {
      title: 'Register or update a model in model_registry (upsert on label)',
      description:
        'Upserts on normalized label (trim+NFC+internal-whitespace-collapse). Every field besides label is ' +
        'optional and "sticky": omitted = leave the existing value untouched (or DB default on first insert), ' +
        'explicit null = clear it, a real value = set it. Re-pointing an existing non-NULL modelId to a ' +
        'different value is rejected unless force:true (the prior value is not preserved anywhere once ' +
        'overwritten). A modelId already used by a different label is rejected unless force:true (route_resolve ' +
        'joins on label only, so aliasing two labels to one modelId lets them be priced/tiered independently). ' +
        'Cost fields reuse usage-telemetry.js\'s finite/non-negative validation plus this table\'s own tighter ' +
        'NUMERIC(10,4) range. A model with partial cost data stays out of route_resolve\'s least-cost pool but ' +
        'remains directive-selectable (session override / profile pin / overrideModel). configuredBy is an ' +
        'optional caller-supplied string, nullable, never derived — no server-side agent identity exists in ' +
        'this MCP surface to draw one from.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root (used only to obtain a DB connection — model_registry has no project_id column).'),
        label: z.string().describe('The model label to register/update. Normalized (trim+NFC+whitespace-collapse) before the upsert key match.'),
        modelId: z.string().optional().describe('The provider\'s own model identifier string. Omit to leave untouched; pass null to clear.'),
        provider: z.string().optional(),
        capabilityTier: z.enum(routingWriteSurfaceLib.CAPABILITY_TIERS).optional(),
        costInPerMtok: z.number().nullable().optional(),
        costOutPerMtok: z.number().nullable().optional(),
        contextWindow: z.number().int().positive().nullable().optional(),
        headlessCliCmd: z.string().nullable().optional(),
        available: z.boolean().optional().describe('NOT NULL column — omit to leave untouched; cannot be explicitly nulled.'),
        kind: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        force: z.boolean().optional().describe('Required to re-point an existing non-NULL modelId, or to alias a modelId already used by a different label.'),
        configuredBy: z.string().optional().describe('Optional caller-supplied provenance string. Never derived automatically.'),
      },
    },
    async (args) => toolModelRegistrySet(args)
  );

  server.registerTool(
    'routing_session_override_set',
    {
      title: 'Set a session-scoped routing directive (project_id, session_id, role)',
      description:
        'Upserts on (project_id, session_id, role) — the ONLY write path for this table; route_resolve never ' +
        'mutates schema. projectId/sessionId cannot be \'*\' (reserved for routing_profiles\' global-default pin; ' +
        'session overrides have no global scope — a \'*\' row here would be permanently unreadable by ' +
        'route_resolve). role accepts ANY non-empty string, deliberately no taxonomy/allow-list (matches ' +
        'route-resolve.js\'s documented no-hardcoded-roles design). label must already be registered in ' +
        'model_registry (call model_registry_set first) and is matched in its NORMALIZED form. No TTL: this ' +
        'table has no expiry and nothing reaps stale rows automatically — clearing an override at session end ' +
        'is the caller\'s responsibility (use routing_session_override_clear).',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string(),
        role: z.string(),
        label: z.string().describe('Must already be registered via model_registry_set.'),
        provider: z.string().optional(),
        setBy: z.string().optional().describe('Optional caller-supplied provenance string. Never derived automatically.'),
      },
    },
    async (args) => toolRoutingSessionOverrideSet(args)
  );

  server.registerTool(
    'routing_session_override_get',
    {
      title: 'List active session-scoped routing directive(s) without side effects',
      description:
        '`role` omitted returns every override active for (project_id, session_id). Read-only — never a ' +
        'substitute for calling route_resolve, but the only way to introspect what is active without ' +
        'route_resolve\'s side effect of finalizing a turn\'s resolution.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string(),
        role: z.string().optional(),
      },
    },
    async (args) => toolRoutingSessionOverrideGet(args)
  );

  server.registerTool(
    'routing_session_override_clear',
    {
      title: 'Clear a session-scoped routing directive (project_id, session_id, role)',
      description:
        'Deletes the (project_id, session_id, role) row if present. Returns {cleared:true} when a row was ' +
        'removed, {cleared:false} when none matched — a no-op on an already-clear key is success, never an ' +
        'error. `role` is required (unlike the getter) — this always targets exactly one row of the table\'s ' +
        'UNIQUE key, never a whole-session wildcard delete.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string(),
        role: z.string(),
      },
    },
    async (args) => toolRoutingSessionOverrideClear(args)
  );

  // ── §18: usage_record / usage_query ──────────────────────────────────────

  server.registerTool(
    'usage_record',
    {
      title: 'Record token/cost usage for one turn',
      description:
        'Matched on (project_id, session_id, turn_idx, agent_role) — UPDATEs the row route_resolve already ' +
        'created (the common resolve-first-measure-after case), or upserts a fresh row if usage is recorded ' +
        'without route_resolve having run first. costUsd omitted computes server-side from model_registry rates ' +
        '(fails soft to NULL, never a guessed price, when the model or its rates are unregistered).',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string(),
        turnIdx: z.number().int().min(0),
        agentRole: z.string(),
        tokensIn: z.number().int().min(0).optional(),
        tokensOut: z.number().int().min(0).optional(),
        cacheReadTokens: z.number().int().min(0).optional(),
        cacheWriteTokens: z.number().int().min(0).optional(),
        costUsd: z.number().min(0).nullable().optional(),
        modelId: z.string().optional(),
        provider: z.string().optional(),
        outcome: z.enum(usageTelemetryLib.VALID_OUTCOMES).optional(),
        sourceModel: z.string().optional(),
        agentId: z.string().optional(),
      },
    },
    async (args) => toolUsageRecord(args)
  );

  server.registerTool(
    'usage_query',
    {
      title: 'Roll up token/cost usage by model, role, provider, day, branch, or PR',
      description:
        'granularity="turn" (default): sessionId given aggregates turn_usage directly, any of ' +
        `${JSON.stringify(usageTelemetryLib.VALID_GROUP_BY)}; sessionId omitted aggregates session_usage ` +
        'ROLLUPS only (staleness-by-design — a session whose rollup has not been recomputed is invisible), ' +
        'groupBy must be "model". granularity="feature" (§18.3): reads feature_usage (per-feature/per-PR ' +
        `provenance), project-scoped only, groupBy one of ${JSON.stringify(usageTelemetryLib.VALID_FEATURE_GROUP_BY)} ` +
        '— sessionId given together with granularity="feature" is a hard error before any query runs.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the project root.'),
        sessionId: z.string().optional().describe('Not supported with granularity="feature".'),
        granularity: z.enum(usageTelemetryLib.VALID_GRANULARITY).optional().describe('Default "turn".'),
        groupBy: z.enum([...new Set([...usageTelemetryLib.VALID_GROUP_BY, ...usageTelemetryLib.VALID_FEATURE_GROUP_BY])])
          .optional()
          .describe('Default "model". Valid values depend on granularity — see description.'),
      },
    },
    async (args) => toolUsageQuery(args)
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
