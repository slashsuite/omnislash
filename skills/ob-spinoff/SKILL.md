---
name: ob-spinoff
description: "The ob spinoff operating procedure. A spun-off ob agent runs THIS end to end: build in its wt worktree, pass the moon gate, and COMMIT it on its own branch ending with a `State:` line (landable / needs-human / blocked / partial) so the architect can scan several worktrees and know what to do without opening a diff; then rebases, pushes, opens its own PR and hands off with the PR URL, and STOPS (it never merges, deploys or closes: the architect gates and merges; no external tracker, no design/screenshot gates). Reports each gate via its ob status. Repo-specific skill living in ob; composes the general shared skills where relevant. Spinoff is always interactive: the brief is the ticket's own brief, not a pointer to it. Load this when the owner wants the self-gate. Use when you are a spun-off agent working an ob ticket."
---

# ob-spinoff (spinoff operating procedure)

You are a spun-off agent on an ob ticket. This is the OmniSlash monorepo (the `ob` tracker):
no external issue tracker, no web dev-server, no design/screenshot gates. **You ship your work through a
PR and you never merge it:** you gate, commit, rebase, push, open the PR and hand off
with its URL, then stop. The architect gates the PR head, merges it, deploys and closes. Follow this repo's build->land flow
(its agent rules). Run this in order and REPORT each gate via your ob status before reporting done. No AI/Claude
attribution anywhere.

## 0. Orient + stay visible
- Nobody is there to answer a permission prompt. Use absolute paths in destructive shell commands, and do not wait on a prompt. Take another way, or end with `State: blocked` and say what was refused.
- **A planned change to the owner's own accounts is not asked step by step.** When your ticket lists the steps of a cut-over or setup on the owner's own infrastructure (Cloudflare, their GitHub repos and secrets, DNS) and the owner has said go on it, run the listed steps in order without asking again, and report each one in your handoff. Ask only for a step that is not on the list, anything destructive with no way back, or a message to another person.
- **`<branch>` in an `ob agent` command means your builder id:** the branch in OmniSlash, the lowercase ticket ref (`hc-7`) in any other repo, whose branch is a title slug. The launch prompt names it.
- Heartbeat while working: `ob agent heartbeat <branch>`. Keep status current. Do not prompt `/rename`.
  `ob agent register --id <branch> --status <status> --note "<what>"` (on a t3 thread, `needs-human` also puts `🙋` in front of the thread title and the next status that is not `needs-human` takes it off). Stamp the
  status BEFORE the phase starts, so the sidebar is true while you are in it:

  | status | when |
  |---|---|
  | `working` | building |
  | `readying` | running the gate |
  | `needs-human` | parked on the owner: a question, a visual judge, any input. Stamp this, THEN ask. Stay on `needs-human` until the answer lands. |
  | `blocked` | cannot proceed (decision or access), not a question you just asked |

  Those four (plus `planning`, the architect's) are the ONLY statuses. `launching`, `failed`,
  `resolving-comments` and `manual-review` are retired: register refuses them. The first two are the
  **spinoff row's** words (`ob spinoff list`), and `needs-human` covers what `manual-review` meant: built
  but not confident is a question, so stamp `needs-human` and ask it (§4, the closing message).
- **`status` is yours; `run` is T3's, and you never write it.** A `t3` row also carries T3's own run state
  in a separate `run` field, written only by the mirror. `ob agents` prints `status · run`
  (`working · running`), and the two disagreeing is information, not a bug. `--json` keeps them apart.
  **Landability is never read from `run`**: the `State:` line in git stays the verdict (see §2).
- **Your registration holds the ticket's lease unless you registered UNDER an architect hold.** `ob agent register --id <branch> --ticket <ref>` claims `ticket:<ref>` when the ticket is free (`<ref>` is your row's ticket ref, `AB-12` style for a row with a per-project ref, and `<branch>` its lowercase `ab-12`); `ob agent register --id <branch> --ticket <ref> --holder architect-<team>` registers under a hold that architect already has and leaves it in place. `ob agent heartbeat <branch>` keeps **your** leases alive; the handoff (§4) releases only leases you yourself acquired, never the architect's `ticket:` hold. **Heartbeat during long builds** or the lease expires and another session may take your ticket. If register is refused with `held by <id>`, **register under it with `--holder <id>`** rather than passing `--no-lease`: another session is working that ticket. Subsequent `ob agent register --id <branch> --status …` (no `--holder`) leaves that inherited hold as it is.

