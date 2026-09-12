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
 *
 * fix/usage-record-marker-fallback (2026-09-12): a real Codex CLI end-to-end
 * run proved usage_record's env-only default is a dead end under Codex --
 * Codex does NOT put CODEX_THREAD_ID into the MCP server process's own env
 * (config.toml's `env` table for this server carries only HANDOFF_HOST and
 * HANDOFF_PROMOTION_FILE; verified against a real Codex e2e transcript,
 * 2026-09-12). handoff.js's own resolveSessionId already had a THIRD
 * fallback below the env check -- the project's live session_in_progress
 * marker (project_settings key 'session_in_progress'), written by the
 * SessionStart loader-hook (`--host codex`) with the Codex thread id -- and
 * that is why handoff_status could report a session_id in the same run
 * where usage_record failed outright. parseSessionMarkersDetailed /
 * parseSessionMarkers / latestSessionMarker are lifted here verbatim (same
 * reasoning as resolveSessionIdFromEnv above: ONE implementation, not a
 * second hand-rolled copy for the MCP path) so resolveSessionIdFromMarker
 * below can share them with handoff.js's own getSessionMarkers/resolveSessionId,
 * and so scripts/handoff-mcp.mjs's usage_record tool can fall back to the
 * SAME marker the engine already uses everywhere else -- never inventing a
 * second "how do we find the live session" rule for the MCP path.
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

// ── session_in_progress marker parsing — lifted verbatim from handoff.js ────
//
// Total classification of the raw stored project_settings value (same as
// handoff.js has always used — see its own "session_in_progress marker —
// per-session aware (S3)" section header for the full storage-format doc,
// not restated here):
//   - absent / null / ''                    -> []
//   - valid JSON, an array                  -> each element normalized to {session_id, ts};
//                                               a malformed element (no string .ts) is dropped
//   - valid JSON, not an array               -> [] (never produced by this code; fail open)
//   - not valid JSON, non-empty string       -> [{session_id: null, ts: raw}]  (legacy format)
//   - not valid JSON, empty/non-string       -> [] (garbage — fail open, never crash)
//
// fix(close): parseSessionMarkersDetailed's `markers` return value MUST stay
// byte-identical over EVERY input to what handoff.js's callers (status,
// loader-stop, resume, close) have always seen — none of them may see their
// list shrink or their session_id values change shape as a side effect of
// this lift or of the close-only dropped/coerced counting:
//   - an array element is DROPPED (never produced as a marker) iff it is not
//     an object (falsy, or typeof !== 'object' — this also drops a bare
//     array element, since arrays lack a string .ts) OR its .ts is not a
//     string.
//   - a surviving element's session_id is used as-is when it is a non-empty
//     string; ANY other value (null, undefined, a number, an object, an
//     empty string, ...) is COERCED to null — counted separately as
//     `dropped` (never became a marker at all) vs `coerced` (became a
//     marker but had a malformed session_id forced to null); only
//     clearSessionMarkerForClose (handoff.js) consumes these counts.
function parseSessionMarkersDetailed(raw) {
  if (raw === null || raw === undefined || raw === '') return { markers: [], dropped: 0, coerced: 0 };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const markers = [];
      let dropped = 0;
      let coerced = 0;
      for (const e of parsed) {
        // Byte-identical to main's filter predicate: `e && typeof e === 'object' && typeof e.ts === 'string'`.
        const isObjectLike = Boolean(e) && typeof e === 'object';
        const tsOk = isObjectLike && typeof e.ts === 'string';
        if (!tsOk) {
          dropped++;
          continue;
        }
        const sidIsUsableString = typeof e.session_id === 'string' && e.session_id.length > 0;
        const sidIsNullish = e.session_id === null || e.session_id === undefined;
        if (!sidIsUsableString && !sidIsNullish) {
          // A non-string, non-null/undefined session_id (number, object,
          // boolean, empty-string-excepted-above...) — main silently forced
          // this to null; still does, but now counted.
          coerced++;
        }
        markers.push({
          session_id: sidIsUsableString ? e.session_id : null,
          ts: e.ts,
        });
      }
      return { markers, dropped, coerced };
    }
    // valid JSON, not an array -> [] (never produced by this code; fail
    // open — no per-element structure to count as dropped/coerced).
    return { markers: [], dropped: 0, coerced: 0 };
  } catch (_) {
    // Not JSON — legacy marker (pre-S3 format). Accepted as-is regardless of
    // whether it happens to be a parseable date (see note above).
    if (typeof raw === 'string' && raw.length > 0) {
      return { markers: [{ session_id: null, ts: raw }], dropped: 0, coerced: 0 };
    }
    return { markers: [], dropped: 0, coerced: 0 };
  }
}

/**
 * fix(close): thin wrapper — returns EXACTLY the `markers` array
 * parseSessionMarkersDetailed computes, for every pre-existing caller
 * (status, loader-stop, resume, ...) that only ever wanted the clean list
 * and must see identical behavior to main (see parseSessionMarkersDetailed's
 * header comment).
 */
