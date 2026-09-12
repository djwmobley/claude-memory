'use strict';

/**
 * scripts/lib/session-identity.js
 *
 * Shared host-env session-id resolution, lifted verbatim out of
 * scripts/handoff.js (which now requires this module instead of defining
 * its own copy) so scripts/handoff-mcp.mjs's usage_record/usage_query tools
 * can resolve a default sessionId from the SAME precedence, without a
 * second hand-rolled implementation drifting from the engine's own (memory
 * PR #284 / adversary G2: never invent a new precedence for the MCP path).
 *
 * No behavior change versus the pre-existing handoff.js function: same
 * total classification, same trim/whitespace handling, same stderr notice
 * text on an ambiguous pair.
 */

/**
 * Resolve a session id from the two host environment variables — total
 * classification over {CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, host}:
 *   neither set                             -> null
 *   exactly one set                         -> that one, no ambiguity
 *   both set and EQUAL                      -> that value, no ambiguity
 *   both set, DIFFERENT, host === 'codex'   -> CODEX_THREAD_ID (notice printed)
 *   both set, DIFFERENT, host === 'claude'  -> CLAUDE_CODE_SESSION_ID (notice printed)
 *   both set, DIFFERENT, host absent/null   -> CLAUDE_CODE_SESSION_ID (default; notice printed)
 *
 * `host` is the value already resolved by resolveHost() ('claude' | 'codex'),
 * or null/undefined for a call site that has no --host signal at all (e.g.
 * the MCP-invoked close/checkpoint paths, which never receive --host —
 * MCP registration always shells out the same `node handoff-mcp.mjs`
 * regardless of host).
 *
 * CODEX_THREAD_ID (a UUIDv7-style id) was verified set by a real interactive
 * Codex session on 2026-09-09; that same session did NOT set
 * CLAUDE_CODE_SESSION_ID. The Codex hook payload's own `session_id` field and
 * CODEX_THREAD_ID are EXPECTED to carry the same id — stated as an
 * expectation here, not verified against a captured fixture pairing both.
 *
 * Each env var is trimmed before use; a whitespace-only value (" ") is
 * treated as absent, same as unset — an env var accidentally set to blank
 * space by a wrapper script must not count as "set" here.
 */
function resolveSessionIdFromEnv(host) {
  const claudeRaw = process.env.CLAUDE_CODE_SESSION_ID;
  const codexRaw  = process.env.CODEX_THREAD_ID;
  const claudeId  = typeof claudeRaw === 'string' ? claudeRaw.trim() : '';
  const codexId   = typeof codexRaw  === 'string' ? codexRaw.trim()  : '';
  const hasClaudeId = claudeId.length > 0;
  const hasCodexId  = codexId.length > 0;

  if (!hasClaudeId && !hasCodexId) return null;
  if (hasClaudeId && !hasCodexId) return claudeId;
  if (!hasClaudeId && hasCodexId) return codexId;
  if (claudeId === codexId) return claudeId;

  const preferCodex = host === 'codex';
  const chosen      = preferCodex ? codexId : claudeId;
  const chosenName  = preferCodex ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID';
  const otherName   = preferCodex ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID';
  process.stderr.write(
    `handoff: CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are both set and differ — ` +
    `using ${chosenName} (${host ? `--host ${host}` : 'no --host'}), ignoring ${otherName}.\n`
  );
  return chosen;
}

module.exports = {
  resolveSessionIdFromEnv,
};
