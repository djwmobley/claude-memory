# Bundle A — Substrate: Spec

| Field | Value |
|---|---|
| Bundle name | Bundle A — Substrate |
| Parent directive ID | 49 |
| Supersedes | 49 |
| Status | PROPOSED |
| Change size | LARGE |
| Child dockets covered | #50 (Phase 0), #51 (Phase 1), #52 (Phase 2), #53 (Phase 3), #54 (Phase 3.5), #55 (Phase 3.6), #56 (Phase 3.7) |
| Estimated effort | 30–40 hours of focused implementation |
| Drafted | 2026-05-13 |
| Last revised | 2026-05-14 (v5) |

### Revision history

| Version | Date | Summary |
|---|---|---|
| v1 | 2026-05-13 | Original spec: six Phase 2 tables including entities/assertions/edges/doc_tree_nodes/topic_payoff; Ollama as unified inference backend for embedder, reranker, and blurb LLM; top-50 reranker candidate pool; 100ms p95 latency budget; 12–24h estimate. |
| v2 | 2026-05-13 | Schema scope cut to retrieval_events only in Phase 2 (entities/assertions/edges/doc_tree_nodes/topic_payoff deferred to Bundle B); inference stack changed from Ollama to vLLM Docker for embedder and reranker (Ollama retained for blurb LLM); vLLM containers pinned at Q8 with gpu-memory-utilization caps (0.40 embedder, 0.25 reranker); late chunking retained with vLLM primary path and Transformers sidecar fallback; reranker candidate pool reduced from top-50 to top-20; reranker p95 latency budget revised from 100ms to 250ms; eval corpus expansion (~20 cross-chunk fixtures) added as Phase 1 precondition; rollback paths updated for Docker stack; risk register expanded with three vLLM-specific rows; estimated effort revised to 14–20h. |
| v3 | 2026-05-14 | Knowledge graph schema restored to Phase 2 (entities, assertions, edges, retrieval_contract, project_settings) with manual+in-session-extraction writer model; assertions adopt 1–10 confidence with per-day exponential decay and live "used" event reinforcement on retrieval; Phase 3.5 introduces /handoff skill with 7 subcommands (init/status/resume/drop/checkpoint/close/purge); Phase 3.6 introduces SessionStart loader hook reading per-CWD handoff.md with staleness check at 7 days configurable; Phase 3.7 adds Stop-hook safety net for implicit close; handoff.md format pinned with YAML frontmatter contract; CLAUDE.md (project root) vs handoff.md (per-CWD) roles delineated with promotion candidate flow; skill execution visibility required (Running/Done announcements); vLLM install sub-task added as Phase 1 step zero (verified not installed on Principal's machine 2026-05-14); VRAM baseline of ~4.2 GB Windows desktop overhead documented; project_id = encoded_cwd from day one (no DEFAULT 'default'); skill eval added to acceptance criteria with golden-session fixtures; honest 100K startup token framing (Bundle A reduces project-context portion only; harness floor unchanged); architect_directives filing called out as pre-Phase-0 step; effort estimate revised to 30–40 hours. |
| v4 | 2026-05-14 | Phase 1 deployment path pivoted from Docker to native WSL: Docker Desktop 29.4.3 could not pull `vllm/vllm-openai` (multi-blob EOF failures, multiple tags, reproducible); working path is uv + Python 3.12 venv inside WSL Ubuntu with `uv pip install vllm` and `sudo apt install build-essential`. CLI rename: `--task embed` replaced with `--runner pooling` throughout (vLLM 0.20.x). Port 8000 Windows preemption hazard documented with pre-flight check. `--enforce-eager` documented as degraded fallback when build-essential is absent. Eval corpus expanded from 22+18 to 42 fixtures + 38 queries; refreshed baseline: recall@1=0.7222, recall@3_relaxed=0.9722, MRR=0.8296, negative_precision=1.0; 2pp regression budget measured against refreshed baseline. Four near-duplicate corpus pairs identified as Phase 3 reranker calibration targets. Docker-compose YAML retained as the upstream-pristine reference path. |
| v5 | 2026-05-14 | Phase 1 step 5 added: halfvec(4000) ANN indexability fix via Matryoshka truncation. pgvector 0.8.1 hard-caps HNSW indexes at 2000 dims for `vector` type and 4000 dims for `halfvec`. The full 4096-dim Qwen3 output is sliced to 4000 leading dims (Qwen3-Embedding-8B is explicitly Matryoshka-trained; leading dims preserve semantic load) and stored as `halfvec(4000)`. HNSW + halfvec_cosine_ops indexes built on both tables. Post-conversion eval held within gate: recall@1=0.7778 (no regression vs prior step-4 baseline of 0.7778), MRR=0.8542, recall@3_relaxed=1.0, negative_precision=1.0. The empty `embedding_mxbai_1024_archive` columns dropped (no soak data; the eval run wiped mxbai pre-swap). Phase 2 DDL updated: `retrieval_events.query_embedding` changed from `vector(4096)` to `halfvec(4000)` for schema consistency. Baseline JSON updated with `embedding_type: "halfvec(4000)"` field. |
| v6 | 2026-05-14 | Phase 3a substrate (vLLM Qwen3-Reranker-4B) shipped on 2026-05-14 (PR #6, squash 9692d4e). Discovered that Qwen3-Reranker-4B requires `--hf_overrides '{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}'` plus a Jinja chat template (`scripts/qwen3_reranker.jinja`) — without these, vLLM loads it as a generic causal LM and `/v1/rerank` returns near-uniform similarity scores; with them, scores spread across ~6 orders of magnitude. The `Reranker precision@5 improvement: ≥+5pp` acceptance gate from §6 was found to be unmeasurable on the 42-fixture eval corpus (both vector-only and reranker mode at 1.00 ceiling). Gate evaluation point moved from "every eval run" to "/handoff:close or :checkpoint, when corpus chunk count exceeds `project_settings.precision_at_5_gate_min_chunks`" (default 1000). The +5pp threshold itself is unchanged; only the trigger point and skip condition are added. Of four near-duplicate corpus pairs flagged in v4 as reranker calibration targets, the reranker disambiguates 1 (`multi-vector-retrieval` vs `semantic-chunking-strategies`); the remaining three remain candidates for Phase 3b late-chunking + contextual blurbs. |

---

## 1. Operative Scope

Bundle A installs the embedding and retrieval substrate on which all subsequent bundles depend: it migrates the existing decisions corpus into the new schema, upgrades the embedding model to Qwen3-Embedding-8B stored as `halfvec(4000)` via Matryoshka truncation (Phase 1 steps 1–5), introduces the `retrieval_events` table, adds the reranker and late chunking techniques that raise retrieval precision, and ships the `/handoff` skill with its associated SessionStart loader hook and Stop-hook safety net. The `halfvec(4000)` storage form is the established embedding dimension for all subsequent phases: pgvector 0.8.1 caps HNSW indexes at 4000 dims for `halfvec` and 2000 dims for `vector`; storing 4000 leading dims (not 4096) is what makes ANN indexing viable as the corpus grows. Nothing in Bundle A implements outcome capture, community detection, automated entity extraction over the backfilled decisions corpus, or graph traversal — those are explicitly out of scope. Nothing in Bundle A introduces multi-user or Codex bridge support; that is gated on a separate Principal decision per the Judge's O3 ruling.

**On the 100K startup token cost — honest framing.** The majority of that cost is harness-level: tool definitions, MCP server schemas, skill descriptions, plugin metadata. Bundle A does not touch any of that; the harness-set floor is unchanged. What Bundle A does reduce is the project-specific portion of startup context. Currently the auto-memory system loads `MEMORY.md` plus every linked memory file inline at session start. After Bundle A, that becomes pointer-only: a small handoff.md surfaces session state, and substance is pulled on demand from Postgres via the SessionStart loader against the retrieval contract. The marginal project-context cost is where the win lives. Implementers and the Principal should set expectations accordingly.

The Phase 2 schema scope is restored from the v2 cut. The tables `entities`, `assertions`, `edges`, `retrieval_contract`, and `project_settings` ship in Bundle A alongside the `/handoff` skill and SessionStart loader that write to them. `doc_tree_nodes` and `topic_payoff` remain deferred to Bundle B; this project's corpus is not structured filings, and the Page Index pattern adds no value here yet.

This bundle groups Phases 0, 1, 2, 3, 3.5, 3.6, and 3.7. Each phase depends on the prior phases within the bundle; no phase in Bundle A can be audited independently at READY_FOR_JUDGE without the preceding phases in place.

**Pre-Phase-0 filing requirement.** Before Phase 0 implementation begins, file a PROPOSED `architect_directives` row in the `pipeline_architect` database with `supersedes_id = 49`. The filing is what makes Bundle A a real audit unit under the Judge protocol; until then it is a draft on disk. The handoff document surfaces this as an open item.

---

## 2. Drift Evidence Anchor

The pre-change retrieval quality baseline, as measured by the eval harness at `test/eval/eval-retrieval.js`, is recorded in `test/eval/baseline.json`. The baseline was refreshed during the Phase 1 bring-up session on 2026-05-14 after the eval corpus was expanded from 22 fixtures + 18 queries to 42 fixtures + 38 queries (see Phase 1 -- Eval corpus expansion below). The expanded-corpus baseline supersedes the original 22-fixture measurement.

| Metric | Pre-expansion baseline (22 fixtures) | Refreshed baseline (42 fixtures, active) |
|---|---|---|
| recall\_at\_1 | 0.8125 | **0.7222** |
| recall\_at\_3\_relaxed | 1.0 | **0.9722** |
| MRR | 0.90625 | **0.8296** |
| negative\_precision | 1.0 | **1.0** |

The refreshed baseline (right column) is the reference for all acceptance thresholds in Section 6. The drop from the pre-expansion numbers is expected: the new fixtures are harder by design, targeting cross-chunk co-reference and near-duplicate disambiguation. This opens headroom for Phase 3 gains to register as statistically meaningful.

**Retrieval failure mode this bundle addresses — embedder quality.** The current embedder is `mxbai-embed-large` (335M parameters, 1024-dim). At 1024-dim, the embedding space is sufficient for the current 22-fixture corpus but is known to underperform on technical jargon, proper nouns, and cross-domain mixed-vocabulary queries as corpus size grows. The recall@1 of 0.8125 represents a ceiling at 1024-dim on this model class; published MTEB benchmarks for `mxbai-embed-large` place it in the 60–65 range on multilingual leaderboards, while `Qwen/Qwen3-Embedding-8B` at 4096-dim achieves 70.58. The move to 4096-dim is justified only if the recall lift on the project's own 22-fixture eval harness exceeds the storage and compute overhead — that is the question Phase 1's eval gate answers empirically before the old embedding column is dropped.

**Retrieval failure mode this bundle addresses — cross-chunk fidelity.** The `pipeline-chunker.js` chunks table is populated with session-end document chunks. Cross-chunk co-reference loss at chunk boundaries is high-frequency in actual usage: the chunks table is populated continuously, confirming this is a common event, not an edge case. When a session-end document spanning 6,000+ characters is chunked at the 1400-char ceiling, entities and section context established in chunk N are silently dropped at the boundary of chunk N+1. Late chunking (pooling over token spans of a full-document pass) addresses this directly. The eval-baseline anchor (recall@1=0.8125, MRR=0.90625) motivates the embedder upgrade; the cross-chunk boundary loss motivates late chunking. Both are concrete and project-specific.

**Reranker justification.** The current retrieval path uses hybrid scoring (FTS 30% + vector cosine 70%) with no precision re-ranking. MRR of 0.906 indicates the correct document frequently ranks first but does not always rank at rank-1 among the top-5 candidates. A cross-encoder reranker is a known technique for closing that gap by scoring candidate pairs against the query at higher semantic fidelity than dot-product similarity.

---

## 3. Architecture

### Phase 0 — Decisions Backfill

**What changes.** The `pipeline_pipeline.decisions` table on localhost Postgres contains 137 rows, of which 82 have embeddings at 1024-dim mxbai-embed-large. These 137 rows are the project's accumulated decisions corpus and represent the primary historical knowledge base for the claude-memory substrate. Phase 0 migrates them into the new claude-memory schema (`memory_entries` + `memory_entry_chunks`) with `embedding = NULL`; Phase 1 produces 4096-dim embeddings.

**Why this belongs in Bundle A.** Phases 1–3 operate on the corpus that Phase 0 migrates. Without Phase 0, the embedding upgrade (Phase 1) has no historical data to operate on. The coupling is direct: Phase 0 creates the rows; Phase 1 re-embeds them.

**Substrate touched.** Source: `pipeline_pipeline.decisions` on the `pipeline_pipeline` schema (localhost Postgres). Target: `memory_entries` and `memory_entry_chunks` in the claude-memory schema. No writes to the source schema.

**Order of operations.**
1. Run a read-only SELECT from `pipeline_pipeline.decisions` to extract all 137 rows.
2. For each row, map `body` → `memory_entries.body`, a generated name slug, `kind = 'decision'` as `mem_type`.
3. Chunk each body using the existing chunker at 1400-char prose ceiling.
4. Upsert rows into `memory_entries` with `source_file = 'decisions/<slug>.md'` convention (virtual path; no actual file is created).
5. Upsert chunks into `memory_entry_chunks` with `embedding = NULL` (embedding backfill happens in Phase 1, not Phase 0).

**Dependencies.** None on prior phases within this bundle. Phase 0 is the entry point.

**Note on existing 1024-dim embeddings.** The 82 rows in `pipeline_pipeline.decisions` that already have mxbai-1024 embeddings are not copied into the new schema with those embeddings. The dimension mismatch (1024 vs 4096) makes co-existence in a single `vector(4096)` column impossible without padding, which would be semantically meaningless. The correct approach is to migrate the text and re-embed at 4096-dim in Phase 1. The old 1024-dim embeddings in the source table are left untouched as a read-only reference.

---

### Phase 1 — Embedder Upgrade and Eval Corpus Expansion

#### Step zero -- vLLM install (active path: native WSL; Docker path preserved as reference)

**vLLM is not installed on the Principal's machine as of 2026-05-14.** Complete these steps before any pipeline code is wired.

---

**Active deployment path: native WSL (Ubuntu via uv)**

This is the path that works on the Principal's Windows 11 + WSL2 + RTX 3090 machine. Docker Desktop 29.4.3 could not pull `vllm/vllm-openai` -- multiple tags, multiple blob fetch attempts, all failed with `httpReadSeeker: failed open ... EOF`. The native WSL path is the required path on this machine.

**One-time setup (inside WSL Ubuntu):**

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv venv --python 3.12 ~/.venv/vllm   # uv downloads CPython 3.12; Ubuntu default is 3.14, too new for vLLM wheels
source ~/.venv/vllm/bin/activate
uv pip install vllm
sudo apt-get install -y build-essential             # required for torch.compile JIT (gcc/g++/make)
```

**Service launch -- embedder:**

```bash
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
  --runner pooling \
  --quantization bitsandbytes \
  --load-format bitsandbytes \
  --dtype auto \
  --gpu-memory-utilization 0.40 \
  --port 8000
```

**Service launch -- reranker (separate terminal or background process):**

```bash
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Reranker-4B \
  --runner pooling \
  --quantization bitsandbytes \
  --load-format bitsandbytes \
  --dtype auto \
  --gpu-memory-utilization 0.25 \
  --port 8001
```

**Reachability.** vLLM listens on `0.0.0.0:<port>` inside WSL. Windows-side clients reach it via WSL2 localhost forwarding: `http://localhost:<port>` on Windows routes to `127.0.0.1:<port>` inside WSL.

**Port pre-flight check.** Before starting, verify Windows is not already occupying the target port:

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen
```

If a listener is present (a stale Python process, another service), either kill it or use an alternate port (`8800` or `18000` are recommended alternatives). WSL2 localhost forwarding means a Windows-side listener on port N silently wins over a WSL-side listener, returning confusing 404s from the Windows client. See README.md `## Gotchas` for the full incident report.

**torch.compile and build-essential.** The `sudo apt-get install -y build-essential` step installs gcc/g++/make, which vLLM requires for torch.compile JIT kernel compilation. If build-essential is not present, append `--enforce-eager` to the vllm serve command to bypass JIT -- this is functional but produces lower throughput. Install build-essential and drop `--enforce-eager` for all non-emergency runs.

**Verify endpoints:**
- **0a.** Embedder: `curl -s -X POST http://localhost:8000/v1/embeddings -H 'Content-Type: application/json' -d '{"model":"Qwen/Qwen3-Embedding-8B","input":"test"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data'][0]['embedding']))"` -- should print `4096`.
- **0b.** Reranker: confirm `POST http://localhost:8001/v1/rerank` responds with a scored list.

---

**Originally specified path: Docker Compose (environmentally blocked on this machine)**

The docker-compose configuration below is retained as the upstream-pristine reference. A future operator on a machine where Docker can pull multi-GB images may find this path viable. On the Principal's current machine it is not the active path.

Note: the NVIDIA Container Toolkit must be installed before `runtime: nvidia` is honored. In Docker Desktop on Windows, enable: Settings -> AI -> "GPU-backed inference". See README.md `## Gotchas` for the Container Toolkit setup detail.

#### Eval corpus expansion (precondition for the Phase 1 eval gate)

**Status as of 2026-05-14: complete.** The corpus was expanded from 22 fixtures + 18 queries to 42 fixtures + 38 queries during the Phase 1 bring-up session. The refreshed baseline (recall@1=0.7222, MRR=0.8296, negative_precision=1.0) is recorded in `test/eval/baseline.json` and is the reference for all subsequent Bundle A acceptance gates.

The expansion targeted cross-chunk co-reference and section-heading continuity -- queries whose correct answers depend on context from an adjacent chunk in the source document, the exact failure mode late chunking addresses. Baseline metrics dropped from the pre-expansion ceiling as expected, opening headroom for Phase 3 gains to register as statistically meaningful.

**Known near-duplicate corpus pairs.** Several new fixtures introduced near-duplicate (title, topic) pairs that cause top-1 retrieval interference on existing queries under mxbai-1024. These pairs are expected to be disambiguated by the Phase 3 reranker. They are documented in Phase 3 (see "Known corpus near-duplicates" note).

#### Embedder upgrade

**What changes.** The embedding model for all new and backfilled writes switches from `mxbai-embed-large` (1024-dim) to `Qwen/Qwen3-Embedding-8B` (4096-dim), served via a vLLM Docker container. The `embedding` columns on `memory_entries` and `memory_entry_chunks` are redeclared as `vector(4096)`. All 137 decisions rows migrated in Phase 0, plus any existing memory fixtures, are re-embedded at 4096-dim. The embed call path in `pipeline-embed.js` is updated to route to the vLLM embedder endpoint.

**vLLM embedder configuration.**
- Model: `Qwen/Qwen3-Embedding-8B` at Q8 quantization
- Runner flag: `--runner pooling` (vLLM 0.20.x; replaces the pre-0.20 `--task embed` flag)
- GPU cap: `--gpu-memory-utilization 0.40` (caps at approximately 9.6 GB on a 24 GB card)
- Exposed port: `8000` (OpenAI-compatible `/v1/embeddings` endpoint)
- Deployment: native WSL (active path); Docker (reference path -- see Section 4)

**Why vLLM for the embedder, not Ollama.** Two gaps make Ollama unsuitable for late chunking: (a) Ollama returns pooled vectors per request and does not expose token-level hidden states required for the mean-pooling-over-spans technique described in the Jina late chunking paper (arXiv:2409.04701); (b) Ollama has no native reranker endpoint as of this writing (PR #7219 unmerged). vLLM 0.20.x supports `--runner pooling` with sequence-level outputs and native cross-encoder rerank tasks, resolving both gaps. Ollama remains in use for the blurb LLM (`qwen2.5:14b`) because that path already works and the swap would be consolidation work, not a capability gap fix.

**Why this belongs in Bundle A.** Phase 2 (retrieval_events) declares a `query_embedding vector(4096)` column; Phase 3 (reranker + late chunking) depends on 4096-dim embeddings being in place. Dimension must be established before downstream schema and pipeline phases.

**Substrate touched.** `memory_entries.embedding`, `memory_entry_chunks.embedding` — column type change from `vector(1024)` to `vector(4096)`. HNSW index rebuilt at new dimension. vLLM Docker container for the embedder. The `pipeline.yml` config key `embedding_model` and embed endpoint URL are updated.

**Order of operations.**
1. Bring up the vLLM embedder service (see Section 4 for native WSL launch commands; Docker reference also in Section 4). Verify GPU access and model load. Run the 4096-dim endpoint check from Step zero.
2. Add `embedding_4096 vector(4096)` alongside the existing `embedding vector(1024)` on both tables (dual-column transition window).
3. Run re-embed pass on all rows using the vLLM embedder endpoint; write to `embedding_4096`.
4. Run the eval harness (expanded fixture set) against the `embedding_4096` column. If recall@1 does not regress by more than 2 percentage points from the refreshed baseline, proceed.
5. Rename: `ALTER TABLE ... RENAME COLUMN embedding TO embedding_mxbai_1024_archive; RENAME COLUMN embedding_4096 TO embedding;` (or DROP old column after one-week soak if storage is a concern).
6. Rebuild HNSW index at `vector(4096)`.
7. Update `pipeline-embed.js` to use the vLLM embedder endpoint instead of `ollamaEmbed()`.

**Dependencies.** Phase 0 must be complete. All 137 decisions rows must exist in `memory_entry_chunks` before the embed backfill pass.

---

#### Phase 1 step 5 — ANN Indexability via halfvec(4000) + Matryoshka Truncation

**Motivation.** After step 4 (embedder swap to Qwen3 at 4096-dim), retrieval is still a sequential scan. pgvector 0.8.1 imposes a hard cap on HNSW indexes: `vector` type is capped at **2000 dims**; `halfvec` type is capped at **4000 dims**. A `vector(4096)` column cannot have an HNSW index at all — confirmed experimentally. At the current corpus scale of ~800 chunks, a seq scan completes in milliseconds. But cross-Claude-session daily use means the corpus grows continuously; at 10k+ chunks, seq scan latency becomes user-visible. Step 5 fixes this before corpus growth forces an emergency migration.

**pgvector constraint matrix (0.8.1):**
| Type | Max dims for HNSW | Max dims for IVFFlat |
|---|---|---|
| `vector` | 2000 | 2000 |
| `halfvec` | 4000 | 4000 |
| `bit` | 64000 | 64000 |
| `sparsevec` | 1000 (non-zero) | — |

**Matryoshka rationale.** Qwen3-Embedding-8B is explicitly Matryoshka-trained (per its Hugging Face model card): the model is fine-tuned so that the first N leading dimensions of its output remain a high-quality embedding. Truncating from 4096 to 4000 leading dims is semantically equivalent to training with `output_dim=4000` — the leading dims carry the semantic load; the trailing 96 dims carry marginal signal. This is not padding zeros or random truncation; it is the expected usage pattern for the Matryoshka family.

**Why `halfvec(4000)` over alternatives:**
- **Binary quantization (`bit`):** Extreme compression but meaningful recall loss at this corpus scale. Reranker can recover some precision, but the initial recall floor is lower. Ruled out until corpus > 50k chunks.
- **Smaller embedder:** Downgrading to a 512-dim or 768-dim model would regress quality established in steps 1–4. Phase 3 reranker depends on 4000-dim semantic richness.
- **Two-column hybrid (`vector(2000)` for ANN + `vector(4096)` for reranker):** Complex write path, 2× storage, and the reranker operates on existing chunk content, not embedding vectors — so the 4096-dim full vector is not needed at query time anyway.

**Canonical migration pattern for embedding column type changes.** pgvector rejects `ALTER COLUMN TYPE` on a column referenced by a view (a Postgres-side constraint, not pgvector-specific). The repository pattern: extract dependent view DDL to `scripts/sql/<view>.sql`, wrap migrations as `BEGIN; DROP VIEW ...; ALTER COLUMN TYPE ...; \ir scripts/sql/<view>.sql; COMMIT;`. `v_memory_hits` lives at `scripts/sql/v_memory_hits.sql`; `scripts/setup.sql` `\ir`s it. Future schema migrations on `memory_entries.embedding` or `memory_entry_chunks.embedding` follow this pattern.

**Conversion DDL (executed in Phase 1, step 5):**
```sql
BEGIN;
-- Drop view that references the embedding column; re-applied via \ir after ALTER
DROP VIEW IF EXISTS v_memory_hits;

-- Drop the empty archive columns (mxbai-1024 archive; no soak data)
ALTER TABLE memory_entries DROP COLUMN IF EXISTS embedding_mxbai_1024_archive;
ALTER TABLE memory_entry_chunks DROP COLUMN IF EXISTS embedding_mxbai_1024_archive;

-- Convert vector(4096) to halfvec(4000) by Matryoshka truncation
ALTER TABLE memory_entries
  ALTER COLUMN embedding TYPE halfvec(4000)
  USING subvector(embedding, 1, 4000)::halfvec(4000);

ALTER TABLE memory_entry_chunks
  ALTER COLUMN embedding TYPE halfvec(4000)
  USING subvector(embedding, 1, 4000)::halfvec(4000);

-- Build HNSW indexes on the converted column
CREATE INDEX memory_entries_vec_idx
  ON memory_entries USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX mem_chunks_vec_idx
  ON memory_entry_chunks USING hnsw (embedding halfvec_cosine_ops);

-- Recreate v_memory_hits from its canonical source file
\ir scripts/sql/v_memory_hits.sql
COMMIT;
```

**Code changes at step 5:**
- `scripts/lib/shared.js` — `vllmEmbed()` truncates returned vectors to `EMBED_DIMS` (default 4000, set by `process.env.EMBED_DIMS`) before returning. Configurable for future re-tuning (e.g., `EMBED_DIMS=3500`).
- `scripts/pipeline-embed.js` — all SQL `$N::vector` casts updated to `$N::halfvec(4000)`.
- `test/eval/eval-retrieval.js` — hybrid SQL cast updated; two-column routing (`embedding_4096` / `v_memory_hits_4096`) retired; both backends now use `embedding` and `v_memory_hits`.
- `scripts/pipeline-memory-loader.js` — `embedPending()` skips Ollama inline embed when `EMBED_BACKEND=vllm` to prevent timeout during eval harness loader subprocess invocation.
- `scripts/sql/v_memory_hits.sql` (new) — extracted view DDL; `scripts/setup.sql` sources this file via `\ir sql/v_memory_hits.sql`. Single source of truth for the view definition.

**Eval acceptance gate (Phase 1.5):**
After conversion, the eval harness must pass:
- recall@1 must not regress more than 1pp from post-step-4 baseline of 0.7778 (floor 0.6778).
- recall@3_relaxed must remain within 5pp of 1.0 (floor 0.95).
- MRR must not regress more than 2pp from post-step-4 baseline of 0.8542 (floor 0.8342).
- negative_precision must equal 1.0 (strict, score-aware at threshold 0.5).
- HNSW indexes must exist on both tables.

**Measured result (2026-05-14):** recall@1=0.7778 (no regression), recall@3_relaxed=1.0, MRR=0.8542 (no regression), negative_precision=1.0. All gates PASS.

**Dependencies.** Phase 1 steps 1–4 must be complete. The embedding column must be populated at 4096-dim before conversion.

---

### Phase 2 — Schema: Knowledge Graph + Retrieval Infrastructure

**What changes.** Six new tables are introduced: `retrieval_events`, `entities`, `assertions`, `edges`, `retrieval_contract`, and `project_settings`. This restores the knowledge graph tables that were deferred in v2, but with a more precise writer model: the writer is Claude (extracting at session-end via `/handoff:close`) and any manual write the Principal performs directly. This is not "schema before writer" — the writer ships in the same bundle (Phase 3.5). The SessionStart loader reads from these tables. This closes the full read/write loop within Bundle A.

**The `project_id` convention.** All six tables carry `project_id TEXT NOT NULL` with no DEFAULT value. The writer must set `project_id` explicitly to the `encoded_cwd` value for the current working directory, computed by `scripts/lib/encoded-cwd.js`. For the claude-memory project, `encoded_cwd = 'C--Users-djwmo-dev-claude-memory'`. This convention is established from day one so no future migration is needed when multi-project usage emerges.

`retrieval_events` is created in Bundle A specifically because Phase 3 (reranker) begins writing to it immediately. Outcome capture (updating the `outcome` column) is Bundle B scope; the table is created here because the writer (the reranker logging its candidate set) is in Bundle A.

**Substrate touched.** Postgres schema: six CREATE TABLE statements, associated CREATE INDEX statements, no data writes in Phase 2, no existing tables modified.

**Order of operations.**
1. Apply the Phase 2 DDL migration from Section 4.
2. Verify all tables and indexes are present (see Verification SELECTs in Section 5, V4–V15).
3. No data migration in this phase.

**Dependencies.** Phase 1 must be complete. The `retrieval_events.query_embedding vector(4096)` column must match the dimension established by Phase 1.

---

### Phase 3 — Reranker, Late Chunking, and Contextual Blurbs

**What changes.**

**Reranker (vLLM).** `Qwen/Qwen3-Reranker-4B` is added as a cross-encoder second-stage precision filter in the retrieval path. The retrieval path becomes: vector recall top-20 candidates → reranker re-scores all 20 against the query → return top-10 by reranker score. The reranker is served via a dedicated vLLM Docker container. Top-30 is acceptable if first measurement shows it fits the latency budget; top-20 is the default. `retrieval_events` rows are written at each reranker call.

**vLLM reranker configuration.**
- Model: `Qwen/Qwen3-Reranker-4B` at Q8 quantization
- Runner flag: `--runner pooling` (vLLM 0.20.x; cross-encoder rerank task)
- GPU cap: `--gpu-memory-utilization 0.25` (caps at approximately 6 GB on a 24 GB card)
- Exposed port: `8001`
- Deployment: native WSL (active path); Docker (reference path -- see Section 4)

**Why vLLM for the reranker, not Ollama.** Ollama has no native `/api/rerank` endpoint in the mainline release (PR #7219 unmerged). The workaround — using embedding magnitude as a relevance proxy — is semantically incorrect. vLLM supports native cross-encoder rerank tasks at the model's correct inference path.

**Combined VRAM budget and Windows desktop overhead.** The RTX 3090 has 24 GB total VRAM. Windows desktop overhead — dwm and Edge WebView baseline processes — consumes approximately 4.2 GB as observed via `nvidia-smi` on 2026-05-14. The effective usable VRAM ceiling for inference is therefore approximately 20 GB, not 24 GB.

Allocation at steady state: embedder container ~9.6 GB (0.40 × 24 GB cap) + reranker container ~6 GB (0.25 × 24 GB cap) = ~15.6 GB resident in vLLM containers. Windows desktop overhead: ~4.2 GB. Total: ~19.8 GB. Headroom: ~4.2 GB remaining on the card.

**Blurb LLM operational sequencing.** `qwen2.5:14b` at Q4 quantization requires approximately 9 GB VRAM. With both vLLM services running, there is insufficient headroom to load the blurb LLM simultaneously. Blurb generation and embed/rerank do not co-reside; they are time-sequenced steps in the corpus ingest pipeline. The operational sequence is:

1. Stop vLLM services (kill the WSL processes, or reduce their `--gpu-memory-utilization` caps temporarily).
2. Run Ollama with `qwen2.5:14b` to generate blurbs for new/changed chunks.
3. Restart vLLM services.
4. Run the embed pass (vLLM embedder) on the blurb-prefixed chunk texts.

This is not a blocking limitation — it is a sequencing constraint. Document it in the ingest pipeline orchestration script.

**VRAM cap model.** In the native WSL path, `--gpu-memory-utilization` is enforced at the vLLM process level. vLLM with an explicit utilization cap refuses to allocate beyond the limit and fails loudly at startup rather than silently degrading at inference time -- the same behavior as the Docker path. This is distinct from Ollama, which has no explicit utilization cap and silently spills to system RAM when VRAM is exhausted (the Principal's prior experience with a 27B model at Q4). Q8 quantization is chosen over FP16 specifically because: at FP16, the embedder (~16 GB) + reranker (~8 GB) = ~24 GB, leaving zero headroom and guaranteed overflow on this card. Q8 preserves embedding quality for retrieval (the meaningful dynamic range lives in early-layer attention, which Q8 preserves) at half the VRAM footprint.

**Late chunking — primary path.** Send the full document (up to 8k tokens) to the vLLM embedder with a request for sequence-level per-token outputs. Client-side code mean-pools over chunk-specific token spans to produce one vector per chunk. This is the cleanest deployment: single inference stack for all embeddings.

**Late chunking — fallback path.** If the vLLM online API in the installed version returns pooled vectors only with no per-token-output flag, deploy a Transformers sidecar: a thin FastAPI service in Docker that loads `Qwen/Qwen3-Embedding-8B` via Hugging Face Transformers with `output_hidden_states=True`, exposes a single endpoint `POST /late_chunk` taking `{text: str, chunk_offsets: [[start, end], ...]}` and returning `{vectors: [[float; 4096], ...]}`. Approximately 150 lines of Python. The sidecar is used only if the vLLM primary path cannot expose per-token outputs cleanly.

**Decision criterion.** Try vLLM primary first; fall back to sidecar if vLLM's online embedding API in the installed version returns pooled vectors only with no per-token-output flag.

**Reranker fallback.** If the reranker vLLM call fails at query time, retrieval falls back to vector-only top-K return. The fallback must be implemented as an explicit error handler, not a silent pass-through.

**Contextual blurbs.** At chunk insertion time (in `pipeline-memory-loader.js`), the local LLM (`qwen2.5:14b` via Ollama, already installed) generates a blurb of no more than 200 tokens: "This chunk is from `<doc-name>`, under section `<heading>`, discussing `<topic-inferred-from-context>`." The blurb is prepended to the chunk text before embedding. The stored `memory_entry_chunks.content` field remains the original chunk text (the blurb is not persisted — it is ephemeral input to the embedder only). A runtime length guard must be implemented: if the blurb exceeds 200 tokens, it is truncated or the embedding proceeds without the blurb for that chunk, and the event is logged.

**Why this belongs in Bundle A.** Late chunking and contextual blurbs depend on the 4096-dim model and the vLLM inference stack established in Phase 1. The reranker operates on the same embedding space. All three techniques are substrate modifications to the embedding and retrieval pipeline; they are not retrieval contract changes (those are Bundle B).

**Substrate touched.** `pipeline-embed.js`, `pipeline-memory-loader.js`, `scripts/lib/shared.js`. vLLM Docker container for the reranker. `retrieval_events` rows begin accumulating once the reranker path is wired. Outcome capture — writing the `outcome` column — is Bundle B scope.

**Order of operations.**
1. Bring up the vLLM reranker service (see Section 4 for native WSL launch commands). Verify GPU access, per-service memory cap, model load.
2. Implement the reranker call in the retrieval path. Wire `retrieval_events` logging.
3. Implement contextual blurb generation in `pipeline-memory-loader.js` (Ollama call to `qwen2.5:14b`; 200-token budget with runtime guard; prepend-before-embed only). Note: blurb generation runs with vLLM containers stopped per the operational sequencing described above.
4. Implement late chunking in the embed path (vLLM primary; sidecar fallback if needed).
5. Re-embed the corpus with blurbs + late chunking active.
6. Run the eval harness; confirm acceptance thresholds from Section 6 are met.

**Known corpus near-duplicates (Phase 3 reranker calibration targets).** The following four fixture pairs were identified during the 2026-05-14 corpus expansion as near-duplicates that cause top-1 retrieval interference under mxbai-1024. The reranker's cross-encoder scoring is expected to disambiguate them. Reranker tuning work should explicitly test these pairs:

| Pair | Fixture A | Fixture B |
|---|---|---|
| 1 | `bge-e5-model-families` | `embedding-model-selection` |
| 2 | `multi-vector-retrieval` | `semantic-chunking-strategies` |
| 3 | `tsvector-weight-classes` | `tsvector-explained` / `sql-fts-tsvector-recipes` |
| 4 | `rag-fusion-strategies` | `reciprocal-rank-fusion` |

If the reranker does not resolve these pairs, the precision@5 improvement threshold in Section 6 will be hard to meet.

**Dependencies.** Phases 0, 1, and 2 must be complete.

---

### Phase 3.5 — The `/handoff` Skill

#### Skill location and scope

The `/handoff` skill is **user-scoped**, installed at `~/.claude/commands/handoff/` (or the equivalent skill directory the implementer selects based on Claude Code's plugin/skill mechanism). User-scoped install is a requirement, not a preference: the whole point is cross-project memory continuity. A project-scoped install would defeat that purpose. Per-project configuration (staleness threshold, decay rate, etc.) lives in the `project_settings` table keyed by `project_id`, not in the skill installation itself.

Explicit registration of the skill in Claude Code's command surface is a Phase 3.5 order-of-operations step; the risk register (Section 10) flags this as a low-likelihood but real failure mode.

#### Seven subcommands

Each subcommand emits `Running: handoff:<sub>` at start and `Done: handoff:<sub> — <one-line result>` at finish. This visibility pattern is required behavior, not optional. Output streams to the user; suppressed only when explicitly silent-mode is requested.

**`/handoff:init`** — First-run provision.
1. Apply Bundle A schema migrations if absent (idempotent).
2. Create `~/.claude/projects/{encoded_cwd}/handoff.md` from template with current datestamp.
3. Create a project-level `CLAUDE.md` at the project root if absent — a small file containing a brief project description, skill invocation hints (`/handoff:status`, `/handoff:resume`, `/handoff:close`), the path to the handoff.md file, and empty placeholders for durable facts. Git-committed.
4. Insert a default `retrieval_contract` row for this `project_id` with `name = 'default'`.
5. Output: confirmation summary of what was created.

**`/handoff:status`** — Read-only inspection.
Shows: last close datestamp, days since close, count of entities/assertions/edges scoped to this project, current retrieval contract names, any "session in progress" orphan markers. No writes.

**`/handoff:resume`** — Explicit continuation despite staleness.
Runs the SessionStart loader's load step regardless of staleness threshold. Used when the user acknowledges stale state and wants to proceed anyway.

**`/handoff:drop`** — Archive prior session memory for this project.
Marks all current assertions as `confidence = 0` (effective_confidence = 0; suppressed from retrieval) rather than deleting. Recoverable via SQL. Renames the handoff.md file to `handoff.{datestamp}.archived.md`. Creates a new empty handoff.md.

**`/handoff:checkpoint`** — Mid-session save without close.
Same extraction as `:close` but does not end the "session in progress" marker. Useful for long sessions where the user wants to preserve progress without formally ending the session.

**`/handoff:close`** — End-of-session extraction.
Claude extracts from the in-context conversation:
- Entities mentioned (with type annotation).
- Assertions made (with `confidence` 1–10 based on firmness: user-stated durable facts score high; model-inferred tentative conclusions score low).
- Edges (typed relationships between entities).
- A `retrieval_contract` for the next session (JSONB query objects covering likely next-session retrieval needs).

Claude then writes:
- Rows into `entities`, `assertions`, and `edges` tables for this `project_id`.
- An updated `retrieval_contract` row for `name = 'default'`.
- The `handoff.md` file (see format subsection below) with YAML frontmatter contract and body TL;DR.

Claude surfaces CLAUDE.md promotion candidates — assertions with confidence ≥ 9 and source = `user_stated` that have been reinforced across multiple sessions — and asks the user for confirmation before writing to CLAUDE.md.

**Reranker precision@5 gate (§6).** As part of `:close` (and identically for `:checkpoint`), if `(SELECT COUNT(*) FROM memory_entry_chunks WHERE project_id = $project_id) >= project_settings.precision_at_5_gate_min_chunks` (default `1000`), the skill runs the eval harness in both `--rerank` and vector-only modes against the project's representative query set, computes precision@5 for each, and reports `Δ = reranker - vector-only`. If `Δ < 0.05`, surface a warning to the user with the two precision@5 values and the suggestion to either (a) defer the next reranker re-tune or (b) inspect for corpus drift. If corpus is below threshold, emit `Reranker gate: SKIPPED — corpus n=<count> below threshold=<threshold>` and proceed. The warning is informational, not blocking — the close still completes.

**`/handoff:purge`** — Hard delete with confirmation gate.
Removes all rows for the current `project_id` from `entities`, `assertions`, `edges`, `retrieval_contract`, and `project_settings`. Deletes the `handoff.md` file. Requires an explicit confirmation response from the user before executing. Not reversible.

#### handoff.md file format

Location: `~/.claude/projects/{encoded_cwd}/handoff.md`. For the claude-memory project: `~/.claude/projects/C--Users-djwmo-dev-claude-memory/handoff.md`.

File size budget: a few KB. Substance lives in Postgres. The file is a navigational pointer plus session TL;DR, not a knowledge store.

Not git-committed. Rewritten at every `/handoff:close`.

```yaml
---
project_id: <encoded_cwd>
last_close: 2026-05-13T22:30:00Z
contract: default
session_summary:
  entities_written: 23
  assertions_written: 47
  edges_written: 12
---

# Handoff — <project name>

## TL;DR
<3–5 sentences summarizing state of play>

## Open threads
- <pending decision or task>
- <...>

## Quick references
<optional named handles the user wants surfaced explicitly>
```

#### CLAUDE.md vs handoff.md split

Two documents with distinct roles:

- **CLAUDE.md** (project root, e.g., `C:\Users\djwmo\dev\claude-memory\CLAUDE.md`) — durable, slow-changing project context. Created by `/handoff:init` if absent. Contains: skill invocation hints, key paths, the 1–2 highest-confidence durable facts about the project (initially empty; populated by promotion from `/handoff:close`). Git-committed.
- **handoff.md** (per-CWD, `~/.claude/projects/{encoded_cwd}/handoff.md`) — transient session-state pointers. Rewritten every `/handoff:close`. Not git-committed.

`/handoff:close` identifies promotion candidates: assertions with confidence ≥ 9 and source = `user_stated` that have been reinforced across multiple sessions. The user is asked before any write to project CLAUDE.md.

#### First-ever `/handoff:close` — the seed pattern

The first close run on a project should be expected to extract everything from the seed conversation: project name, current Bundle being worked on, stack choices, design decisions, scoring system, preferred patterns, etc. This is the bootstrap from "empty memory" to "seeded memory." Because the first extraction starts from zero, the Principal should review the extraction output before the next session loads from it. Using `/handoff:checkpoint` as the first invocation — rather than `:close` — allows manual review of extraction output before formally committing as a close.

---

### Phase 3.6 — SessionStart Loader Hook

The SessionStart loader is triggered via a SessionStart hook in `~/.claude/settings.json` or a project-level hook.

**Behavior on invocation:**
1. Resolve `encoded_cwd` from the current working directory using the `encodeCwd` function from `scripts/lib/encoded-cwd.js`.
2. Read `~/.claude/projects/{encoded_cwd}/handoff.md` if present; skip gracefully if absent.
3. Parse YAML frontmatter; extract retrieval contract name (default: "default").
4. Look up the contract row in `retrieval_contract` table for this `project_id`.
5. **Staleness check:** if `(now() - handoff.last_close) > staleness_days` (default 7 days; configurable via `project_settings` key `staleness_days`): surface a `:status` summary to the user and offer the choices `:resume` / `:drop` / `:status` instead of auto-loading. The hook surfaces staleness state but does not block session start — the user runs the chosen subcommand from the new session.
6. If non-stale or user chose `:resume`: execute each query in the contract's `queries` JSONB array, respecting the per-query `token_budget`. The query types supported: `"entity"`, `"assertion"`, `"vector"`, `"recency"`.
7. **Live "used" event:** for each assertion returned by a retrieval query, `UPDATE assertions SET last_reinforced = now(), last_retrieved = now() WHERE id = <row_id>`. Every retrieval counts as a use event. This is the coarser-but-simpler reinforcement signal (option a): any retrieval bumps `last_reinforced`, including retrieved-but-not-actually-referenced assertions. The tradeoff is simpler implementation and full user visibility vs. less precision than a retrieve-and-reference signal (which would require Claude to cite specific assertion IDs in output). If precision becomes a problem after first usage, revisit in a future bundle.
8. Inject compact context into session start: a brief summary of what was loaded.

**Hook emits:**
- `Running: handoff loader (project=<encoded_cwd>, last=<N> days ago)` at start.
- `Done: handoff loader — injected <N> assertions, <M> entities, <K> vector matches` at finish.

**Token budget:** the loader's total injected context defaults to 4000 tokens (configurable via `project_settings` key `loader_token_budget`). Per-query `token_budget` values in the JSONB sum to this ceiling.

---

### Phase 3.7 — Stop-Hook Safety Net

A Stop hook in `~/.claude/settings.json` checks at session end whether `/handoff:close` (or `:checkpoint`) ran during this session.

- If yes: no-op.
- If no: runs an implicit `:close` with default extraction behavior.

Configurable per project via `project_settings` key `implicit_close` (value `'enabled'` or `'disabled'`). If a project sets `implicit_close = 'disabled'`, the Stop hook skips extraction silently.

---

## 4. Schema Migrations and Docker Configuration

> **Phase 3.8 schema split (added 2026-05-15).**
> The schema is now split into two files with distinct portability guarantees:
>
> | File | Applied by | Requires |
> |---|---|---|
> | `scripts/sql/handoff-core-schema.sql` | `/handoff:init` automatically | Stock Postgres >= 13, no extensions |
> | `scripts/sql/app-retrieval-events-schema.sql` | Manual `psql -f` or pipeline setup | pgvector extension (`halfvec` type) |
> | `scripts/sql/phase3b-schema.sql` | Manual `psql -f` or pipeline setup | `memory_entry_chunks` table from `setup.sql` |
>
> `handoff-core-schema.sql` contains the five handoff-core tables (`entities`, `assertions`, `edges`,
> `retrieval_contract`, `project_settings`) and is safe to apply on any Postgres instance without
> pgvector. `app-retrieval-events-schema.sql` installs `retrieval_events` with its `halfvec(4000)`
> embedding column and requires pgvector 0.8.1+. `phase3b-schema.sql` adds `memory_entry_chunks.blurb`
> and is app-specific (requires the `memory_entry_chunks` table from `scripts/setup.sql`).

### vLLM deployment -- native WSL (active path)

See Phase 1, Step zero for the full native WSL install and launch commands. Summary for reference:

```bash
# embedder (port 8000 -- verify no Windows listener before starting)
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Embedding-8B \
  --runner pooling --quantization bitsandbytes --load-format bitsandbytes \
  --dtype auto --gpu-memory-utilization 0.40 --port 8000

# reranker (port 8001)
~/.venv/vllm/bin/vllm serve Qwen/Qwen3-Reranker-4B \
  --runner pooling --quantization bitsandbytes --load-format bitsandbytes \
  --dtype auto --gpu-memory-utilization 0.25 --port 8001
```

Port alternatives if 8000/8001 are preempted: use `8800`/`8801` or `18000`/`18001`. Update the embed endpoint URL in `pipeline.yml` accordingly.

---

### Docker Compose -- vLLM containers (originally specified; environmentally blocked on this machine)

This configuration was the originally specified deployment path. It is retained here as a reference for future operators on machines where Docker Desktop can pull multi-GB images. On the Principal's Windows 11 machine, Docker Desktop 29.4.3 failed to pull `vllm/vllm-openai` (repeated EOF errors on blob fetch from `production.cloudfront.docker.com`). Do not use this path on the Principal's machine without first verifying the pull succeeds.

The GPU resource model: `--gpus all` passes full GPU access to the container; per-container VRAM caps are enforced at the vLLM layer, not the Docker layer.

```yaml
# docker-compose.yml (vLLM services -- reference path, not active on this machine)
services:
  vllm-embedder:
    image: vllm/vllm-openai:latest
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
    command: >
      --model Qwen/Qwen3-Embedding-8B
      --runner pooling
      --quantization bitsandbytes
      --load-format bitsandbytes
      --dtype auto
      --gpu-memory-utilization 0.40
      --port 8000
    ports:
      - "8000:8000"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

  vllm-reranker:
    image: vllm/vllm-openai:latest
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
    command: >
      --model Qwen/Qwen3-Reranker-4B
      --runner pooling
      --quantization bitsandbytes
      --load-format bitsandbytes
      --dtype auto
      --gpu-memory-utilization 0.25
      --port 8001
    ports:
      - "8001:8001"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

Note: the NVIDIA Container Toolkit must be installed before `runtime: nvidia` is honored. In Docker Desktop on Windows: Settings -> AI -> "GPU-backed inference". This is called out in the risk register (Section 10).

### Phase 1 DDL — column widening and halfvec(4000) conversion

Phase 1 executed in two sub-stages:

**Steps 1–4 (dual-column transition, now complete):** Added `embedding_4096 vector(4096)` alongside the original `embedding vector(1024)` column, ran eval gate, then renamed to promote `embedding_4096` as the primary column. The `embedding_mxbai_1024_archive` archive column was created but never soaked (the eval harness wiped it pre-swap).

**Step 5 (halfvec conversion, now complete — see Phase 1 step 5 section above):** Converted the `embedding vector(4096)` column to `halfvec(4000)` via Matryoshka truncation. The Phase 1 final DDL state is:

```sql
-- Final state after Phase 1 steps 1-5 (for reference; already applied):
-- embedding column on both tables is halfvec(4000)
-- HNSW indexes built with halfvec_cosine_ops

-- To verify current state:
SELECT column_name, udt_name, character_maximum_length
FROM information_schema.columns
WHERE table_name IN ('memory_entries', 'memory_entry_chunks')
  AND column_name = 'embedding';
-- Expected: udt_name = 'halfvec', character_maximum_length = 4000

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('memory_entries', 'memory_entry_chunks')
  AND indexname LIKE '%vec%';
-- Expected: memory_entries_vec_idx (hnsw, halfvec_cosine_ops)
--           mem_chunks_vec_idx (hnsw, halfvec_cosine_ops)
```

**HNSW index notes.** At current scale (hundreds of chunks), the default `maintenance_work_mem` (64 MB) is sufficient for HNSW builds. At 10k+ chunks, set `maintenance_work_mem = '1GB'` before `CREATE INDEX`. The halfvec(4000) index is approximately 12 MB at 800 chunks.

### Phase 2 DDL — retrieval_events + knowledge graph + retrieval infrastructure

All tables include `project_id TEXT NOT NULL` with no DEFAULT value. The writer must supply the `encoded_cwd` value explicitly.

```sql
-- ============================================================================
-- RETRIEVAL_EVENTS — log of every retrieval call; outcome posted by Bundle B.
-- This table is created in Bundle A because the reranker (Phase 3) begins
-- writing to it. Outcome capture (the 'outcome' column) is Bundle B scope.
-- project_id = encoded_cwd value; no DEFAULT — must be set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_events (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  query_embedding halfvec(4000),  -- matches memory_entry_chunks.embedding type (halfvec(4000) after Phase 1 step 5)
  retrieved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome         TEXT DEFAULT 'pending'
                    CHECK (outcome IN ('pending','success','failure','irrelevant')),
  outcome_at      TIMESTAMPTZ,
  outcome_signal  TEXT,  -- 'user_explicit'|'user_correction'|'task_completion'|'auto_decay'|'agent_self_report'
  session_id      TEXT,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS retrieval_events_project_idx
  ON retrieval_events (project_id);
CREATE INDEX IF NOT EXISTS retrieval_events_outcome_idx
  ON retrieval_events (outcome) WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS retrieval_events_time_idx
  ON retrieval_events (retrieved_at DESC);


-- ============================================================================
-- ENTITIES — typed named entities extracted at /handoff:close.
-- Writer: Claude (session-end extraction) and manual writes by the Principal.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS entities (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- e.g. 'person', 'system', 'concept', 'decision', 'file'
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id  TEXT,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS entities_project_idx
  ON entities (project_id);
CREATE INDEX IF NOT EXISTS entities_name_idx
  ON entities (project_id, name);


-- ============================================================================
-- ASSERTIONS — typed subject/predicate/object triples with 1-10 confidence.
--
-- Confidence scoring (1-10):
--   9-10  user_stated durable facts ("the DB is on localhost", "we chose vLLM")
--   7-8   strongly inferred from multiple user statements in session
--   5-6   model-extracted from context with moderate support
--   3-4   tentative inference; contradicting signals present
--   1-2   speculative; should be revisited
--
-- Decay formula (read-time, computed by the loader — column stores raw confidence):
--   effective_confidence = confidence * exp(-decay_rate * EXTRACT(EPOCH FROM
--     (now() - last_reinforced)) / 86400)
--
-- Suppression threshold: effective_confidence < 1.0 → excluded from retrieval.
-- Example: confidence=10, decay_rate=0.05 → survives ~46 days before suppression.
--          confidence=5, decay_rate=0.05  → survives ~32 days before suppression.
--
-- Reinforcement: every retrieval bumps last_reinforced = now() (live "used" event,
-- option a — coarser but simpler than retrieve-and-reference signal).
--
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS assertions (
  id               SERIAL PRIMARY KEY,
  project_id       TEXT NOT NULL,
  subject          TEXT NOT NULL,   -- entity name or topic string
  predicate        TEXT NOT NULL,   -- e.g. 'depends_on', 'is_status', 'prefers', 'chose'
  object           TEXT NOT NULL,   -- asserted value or referenced entity name
  confidence       FLOAT NOT NULL
                     CHECK (confidence >= 1.0 AND confidence <= 10.0),
  last_reinforced  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_retrieved   TIMESTAMPTZ,     -- informational; reinforcement is the binding signal
  decay_rate       FLOAT NOT NULL DEFAULT 0.05,  -- per-day decay rate
  source           TEXT NOT NULL
                     CHECK (source IN (
                       'user_stated',
                       'model_extracted',
                       'doc_quoted',
                       'retrieved_from_prior'
                     )),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id       TEXT
);
CREATE INDEX IF NOT EXISTS assertions_project_idx
  ON assertions (project_id);
CREATE INDEX IF NOT EXISTS assertions_subject_idx
  ON assertions (project_id, subject);
CREATE INDEX IF NOT EXISTS assertions_confidence_idx
  ON assertions (project_id, confidence DESC);


-- ============================================================================
-- EDGES — typed relationships between entities, extracted at /handoff:close.
-- Writer: Claude (session-end extraction) and manual writes by the Principal.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS edges (
  id           SERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  from_entity  TEXT NOT NULL,   -- entities.name (source)
  edge_type    TEXT NOT NULL,   -- e.g. 'depends_on', 'implements', 'blocks', 'owns'
  to_entity    TEXT NOT NULL,   -- entities.name (target)
  weight       FLOAT DEFAULT 1.0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id   TEXT
);
CREATE INDEX IF NOT EXISTS edges_project_idx
  ON edges (project_id);
CREATE INDEX IF NOT EXISTS edges_from_idx
  ON edges (project_id, from_entity);
CREATE INDEX IF NOT EXISTS edges_to_idx
  ON edges (project_id, to_entity);


-- ============================================================================
-- RETRIEVAL_CONTRACT — named retrieval plans executed by the SessionStart loader.
-- Each contract is a JSONB array of structured query objects. The loader walks
-- the array in order, executing each query against the appropriate table and
-- respecting the per-query token_budget.
--
-- Query object shape:
--   {
--     "kind": "entity" | "assertion" | "vector" | "recency",
--     "filter": { ... kind-specific filter fields ... },
--     "token_budget": <int>
--   }
--
-- /handoff:init inserts a default contract row for the project.
-- /handoff:close updates (or inserts) the default contract based on session state.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS retrieval_contract (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,    -- e.g. 'default', 'deep_load', 'minimal'
  queries     JSONB NOT NULL,   -- array of query objects (see shape above)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS retrieval_contract_project_idx
  ON retrieval_contract (project_id);


-- ============================================================================
-- PROJECT_SETTINGS — per-project key/value configuration store.
-- Used by the SessionStart loader and /handoff subcommands to read tunable
-- settings such as staleness_days, decay_rate_default, implicit_close, and
-- loader_token_budget. Falls back to hardcoded defaults if a key is absent.
-- project_id = encoded_cwd; no DEFAULT — set by the writer.
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_settings (
  project_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- Known settings keys and their hardcoded defaults (used when row is absent):
--   staleness_days      default: '7'    (days before loader triggers staleness prompt)
--   decay_rate_default  default: '0.05' (per-day decay for new assertions lacking row-level override)
--   implicit_close      default: 'enabled' ('enabled'|'disabled' — Stop-hook behavior)
--   loader_token_budget default: '4000' (total tokens the SessionStart loader may inject)
--   precision_at_5_gate_min_chunks  default: '1000' (chunk count above which the §6 reranker precision@5 gate is evaluated at /handoff:close|:checkpoint; below this, the gate is recorded as SKIPPED)
```

---

## 5. Verification SELECTs

Engineer runs these queries at READY_FOR_JUDGE. Each has an expected result shape.

| # | Query | Expected result |
|---|---|---|
| V1 | `SELECT count(*) FROM memory_entries WHERE mem_type = 'decision'` | 137 (all decisions migrated from source) |
| V2 | `SELECT count(*) FROM memory_entry_chunks WHERE embedding IS NOT NULL` | Equal to total chunk count; 0 rows with NULL embedding. All rows at halfvec dimension 4000 (after Phase 1 step 5). |
| V3 | `SELECT array_length(embedding::float4[], 1) AS dim, count(*) FROM memory_entry_chunks WHERE embedding IS NOT NULL GROUP BY 1` | Single row: `dim = 4000`, count = total chunk count. No 1024-dim or 4096-dim rows remaining in active column. (Note: `vector_dims()` is for `vector` type; halfvec uses cast to float4[] for dim check, or use `pg_column_size()` as a proxy.) |
| V4 | `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'retrieval_events'` | 1 row: `retrieval_events`. Confirms Phase 2 table is present. |
| V5 | `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'retrieval_events' AND column_name IN ('project_id','query_embedding','outcome') ORDER BY 1` | 3 rows confirming the key columns are present with correct types. |
| V6 | `SELECT indexname FROM pg_indexes WHERE tablename = 'retrieval_events'` | 3 rows: project_idx, outcome_idx, time_idx. |
| V7 | `SELECT count(*) FROM retrieval_events WHERE outcome = 'pending'` | 0 immediately after schema apply (no retrieval calls yet); number grows once Phase 3 reranker is wired. This query confirms the table is writable. |
| V8 | `SELECT c.relname, ic.relname AS indexname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indrelid = c.oid JOIN pg_class ic ON ic.oid = i.indexrelid WHERE c.relname IN ('memory_entries','memory_entry_chunks') AND ic.relname LIKE '%vec%'` | All returned rows have `indisvalid = true`. Confirms HNSW indexes are present and valid on both tables. Index type should be `hnsw` with `halfvec_cosine_ops` (after Phase 1 step 5). |
| V9 | `SELECT count(*) FROM memory_entries WHERE source_file LIKE 'decisions/%'` | 137. Confirms Phase 0 source-file convention was applied to all migrated decisions rows. |
| V10 | `SELECT count(*) FROM memory_entry_chunks mc JOIN memory_entries me ON me.id = mc.entry_id WHERE me.mem_type = 'decision' AND mc.embedding IS NULL` | 0. Confirms no decisions chunks escaped the Phase 1 embed backfill. |
| V11 | `SELECT count(*) FROM entities WHERE project_id = '<encoded_cwd>'` | Schema present and writable; count = 0 before first `/handoff:close` run. |
| V12 | `SELECT count(*) FROM assertions WHERE project_id = '<encoded_cwd>'` | Schema present and writable; count = 0 before first `/handoff:close` run. |
| V13 | `SELECT count(*) FROM edges WHERE project_id = '<encoded_cwd>'` | Schema present and writable; count = 0 before first `/handoff:close` run. |
| V14 | `SELECT count(*) FROM retrieval_contract WHERE project_id = '<encoded_cwd>' AND name = 'default'` | 1 after `/handoff:init` has been run. Confirms default contract was inserted. |
| V15 | `SELECT count(*) FROM project_settings WHERE project_id = '<encoded_cwd>'` | Schema present and writable; count = 0 or more depending on what `/handoff:init` inserts. |
| V16 | After a `/handoff:close` test run: `SELECT count(*) FROM assertions WHERE project_id = '<encoded_cwd>' AND session_id = '<test_session>'` | Should equal the expected extraction count from the golden fixture. Validates skill extraction quality. |

Note: replace `<encoded_cwd>` with the actual `encodeCwd()` output for the current working directory (e.g., `C--Users-djwmo-dev-claude-memory` for this project).

---

## 6. Acceptance Criteria

All retrieval thresholds are measured by running `PGUSER=postgres node test/eval/eval-retrieval.js` against the `claude_memory_eval_test` database after all phases complete. Baseline values are from `test/eval/baseline.json` (updated after eval corpus expansion in Phase 1).

| Criterion | Threshold | Rationale |
|---|---|---|
| Phase 1.5: halfvec(4000) conversion recall@1 | Must not fall below **0.6778** (post-step-4 baseline 0.7778 minus 0.01) | Matryoshka truncation from 4096 to 4000 dims preserves semantic load; 1pp gate is conservative. Measured result 2026-05-14: 0.7778 (no regression). |
| Phase 1.5: halfvec(4000) conversion MRR | Must not fall below **0.8342** (post-step-4 baseline 0.8542 minus 0.02) | 2pp budget. Measured result 2026-05-14: 0.8542 (no regression). |
| Phase 1.5: HNSW indexes | Both `memory_entries_vec_idx` and `mem_chunks_vec_idx` must exist with `indisvalid = true` and `halfvec_cosine_ops` operator class | Confirms ANN indexability is in place before corpus growth makes seq scan user-visible. |
| Recall@1 regression | Must not fall below **0.7278** (post-step-5 baseline 0.7778 minus 0.05) | 5pp regression budget for full Phase 3 (blurb + late chunking + reranker) gate. The Phase 1.5 measurement is now the reference. |
| MRR regression | Must not fall below **0.8042** (post-step-5 baseline 0.8542 minus 0.05) | 5pp budget for full Phase 3 gate. |
| Negative precision | Must equal **1.0** (strict, no regression allowed) | A negative-query leak is a correctness failure, not a quality tradeoff |
| Reranker precision@5 improvement | Must be at least **+5 absolute percentage points** over vector-only baseline measured in the same run. **Evaluated only at `/handoff:close` or `/handoff:checkpoint` when chunk count exceeds the corpus-size threshold below.** | Justifies the latency addition; if the reranker does not improve precision@5 by this margin once the corpus is large enough to make the metric meaningful, it is not earning its cost. Skipped on small corpora where both modes are at ceiling — see Phase 3.5 gating logic. |
| Reranker gate trigger | Gate fires when `(SELECT COUNT(*) FROM memory_entry_chunks) >= project_settings.precision_at_5_gate_min_chunks` (default `1000`). When corpus is below threshold, the gate is recorded as `SKIPPED — corpus n=<count> below threshold=<threshold>` rather than evaluated; this is not a regression. | Vector-only retrieval already saturates precision@5 on small corpora; the reranker's contribution only becomes measurable as topical noise grows in the top-K candidate pool. The default 1000-chunk threshold is calibrated against current corpus size (792 chunks as of 2026-05-14) plus modest near-term growth. Adjust per-project via `project_settings`. |
| Reranker p95 latency | Must not exceed **250ms** above pre-reranker baseline, measured over top-20 candidate pool via vLLM, on a batch of at least 30 representative queries post-deployment | vLLM cross-encoder inference at 4B params is well-benchmarked at sub-100ms per query on modern GPUs; 250ms is a conservative budget that accounts for Docker overhead and network latency to the container |
| Contextual blurb token length | Blurbs generated by `qwen2.5:14b` must not exceed **200 tokens** per chunk; runtime guard must truncate or skip blurbs that exceed this limit | Keeps embed-time overhead bounded |
| Decisions corpus completeness | V1 = 137, V9 = 137, V10 = 0 (see Section 5) | All 137 decisions present, all embedded at 4096-dim |
| Schema completeness | V4 = 1 row, V5 = 3 rows, V6 = 3 rows, V11–V13 schema present, V14 = 1 row (see Section 5) | Phase 2 tables present with required columns and indexes |
| `/handoff:close` extraction precision | Precision ≥ 0.7 on golden-session fixture (entities correctly identified out of those written) | Starting threshold; tunable after first run |
| `/handoff:close` extraction recall | Recall ≥ 0.6 on golden-session fixture (entities present in golden but found in extraction) | Starting threshold; tunable after first run |
| Loader token budget | SessionStart loader injected context must fit within 4000 tokens (configurable); verified on golden session | Keeps session startup cost bounded |

**Golden-session fixture creation is in-scope for Bundle A.** One or two sessions should be recorded with known expected extraction output: list of entities, assertions, edges. Approximately 2–3 hours of work. The fixture is the reference for the extraction quality criteria above.

---

## 7. Test Plan

The existing eval harness at `test/eval/eval-retrieval.js` is the primary vehicle. The following extensions are required for Bundle A:

**Precondition — eval corpus expansion.** Before any eval gate is run, add approximately 20 fixtures to `test/eval/fixtures/` targeting cross-chunk co-reference and section-heading continuity. Re-run the eval against the current mxbai-1024 baseline to refresh `baseline.json`. This expanded baseline is the reference for all Bundle A acceptance gates.

**Extension 1 — vector-only baseline measurement.** Add a `--vector-only` flag (or reuse `--ollama-skip` with a vector-only SQL path) that runs retrieval using only the embedding cosine score, no FTS term, and no reranker. This establishes the baseline against which precision@5 improvement is measured.

**Extension 2 — reranker path measurement.** Add a `--with-reranker` flag that runs the full Phase 3 path: vector recall top-20, then Qwen3-Reranker-4B re-scores to top-10 via vLLM, then report precision@5. Compare to the vector-only result from Extension 1.

**Extension 3 — delta report.** After both paths are measured, print a side-by-side delta table: per-query top-1 match, rank of expected doc, and whether the reranker changed the rank. Aggregate: precision@5 delta. This gives the Engineer per-query visibility into where the reranker helps and where it hurts.

**Extension 4 — bundle gate.** The eval harness already gates on recall@1 and MRR against baseline. Add gating on:
- Reranker precision@5 improvement ≥ 0.05 (Section 6, row 4).
- All V1–V16 verification SELECTs pass (report as a preflight before the query loop).

**Extension 5 — skill eval.** Against the golden-session fixture(s):
- Run `/handoff:close` on the recorded session transcript.
- Compare extracted entities, assertions, and edges against the annotated expected set.
- Report precision and recall for entities. Report confidence calibration (do assigned confidence scores correlate with user-stated certainty in the golden annotation?).
- Verify that the SessionStart loader's injected context from the resulting handoff.md and Postgres rows fits within the 4000-token budget.

**What does not change.** The existing fixture files that are not being expanded, `test/eval/queries.json`, and the core metric computation logic in `eval-retrieval.js`. The `--update-baseline` flag is reserved for post-acceptance use only.

**Running order at READY_FOR_JUDGE.**
1. `PGUSER=postgres node test/eval/eval-retrieval.js --vector-only` (Extension 1 baseline)
2. `PGUSER=postgres node test/eval/eval-retrieval.js --with-reranker` (Extension 2 full path)
3. Print delta report (Extension 3).
4. Assert all thresholds (Extension 4 bundle gate).
5. Run V1–V16 verification SELECTs.
6. Run skill eval (Extension 5) against golden-session fixture.

---

## 8. Rollback Plan

If any acceptance threshold from Section 6 fails after any phase, rollback proceeds as follows.

**Phase 3.7 rollback (Stop-hook safety net).**
Remove or disable the Stop hook entry from `~/.claude/settings.json`. No schema or data changes.

**Phase 3.6 rollback (SessionStart loader hook).**
Remove or disable the SessionStart hook entry from `~/.claude/settings.json`. No schema or data changes.

**Phase 3.5 rollback (/handoff skill).**
Remove the skill files from `~/.claude/commands/handoff/`. Deregister from Claude Code's command surface. Schema (`entities`, `assertions`, `edges`, `retrieval_contract`, `project_settings`) may be left in place or dropped per the Phase 2 rollback instructions below.

**Phase 3 rollback (reranker, late chunking, blurbs).**
1. Stop the reranker vLLM process in WSL (kill the `vllm serve` process for port 8001; or `docker compose down vllm-reranker` if using the Docker path).
2. Disable the rerank stage in the retrieval pipeline via the feature flag in `pipeline-embed.js` (a flag, not a code removal, so it can be re-enabled without a code change).
3. Revert `pipeline-memory-loader.js` to the pre-Phase-3 commit (remove blurb generation call).
4. Re-embed the corpus using the Phase 1 embedder path (vLLM Qwen3-Embedding-8B at 4096-dim, no blurbs): `node scripts/pipeline-embed.js index --all`.
5. Run eval harness to confirm recall@1 returns to the Phase 1 post-embed measurement.
6. No schema rollback required for Phase 3; `retrieval_events` table may have partial rows -- these are harmless and can be truncated: `TRUNCATE retrieval_events`.

**Phase 2 rollback (schema tables).**
```sql
DROP TABLE IF EXISTS retrieval_events CASCADE;
DROP TABLE IF EXISTS assertions CASCADE;
DROP TABLE IF EXISTS edges CASCADE;
DROP TABLE IF EXISTS entities CASCADE;
DROP TABLE IF EXISTS retrieval_contract CASCADE;
DROP TABLE IF EXISTS project_settings CASCADE;
```
No data is lost in `memory_entries` or `memory_entry_chunks`; those tables are unaffected by this DDL.

**Phase 1 rollback (embedder downgrade).**
1. Stop the embedder vLLM process in WSL (kill the `vllm serve` process for port 8000; or `docker compose down vllm-embedder` if using the Docker path).
2. Re-enable the Ollama embed path in `pipeline-embed.js` via the feature flag (not a code removal).
3. If the dual-column transition window is still open (old `embedding vector(1024)` column preserved): update `pipeline.yml` to restore `embedding_model: mxbai-embed-large`. Drop the `embedding_4096` column. Rebuild the 1024-dim HNSW index.
4. If the old column has already been dropped: re-embed all rows using mxbai-embed-large into a new `vector(1024)` column, then rename it to `embedding`.
```sql
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE memory_entry_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);
```
Then run: `node scripts/pipeline-embed.js index --all` with `embedding_model: mxbai-embed-large` in `pipeline.yml`.

**Phase 0 rollback (decisions backfill).**
```sql
DELETE FROM memory_entry_chunks mc
  USING memory_entries me
  WHERE mc.entry_id = me.id AND me.mem_type = 'decision';

DELETE FROM memory_entries WHERE mem_type = 'decision';
```
The source data in `pipeline_pipeline.decisions` is untouched throughout; Phase 0 is read-only on the source.

---

## 9. Out of Scope (Explicit Non-Goals)

The following are explicitly out of scope for Bundle A. They are listed to protect the bundle from scope creep at READY_FOR_JUDGE.

- **`doc_tree_nodes` (future bundle).** This project's corpus is not structured filings; the Page Index pattern adds no value here yet. Defer to a future bundle when the corpus includes hierarchically structured long documents.
- **`topic_payoff` and outcome-capture writer (Bundle B Phase 4).** The outcome-capture loop, the 1–10 rating ritual, and `topic_payoff` writes are Bundle B. Bundle A creates `retrieval_events` but does not wire outcome capture.
- **Community detection (Bundle B Phase 4b).** Leiden/Louvain community detection, `communities` and `community_summaries` tables, and the `intent: 'global'` / `intent: 'drift'` retrieval paths are Bundle B.
- **Automated entity extractor over backfilled decisions corpus (Bundle B).** In Bundle A, Phase 0 brings decisions in as text only; entity and assertion accumulation begins from the first `/handoff:close` going forward. Running an automated extractor over all 137 backfilled decisions is Bundle B scope.
- **Validator skill (Phase 6e, Bundle E2).** The 2% audit floor and validator subagent are not part of Bundle A.
- **Multi-user and Codex bridge (gated docket).** The `users` table, per-user rater calibration, 7-level trust taxonomy, and Codex wrapper CLI are explicitly deferred per Judge O3 ruling. The `project_id` column in all Phase 2 tables is a forward-compat convention (using `encoded_cwd`), not a multi-user runtime implementation.
- **Universal enforcement hooks (Phase 6b).** The Stop hook and SessionStart hook wired in Phases 3.6–3.7 are scoped to the `/handoff` skill only. Universal enforcement hooks modifying `~/.claude/settings.json` and `~/.claude/CLAUDE.md` for other purposes are a separate docket with their own backup/dry-run/uninstall requirements (per Judge O5 ruling).
- **Skill packaging beyond `/handoff` (Phase 6).** The `SKILL.md` and references directory structure for other skills are out of scope.
- **Tabular text-to-SQL and ridge regression scoring (Phase 4c).** Bundle A does not implement `pipeline-tabular.js` or the applicability scorer.
- **Freshness audit CLI (Phase 5).** `pipeline-audit.js` is out of scope.
- **Formal bundle taxonomy methodology (Bundle B).** The structured query schema (`retrieval_contract` table + JSONB query format) ships in Bundle A. The formal methodology of "writing down the bundle" at an organizational level — per Nate Jones's framing — is a Bundle B design concern.

---

## 10. Risk Register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| vLLM stack first-time setup -- native WSL path (uv + Python 3.12 venv + build-essential) is the active path on the Principal's machine; Docker pull blocked by Docker Desktop 29.4.3 EOF errors | Done (2026-05-14) | Medium | Native WSL install via uv is the resolved path. Port pre-flight check required before service launch. See Phase 1 step zero and README.md `## Gotchas`. |
| Late chunking via vLLM online API unavailable in installed vLLM version — vLLM's online API may return pooled vectors only in the installed version, making the primary late chunking path unavailable | Medium | Medium | Transformers sidecar fallback is fully specified (approximately 150 lines of Python). Decision criterion is explicit: try primary first, fall back if pooled-vector-only response is observed. |
| Reranker latency via vLLM exceeds 250ms p95 budget | Low | Medium | vLLM cross-encoder inference at 4B params is well-benchmarked at sub-100ms per query on modern GPUs; 250ms is conservative. If exceeded, reduce top-K below 20 (try top-10 or top-5). The latency budget is a measured number, not a hard gate that kills the bundle. |
| pgvector ANN scalability — `vector(4096)` cannot have an HNSW index (pgvector 0.8.1 caps at 2000 dims for `vector`); seq scan viable at current scale but fails as corpus grows | **RESOLVED** (2026-05-14, Phase 1 step 5) | Was High | Converted `embedding` to `halfvec(4000)` via Matryoshka truncation. HNSW indexes built with `halfvec_cosine_ops`. Eval gate passed with no regression. See Phase 1 step 5 section. |
| HNSW index build disk-based at scale — Postgres default `maintenance_work_mem` (64 MB) forces disk-based HNSW build at 10k+ chunks | Low now / High later | Low now | Document `maintenance_work_mem` tuning instruction in Phase 1 order of operations. Current scale (hundreds of chunks) is well within the default. Add a note to set `maintenance_work_mem = '1GB'` before the HNSW build step as corpus grows. |
| Blurb runtime length guard failure — qwen2.5:14b returns blurbs exceeding 200 tokens; guard must be implemented to prevent silent embedding quality degradation | Low | Medium | Runtime guard is a required deliverable in Phase 3 (not optional). If a blurb exceeds 200 tokens, it is truncated or the embedding proceeds without the blurb for that chunk, and the event is logged. |
| FP16 quantization overflow -- if vLLM services are started with FP16 instead of Q8, combined VRAM exceeds 24 GB and overflows to CPU RAM, causing the performance failure mode observed previously with large Ollama models | Low (Q8 is pinned) | High | Q8 is explicitly pinned in both service launch commands. Verify quantization flags are correct before the first service start. |
| Skill not registered in Claude Code's command surface — if the user-scoped install path is not followed or the registration step is missed, the skill subcommands are unavailable | Low | Medium | Explicit registration step in Phase 3.5 order of operations. Test with a simple `/handoff:status` call after install before proceeding to `:close` wiring. |
| Decay rate miscalibration — if 0.05/day is too aggressive, assertions disappear too fast; if too slow, stale content persists | Medium initially | Medium | `decay_rate` is per-row tunable and the global default is configurable via `project_settings`. First two weeks of usage will calibrate. Revisit the default after real usage data is available. |
| Golden fixture session capture not yet done | High at start of implementation | Medium | Capturing the golden fixture is in-scope for Bundle A (2–3 hours). Schedule it early in Phase 3.5 implementation so skill eval can run at READY_FOR_JUDGE. |
| First-close seed fidelity — if the first `/handoff:close` extracts poorly, the entire substrate starts with bad assertions | Medium | Medium | The very first close should be reviewed by the Principal before the next session loads from it. Strongly recommend using `/handoff:checkpoint` as the first invocation (not `:close`) to allow manual review of extraction output before committing. |
| Loader infinite loop on stale prompt — if the staleness prompt runs at SessionStart, there may be no clean UI to receive input | Low | Low | The SessionStart hook surfaces staleness state but does not block session start. The user runs `:resume` or `:drop` from the new session. Hook never waits for inline input. |

---

## 11. Open Questions and Known Unknowns

**Q1. Does 4096-dim Qwen3 actually outperform 1024-dim mxbai on the project's expanded eval fixture set?**
This is the central empirical question. Published MTEB rankings favor Qwen3-Embedding-8B, but those benchmarks do not include this project's specific fixture mix (technical prose, proper nouns, Postgres schema fragments, markdown frontmatter). The eval gate in Phase 1 answers this directly. If recall@1 falls below the refreshed baseline minus 2pp after re-embedding, the embedder upgrade must be reconsidered before Phase 2 proceeds.

**Q2. What is the actual blurb generation throughput at Phase 3?**
The plan estimates approximately 5–6 seconds per chunk using `qwen2.5:14b` for contextual blurb generation at a 200-token budget. At 548 chunks for the initial corpus, that is approximately 50 minutes for the initial backfill — acceptable at load time (not at query time), but the estimate should be validated on a representative batch of 50 chunks before committing to the full pass. If throughput is unacceptable, blurb generation can be batched or limited to new/changed chunks only (incremental mode).

**Q3. Does the vLLM online embedding API in the installed version expose per-token outputs?**
This determines whether the primary late chunking path works or whether the sidecar fallback is needed. Validated at the start of Phase 3 implementation by issuing a test embed request and examining the response shape.

**Q4. Does the eval corpus expansion (20 cross-chunk-focused fixtures) sufficiently increase headroom to detect Phase 3 gains?**
Validated by the first run of the expanded eval against the current mxbai baseline. Expect baseline metrics to drop modestly, opening room for Phase 3 improvements to register as statistically meaningful. If the expanded baseline does not show meaningful headroom below the previous ceiling, the fixture design needs revision before Phase 1 gating proceeds.

**Q5. Will Apache AGE become available for PG18 on Windows before the graph retrieval phases (Bundle B) ship?**
The SQL adjacency-list + recursive CTE approach is the planned substitute for Bundle B. If AGE ships PG18 Windows support before Bundle B's graph retrieval is implemented, the Bundle B schema can evaluate AGE compatibility at that time. No impact on Bundle A.

**Q6. Does the decay rate of 0.05/day produce useful retention curves on real usage?**
An assertion at confidence 10 survives approximately 46 days before suppression; at confidence 5, approximately 32 days. These curves are theoretical; calibration requires real usage data. Tunable via `project_settings` key `decay_rate_default`. Revisit after two weeks of actual usage.

**Q7. What is the right `effective_confidence` suppression threshold?**
Default 1.0 (see decay formula in Section 4 DDL). At confidence 10 and decay_rate 0.05, suppression occurs at approximately day 46; at confidence 5, approximately day 32. Validated empirically; tunable per the same pattern as Q6.

**Q8. Should the SessionStart loader's token budget default be 4000 tokens, or higher/lower?**
Empirical question; revisit after first usage. 4000 tokens is a conservative starting point that leaves ample room for the harness-level startup cost. If real sessions show the budget is too tight to surface useful context, increase it via `project_settings` key `loader_token_budget`.

---

## 12. Estimated Effort

**30–40 hours of focused implementation**, broken down as:

| Phase | Low estimate | High estimate |
|---|---|---|
| vLLM install + service bring-up (Phase 1 step zero) -- WSL install done 2026-05-14; endpoint verification pending | 0.5 h | 1 h |
| Eval corpus expansion + baseline refresh -- done 2026-05-14 (42 fixtures, 38 queries, baseline.json updated) | 0 h | 0 h |
| Phase 0 — Decisions backfill | 2 h | 3 h |
| Phase 1 — Embedder swap to vLLM + eval gate | 2 h | 4 h |
| Phase 2 — Schema (6 tables: retrieval_events, entities, assertions, edges, retrieval_contract, project_settings) | 2 h | 3 h |
| Phase 3 — Reranker + late chunking + blurbs | 4 h | 6 h |
| Phase 3.5 — /handoff skill (7 subcommands + handoff.md template + CLAUDE.md bootstrap) | 8 h | 12 h |
| Phase 3.6 — SessionStart loader hook + staleness handling | 4 h | 6 h |
| Phase 3.7 — Stop-hook safety net | 1 h | 1 h |
| Golden-session fixture + skill eval | 2 h | 3 h |
| Eval extension + READY_FOR_JUDGE prep | 2 h | 2 h |
| **Total** | **31 h** | **47 h** |

The low end assumes vLLM containers start cleanly on first attempt, the vLLM online API exposes per-token outputs (no sidecar needed), the expanded eval shows clear headroom, and skill extraction on the golden fixture meets thresholds on the first calibration pass. The high end accounts for NVIDIA Container Toolkit setup friction, sidecar implementation if the vLLM primary path is unavailable, HNSW rebuild time at 4096-dim, iteration on the blurb prompt to stay within the 200-token budget, and skill extraction calibration requiring multiple refinement passes.
