Code-grounded comparison study (spine step 1). Informs the public-viability positioning and resolved Forks 1 & 2.

# claude-memory vs. Alternatives: Was the Build Justified?

*Grounded analysis of code-read inventories (claude-memory, agentmemory, mem0, Letta/MemGPT, Graphiti/Zep, Cognee). All claims trace to code-read inventories.*

## 1. Bottom Line Up Front
The build was not a waste. No existing system delivers the combination of zero-per-write-token-cost extraction, ranking-only decay with a guaranteed top-N floor, Claude Code session-lifecycle binding (SessionStart/Stop + staleness gate), and cardinality-aware deterministic supersession. The closest alternative — agentmemory — shares the zero-LLM and Claude-native goals but locks you to a non-swappable proprietary sidecar with no decay model and no SQL durability. Adopting Graphiti (Kuzu) or Cognee would be faster but imposes 3–5 LLM calls per write indefinitely, violating the zero-per-write-token-cost requirement from day one. The bespoke build was justified on the constraints as stated; the retrieval and supersession IP is genuinely novel relative to everything surveyed.

## 2. The Premise Correction
claude-memory is NOT pgvector-locked. The only pgvector artifact (`halfvec(4000)` on `retrieval_events.query_embedding`) was dead code, never written/read; the schema comment said "Pure stock Postgres — no extensions." The real (modest) coupling was to stock SQL features (recursive CTE, partial unique indexes, JSONB) — all SQLite-portable. (Post-study: a storage abstraction shipped; the system now runs on stock Postgres OR embedded SQLite, and the dead pgvector column/extension was removed.)

## 3. Comparison Matrix (axes: A substrate/deploy weight, B multi-session continuity fit, C retrieval decay/supersession, D per-write token cost, E Claude-Code harness fit, F adopt/adapt effort)
- claude-memory: stock PG or embedded SQLite, no daemon | native session lifecycle + staleness gate | ranking-only decay + top-N floor + cardinality-aware bi-temporal supersession | ZERO | purpose-built hooks/slash-commands | n/a (already built)
- agentmemory: mandatory proprietary iii-engine sidecar, non-swappable | sessions first-class | NO decay; Jaccard+isLatest | ZERO (heuristic) | purpose-built Claude Code | moderate, but sidecar lock + no SQL durability + no decay
- mem0: clean adapter (pgvector/FAISS/Qdrant), SaaS plugin | no session lifecycle; implicit accumulation | no decay; LLM-decided conflict | HIGH (LLM per add) | SaaS-hardwired plugin; no auto-capture | high; rebuild server+hooks
- Letta/MemGPT: mandatory always-running server | persistent agent identity (strong concept) | no decay; no dedup/supersession | ZERO (agent self-insert) | no CLI lifecycle | very high; invert CC into a Letta agent
- Graphiti/Zep: Kuzu embedded zero-server | group_id partition | bi-temporal valid/invalid (rigorous) | HIGH (3–5 LLM/episode) | library; no lifecycle | high; build lifecycle adapter
- Cognee: Kuzu+LanceDB+SQLite embedded | session_lifecycle module | no decay; no true bi-temporal | HIGH (cognify) | MCP ships; no CC lifecycle | moderate; accept LLM write cost

## 4. Decisive Differentiators
Only claude-memory pairs: zero-per-write-token-cost extraction (conversation-native; not an LLM API call per write) + ranking-only decay with a guaranteed top-N floor (dormancy-resilient; no surveyed system has any recency-decay) + Claude Code session-lifecycle binding (hooks + staleness gate) + deterministic predicate-registry cardinality supersession (no LLM needed for conflict resolution). agentmemory matches zero-LLM + Claude-native but with a non-swappable proprietary sidecar and no decay. What claude-memory lacked and has now adopted from the field: Graphiti's bi-temporal valid_at/invalid_at (shipped via PR #42's suppression_kind + invalid_at, with probation recoverable); a storage adapter boundary (shipped via PR #41). Cognee's session-cache/permanent split remains a noted future improvement (not a viability blocker).

## 5. Verdict Per Alternative
- agentmemory: strongest "could have adopted" — but permanent dependence on a closed, non-auditable, non-swappable sidecar; no decay; no SQL durability. Different tradeoff set, not a strict win.
- mem0: would require rebuilding the entire session-lifecycle + a local server (SaaS plugin is a misleading start) and pay LLM per write. No zero-LLM path.
- Letta: right concept, wrong operational shape for a solo self-hosted CLI; mandatory server; CC must become a Letta agent.
- Graphiti (Kuzu): best supersession model, zero-server — but 3–5 LLM calls per write is structural; eliminated by the zero-token constraint.
- Cognee: cleanest drop-in API, embedded — but LLM-heavy writes and no true bi-temporal supersession.

## 6. Recommendation
Steelman "wasted": agentmemory existed and was zero-LLM + Claude-native; "good-enough" dedup + no decay would have been user-indistinguishable for a solo handoff use case. Steelman "justified": the zero-per-write-token-cost constraint eliminates Graphiti/Cognee/mem0 on day one; agentmemory's sidecar+no-decay is a real gap; the dormancy fix (ranking-only decay + top-N floor) and deterministic predicate-registry supersession have no equivalent in any surveyed system. Honest landing: justified on the stated constraints; keep an eye on agentmemory. Ideas to steal (status): Graphiti bi-temporal → SHIPPED (PR #42); mem0 adapter boundary → SHIPPED (PR #41, also enabling embedded SQLite + dead-pgvector removal); Cognee session-cache/permanent split → noted backlog, not a blocker.

## 7. Impact on the Open Forks (resolved)
Fork 1 (auto_downvoded lifecycle / absorbing-state trap): RESOLVED — bi-temporal invalid_at + suppression_kind with downvoted_probation as a recoverable soft-exclusion (excluded from standard retrieval, present in history, rehabilitatable by positive feedback), downvoted_terminal/superseded non-auto-revived. Probation escapes the absorbing-state trap. Shipped in PR #42.
Fork 2 (couple #4 pinned-exemption + #5b suppression_kind): RESOLVED — shipped coupled in PR #42; pinned blocks AUTO suppression only (explicit cardinality supersession may still replace a pinned row). Decoupling would have produced unclassifiable early suppressions; coupling cost was low (same table).