## 1. Build (in your worktree only)
Work ONLY in your assigned `wt` worktree on branch `<branch>`: small, focused, trunk-based. Runtime + package
manager is Bun. DB is Drizzle (`drizzle-orm/bun-sqlite`) via the `orm()` builder, NO raw SQL in app queries; a
new table is an ADDITIVE, non-destructive migration in `apps/cli/src/db`. Tests use fresh in-memory / temp DBs
only, NO live network and NO live DB.

**A change that adds or touches a browser test (Playwright, Storybook, a DOM route test) follows `ob-ui-testing`**, its Done when list included.

**Browser test runs take the `cpu:browser` lease.** Run every local Storybook or Playwright command as `ob lease run cpu:browser -- <command>`, never bare: it waits for the machine-wide slot, so one browser run loads the desktop at a time, and it always releases it. Wrap the whole command that starts the browsers, a moon gate that includes an e2e task too. Your repo's `AGENTS.md` (`ob project rules`) lists its commands. CI is out of scope. Marketing sites are exempt and run them bare.

**Marketing copy is transcribed, never written.** The words on a marketing site (headlines, pitch, product claims, footer line, share card, meta description) change only through a ticket that carries copy the owner approved through `ob-marketing-copy`; transcribe that text word for word, and report a line that will not fit rather than editing it. Any other PR leaves a marketing site's copy as it is: when your feature needs new words there, ship without them and name the gap in your handoff.

**A dev server takes its port from `ob ports next` and binds the LAN.** The owner opens dev servers on a tablet and a phone, so a port
comes from the shared range, never a guess: `PORT=$(ob ports next -q --holder <builder id>)`, then start the server on `--host --port "$PORT" --strictPort` (bind `0.0.0.0`, on that port only; a server
on loopback shows as `loopback only` in `ob ports` and the tablet gets nothing, and without `--strictPort` Vite drifts to a port nobody leased). `ob ports` shows what is free, leased or listening; release with
`ob lease release port:<n> --holder <builder id>` when you are done. **Any dev server address you write (a message, the handoff, a PR, a note) is the
LAN URL `ob ports next` prints, `http://<lan-ip>:<port>`, never `localhost` or `127.0.0.1`.** Internal client endpoints and test `baseURL`s are not dev
server printouts and stay as they are. If the ufw rule for the range is missing, `ob ports` prints the one `sudo` line for the owner; never run it yourself.

**Past 200k context, checkpoint and start fresh.** In one usage review, builders in the day's top ten rode to 363k to 366k context, 11% of a day's usage, re-reading all of it on every call. Watch the context meter T3 shows for your thread. Past 200k: commit a WIP checkpoint on your own branch (a Conventional Commit, no `State:` line yet), `ob note <ref> "<where you are, what is left, what you learned>"`, then ask the owner with the question tool to open a fresh thread on this worktree seeded with `/ob-spinoff <ref>` and that note. The fresh thread reads the note and the branch and carries on; nothing in the old context needs to survive.

**You are a T3 thread: there is no app to restart.** T3 Code is the only harness. `ob spinoff` resolves to the `t3` launcher, which opens a thread bound to the row's worktree on
the model the architect's **complexity score** picked (1-3 → Haiku, 4-6 → Opus, 7-10 → Opus by default, on the T3
project's own provider; `ob spinoff show <row>` prints both). If the job turns out bigger than its score (a
design call, a migration, a lease race the brief did not mention), say so and stamp `needs-human` rather
than pushing through; the architect re-dispatches at a higher `--complexity`. An urgent ticket always builds at complexity 7 or more (Opus), whatever `--complexity` named, so a builder on an urgent ticket is on the top range (a thread that was already open keeps the model it opened with, and the launch says so). The owner steers you there. The old headless launcher and the drain
daemon are gone: `ob spinoff <ref>` opens your thread in the same invocation. The rules that used to guard the
release instance are moot. The general one stands: never kill or relaunch a process you did not start, and
never `ob lease release <resource> --force` a live holder.

