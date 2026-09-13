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
      "reason": "Bundle-A eval-migration artifacts, cm-runbook §11.6" }
  ]
}
```

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

## Outcome classification (total)

| Outcome | Condition |
|---|---|
| PASS | All entries LIFT/LEAVE with no overlap, no hash drift, zero scanner findings |
| FAIL_UNCLASSIFIED_PATH | A discovered path has no manifest entry at all |
| FAIL_HASH_DRIFT | A LIFT file's live sha256 (source- or target-side) ≠ manifest's recorded value |
| FAIL_CONTENT | ≥1 scanner finding (label attached) |
| FAIL_GATE_ERROR | Scanner crash; `sanitize-private-terms.txt` missing/unreadable/empty; malformed manifest shape; a discovered path matched by more than one manifest entry (overlap — no implicit precedence, see Classification above); `SANITIZE_LIFT_COMMIT_IDENTITY` unset when required; a skip/bypass env var is set (see below) |

**Priority when multiple conditions hold at once.** `FAIL_GATE_ERROR` takes
precedence over every other outcome (a run with a gate error cannot be
trusted to have evaluated the rest correctly), then
`FAIL_UNCLASSIFIED_PATH`, then `FAIL_HASH_DRIFT`, then `FAIL_CONTENT`, then
`PASS`. This order is itself total and fixed — it is not configurable per
invocation.

Unknown/unexpected internal state → `FAIL_GATE_ERROR`. The gate never
resolves to PASS on an exception path.

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

1. **Pre-push hook**, installed into the public repo by the installer's
   `--hooks` step; runs the gate against the outgoing ref's diff before
   `git push` proceeds. Documented as a fast local backstop — CI (below) is
   authoritative regardless of what the local hook reports.
2. **GitHub Actions**, on `pull_request` and `push`; scans the full PR diff
   (files + PR body via the GH API) and the push's commit messages, author/
   committer identity, and ref name.
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

## Blind spots

What this gate cannot detect: semantic leaks in prose (a paraphrased
description of private infrastructure that names no literal term on the
list); any private name, path, or project identifier not present in
`sanitize-private-terms.txt` at scan time; secrets embedded in binary files
(images, compiled artifacts) where byte-pattern scanning is unreliable or
skipped, and where UTF-16 decode heuristics do not apply; anything in the
historical git log of the private `claude-memory` repo itself (the gate
scans the lift-set snapshot and the public repo's own history going forward,
not the private repo's past commits); GitHub-side required-check enforcement
itself is configured via the GitHub API/branch-protection settings, which
this spec assumes are set correctly and does not itself verify at runtime
(a misconfigured branch-protection rule that doesn't actually require the
check is outside what `sanitize-gate.js` can detect from within a CI run).
