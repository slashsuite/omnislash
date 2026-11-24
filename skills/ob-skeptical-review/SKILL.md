---
name: ob-skeptical-review
description: "Adversarial pass on a builder's diff. The readers presume every changed line is wrong (buggy, stupid or overbuilt) and clear a line only when they can show it is right. Triggers: skeptical review, adversarial review, council, overkill, overboard, YAGNI on this diff, spinoff self-review. Not Standards, not Spec, not nits, not CodeRabbit."
---

# Skeptical review

A **subagent** pass on `git diff main...HEAD` (or the PR diff).

## The stance: every line is wrong until shown right

The reader starts from the presumption that **every added or changed line in the diff is wrong**, and the builder has
to be proven right, not the other way round. Go through the diff line by line, hunk by hunk. For each line, try to break
it: what input, state, caller, race, error path or platform makes it do the wrong thing? Is it needed at all? Is it in
the right place? A line is cleared only when you can say, in your head, why it is correct, needed and in the right
place. Do not skim a hunk because it looks routine; routine lines are where the bugs the builder stopped looking at sit.
Read the surrounding code and the callers a line depends on before clearing it.

Each line that is not cleared is one of three findings:

1. **wrong**: it does the wrong thing. A bug, a wrong condition, an off-by-one, an unhandled error or empty case, a
   race, a broken must-still-work, a test that passes without proving the behaviour.
2. **stupid**: it works but is the wrong move (wrong layer, duplicate, fights an existing seam).
3. **overboard**: it should not exist, or should be much smaller, for this ticket (extra files, extra abstraction,
   extra tests, extra API for a one-line job).

**The presumption is where you start, not what you report.** A finding counts only with evidence: for `wrong`, the
concrete failure (these inputs or this state, then this wrong result); for `stupid` and `overboard`, the `file:line`
and the simpler move. A suspicion you could not turn into evidence after reading the code is not a finding; leave it
out, or name it once as `unproven:` with what would settle it. Inventing findings to look adversarial costs a review
round and the builder's time (review cost), and a reader that does it is noise.

Not style. Not nits. Not "add coverage for completeness." Not "extract this for cleanliness."

## Always check

These count as **stupid** or **overboard** in any repo on the standard stack
(`STANDARD-STACK.md` in your `ob-new-project` skill):

- **Test bloat** (overboard). A test that duplicates a higher layer's coverage: a unit test for a path an
  integration test already drives, an e2e for an edge case, many near-identical cases where one shows the
  behaviour. Name the tests to cut.
- **A smoke test that is not isolated** (stupid). It runs as a real user, writes rows without `is_smoke`,
  accumulates rows on repeat runs, sends to a real recipient, or carries credentials in the repo. Also: a
  new report, dashboard, count, listing or billing query that skips the `real()` filter, or that has not
  joined the exclusion test.
- **A payment path that can be reached unguarded** (stupid). A charge, payout or refund call that does not
  go through `guardedPayment`, a smoke test that needs live keys, or a "smoke" test that makes a real charge.
- **What the linter cannot see** (stupid). New exports that nothing imports, and a catch that swallows
  the error (holds only a comment, or logs and carries on where the caller needed to know).

## Which models

**The owner picks the readers, their models and how many run per ticket tier.** The owner sets them on the dashboard's **Reviewers** page (`/reviewers`) or with
`ob review readers set|rm|tier`; both write the server's `review_readers` setting, so every machine reads the same
set. `ob review readers --tier <tier> -q` prints the legs a tier runs, one per line, and How to run runs exactly
those. A simple ticket may get one reader and a complex one two or more. Unset, every tier runs the two below. The free
`opencode/` readers failed on every review (glm and mimo hit "Free usage limit reached",
`opencode/nemotron-3-ultra-free` is gone), so the page does not offer them.

The default readers:

1. **`antigravity:gemini-4-neon`** (run by `agy --sandbox` through `review-leg.ts`), named `neon`.
2. **`claude-opus-5-5` at its default effort** (run by `claude -p` through `review-leg.ts`), named `opus` (old name `sonnet`, an alias that a `models.jsonc` `review.sonnet` still feeds). It passes no `--effort`. **Opus never runs a review on `high` or above unless the owner explicitly asks for it.** It replaced Sonnet.

`deepseek` (`opencode-go/deepseek-v4.1-flash#high`, paid) and `luna` (`opencode-go/gpt-6-luna#high`, paid) left the default set and stay runnable whenever a models profile or `review_readers` names them.