function parseSessionMarkers(raw) {
  return parseSessionMarkersDetailed(raw).markers;
}

/**
 * The single most-recently-written marker across all sessions for this
 * project — a compatibility shim for callers that predate S3 and only ever
 * expected ONE global session_in_progress value (C2 bias-attribution
 * session-id resolution in writeExtraction/resolveSessionId, retrieval_events
 * logging in cmdLoaderLoad). Under S3's true multi-session model these
 * callers cannot disambiguate between concurrent sibling sessions; picking
 * the most recent write reproduces the pre-S3 last-writer-wins behavior
 * exactly for the single-session case (still the overwhelming majority).
 *
 * ts is not guaranteed to be a parseable date — a legacy opaque marker
 * carries whatever string was originally written (see parseSessionMarkers).
 * Total classification of the pairwise comparison: both parseable -> later
 * date wins; one parseable -> the parseable one wins (a real timestamp is
 * always preferred over an opaque legacy string); neither parseable -> the
 * later array entry wins (addSessionMarker always appends, so "later in the
 * array" already means "more recently written").
 */
function latestSessionMarker(list) {
  if (!list || list.length === 0) return null;
  return list.reduce((latest, m) => {
    if (!latest) return m;
    const mMs = Date.parse(m.ts);
    const lMs = Date.parse(latest.ts);
    if (Number.isNaN(mMs) && Number.isNaN(lMs)) return m;
    if (Number.isNaN(lMs)) return m;
    if (Number.isNaN(mMs)) return latest;
    return mMs > lMs ? m : latest;
  }, null);
}

/**
 * resolveSessionIdFromMarker(db, projectId) — the second exported function,
 * taking the db client + projectId directly (fix/usage-record-marker-
 * fallback): the project's live session_in_progress marker, resolved the
 * SAME way handoff.js's resolveSessionId always has (getSessionMarkers +
 * latestSessionMarker + `latest.session_id || latest.ts`) — queried here
 * directly against project_settings rather than through handoff.js's
 * getSetting, so this module has no require() back onto handoff.js (which
 * already requires THIS module — a back-reference would be circular).
 * The SQL itself is the same single-row-by-key lookup getSetting has always
 * run; this is not a second precedence, just the same one query inlined so
 * both call sites (handoff.js's resolveSessionId, scripts/handoff-mcp.mjs's
 * usage_record default) share one implementation of "how do we find the
 * live marker" without a circular require.
 *
 * Returns the resolved session id string, or null when no marker exists for
 * this project (an absent/empty session_in_progress row, or one that parses
 * to an empty marker list) — the caller decides what a null result means
 * (handoff.js's resolveSessionId falls through to null; usage_record turns
 * it into its actionable "pass sessionId explicitly" error, now mentioning
 * this marker fallback too).
 */