## 2. COMMIT with a state line; push only your branch, never merge
Commit your work on your own branch. You push only that branch and open its PR (§4, `ob-land`); the architect merges it.
You never merge, never push to `main` and never commit on it. **Never `git reset --soft main` or `commit-tree` onto `main` yourself**: that keeps your
stale tree and turns what `main` gained since your fork into your own diff, which is how one land once undid an earlier one. Leave your commits as they are;
the PR's GitHub squash merge folds them into one (except the rebase below). Stage with `git add -A` or explicit paths, **NEVER `git commit -am`**, which stages
only modified tracked files and silently drops new ones.

**Commit and push at every working step.** Each time a piece works (a test passes, a module is wired, the docs are written), commit it on your own branch as a Conventional Commit with **no `State:` line**, and push that branch (`git push -u origin <branch>` the first time). Your branch on origin is what other builders' overlap checks read (`ob spinoff overlap`), and a pushed step survives a lost worktree or a compacted thread. Only the final commit carries `State:` and `Gate:` (below); the PR's squash merge folds every step into one.

**The rebase you run.** A real `git rebase origin/main` of your own commits: every PR land does it before the push (`ob-land` step 3),
and a gate that needs origin/main's tip (the PixelSlash visual upload) does it earlier. Run `git fetch origin` first, so origin/main is current, then `git rebase origin/main`. Resolve conflicts by hand
(`ob-resolving-merge-conflicts`), then re-run the local-only checks (§3), since the rebased tree is new (CI re-gates typecheck and test on the pushed head). The `reset --soft` and `commit-tree` ban above stays.

**Modernize the idea, not just the branch (modernize skill, adapted).** A clean rebase does not prove the change still
belongs on main. Before you rebase:

- Read what `origin/main` gained since your fork on the paths you touch (`git log --oneline <fork>..origin/main -- <paths>`),
  and search `origin/main` and open PRs for the same behaviour under another name.
- If main already solves the same problem, or another change now owns that behaviour, **stop and say so**:
  `ob agent register --id <branch> --status blocked --note '<what already landed, with its SHA>'`. Do not rebase a second
  implementation onto it, and do not open a PR.
- Compare the old and new commit series with `git range-diff` after the rebase. No behaviour you meant to keep may disappear,
  and no behaviour that already landed may come back.

**Pushing a rebased branch (modernize).** Record the remote head SHA **before** the rebase (`git rev-parse origin/<branch>`, or
your last push). Push with `git push --force-with-lease=<branch>:<that SHA>`, never a bare `--force`. If the lease fails,
someone pushed to your branch: fetch, look at what they pushed, and reassess before you overwrite it.

**Visual repos.** A repo with a visual check (the UISlash repo, for example) documents it in its `AGENTS.md` "Visual check" section. Read that section and follow
it, including the upload when the commit carries a `Visual:` line. The visual-review host and its token come from your own config or `ob secret get <name>`.

**A ticket tagged `spike` answers instead of committing.** It may edit, test and run commands in its worktree. It may commit documentation but never code: when its ticket asks for a report under `docs/`, it commits that file, plus any `.mmd` or `.json` file it documents under `docs/` (a diagram, a data file), as `docs(<ref>): ...`, rebases, pushes and opens a PR, and otherwise it never commits, pushes or opens a PR. It answers the ticket's `## Questions` with `ob note` on the parent ticket: each answer with evidence, what is still unknown, the size it now expects, whether to split. It stops at its `## Box`. **Before the handoff it runs the claims review (OS-180)**, `ob-skeptical-review`'s `## Claims review (spikes)`: every claim in its `docs/` report and its notes on the parent is wrong until evidence clears it. It runs every leg `ob review readers --complexity <n> -q` lists for its row's score, as for a diff review, and fixes or strikes each finding, for at most 3 rounds as for a build: in the report by editing it, in a note with a new `ob note` on the parent that corrects or withdraws the claim. When it has answered, it runs `ob spinoff handoff <ticket> --note '<one line>; claims-review: <N> cut, 0 open (opus: <a>, neon: <b>)'`, naming each leg that ran (the line may come from `--report` instead). The handoff refuses a spike without that line, or with open findings. It skips the dirty-worktree check (a spike tries things), refuses naming each path if the branch changes anything but documentation past `base_sha` (a `.md` file outside `apps/`, `platform/`, `domains/`, `skills/` and `ops/`, or a `.mmd` or `.json` file under the repo-root `docs/`; drop those changes and hand off again), names the open doc PR in the architect's note, and stamps nothing, so there is no `State:` line and no gate. It then stops. The architect reads the notes on the parent, closes the spike and removes its worktree. The rest of this section is for builds.