A reader the owner left on is run; it is not skipped in advance because `ob creds check opencode-go` warns "running low"
(choosing is the owner's, and the page shows the credit state). An `opencode-go/` reader that fails on a credit error is
`skipped (no credits)` and owes nothing (Out of credits rule below). Do not add a free `opencode/` reader without the owner's word.

Every leg run is recorded: `review-leg.ts` writes one line per attempt (wall time, model, diff size, exit, tokens where the tool leaves them) to `review-legs.jsonl` beside the models file, and `ob models legs` prints the trend per model per day. Run the leg from your rebased worktree so the diff size is right.

- **Where a leg's model comes from.** `review-leg.ts` reads the readers in force once
  (`ob review readers --json`: the active profile's `review` in `model_routes`, set with `ob models reader`, else the
  old `review_readers` key): a leg named there runs on that model, with one attempt (no profile fallback).
  Otherwise the machine's `~/.config/ob/models.jsonc` (`ob models show`, the active profile's `review` map), then the
  built-in table. An `antigravity:` model runs through `agy`, an `opencode/` or `opencode-go/` model runs through opencode, anything else through claude. A leg
  whose model comes from the setting prints `review-leg: <leg> runs <model> (review_readers)` on stderr. If the setting cannot be read (API down) it says so
  in one stderr line and uses the models file. A models file that does not parse makes the leg fail by name; report
  that leg as failed.
- **Skip (independence).** If the builder itself ran a reader's model, that leg is skipped and reported as
  `+ <leg>: skipped (builder)`; do not add a fallback reader in its place. The Opus leg is never skipped on this rule, and the Neon leg is never skipped when the builder ran another model (for two default legs, a builder on one still gets the other independent reader; with Opus also down, the Opus stand-in rule below applies).
- **Failure.** A failed leg ends on one stderr line, `review-leg: <leg> failed: exit <n>: <reason>`. Copy its `exit <n>: <reason>` into the review line: `+ <leg>: failed (exit <n>: <reason>)` (`+ neon: failed (exit 1: model gemini-4-neon unavailable)`), never a bare `failed`. It is never retried around and
  never blocks the land; the review still stands on the readers that ran. The Opus leg failing is handled by the stand-in
  rule below.
- **Profiles first.** `review-leg.ts` already reruns a leg that ends on a credit or quota error on the
  next models profile that gives that leg another (kind, model) (`ob models show`, the `fallback` list), and says so on
  stderr. For `agy` (`antigravity:` legs), quota, rate limit, `RESOURCE_EXHAUSTED`, `429` or a JSON `status` other than `SUCCESS` with such text triggers the same fallback. The rule below applies only once the leg has exited non-zero after that.
- **Out of credits rule.** No required reader is paid, so a paid
  leg (`deepseek` or `luna`, when a profile names one) out of credits reports `skipped (no credits)` and files nothing; the owed-review
  steps below apply only if a paid reader is made required again. When a required `opencode-go/...` reader
  exits non-zero, run `ob creds check opencode-go`. Only if it reports `FAILED` is the reader `skipped (no credits)`
  and not `failed`. The review carries on with the readers that ran, and the land is not blocked. If the check
  passes, the leg is an ordinary `failed` as above and no ticket is filed. The check decides, not the leg's error text,
  so do not match on `Insufficient account funds` or rate-limit output. A paid optional leg skipped this way reports
  `skipped (no credits)` and files nothing.
  - **Log the owed review.** Each skipped review files one ticket, on the reviewed repo's project, in the same step that
    records the result. One owed ticket per reviewed ticket, covering every reader it is owed:
    `ob add "Owed review: <ticket>, <readers>" --project <project> --priority medium --tag review-owed --body "<body>"`
    The body names the ticket, the branch (the PR may not exist yet: round 1 usually runs before `gh pr create`, so
    the architect finds the PR by `gh pr list --state all --search <ticket>`), the readers owed (the paid ones, such as `deepseek` or `luna`), the
    round they missed, and the review kind: skeptical review, or hill climb with its kit path. The body also says
    "the architect pays this back under Owed reviews, not through `ob spinoff`". Note the ticket's ref.
  - A reader skipped for independence (`skipped (builder)`) is not owed and files nothing.
  - **Paying it back** is the architect's: `skills/ob-architect` (Step 0 and the queue pass) runs the owed readers once the
    creds check passes and closes the ticket.
