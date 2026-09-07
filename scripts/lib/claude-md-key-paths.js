'use strict';

/**
 * claude-md-key-paths.js — portable "## Key paths" bullet rendering for the
 * generated project CLAUDE.md (templates/project-claude-md.tpl).
 *
 * Background: the template used to interpolate {{HANDOFF_MD_PATH}} and
 * {{PROJECT_ROOT}}/scripts/handoff.js — both filesystem-absolute paths baked
 * in at `init` time on the machine that ran init. That breaks the moment the
 * repo is cloned onto a second machine/user (different home dir), and it is
 * flatly wrong for the helper-script bullet in plugin mode (CLAUDE_PLUGIN_ROOT
 * set) since the target project is never the engine checkout.
 *
 * renderKeyPathsBullets(env) computes the two SYMBOLIC (never
 * filesystem-absolute) bullet values used by fresh template rendering
 * (cmdInit). The precedence mirrors resolveBaseDir() in
 * scripts/lib/handoff-paths.js exactly, but renders the literal env-var
 * token rather than the expanded value.
 *
 * Scope note: this module intentionally does NOT heal an already-generated
 * CLAUDE.md's Key paths section — that is out of scope for this change (see
 * cm#263 AUTHOR spec). It only governs what a fresh `handoff init` writes.
 */

function _envNonEmpty(env, key) {
  const v = env ? env[key] : undefined;
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Resolve the SAME precedence resolveBaseDir() (scripts/lib/handoff-paths.js)
 * uses, but rendered as a literal symbolic token — never the expanded value.
 * resolveBaseDir() only recognizes HANDOFF_BASE_DIR (falling back to
 * ~/.claude) — there is no CLAUDE_CONFIG_DIR branch in that function, so
 * this must not invent one.
 */
function resolveBaseSymbol(env) {
  if (_envNonEmpty(env, 'HANDOFF_BASE_DIR')) return '$HANDOFF_BASE_DIR';
  return '~/.claude';
}

/**
 * Resolve the helper-script bullet as a literal symbolic token. Never
 * `<repo-root>/scripts/handoff.js` — the target project is not the engine.
 */
function resolveHelperSymbol(env) {
  if (_envNonEmpty(env, 'CLAUDE_PLUGIN_ROOT')) return '$CLAUDE_PLUGIN_ROOT/scripts/handoff.js';
  return '<engine-root>/scripts/handoff.js';
}

/**
 * Compute the two portable "## Key paths" bullet values for the given env
 * (defaults to process.env). Neither value is ever filesystem-absolute —
 * both are literal symbolic tokens (`$HANDOFF_BASE_DIR`, `~/.claude`,
 * `$CLAUDE_PLUGIN_ROOT`, `<engine-root>`) plus the literal `<project-id>`
 * placeholder, never an interpolated real path.
 */
function renderKeyPathsBullets(env) {
  env = env || process.env;
  const base = resolveBaseSymbol(env);
  return {
    handoffPath: `${base}/projects/<project-id>/handoff.md`,
    helperPath:  resolveHelperSymbol(env),
  };
}

// ─── absolute-path / portable-form classification (test + call-site use) ───

function isAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;   // Windows drive root
  if (/^\\\\/.test(p)) return true;              // UNC
  if (/^\/[a-z]\//.test(p)) return true;         // MSYS (/c/Users/...)
  if (/^\//.test(p)) return true;                // POSIX absolute (any root)
  if (p.includes('%USERPROFILE%')) return true;  // literal Windows env token
  return false;
}

function isPortableForm(p) {
  if (typeof p !== 'string') return false;
  return (
    p.startsWith('~/') ||
    p.startsWith('$HANDOFF_BASE_DIR') ||
    p.startsWith('$CLAUDE_PLUGIN_ROOT') ||
    p.startsWith('<engine-root>')
  );
}

module.exports = {
  renderKeyPathsBullets,
  // exported for tests / callers that need to classify a rendered bullet
  isAbsolutePath,
  isPortableForm,
};