**The final commit ends with a `State:` line, and it is the first thing the architect reads.** An architect scanning
`git log --format='%s%n%b'` across several worktrees must be able to tell, without opening a diff, which builds
are mergeable, which are waiting on a human, and which stopped. Use exactly one of:

**The State line carries the reason only.** One short line, about 100 characters or less, phrased as what
the owner must decide or look at. The gate result and the review tallies go on their own `Gate:` line beneath it,
and `Look at:` / `Run:` lines give the files and the command. `ob spinoff gateable`, `ob spinoff show`, the
readying note and `ob agents` print the reason on its own marked line and never the paragraph, so a reason buried
behind the gate result is a reason nobody sees (a longer one is cut at a word boundary).

- `State: landable`: Done when items met, gate green, mergeable as-is. Put the gate result on the `Gate:` line.
  (`State: ready` is the older spelling; old commits that carry it stay landable, but write `landable`.)
- `State: needs-human: <what to decide or look at>`: built and gated, but the human must judge it (feel, wording,
  anything visual). Write the reason as the question the owner answers, not as a status report: `is the empty-state wording
  right?`, never `judge home` or `added the band; gate green`. If you can decide it yourself, decide it and do not park. Shown as `🙋 needs you: <reason>`. When you put the question to the owner in your thread, ask it with the question tool (`AskUserQuestion`), never as plain text in your final message (`skills/ob-ask-one-by-one`). Also `--status needs-human`, which marks your thread title `🙋`; once the owner has replied, your first act is `ob agent register --id <branch> --status working` to clear it.
- `State: blocked: <what decision or access, from whom>`: stopped and cannot proceed. Shown as `⛔ blocked on: <reason>`.
  Also `--status blocked`.
- `State: partial: <what is missing>`: some criteria met, others not. Shown as `🧩 missing: <reason>`. Stay
  `--status working` unless you are parked on the owner (`needs-human`).

An old commit whose State line is the wall of text (gate result first) still reads: the reader falls back to the
first sentence that is not the gate result or a review tally, and failing that prints the State text as it was.

**The subject is a Conventional Commit** (`<type>(<KEY>-1234): <subject>`, or `<type>(<PROJECT>-12): <subject>`, where type is one of `feat fix docs chore refactor test perf build ci style revert`, plus `!` for a breaking change). The scope is the **ref shown on your ticket**. Never `(ob N)` with a bare number: that is the internal item id, a different item from the ref once the sequences drifted, so it claims another ticket's work; the hook warns on it. The architect's squash keeps your type, so pick the right one: `fix` for a bug, `feat` for new behaviour, `chore` for removals and housekeeping.

```
feat(<KEY>-234): nest agent rows and give them a two-line label

State: needs-human: is the empty-state wording right? Taste, so read it in place
Gate: green (typecheck 9 projects, test 7); skeptical-review: 0 cut, 0 open
Look at: apps/dashboard/src/agents/empty.tsx
Run: bunx moon run dashboard:dev
```

*(Learned the hard way: two builds both finished, committed and ended silently. The architect had to
inspect two worktrees and diff each against main to work out they were complete rather than stalled: work
that a single line in the commit would have made unnecessary.)*