- **Optional legs:** `deepseek`, `luna`, `opencode-go/claude-haiku-5-5#high` and `opencode-go/qwen3.8-flash#high` (paid, so only while the
  account is funded). Their disagreement is signal; add one only to settle a thin or disputed finding, and never
  while `ob creds check opencode-go` warns "running low".
- **Opus unavailable** → the other default leg (`neon`) stands in for Opus, or `deepseek`/`luna` when `neon` is
  skipped (builder) or out of credits, and the report says so. The review is never skipped and never stamped
  `needs-human` for want of a reviewer.
- **Independence, not consensus.** Each leg gets the **same shared part of the brief** and the **same diff**, and
  from round 2 only its **own** previous findings and answers (How to run), with **no knowledge of the others'
  findings**: showing a later model an earlier list is how several reviews become one review with several names.
- **Merge the lists yourself.** Findings that **agree** get one line saying which legs raised them.
  The readers stay blind to each other; agreement is read off the independent lists, at no cost. The council trial
  (a 2026 trial of these merge rules against a council vote) is the evidence for each rule here:
  - **Rank by agreement.** Order the merged list by how many legs raised each finding, then by severity (`wrong`
    before `stupid` before `overboard`). In the trial that order put 19 planted defects in the top three, against
    13 for a council vote.
  - **Cap at ~8, but a single reader's finding is never dropped unread.** Only one leg raising a finding is not a
    reason to drop it: the one real defect the trial's council lost was raised by a single reader. Drop it, at
    the merge or under the cap, only with a reason that names the code (`file:line` and why it is right). Past the
    cap, the rest go in a short `raised by one reader:` tail below the list, one line each, so they are kept
    and not acted on first.
  - **Agreed-only short list, on request only.** When a short list matters more than catching everything (a
    quick second look, a PR with little time), keep only findings two or more legs raised and say so in the
    report line (`agreed only`). In the trial that gave 94% precision but lost recall, so it is never the default.

  Report Neon and Opus (plus any extra or configured leg), naming the model that
  actually ran: `skeptical-review: N cut, 0 open (neon: a + opus: b)`. A failed leg reads
  `+ neon: failed (exit 1: <reason>)`, copied from its `review-leg: neon failed: ...` line (Failure, above), a skipped one `+ neon: skipped (builder)`, an out-of-credits paid one `+ luna: skipped (no credits)`,
  and an Opus stand-in `(neon(for opus): a)`.
  A model that keeps returning `ok` should be visible, not averaged away.
- **Never `opencode-go/gemini-4-argon-contributor` and never `opencode-go/grok-4.7`** (too expensive). Do not reach for them to make a review "stronger", and do not re-propose them.
- **Escalating:** when a diff is hairy or a finding sounds thin, re-run on the narrowed question (one
  file, one finding) rather than a bigger model on the whole diff.
- **Never the builder's own model**: independence is the point. The Opus leg is never skipped, and
  medium and complex builders also run Opus or Neon, so for those builds one reviewer matches the builder
  while the other stays a different model, and both get a fresh context and brief-only independence.
- **Readers are read-only by permission, not by brief.** Every leg runs through
  `review-leg.ts` (beside this file) under a read-only profile (`ob-reviewer.md` for OpenCode, `--allowedTools`/`--disallowedTools` for Claude, `--sandbox` + `--settings` for Antigravity).
  It denies edits and writes. The shell is cut to a read-only allowlist (`git log/show/diff/status/blame`,
  `cat`, `grep`, `ls`, `head`, `tail`, `wc`, `ob show`, `ob status`), and backticks, `$(`, `;`, `&`,
  pipes and redirects are denied on the OpenCode and Claude legs (the Antigravity legs also list them in their deny rules, but that is unverified; see the Antigravity bullet). That ends two past accidents: a reader that shell-executed `ob spinoff cleanup`
  through an unescaped backtick, and one that left edits in six files.
  - **Antigravity legs (`neon`, or any `antigravity:<model>`)** have no shell-metacharacter denial verified: their read-only guarantee is `--sandbox` plus the `--settings` allow list only. Until a live run shows agy's matcher refuses a compound command, treat them as read-only by instruction and sandbox, not by proof. They run `agy --model <model> --sandbox --output-format json --settings '<read-only permissions>' --add-dir <briefDir> -p '<short prompt>'` (no `--mode plan`, no `--dangerously-skip-permissions`). The brief is written to a temp file under `$TMPDIR` so briefs over 128 KiB never hit E2BIG; `review-leg.ts` prints `response` as plain text and records `usage` tokens in `review-legs.jsonl`.
  - **OpenCode legs (`deepseek`, `luna`, or `opencode/<model>`)** run `opencode run --standalone --agent ob-reviewer -m <model>#high`. `OPENCODE_CONFIG_DIR`
    carries the profile, so it applies in any repo under review. The brief goes on stdin, as it does to the
    Opus leg, never in argv, which avoids the 128 KiB cap on one argv string (a larger one fails with
    E2BIG). An agent that fails to resolve stops the run
    (`Agent not found`); it never falls back to `build`.
  - **The Opus leg** runs `claude -p --restricted --strict-mcp-config --permission-mode dontAsk`, with only
    `Read,Grep,Glob,Bash` and Bash narrowed to the same allowlist. Anything outside the allowlist is denied,
    never asked about.
