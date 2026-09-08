'use strict';

/**
 * host-target.js — total classification of the `--host` flag shared by
 * scripts/install.js and scripts/handoff.js's `loader-hook` / `loader-stop`
 * entry points (cm codex-host-adapter, S1).
 *
 * Every input maps to a branch; unknown/malformed input is refused (never
 * silently coerced to a default). Absent is the ONLY branch that resolves to
 * the default host ('claude') — every other unrecognized shape is a refusal,
 * because a wrong host silently accepted would point hook wiring or MCP
 * registration at the wrong config file (AGENTS.md vs CLAUDE.md) with no
 * visible signal.
 *
 * Matching is exact and case-sensitive, with no trimming — `--host Codex`,
 * `--host codex ` (trailing space in the value token), and `--Host codex`
 * are all refused, not coerced.
 */

const VALID_HOSTS = ['claude', 'codex'];
const DEFAULT_HOST = 'claude';

/**
 * @param {string[]} argv - the argument list to scan (callers pass the
 *   subcommand's own `args`/`rest` array — never raw `process.argv` — so
 *   there is no need to skip node/script/subcommand tokens here).
 * @param {NodeJS.ProcessEnv} [env] - accepted for signature symmetry with
 *   other `resolve*` helpers in this codebase (e.g. resolvePromotionFilePath)
 *   and to leave room for a future env-based override without touching every
 *   call site. `--host` is argv-only today (S1) — env is not consulted.
 * @returns {{ ok: true, host: 'claude'|'codex' } | { ok: false, reason: string }}
 */
function resolveHost(argv, env) {
  void env;
  const list = Array.isArray(argv) ? argv : [];

  const foundValues = [];

  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;

    if (tok === '--host') {
      const next = list[i + 1];
      if (next === undefined) {
        return { ok: false, reason: '--host requires a value (claude or codex) but none was given' };
      }
      if (typeof next === 'string' && next.startsWith('--')) {
        return {
          ok: false,
          reason: `--host requires a value (claude or codex), got the next flag "${next}" instead`,
        };
      }
      foundValues.push(next);
      i++; // consume the value token so it isn't scanned again
      continue;
    }

    if (tok.startsWith('--host=')) {
      foundValues.push(tok.slice('--host='.length));
      continue;
    }
  }

  if (foundValues.length === 0) {
    return { ok: true, host: DEFAULT_HOST };
  }

  const distinct = [...new Set(foundValues)];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `--host given conflicting values: ${distinct.map((v) => JSON.stringify(v)).join(', ')}`,
    };
  }

  const value = distinct[0];
  if (value === '') {
    return { ok: false, reason: '--host was given an empty value' };
  }
  if (!VALID_HOSTS.includes(value)) {
    return {
      ok: false,
      reason: `--host must be exactly one of: ${VALID_HOSTS.join(', ')} (got ${JSON.stringify(value)})`,
    };
  }

  return { ok: true, host: value };
}

module.exports = { resolveHost, VALID_HOSTS, DEFAULT_HOST };