## 3. Gate via moon (report each)
This is a moon workspace, run the gate through moon, not raw ad-hoc commands. **CI covers typecheck and test:**
`ci.yml`'s `gate` job runs `ob gate run` (the repo's `gate.json`, OS-210) on your PR head; run the same command locally, and a second run at the same commit is a cache hit. A green `gate` on the current head
SHA is the gate for those two. Run them locally while you build as your own feedback; they are not a second required
pass before the handoff, and you do not re-run them after the rebase. **You do wait for CI, though:** open the PR, then
`~/.claude/skills/ob-babysit-pr/scripts/pr-wait <N> --until green` until every check on the PR head is green (PixelSlash is a review, not CI: `ob-babysit-pr`): a pending PixelSlash review is not waited on, it is named as `PixelSlash review owed:`. A failing check is fixed on the branch (push, watch again),
or reported as a flake (below), never handed off. `ob spinoff handoff` enforces this: with an open PR it refuses a pending or failing
check, a PR head that is not your HEAD, and a `gh` it cannot read (`COULD NOT READ CI`, never treated as green). A pending PixelSlash status is not a pending check: the handoff goes through and names it as `PixelSlash review owed:`; a failed one still refuses. "I believe the ticket
is done" is not the trigger; a green PR is. The rest stays yours to run and report:
- `ob` still loads (the on-PATH `ob` runs this source; try `ob next`).
- `bunx moon run <project>:typecheck` and `bunx moon run <project>:test` while you build (feedback; CI gates the PR head).
- `bunx moon run cli-db:test` run TWICE for anything touching the DB, the second with `--force` (otherwise it is a cache hit): CI runs it once, so the second run is the flake check.
- **A flaky test is reported, never rerun past: a flaky test becomes the highest priority in its project.**
  A test that fails and then passes on the same code, locally or in CI, in your change or not: stop and tell the architect
  in the readying note and your thread (`flaky: <test> <run id or command>; <the failing output>`). Do not rerun until green
  and hand off as if nothing happened, and do not retry, raise a timeout, skip or quarantine it to get past it. If the flake
  is in your own change, fix its cause from a reproduction before the handoff. The architect tickets an unrelated one at
  priority `flake` (its own level, between urgent and high).
- **A load-only failure is not a flake.** If the test failed while other work had the machine
  overloaded (check `uptime`: a load average far above `nproc`) and passes once the load is back to normal, it is not a
  flake: do not report it as one or chase it. Say in the handoff that it failed under load and passed at normal load, with
  the load average you saw. A test that also fails at normal load is a flake, reported as above.
- **A flake is reproduced by starving only the test, never the machine.** Do not start a machine-wide
  load generator (busy loops, `stress`, a burner script): the desktop is shared with every other builder, and once one
  flake builder's 24 busy loops drove the load average to 85, slowing every build and falsifying the other reproductions. Run
  every test and reproduction in an isolated box with dedicated CPUs and memory and no swap, so it can loop a test without
  touching anyone else. To starve the test further, pin it to fewer of the box's CPUs with `taskset` (and never start a
  process from inside the box in a way that leaves it, such as `systemd-run --user`). Inside the box no lease is needed and there is
  no time cap: no `ob lease run cpu:browser`, no 10 minute limit, loop the test for as long as it takes to fail.
  The box is what keeps it off everyone else. Only one flake fix runs on the machine at a time: `ob spinoff` took `flake:slot` for you when it launched a `flake` ticket, your `ob agent heartbeat` keeps it alive, and your handoff releases it. Name the
  command that reproduced it in the handoff.
- A PixelSlash failure (the visual upload or capture, its check or review, the review server, a hang or wrong verdict), in
  any repo: do not work around it. File it at once, `ob add "<what failed>" --project pixelslash --priority urgent --tag
  pixelslash-failure --body "<repo, PR, run id or command, output>"`, and name the new ref in your thread and readying note
  (`pixelslash: <ref> <what failed>`). Your architect tells the PixelSlash architect (`skills/ob-architect`).
- `bunx moon run <app>:build` green for an app change (dashboard/etc.).
- the 097 migration fingerprint snapshot (`platform/cli-db/test/db-migration.e2e.test.ts`) changed ONLY as a reviewed
  ADDITIVE diff (columns/tables added, none altered or dropped), or not at all.
- any CLI change updates the docs in the SAME change: `ob --help` (the HELP string in `apps/cli/src/cli.ts`,
  every HANDLERS command must appear) AND the CLI docs (`apps/cli/docs/commands.md` for a command, `apps/cli/docs/guide.md` for how it fits).