- **Not `delegate_task` for the legs.** `delegate_task` cannot choose a tool profile. T3 runs every
  OpenCode child on its `build` agent (`plan` in plan mode) with a session-wide `* allow` in full-access, and
  a narrower runtime mode turns shell into an `ask` that parks a headless child. A Claude child gets no tool
  list at all. If T3 grows an agent or permission option, move the legs back onto it, keeping the profile.

## How to run

Write the shared part of the brief once: this skill, the diff (`git diff main...HEAD`) and the ticket ACs.
Give it this scope line, and nothing that invites more (never "read the other checkouts under ~/dev"):
`Scope: read the diff above first, then only the files it touches and their direct callers, inside this checkout.`
A reader that wanders burns its turns and time (one DeepSeek leg made 101 calls on a skill-text diff).
Launch **one background leg per model**, each from its own brief file, none told what the others said. Run
them from the worktree under review:

Read the readers for the ticket's tier first (`ob spinoff show <ticket>` prints `tier:`; no tier on the row means
medium), and run exactly those:

```bash
R=<skill dir>   # ~/.claude/skills/ob-skeptical-review
D="${TMPDIR:-$HOME/.cache/tmp}"
TIER=<the row's tier, else medium>
# an older ob or the API down: fall back to the two defaults rather than run no reader
legs=$(ob review readers --tier "$TIER" -q) && [ -n "$legs" ] || legs="neon opus"
for leg in $legs; do
  bun "$R/review-leg.ts" "$leg" < "$D/review-<ticket>-$leg.brief.md" > "$D/review-<ticket>-$leg.txt" 2>&1 &
done; wait
```

Each leg ends on its own, so the loop needs no timeout of its own: an attempt that passes 15 minutes
(`OB_REVIEW_LEG_TIMEOUT_S` overrides) is killed, keeps the output it printed, prints
`review-leg: <leg> timed out after <n>s; partial output above` (for an `agy` leg, `no partial output`, since agy prints only when it finishes) and exits 124 (report it as `failed (timeout)`;
rerunning it is your call), and a reader has 40 turns (`steps: 40` in `ob-reviewer.md`, `--max-turns 40` on the
claude leg). At the cap an OpenCode reader gives its final answer with tools off; the claude leg exits 1 with
`Error: Reached max turns (40)` and no findings, which is `failed (max turns)`. Either way the leg's last stderr line is
`review-leg: <leg> failed: exit <n>: ...`; these two named reasons replace the copied one.

An optional leg is its full id too: `bun "$R/review-leg.ts" opencode-go/qwen3.8-flash#high`. A leg that exits
non-zero is `failed`, or, for a required `opencode-go` reader out of credits, `skipped (no credits), owed <ref>`. Drop a skipped
leg from the loop. Never start a leg any other way: a reader run outside `review-leg.ts` is read-only by
instruction only. If no leg can launch, do the pass yourself in a fresh turn with **only** that diff. Do not
skip the gate.

**From round 2 the brief is per leg, because the round is the rebuttal pass.** Each leg's brief file
is the shared part above plus, for that leg only, its own previous findings verbatim and the builder's answer to
each:

```
fixed: <file:line>
rebutted: <what the answer rests on, in the finding's own terms>
```

For a `wrong` that is the input or state the finding needs, the line that handles it, or a probe output. For a
`stupid` or `overboard` it is the one-line justification (the ticket required it, an existing pattern already does
this, an earlier round asked for it), and the reader rejects it by naming the simpler move the answer misses. An
`unproven` the builder dropped is answered with the one line on why it does not hold.

