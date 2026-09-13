# Codex review contract

Spec for a checked-in wrapper that runs OpenAI Codex CLI as a directed PR
reviewer against this repo. Owner rulings below (2026-09-13) are hard
rules, not defaults to negotiate. This revision closes all 17 findings
from the 2026-09-13 spec-adversary pass (see "Adversary findings" below);
the pass ran before `scripts/codex-review.js` was authored, per this
repo's adversary-before-author rule.

## Purpose

A scripted, non-interactive way to have Codex review a pull request's diff
and return a machine-checkable verdict, without Codex acting as an
unsupervised approver or widening its own scope. The wrapper directs
Codex; it does not treat Codex's architectural opinions as findings (R1).

## Inputs

- `prNumber` — the PR under review; the wrapper resolves its changed-file
  list, PR body, draft status, and head SHA via
  `gh pr view <prNumber> --json files,body,headRefOid,isDraft` (or
  equivalent), never by asking Codex to discover them.
- `repoRoot` — absolute path to the checkout Codex runs against
  (`-C <repoRoot>` in the invocation below); must be a clean worktree at
  the PR's head SHA.
- `round` — integer, 1 or 2. Any caller-supplied value outside {1,2} is
  refused by the wrapper before invoking Codex at all (R3), bucket
  `INVALID_SHAPE` / `ROUND_OUT_OF_RANGE`.
- `priorVerdictPath` — required when `round=2`, absent when `round=1`; path
  to the round-1 verdict record (see Round ledger). The wrapper reads it by
  labeled field, never by line position.

Invocation shape (from the working binary reference): the wrapper writes
the assembled prompt to a tempfile and pipes it in —
`Get-Content -Raw <prompt.md> | & "<codex.exe>" exec - -s read-only -C <repoRoot>`
— never an inline `-e`/`-c` string, per this repo's complex-payload rule.
`-s read-only` is non-negotiable: the wrapper never grants Codex a
write-capable sandbox for review.

## Prompt assembly

Built in this fixed order, all from data the wrapper already resolved
(never from anything Codex claims about itself):

1. **Role framing** — Codex is directed to check specific things; its own
   architecture preferences are out of scope and must not appear in
   findings (R1).
2. **Scope fence** — the exact changed-file list from `gh pr view`,
   resolved fresh every round (B6, never cached from round 1), plus the
   PR body's stated purpose, verbatim. This is the reviewable surface
   (R2). A renamed/moved file contributes **both** its previous and
   current path to the fence (B6). Anything else in the repo is
   explicitly out of bounds.
3. **Round context** — round number; on round 2, the full round-1 verdict
   (all BLOCKER findings) is included and Codex is told: verify these
   specific fixes only, no new findings are accepted this round (R3).
4. **Verdict shape instructions** — the exact required output template
   (see Verdict shape below), stated as a strict template with no
   freeform prose permitted outside it (A1).
5. **The diff** — `git diff <base>...<head>` for the PR, scoped to the
   changed-file list from step 2.

## Verdict shape

Codex's stdout must consist **only** of the following labeled lines (blank
lines permitted between them); any other non-blank line anywhere in the
output — before the first field, between fields, or after the last field
— is a shape violation (A1) and forces `INVALID_SHAPE`:

```
SHA: <full 40-char head SHA>
VERDICT: APPROVE|BLOCK
SCOPE_RESPECTED: yes|no
ROUND: <1|2>
FINDINGS:
- BLOCKER file=<path> text=<one-line remedy>
- LEAD file=<path> text=<one-line note>
END_FINDINGS
```

`FINDINGS:`/`END_FINDINGS` bracket zero or more finding lines and may be
omitted only when there are no findings at all. `SHA`, `VERDICT`,
`SCOPE_RESPECTED`, and `ROUND` are each **required exactly once** (A2);
zero or 2+ occurrences of any of them is `INVALID_SHAPE`.

## Total classification of wrapper outcomes

Every possible wrapper outcome maps to exactly one bucket; unknown or
ambiguous output is the default branch, `INVALID_SHAPE`. Buckets are
evaluated in this fixed priority order (D12), each check short-circuiting
the ones below it:

1. `HALTED` — a prior halt marker (`codex-review-halt`) exists on the PR
   and no `codex-review-halt-cleared` comment follows it (E15/E16), or the
   ledger itself is tamper-evident-invalid (C10). No Codex invocation is
   attempted.