- **ob-skeptical-review** before `State: landable`: one read-only leg **per model** on `git diff main...HEAD`,
  each launched with the skill's `review-leg.ts` under the `ob-reviewer` profile (no edits, no writes, a read-only
  shell; not `delegate_task`, which cannot choose a tool profile). The legs are the ones the owner picked for your row's complexity range: `ob review readers --complexity <n> -q` (n is the `complexity N/10` that `ob spinoff show` prints), set on the dashboard; a row with no score reads as 5. Run exactly what it prints; never assume a reader or range from memory (OS-238). `deepseek` and `luna` are retired (OS-206) and refused. None is told what the others found. Readers presume every changed line is wrong and report
  `wrong` (a bug, with the failure), `stupid` or `overboard`: fix wrong, cut or justify the rest. Not nits. A leg the builder itself ran is skipped (`+ <leg>: skipped (builder)`); a failed
  leg is reported, never blocking. A paid leg that fails because the account is out of credits (the creds check reports FAILED) is
  `skipped (no credits)` and owes nothing (ob-skeptical-review's Out of credits rule). An unavailable leg runs its configured fallback (`ob review readers`, the `fallback` column, set on the dashboard Models page), and nothing else does; when the fallback is unavailable too, or none is set, the leg is reported skipped or failed with the reason, and the report says so. Report each leg separately: `skeptical-review: N cut, 0 open (opus: a)`. From round 2, hand each leg its
  own previous findings and your `fixed` / `rebutted` answer to each, and a `rejected` answer keeps the finding open
  (ob-skeptical-review, the rebuttal pass).
Report each gate result: `ob agent register --id <branch> --status readying --note "moon typecheck clean; cli:test 1040 pass x2; migration fingerprint additive"`.
That `readying` status is the sidebar's in-progress phase. The `--note` is the PAYLOAD, not the announcement:
registering `readying` does NOT tell the architect anything. The announcement is step (d) below, `ob spinoff handoff`,
which **sends the note to the architect thread** as the readying note, along with the ticket, branch, worktree, commits ahead and the last
`State:` line. So put the facts an architect needs and cannot see in a gate: the gate result, the review line
(`skeptical-review: N cut, 0 open`), what was live-proven, and anything land time still owes. Keep it
semicolon-separated on one line; the review line is read back out of it verbatim. The note also
DATES itself: its row id, the row's status as composed, the moment it was composed, and the checks that
settle whether it is still true (`ob spinoff show <row>` for the row's recorded status, `ob spinoff
gateable` for a landed row or a checkout that went with the land), because T3 delivers a queued note when
the architect's turn ends, which can be after the land. Nothing changes for you: the note is a pointer, the
`State:` line in git is the verdict.

## 4. Finish sequence: the single completion path
Once the build is committed, finish in this order. It is the only normal completion path; do not improvise another.

- **(a) Commit ending in `State:`** (§2). The verdict lives in git.
- **(b) Register the gate facts** as the payload (§3): `ob agent register --id <branch> --status readying --note '<gate facts; review line>'`
  (or `--status needs-human` when §2 says so).
  The `--note` on `needs-human` is the same question as the State reason, not a progress report.
- **(c) Open the PR: load `ob-land` and follow its builder steps (1 to 3, 4a) up to `gh pr create`.** `git fetch origin && git rebase origin/main`,
  re-run the local-only checks (§3) if the rebase brought anything in (CI re-runs typecheck and test on the pushed head), run the land guard with `--subject`, `git push -u origin <branch>` (a branch
  pushed before uses `--force-with-lease` against the pre-rebase SHA, above), and `gh pr create --base main`; on a T3 thread register it with
  `link_pull_request`. The CI wait that follows (`pr-wait`, §4d) moves the row to phase `pr_ci` itself, and again after every later push (OS-285), so the dashboard shows it waiting on CI (a sent-back row stays in `updating_pr`). `blocked` / `partial`: no PR.
  - **Title (file-pr, adapted).** The title is the squash subject: a ticket-scoped Conventional Commit that says **why the change
    matters**, not what it touches. `fix(<KEY>-1234): my new-worktree default was ignored on existing worktrees`, not
    `fix(<KEY>-1234): remove buildContextualThreadOptions`. Keep the builder's type.
  - **Body (file-pr, adapted; the PR body is the commit body, ob-land 4a, so this is the same rule).** Open with the problem in the user's terms, from the ticket's brief. Then one or two sentences on
    the solution. Do not lead with an inventory of files and functions; the diff already has that. The body ends with the
    `State:` and `Gate:` lines from the commit, and a `## Skeptical review` section once the review has run (ob-skeptical-review).
  - **`## Done check`, the last section of the body.** Every `## Done when` item on the ticket, pass or fail, with its evidence: test name, command output, or screenshot path and what it shows. A failed or unchecked item is stated, not omitted.
  - **Every repo except OmniSlash: nothing of ob in the PR.** ob is your private workflow, so a PR in any other
    repo reads like an ordinary open-source PR. This overrides the title and body rules above, and any `repos/<project>/AGENTS.md` line that says otherwise:
    - Title and every commit subject: `<type>(<area>): <subject>`, where the area is the code it touches (`engine`, `web`, `ui-react`). No ticket ref.
    - Body: the problem, what changed and why, and how it was tested (commands and results in plain words, plus screenshots or visual results where the repo has them).
    - Never in the title, body or commit subjects: a ticket ref, a `State:`, `Gate:` or `Visual:` line, the words architect, builder, spinoff or OmniSlash, an `ob` command, or `AGENTS.md`.
    - Branch: `ob spinoff` already named it a slug of the ticket title (no ref). Keep it; your builder id stays the lowercase ref (`hc-7`).
    - Commit bodies carry no `State:` or `Gate:` line. Record the verdict on the row instead:
      `ob spinoff state <ticket> landable --gate '<gate result; review line>'` (or `needs-human|blocked|partial --reason '<the question>'`).
      Every reader (the handoff, `gateable`, `show`, the readying note) reads that first.
    - Your `## Done check` and `## Skeptical review` go in a file and onto the ticket with `ob spinoff handoff <ticket> --report <file>`, not in the PR.
    - The handoff refuses, naming each hit, when the branch, a commit message or the PR title or body carries ob. Fix it (`git commit --amend`, `gh pr edit`) and hand off again.
  - **No attribution (hard line).** No `Created with <model>` footer, no `🤖 Generated with` line, no `Co-Authored-By`, in the
    title, the body or the commit. This replaces file-pr's footer and the takeover attribution rules, which are not used here.
- **(d) `ob spinoff handoff <ticket> --note '<one-line summary>'`: the handoff.** The `--note` is your own
  one-line summary of what landed, recorded on the ticket's Decisions trail (`ob show <ticket>`) so the decision
  outlives the chat, e.g. `--note 'verification rung: admin page + migration 0011; 25 tests x2'`. Optional, and
  separate from the gate facts above: that note announces to the architect, this one is the record. It moves the row to `handed-off`, sends the note to the architect
  thread, and releases the builder's `ticket:`/`worktree:` holds; the readying note tells the architect to gate and merge the PR. Who runs it:
  - **The builder**, when the commit says `State: landable`, once every gate in §3 is green and the PR is open (c) **and its CI has passed**: run `~/.claude/skills/ob-babysit-pr/scripts/pr-wait <N> --until green` after `gh pr create` and hand off only on a green PR (never `gh pr checks --watch`, which waits on a PixelSlash review for ever). The handoff reads the check
    rollup itself and refuses a pending or failing PR, naming the checks (OS-211: a branch with commits past main and no open PR is refused; only a run with no commit past main, a scan or a
    measurement, hands off without one). A failing check is fixed on the branch or reported as a flake, never handed off. If CI genuinely cannot be
    read (no `gh`, no network), `--ci-unchecked '<why>'` hands off and records the reason; do not use it to skip a wait or a failure.
  - **The human**, via `/ob-spinoff-handoff`, for `State: needs-human`. The human's yes is the handoff; `needs-human` does not block land.
  - Not for `State: blocked`, `partial` or a missing State. Those stop at (b) with the matching `--status` and wait.
  - **Whoever built the work rates its tier** on that handoff: add `--tier-fit <lower|right|higher> --tier-fit-why '<one line>'`. Be candid; the architect uses this to route future tickets to cheaper models, and overstating difficulty wastes money.
    - `lower`: a cheaper tier would have done it cleanly.
    - `right`: the tier fit the job.
    - `higher`: you struggled, needed retries, or guessed at something the tier should have handled.
    The why is one line, e.g. `--tier-fit lower --tier-fit-why 'a rename across three files; no design judgment'`. Do not rate up to look thorough.
- **(e) Stop.** Hand off with the PR URL and end your turn. **You never run `gh pr merge`, `ob deploy run` or
  `ob close`**, whatever `ob-land` or an older note says, and not even on a green gate: the architect gates the PR head (plus
  any visual gate the repo requires), merges it, deploys and closes. `needs-human` also stops after (c) and waits for the
  human's handoff. An architect message asking for a fix (a failing UI-review check) is yours to
  do on the branch: fix, re-gate, push, and hand off again. A PR that falls behind `main` or conflicts after the handoff is
  the gating thread's to update when it needs it; you do not rebase it again.
  **A send-back.** The architect sends work back with `ob spinoff sendback`: your row reads `building` again, the
  message in your thread says what to fix, and the row is off `ob spinoff gateable`. Fix it on the branch with a NEW commit
  (or an amend and a `--force-with-lease` push), re-gate, then run `ob spinoff handoff` again. The architect's note is keyed on
  the branch head SHA, so a new commit always sends a new note; a handoff on the same commit sends none, and the output says
  "note: queued for <sha7>" because T3 does not say when it dropped a repeat. Until you hand off again the architect is not
  told, so do not stop at the push.

One word per step: `State: landable` → `ob spinoff handoff` (row `handed-off`) → `landed` (the architect's PR merge). The older
spellings `State: ready`, `ob spinoff ready` and `/ob-spinoff-done` still work as aliases; use the new words.

If `ob spinoff handoff` refuses (dirty worktree, no worktree, already landed), it has handed off nothing: read the reason it
prints, fix it, and run it again. Do not work around the guard.

**Every closing message is short and plain.** A report with a heading per area, test counts and every decision listed is extremely difficult to read. The owner reads your last message to learn three things in seconds: is it done, do they need to do anything, can they trust it. So, for a `landable` handoff too:

```
<REF> is ready for you to merge. Nothing needs your decision.

The map, homepage and directory tests now find things the way a person would (by name on screen) and wait for what they triggered, so they no longer break on timing. They passed four times in a row on desktop and phone, and CI is green.

The review caught one test that could not catch the bug it was written for. I fixed it, then put the bug back to prove the test now fails.

Only the Opus reviewer ran: OpenCode Go is nearly out of credit.

---
Gate green. PR: <url>
```

- **First line: done or not, and whether the owner must act.**
- **Then what changed for whoever uses it, in a sentence or two,** and why to trust it (it passed, how a fix was proven). No headings, no bullet lists of results, no test counts, file names or run-by-run detail.
- **Only what the owner would want to know:** a real catch from the review, a reviewer that did not run, a deviation from the brief (that is an ask, below).
- **The rest goes in the PR body and the ticket,** where the architect reads it. The architect wants the detail; the owner does not.
- This text was picked by a blind both-orders knockout of four drafts, judged as the owner reading on a phone: it won all four of its matches.

**The closing message when you need the owner.** The owner reads it to find why they are needed. Applies to `needs-human`, `blocked` and any question you stop on, in any repo.

**Why you need the owner is 400 characters at most, in plain words.** Count them. Commands and the next step are inside the 400.

```
**I need 2 answers from you.**
1. Is the light home page good enough? Run `bunx moon run site:build && (cd apps/site && bunx vite preview)`.
2. I kept the hero image instead of redoing it. OK? I'd say yes.

If yes to both, run `/ob-spinoff-handoff`.

---
Gate green. PR: <url>
```

- **Open with the ask.** Nothing goes above it.
- **Each ask is a yes/no or A/B question,** with your recommendation and the command or URL to check. "Judge X" is not an ask.
- **Short sentences, no jargon.** No file lists, test counts, measurements or history. If the owner must know it to answer, say it in a few words.
- **Only real asks.** If you can decide it, decide it. A deviation from the brief is an ask; anything the owner need not act on is not.
- **Below the rule, one line:** gate result and PR link. All other detail goes in the PR body.
- **Short is the default.** Do not add reasoning in case the owner wants it. If they don't understand, they will ask, and then you explain as fully as they need.

## 5. Not high-confidence -> stop
Gates will not come clean / spec ambiguous / approach shaky: do NOT report done. Run
`ob agent register --id <branch> --status needs-human --note "<the question>"`, leave the worktree intact, and stop, closing as §4 says.