Copy the findings out of the stdout file the loop writes for that leg (`$D/review-<ticket>-<leg>.txt`, or
the same under `$TMPDIR` when it is set; scratch, never committed), so verbatim is a file copy and not a retype.
Never put two legs on one brief file: a shared file either shows every leg the others' findings or leaves all but
one unable to answer its own. No leg ever sees another leg's findings or answers, in its brief or anywhere else:
a rebuttal round stays several independent reviews, not one review with several names. This is the same
`review-leg.ts` call with different stdin, so there is no new mode and no change to `review-leg.ts` or
`ob-reviewer.md`.

Each subagent returns a short list, nothing else. **On a rebuttal brief it answers the prior findings first**,
one line each, before any new finding and before the score:

- `accepted` / `rejected: <the concrete input and wrong result the answer misses>`: one line per prior
  finding, in the order the brief listed them (rebuttal rounds only). A `stupid` or `overboard` finding has no
  wrong result, so its rejection names the simpler move the answer waves away.
- `wrong:` file:line: what breaks, the inputs or state that break it, the fix
- `stupid:` file:line: what, why, the simpler move
- `overboard:` file:line: what could go; the small change that was enough
- `unproven:` file:line: a suspicion the reader could not settle, and what would settle it (at most two; never counts as a cut)
- `ok`: only when every changed line was cleared; say how many hunks were read

Then one line: `score: N/10`: how far the diff is from a correct, simplest version that meets the ticket (10 = nothing
wrong and nothing to cut, 1 = mostly broken or overbuilt). A reader that cannot score says `score: none`.

Cap each list at ~8 findings, `wrong` first; merge them yourself, ranked by agreement and keeping single-reader
findings (Which models, Merge the lists yourself). No praise. No essay.

## Claims review (spikes)

A spike (a ticket tagged `spike`) ships no code, so there is no diff to read. What reaches the architect is
its claims: the report it committed under `docs/`, and the `ob note`s it wrote on the parent ticket. Its numbers
and file references drive build tickets (OS-180: HC-559's numbers drove four; OS-167 named a decision write in
`moveSpinoff` that is not there), so the spike runs this review before its handoff.

**The stance.** Every claim in the report and the notes is wrong until evidence clears it. A reader reports
one of three findings, each with the claim quoted:

- `wrong:` a file:line, symbol, behaviour or count that the code at the brief's sha contradicts. Quote what
  is actually there (`git show <sha>:<path>`).
- `unbacked:` a number or result whose command and output are not in the report or the worktree. Readers
  cannot re-run anything (`READ_COMMANDS` in `review-leg.ts`), so they only look for the cited output; a
  number with no output beside it is unbacked, however plausible.
- `leap:` a recommendation or draft ticket that the evidence above it does not support. Name the step
  that is missing.

On a rebuttal brief (round 2 on) it first answers each prior finding, one line each, `accepted` or
`rejected: <the evidence the answer misses>`. Then `ok` (say how many claims were read) or the findings, at most
~8, `wrong` first, and `score: N/10`.

**The brief recipe.** The same legs as a diff review, every one `ob review readers --tier <tier> -q` lists
(How to run), each through `review-leg.ts` with its own brief file; `review-leg.ts` and `ob-reviewer.md` do
not change. Fetch first, because readers cannot:

```bash
git fetch origin
SHA=$(git rev-parse origin/main)
legs=$(ob review readers --tier "$TIER" -q) && [ -n "$legs" ] || legs="neon opus"
for leg in $legs; do
  { sed -n '/^## Claims review (spikes)/,/^## Before the readers run/{/^## Before/d;p;}' "$R/SKILL.md"
    echo "Ref: check every claim against origin/main at $SHA (git show $SHA:<path>)."
    echo "Scope: the claims below; read only the files they name, at that sha."
    echo; echo "## The report"; cat docs/<the report>.md
    echo; echo "## The notes on the parent"; ob show <parent>
  } > "$D/review-<spike>-$leg.brief.md"
  bun "$R/review-leg.ts" "$leg" < "$D/review-<spike>-$leg.brief.md" > "$D/review-<spike>-$leg.txt" 2>&1 &
done; wait
```

With no report, the notes alone are the brief. A leg's recorded `diffSize` is the spike branch's diff and
means nothing for a claims review; ignore it. Skipped and failed legs are reported as for a diff review.