2. `DRAFT_PR` — `gh pr view` reports the PR as a draft (D14). Halts.
3. `EMPTY_FENCE` — the resolved changed-file list is empty (D13). Halts.
4. `ROUND_EXCEEDED` (idempotent-abort case) — a ledger marker already
   exists for this exact `(round, headSha)` pair (C8/C9); re-posting is
   refused rather than duplicated.
5. `INVALID_SHAPE` (`ROUND_OUT_OF_RANGE`) — caller `round` not in {1,2}
   (R3).
6. `INVALID_SHAPE` (`ROUND_DISAGREES_WITH_LEDGER`) — caller `round` does
   not equal the ledger-computed next round (max recorded round + 1); a
   force-push that changes `headSha` does **not** reset the round counter
   (C11) — the ledger is keyed by PR number, not by SHA.
7. `CODEX_ERROR` — nonzero exit code, or empty/whitespace-only stdout,
   from the `codex exec` invocation itself (process-level failure, not a
   content problem). Checked before any shape/fence/round parsing of the
   verdict body (D12).
8. `INVALID_SHAPE` — the verdict body fails template parsing (A1: stray
   text; A2: a required field missing or duplicated), or `SHA` in the
   verdict does not match the wrapper's independently-resolved
   `headRefOid` (A3), or an `APPROVE` verdict carries a BLOCKER finding,
   or a `BLOCK` verdict carries zero BLOCKER findings.
9. `OUT_OF_FENCE_BLOCKER` — shape otherwise valid, but at least one
   BLOCKER's `file=` value is outside the fence after normalization
   (B5/B7), or its `text=` remedy mentions a path token
   (`\S+\.(js|mjs|md|json|sql|yml|ps1)`) outside the fence (A4), or its
   remedy text matches the rearchitecture pattern — "new file", "new
   module", "extract", "refactor into", "move to", or any path not in the
   fence (F17). Rejected outright, never silently downgraded to LEAD.
10. `ROUND_EXCEEDED` (content case) — the verdict's own `ROUND` field is
    > 2, or its text otherwise asks to widen scope or run another pass.
11. `VALID_APPROVE` — all required fields present, `VERDICT=APPROVE`,
    zero BLOCKER findings, `SCOPE_RESPECTED: yes`, round ≤ 2, SHA matches.
12. `VALID_BLOCK` — all required fields present, `VERDICT=BLOCK`, ≥1
    BLOCKER finding, every BLOCKER's file inside the fence, round ≤ 2,
    SHA matches.

Every bucket other than `VALID_APPROVE` is a non-passing result; the
wrapper never defaults a non-passing bucket to approval.

## Wrapper exit codes and final result line (round 2)

The wrapper's process exit code distinguishes all three outcome classes a
caller (CI step, shell script) might branch on: `VALID_APPROVE` exits `0`;
`VALID_BLOCK` — a real, unresolved BLOCKER verdict — exits `2`; every other
bucket (every halt, every precondition refusal, every gate error such as a
failed `git diff` or a failed `gh pr comment` post) exits `3`. No bucket
other than `VALID_APPROVE`/`VALID_BLOCK` ever exits `0`.

Regardless of bucket, the wrapper's LAST line of stdout is always a
single-line JSON object — `{"outcome": "<bucket>", "round": <int|null>,
"sha": "<headSha>"|null, "reason": "<reason>"|null}` — in addition to the
human-readable `Bucket: <bucket> (<reason>)` line and, for halting
outcomes, the `HALT` line (Escalation, bullet 3). This JSON line is the
authoritative machine-checkable result; the human-readable lines are for
operators reading the log.

## Path fence equality (B5/B7)

Both the fence's paths and any path being tested against it are
normalized before comparison: backslashes become forward slashes, a
leading `./` is stripped, repeated `/` collapse to one, and the result is
lower-cased when the wrapper is running on `win32` and left
case-sensitive on every other platform. This makes fence membership
resilient to `gh`/`git diff` emitting `/`-separated paths while a BLOCKER
finding's `file=` value (typed by Codex) uses `\`-separated ones.

## Round ledger

Round history for a PR is recorded as PR comments, **appended, never
rewritten or deleted**:

- Each round's comment carries a marker line
  `<!-- codex-review-round:<N> sha:<headSha> hash:<sha256 of the fenced
  verdict body> -->` (C10). Before posting, the wrapper re-reads the full
  comment list; if a marker for the same `(round, headSha)` already
  exists, it aborts as `ROUND_EXCEEDED` rather than posting a duplicate
  (C8/C9, idempotent).
- The wrapper recomputes each existing marker's hash against its fenced
  verdict body on every read. A mismatch (the comment was edited after
  posting) makes the ledger tamper-evident-invalid; the wrapper treats
  this the same as an unlifted halt and refuses to proceed (C10).
