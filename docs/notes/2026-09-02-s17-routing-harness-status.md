# §17 routing harness — mis-filed DTC thread and stale ceiling note

Date: 2026-09-02

## Finding 1: mis-filed thread

DentalTalentConnect's handoff carried an open thread "§17 routing DB parked
(Damian decision)." Recon confirmed this does **not** refer to DTC's
`docs/specs/licensing.md` §17 (that section is "Heartbeat, lease, follower
refresh"). It refers to **this repo**: `CONSOLIDATION-RUNBOOK.md`
`## 17. Agnostic model-routing harness (cost-aware, idempotent,
provider-spanning)` (line 2469 at time of reading). Damian re-parked it on
2026-09-02 as "wrong project — handle in a claude-memory session."

## Finding 2: stale ceiling note

§17's closing ceiling note (around line 2622) states "ZERO implementation
exists yet." However, the handoff MCP server already exposes `route_resolve`,
`routing_profile_get`, `routing_profile_set`, `usage_query`, and
`usage_record`. Either the ceiling note is stale, or those tools are stubs —
undetermined as of this writing. Recommended first step: a gap-audit
comparing the exposed tools against the §17 schema (`routing_profiles`,
`routing_session_overrides`, `model_registry` extensions, `turn_usage`) and
the 5-step precedence resolver described in §17.

## Finding 3: DTC-side cleanup

The DTC handoff assertion is being rewritten to point here, so this thread
stops resurfacing in DTC sessions.

## Next action

Run the gap-audit (tools vs. §17 schema and resolver spec) in a claude-memory
session; only after that, decide whether to plan or implement.