**Rounds.** Fix or strike each finding, then run the next round with the rebuttal pass above, at most 3
rounds as for a build. A claim in the report is fixed by editing the report. A claim in a note is fixed by
a new `ob note <parent>` that corrects or withdraws it (a note cannot be edited), and the next round's brief
carries it. The spike hands off with `claims-review: <N> cut, 0 open (<leg>: <a>, <leg>: <b>)` in `--note`,
naming every leg, for example `claims-review: 3 cut, 0 open (opus: 2, neon: 1)` (`ob-spinoff`, the spike
paragraph). The handoff refuses a spike without that line or with open findings. It reads the last such line in
the note and `--report` together, report last, so a report that records earlier rounds ends on the final one.

## Before the readers run (rounds, step a)

Readers judge the diff they are handed, so hand them the current one. Before a round starts:

1. Address the open PR comments that are newer than the latest push (verify each finding first; decline with a reason). Round 1 usually has no PR yet, so this step is a no-op then.
2. Fix the known issues in the diff. Do not defer a known fix until the readers return.
3. Run the gate (ob-spinoff §3) on that tree.

Only then build the brief and launch the legs. If the user wants to throw the implementation away and explore new
ideas, skip the fixes to code that is being replaced, and say so.

## Scores and rounds (steps b to d)

- **Each reader gives a score out of 10**, on top of its wrong / stupid / overboard list. The score is for the same lens
  (wrong, stupid or overbuilt), not for style or completeness. A reader that gives no score is recorded as `no score`. Never
  invent one.
- **One full pass of the readers is one round.** A fresh pass after fixes is a new round, with a fresh brief and the
  readers that are still funded. Do not re-run a round to get a different answer.
- **The next round is the rebuttal pass.** There is no separate pass bolted onto the loop: from round 2,
  each leg's brief carries that leg's own previous findings and the builder's `fixed` / `rebutted` answer to each
  (How to run). The reader answers every prior finding `accepted` or
  `rejected: <the concrete input and wrong result the answer misses>` before it reports new findings, then scores
  the diff again. A finding closes only when the reader accepts the answer to it, `fixed` or `rebutted` alike; a
  reader that stops reporting a prior finding without answering it has not closed it. A `rejected` answer is an
  open cut exactly like an unfixed `wrong`, and it blocks `State: landable`. An answer left in the PR text alone
  closes nothing: the reader never saw it, so it reports the same finding again and its score cannot move. One PR
  saw the same open finding survive three rounds that way.
- **The score is the verdict on that pass, not a separate number.** If a reader accepts every answer, reports no
  new finding, and still scores below 10 and no higher than it did in the previous round, it must name the concrete
  finding that still holds. A score with no finding behind it is a question for the owner, never a reason to keep a
  round open. A 10/10 with nothing new to say is a finished pass, not a finding owed.
- **Keep the scope.** Repeated rounds are the usual way a small PR grows. Fix every `wrong` finding (or show with
  evidence that it is not), cut or justify every stupid / overboard finding, leave `unproven` ones to the builder's judgement, and do not add a new change in response to a score alone. Stop when no reader has an open cut. A low score
  with no concrete finding behind it is a question for the owner, not a todo.
  **The overboard ratchet costs two rounds:** a reader that asks for a lock, a guard or a split makes the next diff
  bigger, and a later round that then marks that growth `overboard` has charged twice for one finding (one PR spent
  rounds 1 to 3 that way). When a fix would grow the diff, the builder prefers the smaller correct version and
  records the trade-off in its answer; the reader scores the smallest version that is correct, not the most guarded
  one, and does not mark as overboard a mechanism an earlier round asked for without saying that earlier ask was
  wrong. The builder's answer may say an earlier round asked for it without naming the leg: the fact crosses, not
  the findings, so the legs stay independent.

### The `## Skeptical review` section in the PR body

Once the PR is open, put the result in its body, under this heading:

```markdown
## Skeptical review

Rounds: 2

| Reader | Round 1 | Round 2 (rebuttal) |
| --- | --- | --- |
| claude-sonnet-5-5 (high) | 7/10 | 8/10 |
| opencode-go/deepseek-v4.1-flash | 6/10 | 8/10 |
| opencode-go/gpt-6-luna | 8/10 | 9/10 |

Rebuttals: round 2, 4 accepted, 0 rejected (sonnet 2, deepseek 1, luna 1).

The scores above are a format example. Sonnet has no recorded score yet.

Cut in round 1: 2 (test duplicates the integration case; unused `mode` option).
Open: 0.
```