- `round` is decided by the wrapper from the ledger's own comment count
  for that PR (max marker round + 1), not from caller say-so alone; a
  caller-supplied `round` that disagrees is a refusal (`INVALID_SHAPE` /
  `ROUND_DISAGREES_WITH_LEDGER`), not an override.
- Force-pushing a new head SHA does **not** reset the round count (C11):
  the ledger is keyed by PR number across all SHAs seen on that PR: round
  2 after a force-push is still round 2, not a fresh round 1.
- Round 2's prompt assembly reads the round-1 comment by its marker and by
  labeled fields inside it (SHA, verdict, findings) — never by assuming it
  is the file's last comment or at a fixed offset.

## Escalation / halt (E15/E16)

Any of: a `ROUND_EXCEEDED` classification (content case), a caller
request for round 3, a `HALTED`-ledger read, or any prompt/response
proposing to widen the fence, halts the wrapper immediately — no round 3
prompt is ever assembled automatically (R3). On halt the wrapper:

1. Posts exactly one PR comment carrying the marker
   `<!-- codex-review-halt -->`, stating: which condition fired, the PR
   number, the round count so far, and that owner approval is required
   before continuing.
2. Writes durable halt state (the posted comment itself, read back on
   every subsequent invocation via `parseLedger`) — a halt is not only an
   in-process flag.
3. Exits with code `3` (see "Wrapper exit codes and final result line"
   below) and prints a `HALT` line to stdout, so a CI step that only
   checks exit code and a shell script grepping stdout both detect it.

Any later invocation on that PR is classified `HALTED` and performs no
further work — no Codex call, no new ledger comment — **unless** a PR
comment containing `<!-- codex-review-halt-cleared -->` has since been
posted by the owner. No agent may post that clearing marker itself; only
a human owner action does.

## Non-goals

Not building: an approve/merge action (separate, independent-agent concern
per this repo's PR-independence rule); a general Codex-as-architect
consultation path (R1); automatic rearchitecting toward Codex's
preferences (R4) — the sole exception, a net improvement for both hosts,
still requires owner approval before authoring, never wrapper-triggered.

## Adversary findings (2026-09-13) — disposition

All 17 findings below are closed by the sections above; this table is a
mapping from finding ID to where the fix lives, for traceability.

| ID | Finding (short) | Fix location |
|---|---|---|
| A1 | Free text outside enumerated fields | Verdict shape (strict template); classification step 8 |
| A2 | Required field occurring ≠ exactly once | Verdict shape; classification step 8 |
| A3 | Verdict SHA not checked against a wrapper-resolved SHA | Inputs (`headRefOid` resolved independently); classification step 8 |
| A4 | BLOCKER text references an out-of-fence path outside the `file=` field | Classification step 9 |
| B5 | Path equality not normalized | Path fence equality section |
| B6 | Fence not resolved fresh per round; renames not covered | Prompt assembly step 2; Path fence equality |
| B7 | Case sensitivity unspecified | Path fence equality section |
| C8 | Ledger dup-round not idempotent | Round ledger, bullet 1 |
| C9 | Ledger not re-read before posting | Round ledger, bullet 1 |
| C10 | Ledger comment could be edited post-hoc undetected | Round ledger, bullet 2; classification step 1 |
| C11 | Force-push resets round count | Round ledger, bullet 4; classification step 6 |
| D12 | No fixed priority order across failure classes | Total classification (fixed 12-step order) |
| D13 | Zero changed files unhandled | Total classification step 3 |
| D14 | Draft PR unhandled | Total classification step 2 |
| E15 | Halt has no durable state | Escalation, bullets 2-3 |
| E16 | Halt not enforced on subsequent runs | Escalation, final paragraph |
| F17 | Rearchitecture BLOCKER not distinguished from in-scope BLOCKER | Classification step 9 |

## Blind spots

What this wrapper cannot detect: Codex silently ignoring an instruction in
the prompt while still emitting a well-formed verdict; a finding phrased as
a question rather than a stated BLOCKER/LEAD, which may evade the
classifier's field parsing entirely; scope-fence evasion via a file rename
or move whose *content* (not path) smuggles unrelated changes past a
path-only fence check; and any case where Codex's own sandbox or `codex
exec` environment silently truncates the diff or prompt below its stated
size limits without surfacing an error. The `gh pr view --json files`
JSON shape has not been verified live against a Windows `gh` install in
this pass — see BLIND SPOTS in the implementation PR.
