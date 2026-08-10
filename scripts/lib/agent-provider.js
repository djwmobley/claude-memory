'use strict';

/**
 * scripts/lib/agent-provider.js
 *
 * Abstract contract for a headless-CLI adapter that can run an agent
 * non-interactively and report its own identity. This module ships ZERO
 * concrete providers by design (§9.2 in the origin design) -- operators
 * implement `AgentProvider` themselves for whichever headless CLI they run
 * (their own wrapper script, container entrypoint, etc.). This PR does not
 * wire any concrete provider into the engine's write path.
 *
 * ONE IDENTITY STRING, THREE CONSUMING SURFACES: `label()` returns a single
 * free-text self-identification string. That SAME string is the value an
 * operator's integration stamps into:
 *   1. attribution     -- source_model / agent_id columns on entities,
 *                          assertions, edges, agent_exchange, turn_usage
 *                          (and any future guarded table).
 *   2. registry         -- model_registry.label (the join key route-resolve
 *                          and usage-telemetry key their lookups on).
 *   3. telemetry         -- turn_usage.model_id, matched against
 *                          model_registry.label by convention (no hard FK
 *                          -- see route-resolve.js's own header comment).
 * label() returning a DIFFERENT string on different calls, or different
 * providers returning colliding strings for genuinely distinct agents, is
 * an integration bug outside this contract's ability to detect or prevent
 * -- see the blind-spot section in this PR's final report.
 *
 * No named real-world model/vendor identifiers appear anywhere in this
 * file. A concrete provider's label() return value is operator-supplied
 * configuration, not something this module declares or defaults.
 */

class AgentProvider {
  /**
   * Free-text self-identification for this provider. MUST be stable across
   * calls within a single agent's lifetime -- see the "one identity, three
   * surfaces" note above for why a changing label silently breaks
   * attribution/registry/telemetry joins that key on it.
   *
   * @returns {string}
   */
  label() {
    throw new Error('AgentProvider.label() not implemented -- this is an abstract base class; operators supply a concrete subclass.');
  }

  /**
   * Run this provider's underlying headless CLI non-interactively with
   * `prompt`, in working directory `cwd`, with environment overrides `env`,
   * and resolve with whatever output/result shape the concrete provider
   * defines (this contract does not prescribe a return shape -- that is a
   * concrete-provider concern, same as label()'s value being operator
   * configuration, not engine policy).
   *
   * @param {string} prompt
   * @param {{ cwd?: string, env?: Record<string, string> }} [options]
   * @returns {Promise<unknown>}
   */
  async runHeadless(prompt, options) {
    throw new Error('AgentProvider.runHeadless() not implemented -- this is an abstract base class; operators supply a concrete subclass.');
  }
}

module.exports = { AgentProvider };