- `Rounds:` is the count of full passes. A reader that is skipped (builder), failed, or skipped (no credits) shows its
  status in its cell (`skipped (builder)`, `failed`, `skipped (no credits), owed <ref>`), not a score.
- A round that carried answers is labelled `Round N (rebuttal)`, so an accepted answer is visible in the
  `Rebuttals:` count and, when nothing else held the score down, as a score that moved; a rejected one shows as a
  named cut. The score stays a verdict on the whole diff and not a mark per finding, so accepting one finding while
  another of the same weight stays open can leave the score where it was. Under the table, one `Rebuttals:` line
  carries `<a> accepted, <r> rejected` per round, with the per-reader split when the legs differ. Only a reader's own
  `accepted` / `rejected` replies can fill it, which is what proves the answers reached the reader. A rejected answer
  is counted in `Open:` under the finding it keeps alive, exactly like an unfixed `wrong`, and the round is not
  landable until it is fixed or accepted.
- Add the section when you open the PR. Once it exists, edit the body with `gh pr edit <pr> --body-file <file>`. Do not
  post a comment for this. The commit body carries no review section: the squash would copy it into `main`.
- **Every repo except OmniSlash:** the section goes in the `--report <file>` of `ob spinoff handoff`, onto the
  ticket's Decisions trail, never in the PR body. Its model names would read as ob in an open-source PR, and the handoff
  refuses a PR body that carries ob.
- The section carries no AI attribution (ob-spinoff §4: no `Created with` footer, no `Co-Authored-By`). The model names
  in the table are the readers' ids, not a signature.

## The blind pair review (architect)

A model trial pair is reviewed blind, by the architect, before either leg lands. This is not the builder's review above: it compares two
finished builds of the same ticket.

1. `ob spinoff trial pair <ref> --diffs <dir>` writes `X.diff` and `Y.diff`. Read only those two and the ticket. Never `ob spinoff show`,
   `list` or `trial report` for the pair before the verdict: they name the model.
2. Run the same readers as above (`review-leg.ts`, the `ob-reviewer` profile, each leg blind to the others), each given only the two
   diff files and the ticket's `## Done when`. Each reader scores each leg **0 to 10** on the `## Done when` (met, with evidence),
   defects (anything wrong, stupid or overboard by the rules above) and how simply it does the job. The recorded score is the readers'
   mean, rounded; a `done` mark is yes when most readers say yes. A leg that is `blocked` or `partial` scores `blocked` or `partial` (0).
3. Write the notes file, one `done` mark per `## Done when` item in order (a count that differs is refused):
   ```json
   {"X":{"done":[true,true,false],"defects":["writes the lease twice"],"notes":"..."},"Y":{"done":[true,true,true],"defects":[],"notes":"..."}}
   ```
4. `ob spinoff trial record <ref> --x <n> --y <n> --notes <file>`. The higher score wins and a tie goes to leg a.

## What the builder does

- **wrong**: fix it, with a test that fails before the fix when one can be written, or rebut it with evidence (the
  line that handles that case, the test that already covers it). "Looks fine to me" is not a rebuttal. The evidence
  reaches the reader only through the next round's brief, so write the answer down where that brief can copy it
  (below).
- **Record every answer for the next brief.** For each finding, save the leg's stdout for the round and write, beside
  it, that leg's answer: `fixed: <file:line>` or `rebutted: <what the answer rests on, in the finding's own terms>`
  (How to run says what that is for each finding kind). The next round's brief is that file plus the saved findings
  (How to run). An answer that lives only in the PR text or in your head is a veto: the reader never judges it,
  reports the same finding again, and the score cannot move.
- **stupid** / **overboard**: cut it or justify in one line (ticket required it / existing pattern). Start a new round (see Scores and rounds) only when a fix or cut changed the diff.
- **unproven**: check it yourself; fix it if it holds, otherwise drop it with one line on why.
- An unfixed `wrong`, a `rejected` answer, or an unjustified leftover blocks the PR and `State: landable`.
- Report: `ob agent register --id <builder id> --status readying --note "skeptical-review: N cut, 0 open (neon: a + opus: b)"`, each leg separately, because a model that keeps returning `ok` is information the thread that gates it wants.