async function resolveSessionIdFromMarker(db, projectId) {
  const { rows } = await db.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = $2`,
    [projectId, 'session_in_progress']
  );
  const raw = rows.length > 0 ? rows[0].value : null;
  const markers = parseSessionMarkers(raw);
  const latest = latestSessionMarker(markers);
  return latest ? (latest.session_id || latest.ts) : null;
}

// ── usage_record-only strict marker default (Codex review C1/C2, fix/usage- ─
// record-marker-fallback follow-up) ─────────────────────────────────────────
//
// resolveSessionIdFromMarker (above) is handoff.js's OWN third fallback,
// unchanged, and stays the one implementation handoff.js's resolveSessionId
// and handoff_status both use — this PR's task scope forbids touching that
// behavior. The MCP usage_record tool's sessionId default needed a STRICTER
// rule than "any project marker, however stale or cross-host" (Codex review
// C1: usage_record's prior marker fallback accepted ANY live marker for the
// project, including one written by a different host or long stale), so it
// gets its OWN function here rather than a behavior change to the shared one.
//
// parseSessionMarkersStrict(raw) — a total classification distinct from
// parseSessionMarkersDetailed's (legacy-tolerant) one:
//   - absent / null / ''                -> { markers: [], excludedCount: 0 }
//   - malformed (non-JSON) raw string   -> { markers: [], excludedCount: 1 }
//     (C2: NEVER legacy-parsed as a bare-string marker on this path — that
//     legacy fallback is parseSessionMarkersDetailed's own behavior, kept
//     there unchanged for handoff.js, but this strict parser excludes it.)
//   - valid JSON, not an array           -> { markers: [], excludedCount: 1 }
//   - valid JSON array                   -> each element without a string
//     .ts is excluded (counted); a surviving element's session_id/host are
//     each normalized to a non-empty string or null (an empty string counts
//     as absent; anything else, e.g. whitespace-only, is kept verbatim so
//     the trim/non-empty check below can reject it explicitly rather than
//     silently substituting ts).
function parseSessionMarkersStrict(raw) {
  if (raw === null || raw === undefined || raw === '') return { markers: [], excludedCount: 0 };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { markers: [], excludedCount: 1 };
  }
  if (!Array.isArray(parsed)) {
    return { markers: [], excludedCount: 1 };
  }
  const markers = [];
  let excludedCount = 0;
  for (const e of parsed) {
    const isObjectLike = Boolean(e) && typeof e === 'object';
    const tsOk = isObjectLike && typeof e.ts === 'string';
    if (!tsOk) { excludedCount++; continue; }
    const sidIsUsableString = typeof e.session_id === 'string' && e.session_id.length > 0;
    const hostIsUsableString = typeof e.host === 'string' && e.host.length > 0;
    markers.push({
      session_id: sidIsUsableString ? e.session_id : null,
      ts: e.ts,
      host: hostIsUsableString ? e.host : null,
    });
  }
  return { markers, excludedCount };
}

/**
 * Host filter, backward-compatible with markers that predate the `host`
 * field (loader-hook only started writing it in this PR):
 *   - handoffHost falsy (HANDOFF_HOST unset)         -> every marker stays a
 *     candidate, no filtering at all.
 *   - handoffHost set, but NO surviving marker has a
 *     non-empty host field                            -> every marker stays
 *     a candidate — an absent host is "unknown", never treated as
 *     non-matching when there is nothing host-tagged to lose to.
 *   - handoffHost set AND at least one marker carries
 *     a host field                                     -> keep ONLY markers
 *     whose host === handoffHost; a host-absent marker in this case IS
 *     treated as non-matching (it is competing against a real host-tagged
 *     signal, so "unknown" must not silently win).
 */
function filterMarkersByHost(markers, handoffHost) {
  if (!handoffHost) return markers;
  const anyHostTagged = markers.some((m) => typeof m.host === 'string' && m.host.length > 0);
  if (!anyHostTagged) return markers;
  return markers.filter((m) => m.host === handoffHost);
}

/**
 * resolveUsageRecordMarkerDefault(db, projectId, handoffHost) — the ONLY
 * caller of this is scripts/handoff-mcp.mjs's toolUsageRecord (C1). Total
 * classification over the candidate marker count AFTER strict parsing +
 * host filtering:
 *   - zero candidates      -> { sessionId: null, markerTs: null, error }
 *     (error text unchanged from the pre-existing "no marker" message).
 *   - exactly one candidate -> its session_id (falling back to its ts only
 *     when session_id itself was never present/usable — see
 *     parseSessionMarkersStrict), trim/non-empty validated (C2): a
 *     resulting blank/whitespace-only id is ALSO an actionable error, never
 *     silently substituted with ts.
 *   - more than one candidate -> an "ambiguous session markers (N)" error
 *     naming only the surviving count and each candidate's host (a
 *     host-absent candidate is reported as "unknown") — NEVER a session id,
 *     per this PR's task scope (ids must not appear in error text).
 *
 * Returns { sessionId, markerTs, error }: sessionId/markerTs are null iff
 * error is non-null. Never touches handoff.js's resolveSessionId / the
 * shared resolveSessionIdFromMarker above — a distinct rule for a distinct
 * (stricter) caller.
 */
async function resolveUsageRecordMarkerDefault(db, projectId, handoffHost) {
  const { rows } = await db.query(
    `SELECT value FROM project_settings WHERE project_id = $1 AND key = $2`,
    [projectId, 'session_in_progress']
  );
  const raw = rows.length > 0 ? rows[0].value : null;
  const { markers } = parseSessionMarkersStrict(raw);
  const candidates = filterMarkersByHost(markers, handoffHost);

  if (candidates.length === 0) {
    return {
      sessionId: null,
      markerTs: null,
      error:
        'usage_record: sessionId was omitted, no default could be resolved from this MCP server ' +
        'process\'s own CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID env vars, and no project session ' +
        'marker (session_in_progress) was found -- pass sessionId explicitly.',
    };
  }

  if (candidates.length > 1) {
    const hosts = candidates.map((m) => m.host || 'unknown');
    return {
      sessionId: null,
      markerTs: null,
      error:
        `usage_record: ambiguous session markers (${candidates.length}) -- pass sessionId explicitly ` +
        `(hosts: ${hosts.join(', ')}).`,
    };
  }

  const only = candidates[0];
  const derived = (typeof only.session_id === 'string' && only.session_id.length > 0) ? only.session_id : only.ts;
  const trimmed = typeof derived === 'string' ? derived.trim() : '';
  if (trimmed.length === 0) {
    return {
      sessionId: null,
      markerTs: null,
      error:
        'usage_record: the project session marker (session_in_progress) resolved to a blank/whitespace ' +
        'session id -- pass sessionId explicitly.',
    };
  }

  return { sessionId: trimmed, markerTs: only.ts, error: null };
}

module.exports = {
  resolveSessionIdFromEnv,
  parseSessionMarkersDetailed,
  parseSessionMarkers,
  latestSessionMarker,
  resolveSessionIdFromMarker,
  parseSessionMarkersStrict,
  filterMarkersByHost,
  resolveUsageRecordMarkerDefault,
};
