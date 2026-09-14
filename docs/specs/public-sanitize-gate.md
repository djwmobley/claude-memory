# Public sanitize gate — spec

Status: SPEC (fixed against adversary pass; implementation ships alongside
this fix). Answers cm-backlog#27 ("Durable sanitization gate for
agent-authored public PRs") with the recommended lean from that issue:
content-manifest total classification, not pattern-denylist.

## Purpose

Prevent private instance data (owner filesystem paths, email, private DB
names, client/project names, secrets, marker UUIDs) from entering the public
`memory-manager` repo — at initial lift from `claude-memory` and on every
subsequent PR. Replaces the manual-grep-denylist process that failed on
2026-08-15/16 (cm-backlog#27) with a mechanical, total-classification gate.

## Adversary findings addressed (pre-authoring pass)

Every row below is a fix to this spec, made before `scripts/sanitize-gate.js`
was written, per the adversary-before-author rule. Each finding names the
pass-but-shouldn't input the prior draft allowed and the section that now
closes it.

| ID | Finding (prior draft's gap) | Fix (section) |
|---|---|---|
| A1 | `C:\Users\<name>` only — `C:/Users/<name>`, `%USERPROFILE%`, `~/<name>`, and URL-encoded (`%5C`/`%2F`) forms all escaped | Scanners → OWNER_PATH |
| A2 | Two manifest entries could match the same discovered path with no stated precedence — silent first/last-wins | Classification (total) |
| A3 | Discovery implied "under the lift-set root" without saying what enumerates it; a glob-driven walk misses gitlinks/submodule pointers | Discovery |
| B1 | Nothing stopped `lift-to-public.js` from computing and writing `sha256` itself, making FAIL_HASH_DRIFT unfalsifiable (script always agrees with itself) | Manifest authorship & hash-drift |
| B2 | A `transform` entry recorded only one hash — unclear if it's pre- or post-transform, so drift on either side goes undetected | `PUBLIC-MANIFEST.json` shape |
| C1 | Byte-pattern scanners miss the same string re-encoded as UTF-16LE/BE (e.g. a path pasted from a Windows tool) | Scanners → decode step |
| C2 | "Missing file is a gate error" didn't cover a present-but-empty or whitespace-only file, which would scan against zero terms and PASS | Inputs; Outcome classification |
| C3 | Private terms matched as raw substrings — a short term (e.g. a 3-letter client code) matches inside unrelated words, and matching wasn't specified case-sensitive vs. not | Scanners → PRIVATE_TERM |
| D1 | Nothing scanned the commit identity of the change under test; an agent-authored commit carrying the owner's real git identity would ship untouched | Scanners → COMMIT_IDENTITY |
| D2 | Scanners covered file bytes/commit messages/PR bodies but not path strings themselves or ref/branch names, both of which can carry a private client name | Scanners → PATH_STRING, REF_NAME |
| E1 | No bootstrap sequencing — first import could land before the required check exists, in the window when nothing blocks merge | Enforcement points → Bootstrap order |
| E2 | No statement that a skip/bypass mechanism must not exist; a later PR could quietly add `SANITIZE_SKIP=1` as an escape hatch | Enforcement points → Fail-closed skip posture |
| F1 | Outcome was implied by scanner findings printed to stdout during the run — a reader could treat partial/interrupted stdout as a result | Outcome classification → Sole authoritative result |

## Inputs

- `PUBLIC-MANIFEST.json` — the classification record (LIFT/LEAVE) for the
  lift set. `sha256` fields in this file are written and updated ONLY by a
  human or an approving reviewer editing the file directly (via `Write`/
  `Edit`/a normal commit) — see "Manifest authorship & hash-drift" below.
- `sanitize-private-terms.txt` — private, gitignored, path passed via
  `SANITIZE_PRIVATE_TERMS_FILE` env var; one term/pattern per line, `#` at
  line-start is a comment. Missing file, unreadable file, or a file that is
  empty or contains only whitespace/comment lines (zero usable terms) is a
  gate error (`FAIL_GATE_ERROR`) — never an empty-list pass.
- The file bytes of every path in the discovered tree (see Discovery), plus:
  commit messages, PR bodies, commit author/committer name+email, ref/branch
  names, and the path strings themselves, all of the commit(s) under test.

## Discovery

The path set the gate classifies is produced by `git ls-tree -r --name-only
<commit>` against the commit under test (full recursive tree listing) — never
a glob walk of the filesystem, and never limited to paths a diff touched. This
includes gitlink entries (submodule pointers, mode `160000`) and
`.gitmodules` itself: both are ordinary discovered paths and land in
UNCLASSIFIED (→ FAIL_UNCLASSIFIED_PATH) unless a manifest entry explicitly
names them. The gate does not special-case any path shape at discovery time —
classification below is what decides disposition, not discovery.

## `PUBLIC-MANIFEST.json` shape

```json
{
  "generated_at": "2026-09-13T00:00:00Z",
  "source_sha": "<claude-memory commit sha>",
  "entries": [
    { "path": "scripts/lib/project-identity.js", "class": "LIFT",
      "source_sha256": "…", "transform": null },
    { "path": "scripts/lib/embedding-provider.js", "class": "LIFT",
      "source_sha256": "…", "target_sha256": "…",
      "transform": { "from": "pipeline-scripts", "to": "memory-manager" } },
    { "path": "scripts/migrations/**", "class": "LEAVE",
      "reason": "Bundle-A eval-migration artifacts, cm-runbook §11.6",
      "expansion": ["scripts/migrations/0001_init.sql", "scripts/migrations/0002_seed.sql"] }
  ]
}
```

Every glob entry (a `path` containing `*`) additionally carries `expansion` —
the resolved file list the glob matched at approval time. The gate
recomputes the glob's expansion against the discovered tree and diffs it
against this recorded list: a live match not in `expansion` is treated as
not matched by that glob at all (falls through to another entry or to
UNCLASSIFIED — "new file matched an old glob" is never a silent pass), and
an `expansion` entry that no longer live-matches is a stale manifest record
(`FAIL_GATE_ERROR`). A glob entry missing `expansion` is a shape violation
(`FAIL_GATE_ERROR`).

Every `LIFT` entry carries `source_sha256` (the sha256 of the file's bytes at
`source_sha` in `claude-memory`, as approved). An entry whose `transform` is
non-null additionally carries `target_sha256` — the sha256 of the bytes
*after* the recorded transform is applied, i.e. what the file must hash to in
the target repo. A `transform`-bearing entry with no `target_sha256`, or a
non-transform entry carrying a `target_sha256`, is a malformed manifest →
`FAIL_GATE_ERROR` (shape violation, not a content finding).

## Manifest authorship & hash-drift

`sha256`/`source_sha256`/`target_sha256` fields are populated only by a human
editing `PUBLIC-MANIFEST.json` directly (or a reviewer approving such an
edit) — this is the sole approval record that a specific byte sequence was
reviewed. `scripts/lift-to-public.js` has **no code path that writes to
`PUBLIC-MANIFEST.json`**; it only reads it. This is enforced structurally
(the script never opens the manifest path for writing) and is covered by a
test that greps the script source for any write-mode `fs` call touching a
path matching `PUBLIC-MANIFEST.json`. The gate (`sanitize-gate.js`)
independently recomputes sha256 for every discovered LIFT path (source-side
pre-transform, target-side post-transform where applicable) and compares
against the manifest's recorded value(s) — any mismatch is
`FAIL_HASH_DRIFT`, gate-computed, never manifest-computed.

For a `transform` entry, the **target** side is always verified: the gate
reads the file's bytes as actually committed at the commit under test (git
blob, never the working tree) and compares against `target_sha256` — this
is what closes "unapproved transformed bytes can PASS", since the committed
tree only ever contains the post-transform bytes. The **source** side (the
pre-transform bytes, which do not exist in the target tree at all) is
verified only when `--source-root <dir>` is supplied — the lift step (run
from `claude-memory`, where the pre-transform bytes live) passes it,
pointing at the approved `source_sha` checkout; comparisons are against a
plain filesystem read at `<source-root>/<path>`, not a git blob, since the
source tree is a different repository than the one under test. Ordinary
public-repo CI/pre-push runs omit `--source-root` (there is no source tree
to check against there) and skip the source-side comparison, relying on the
lift step having verified it once at import time.

## Classification (total)

Every path discovered under the lift-set root maps to exactly one class.
Default (no matching entry) is UNCLASSIFIED, which is a gate FAIL — never a
silent pass.

| Class | Meaning | Requires |
|---|---|---|
| LIFT | Ships to public repo | `source_sha256` (+ `target_sha256` if `transform` is set) recorded at approval time |
| LEAVE | Excluded, deliberately | `reason` string |
| UNCLASSIFIED | Not in manifest | N/A — gate FAILS |

No path-prefix allow-listing. Entries are explicit file paths or explicit
glob entries whose expansion is recorded (resolved file list stored
alongside the glob, so a new file matching an old glob is caught by
hash-drift/re-expansion diff, not silently included).

**Overlap is a manifest error, not a precedence question.** If a discovered
path matches more than one manifest entry (e.g. an explicit path entry and a
glob entry both cover it, or two glob entries overlap), that is
`FAIL_GATE_ERROR` — there is no implicit first-match/last-match/most-specific
precedence rule. The manifest author must make entries mutually exclusive
(narrow the glob, or list the path as its own entry with an explicit class)
before the gate will run to a content-scanning outcome for that path.

## Scanners

Each scanner runs over every LIFT file's bytes, commit messages, PR bodies,
commit author/committer name+email, ref/branch names, and path strings of
every discovered path. Base64 blobs ≥64 chars are decoded once and re-scanned
by all scanners (`BASE64_DECODE`). Before any text scanner runs on a byte
buffer, `decodeMaybeUtf16` inspects it for a UTF-16LE/BE BOM or a
null-byte-interleave heuristic (≥N alternating null bytes across the first
512 bytes, consistent with ASCII-range UTF-16) and, if detected, decodes to
UTF-8 text before scanning proceeds; the original bytes are also scanned
as-is (both passes run — decoding is additive, not a replacement).

**Decoded scanning (a).** Every text scan additionally runs over decoded
variants of the WHOLE string — never a substring extracted by splitting on
whitespace first (no whitespace tokenization gates decoding, so a decoded
owner path is still found even when it is not surrounded by whitespace/
quotes). Variants:

- Percent-decoding, run to a fixpoint, capped at 5 rounds even if a
  fixpoint has not been reached. Each round decodes every valid `%XX`
  (case-insensitive hex) and `%uXXXX` escape found anywhere in the string;
  a malformed sequence (bad hex, a bare trailing `%`) is left literal and
  the round never throws. A double-encoded owner path (e.g. `%2543...` →
  `%43...` → `C...`) resolves fully only at depth 2, and its finding
  records that depth.
- An unconditional plus-as-space variant (`+` → ` `) — no query-string
  detection; `+` is always treated as a possible encoded space regardless
  of context.

Findings from every variant (raw, each percent-decode round, plus-as-space)
are unioned; each finding records which `variant` (`raw`/`percent`/`plus`/
`base64`) and `depth` produced it.

| Label | Pattern intent | Canary example |
|---|---|---|
| OWNER_PATH | `C:\Users\<name>`, `C:/Users/<name>`, `/home/<name>`, `/Users/<name>`, `%USERPROFILE%\<...>`, `~/<name-looking-segment>`, and URL-encoded equivalents (`%5C`/`%2F` for the separators, `%7E` for `~`) of all of the above | `C:\Users\testcanary\foo` |
| OWNER_EMAIL | owner email + `@users.noreply.github.com` shapes | `canary@users.noreply.github.com` |
| PRIVATE_DB | `claude_policy_framework`, `pipeline_*`, `claude_context`, `memory_manager_staging` | `pipeline_canarydb` |
| PRIVATE_TERM | lines from `sanitize-private-terms.txt`, matched case-insensitively at word boundaries (`\b<term>\b` semantics — a term does not match as a substring of a larger identifier) | seeded test term |
| MARKER_UUID | UUID literals matching `.claude-memory`/`.memory-engine` marker shape | random v4 UUID in canary fixture |
| SECRET_KEY | AWS, `ghp_`/`github_pat_`, `sk-`, `sk-ant-`, JWT, PEM block | `ghp_` + 36 canary chars |
| CONN_STRING | URI with embedded password (`://user:pass@host`) | `postgres://u:canarypw@h/d` |
| BASE64_DECODE | any of the above found inside a decoded ≥64-char base64 blob | owner path base64-encoded |
| COMMIT_IDENTITY | commit author/committer name or email of the commit under test does not equal the configured lift-bot identity (`SANITIZE_LIFT_COMMIT_IDENTITY` — an explicit `name <email>` value; unset is itself a `FAIL_GATE_ERROR`, not a pass) | commit authored as `Damian Mobley <djwmobley@gmail.com>` |
| PATH_STRING | any discovered path (not just LIFT file bytes) whose string value matches any other scanner's pattern | a LEAVE-classified path literally named `C:\Users\djwmo\...` |
| REF_NAME | the ref/branch name under test matches any other scanner's pattern | branch `fix/advisicon-ppm-thing` |

Each finding is labeled `file:line` (or `ref`/`commit-identity`/`pr-body` for
non-file sources); any finding → FAIL.

## Ref resolution (d)

The ref under test is resolved BEFORE base derivation (below), since base
derivation needs it. Total classification, every input maps to exactly one
branch:

- Explicit `--ref` (blank/whitespace-only is treated as omitted).
- Otherwise, `git symbolic-ref --short HEAD` — this fails closed under a
  detached HEAD (exactly the state a CI checkout of a PR/push commit is
  normally in) instead of silently resolving to the literal string `HEAD`.
- A resolved candidate is then rejected (`REF_UNRESOLVED`) if it is the
  literal name `HEAD`, `FETCH_HEAD`, or `ORIG_HEAD`; if it fails `git
  check-ref-format --branch`; or if `git rev-parse --verify <ref>^{commit}`
  fails (no such ref).
- **A branch literally named `HEAD`, `FETCH_HEAD`, or `ORIG_HEAD` is
  unsupported by design** — these are reserved git meta-refs, not ordinary
  branch names, and a real incoming ref is never expected to collide with
  them.

## Base derivation (c)

`--base` absent OR blank/whitespace-only is treated as omitted. An omitted
base is DERIVED as `git merge-base <ref> <public-base>`, where `<public-base>`
defaults to `origin/main` (override with `--public-base <ref>`). An explicit,
non-blank `--base` is used as-is (no derivation).

`BASE_UNRESOLVED` (a BLOCK-class outcome, see below) fires when `git
merge-base` itself errors — a missing/unresolvable `<public-base>`, no common
ancestor, or an invalid ref. `merge-base` succeeding with an output equal to
`<ref>` itself is the **normal fast-forward case, not an error** — the
incoming range is empty (nothing to diff), so the gate still scans the ref
name and, if there is any range at all, the commit message(s) in it, then
resolves PASS on a clean tree.

**There is no tip-only scan mode.** A resolved base (explicit or derived) is
always required — the round-2 behavior of silently checking only the tip
commit's identity when `--base` was omitted has been removed from both this
spec and the implementation.

## Outcome classification (total)

| Outcome | Class | Condition |
|---|---|---|
| PASS | — | All entries LIFT/LEAVE with no overlap, no hash drift, a resolved ref and base, zero scanner findings |
| FAIL_REF_UNRESOLVED | BLOCK | The ref under test could not be resolved (see "Ref resolution" above) |
| FAIL_BASE_UNRESOLVED | BLOCK | The base under test could not be resolved/derived (see "Base derivation" above) |
| FAIL_UNCLASSIFIED_PATH | BLOCK | A discovered path has no manifest entry at all |
| FAIL_HASH_DRIFT | BLOCK | A LIFT file's live sha256 (source- or target-side) ≠ manifest's recorded value |
| FAIL_CONTENT | BLOCK | ≥1 scanner finding (label attached) |
| FAIL_GATE_ERROR | ERROR | Scanner crash; `sanitize-private-terms.txt` missing/unreadable/empty; malformed manifest shape; a discovered path matched by more than one manifest entry (overlap — no implicit precedence, see Classification above); `SANITIZE_LIFT_COMMIT_IDENTITY` unset when required; a skip/bypass env var is set (see below) |

**Priority when multiple conditions hold at once.** `FAIL_GATE_ERROR` takes
precedence over every other outcome (a run with a gate error cannot be
trusted to have evaluated the rest correctly), then `FAIL_REF_UNRESOLVED`,
then `FAIL_BASE_UNRESOLVED`, then `FAIL_UNCLASSIFIED_PATH`, then
`FAIL_HASH_DRIFT`, then `FAIL_CONTENT`, then `PASS`. This order is itself
total and fixed — it is not configurable per invocation.

Unknown/unexpected internal state → `FAIL_GATE_ERROR`. The gate never
resolves to PASS on an exception path.

### `classifyOutcome` total classification

Distinct from the outcome-derivation table above (which reads the gate's
internal accumulator buckets), `classifyOutcome` is a narrower, paranoia-
hardened pure function that validates an ALREADY-COMPUTED summary payload
shaped like the gate's own final JSON line — `{ outcome: 'PASS'|'BLOCK'|
'ERROR', findings: [...], exitCode?: N }` — against tampering or a malformed
shape, before that payload is trusted enough to print. It is wired into
`main()` as a self-check on the gate's own derived payload (belt-and-
suspenders: an internal bug that ever produces a malformed payload is
forced to `FAIL_GATE_ERROR` rather than silently trusted).

Total classification — every input maps to exactly one of PASS / BLOCK /
ERROR, with the default branch for anything not exactly matching the rules
below being BLOCK with `reason: 'MALFORMED_OUTCOME'`:

- `outcome` and `findings` are read ONCE, inside a single `try`/`catch` —
  any exception anywhere (a Proxy trap on prototype lookup, own-key
  enumeration, or property-descriptor lookup) → BLOCK `MALFORMED_OUTCOME`.
- The input must be a plain object: prototype exactly `Object.prototype` or
  `null` (excludes arrays, `Date`, class instances, and other exotic
  objects without needing a separate check for each).
- No own keys other than `outcome`, `findings`, and the documented optional
  metadata key `exitCode` — enforced on every branch, including ERROR.
- `outcome`/`findings`/`exitCode`, when present, must be plain DATA
  properties — an accessor (getter/setter) on any of them is rejected
  outright without ever invoking it, which is what makes a throwing getter
  harmless here (it is detected via its property descriptor, never called).
- PASS only if `outcome === 'PASS'` exact-byte (a homoglyph or a trailing-
  space variant is simply a different string and never matches) AND
  `findings` is `Array.isArray` with length 0.
- BLOCK only if `outcome === 'BLOCK'` AND `findings` is a non-empty array.
- ERROR only if `outcome === 'ERROR'` (no `findings` shape constraint).
- Everything else → BLOCK `MALFORMED_OUTCOME`.

**Sole authoritative result.** The gate's only authoritative output is its
process exit code together with exactly one final line of JSON written to
stdout: `{"outcome": "<one of the table above>", "findings": [...],
"exitCode": <int>}`. Any other stdout (progress lines, scanner-by-scanner
chatter) is diagnostic only and MUST NOT be parsed by a caller for a result —
`--json` mode emits ONLY that final line (no progress lines interleaved on
stdout; progress goes to stderr if emitted at all). A run that is killed,
times out, or crashes before emitting that final line has no result — a
consuming CI step must treat missing/unparseable final JSON as a failure, not
as "no findings."

## Enforcement points

1. **Pre-push hook** (`templates/public-repo/hooks/pre-push`), installed
   into the public repo by the installer's `--hooks` step; runs before
   `git push` proceeds. Documented as a fast local backstop — CI (below) is
   authoritative regardless of what the local hook reports. Reads every
   ref-update line git supplies on stdin (`<local_ref> <local_sha>
   <remote_ref> <remote_sha>`), stripping a trailing `\r` and whitespace
   from every field (CRLF-safe); zero stdin lines, or any line that does
   not parse into exactly those four fields, is itself a failure (exit 1),
   never a silent exit 0. Per line: an all-zero `local_sha` is a ref
   deletion and is skipped; an all-zero `remote_sha` (new branch on the
   remote) runs the gate with `--ref <local branch short name>` and no
   `--base` (the gate derives one per "Base derivation" above); otherwise
   the gate runs with `--base <remote_sha>` (the remote's current tip).
   When the remote ref's short name differs from the local one (a `git push
   local:remote` rename), the gate is run a second time to also scan that
   name — via `--pr-body-file` (a temp file holding just the remote short
   name), not `--ref`: a remote-only name is typically not itself a
   resolvable local git ref, and passing it as `--ref` would trip the ref-
   validation requirement above (`REF_UNRESOLVED`) for the ordinary,
   innocent case of a rename push whose remote name isn't also a local
   branch — blocking on ref-shape instead of on content. Routing it
   through the existing free-text scan channel runs the same scanners
   (including `PRIVATE_TERM`) over the same bytes without that false
   constraint. The overall exit status is the **bitwise OR** of every gate
   invocation's exit code, accumulated — never reassigned — so an earlier
   BLOCK is never silently discarded by a later PASS on a different ref in
   the same push.
2. **GitHub Actions** (`templates/public-repo/.github/workflows/sanitize.yml`),
   on `pull_request` (`opened`/`synchronize`/`reopened`/`edited`) and `push`
   to `main`; scans the full PR diff (files + PR body via the GH API) and
   the push's commit messages, author/committer identity, and ref name.
   Checkout uses `fetch-depth: 0` (full history, needed for `git
   merge-base`) and, for `pull_request` events, checks out the PR's actual
   head commit (`github.event.pull_request.head.sha`) rather than the
   default merge ref. `pull_request` runs pass `--base
   ${{ github.event.pull_request.base.sha }}` explicitly (the PR API always
   has one); `push` runs omit `--base` entirely and let the gate derive it
   via `merge-base(ref, origin/main)`.
3. CI is authoritative — the pre-push hook is a fast local backstop, not a
   substitute. The Actions check is a **required status check on `main`**;
   branch protection blocks merge without it green.

**Bootstrap order (E1).** Because a required check cannot be required before
it exists, the public repo's very first commit is workflow-only: it adds
`.github/workflows/sanitize.yml` (and nothing else — no lift-set content) so
the check has run and reported at least once. Branch protection is then
configured to require that check. Only after the required check is active
does the actual lift import (the `lift-to-public.js` output commit) get
pushed and reviewed as a PR — so the very first content the gate ever
evaluates is already covered by a required, blocking check. A bootstrap that
lands the import commit before the check is required is a process violation
of this spec, not a mechanism the gate itself can catch after the fact.

**Fail-closed skip posture (E2).** No flag, environment variable, or CLI
argument exists anywhere in `sanitize-gate.js`, the workflow template, or the
pre-push hook template that skips, bypasses, or downgrades the gate. The gate
additionally checks its own environment for common bypass-shaped variable
names (`SANITIZE_SKIP`, `SKIP_SANITIZE`, `SANITIZE_BYPASS`,
`SANITIZE_DISABLE`) and treats any of them being set (to any non-empty
value) as `FAIL_GATE_ERROR` — not a pass, not a skip. This is a deliberate
tripwire: if a future edit adds such a variable and wires it to actually
skip scanning, this check goes stale silently, so the check is paired with a
test asserting the gate fails when each of those names is set, which will
catch it turning into a no-op if the wiring is ever added without updating
this list.

## Lift procedure (`scripts/lift-to-public.js`)

1. Read `PUBLIC-MANIFEST.json`. Never write to it.
2. Copy every LIFT-classified file into the target dir, verifying live
   sha256 (source-side) matches the manifest's `source_sha256` (FAIL_HASH_DRIFT
   aborts the lift).
3. Apply only the listed `transform`s (before/after recorded in the
   manifest) — no other rewrite happens silently. After applying, verify the
   resulting bytes' sha256 matches `target_sha256`; mismatch aborts.
4. Run `sanitize-gate.js` against the copied tree, using the commit that
   will become the import commit as `--commit` and
   `SANITIZE_LIFT_COMMIT_IDENTITY` set to the configured lift-bot identity.
5. Only on gate PASS: create the single commit
   `Initial import (lifted from claude-memory @ <sha>)` in the fresh target
   repo. Gate FAIL aborts before any commit.

## Non-goals

- Not a general secret-scanning replacement for third-party dependencies.
- Not a runtime/production data-leak guard — scope is repo content and PR
  metadata only.
- Does not rewrite git history of the source (`claude-memory`) repo.
- Does not classify content the private-terms file doesn't enumerate — term
  curation is a human responsibility this gate depends on, not replaces.

## Round 1 Codex review (PR #306) — findings disposition

All 14 findings from the round-1 review were verified against the code and
fixed in round 2 (none were judged not-a-defect).

| # | Finding (short) | Status |
|---|---|---|
| 1 | Transform entries skip hash verification (`!entry.transform` disabled it; `target_sha256` never checked) | Fixed — target always verified from the committed blob; source verified via `--source-root` when supplied |
| 2 | Gate reads working-tree files instead of the commit's git blob | Fixed — `gitShowBlob` reads `<commit>:<path>` for every LIFT file |
| 3 | Duplicate literal-path entries collapse in `literalMap`, silently picking one class | Fixed — duplicate normalized literal keys detected before the map is built -> `FAIL_GATE_ERROR` |
| 4 | Glob expansion is unrecorded/unverified; a new file matching an old glob silently rides in | Fixed — `expansion` array required per glob entry, recomputed and diffed (new match not recorded -> UNCLASSIFIED; recorded match no longer live -> `FAIL_GATE_ERROR`) |
| 5 | `globToRegExp` `**` does not respect path-segment boundaries (`dir/**/file.txt` matched `dir/notfile.txt`) | Fixed — segment-aware globstar construction; matrix test added |
| 6 | PR bodies are never scanned (workflow never obtains/passes them) | Fixed — `--pr-body-file`, workflow writes `github.event.pull_request.body` to a temp file for `pull_request` events |
| 7 | Commit range (messages, identity, earlier commits) is not evaluated — only the tip's tree/identity | Fixed for messages + identity — `--base <sha>` walks `git rev-list base..commit` and scans every commit's message + identity. Byte-content of intermediate trees is intentionally NOT diff-scanned (the gate evaluates the final tree snapshot per its Non-goals — "not a general secret-scanning replacement"); this remains a documented blind spot below |
| 8 | `args.ref` never populated by `parseArgs`; fallback reads the checkout's branch (breaks under detached HEAD) | Fixed — `--ref` parsed and used ahead of the `gitRefName` fallback; templates pass it explicitly |
| 9 | Omitting `--commit` skips identity requirement/checks entirely | Fixed — `effectiveCommit = args.commit \|\| 'HEAD'`; identity requirement and check now apply uniformly regardless of whether `--commit` was passed |
| 10 | `pre-push` hook `exit 0`s when `SANITIZE_PRIVATE_TERMS_FILE` is unset, bypassing the check | Fixed — early-exit removed; the gate's own fail-closed `loadPrivateTerms` now produces `FAIL_GATE_ERROR` and blocks the push |
| 11 | `pre-push` hardcodes `--commit HEAD`, ignoring git's actual ref-update input | Fixed — hook reads stdin ref-update lines and runs the gate once per outgoing, non-deleted ref/sha |
| 12 | Whole-string `decodeURIComponent` throws on any malformed `%` elsewhere, suppressing a valid encoded `OWNER_PATH` | Fixed — percent-encoded candidate substrings are extracted and decoded independently |
| 13 | Base64-decoded bytes are only re-scanned as UTF-8, missing a base64-wrapped UTF-16 (BOM) owner path | Fixed — `decodeMaybeUtf16` now also runs on the decoded base64 buffer |
| 14 | `classifyOutcome(null)` / `classifyOutcome({findings:{}})` return PASS instead of failing on malformed/unknown state | Fixed — non-object/null `results`, or any bucket present but not an array, -> `FAIL_GATE_ERROR` |

## Blind spots

What this gate cannot detect, and named limitations of the design:

- **Semantic/paraphrased leaks depend on curation.** Semantic leaks in prose
  (a paraphrased description of private infrastructure that names no
  literal term on the list), and any private name, path, or project
  identifier not present in `sanitize-private-terms.txt` at scan time, are
  not caught — term curation is a human responsibility this gate depends
  on, not replaces.
- Secrets embedded in binary files (images, compiled artifacts) where
  byte-pattern scanning is unreliable or skipped, and where UTF-16 decode
  heuristics do not apply.
- Anything in the historical git log of the private `claude-memory` repo
  itself — the gate scans the lift-set snapshot and the public repo's own
  history going forward, not the private repo's past commits.
- **Branch-protection enforcement is an external operational check.**
  GitHub-side required-check enforcement is configured via the GitHub
  API/branch-protection settings, which this spec assumes are set correctly
  and does not itself verify at runtime — a misconfigured branch-protection
  rule that doesn't actually require the check is outside what
  `sanitize-gate.js` can detect from within a CI run.
- Over the resolved `base..commit` range, only each intermediate commit's
  **message** and **author/committer identity** are scanned — the byte
  content of intermediate trees is not diff-scanned commit-by-commit (only
  the final tree at the commit under test is), so private bytes introduced
  and then reverted within the same incoming range, without appearing in
  any commit message, would not be caught by this gate (this is a scope
  line, not an oversight — see Non-goals: not a general secret-scanning
  replacement).
- `--source-root` source-side hash verification for `transform` entries
  only runs when the caller supplies it (the lift step does; ordinary
  public-repo CI/pre-push runs do not have a source tree to check and skip
  that side, relying on the lift step's one-time verification at import).
- **HEAD-named branches are unsupported by design.** A branch literally
  named `HEAD`, `FETCH_HEAD`, or `ORIG_HEAD` cannot be scanned as a ref
  under test — see "Ref resolution" above. This is a deliberate scope line,
  not an oversight: these names collide with git's own reserved meta-refs.
