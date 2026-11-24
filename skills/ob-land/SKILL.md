---
name: ob-land
description: >
  Land an ob ticket through its GitHub PR. Triggers: land it, merge it,
  squash it, open the PR, State: landable (or its old alias State: ready),
  handed-off after /ob-spinoff-handoff (or /ob-spinoff-done). Not blocked or
  partial. needs-human + handed-off is landable. The BUILDER runs steps
  1-4a on its own branch (rebase, gate, push, open the PR, hand off with the
  URL) and STOPS; it never merges. The ARCHITECT runs steps 2-5 on the PR: gate
  the PR head, squash-merge, deploy, close.
---

# ob-land

Land one ob ticket onto `main` through a pull request; the architect does the merge. **Two roles, one skill, and the builder never merges its own PR.**

- **Builder** (steps 1, 2, 3, 4a): refuse checks, rebase, gate, land guard, push, `gh pr create`, `ob spinoff
  handoff`, hand off with the PR URL, then **stop**. No `gh pr merge`, no `ob deploy run`, no `ob close`.
- **Architect** (steps 2, 3, 4b, 5): holds the ticket, gates the PR head (plus any visual gate the repo requires),
  squash-merges with `gh pr merge --squash --delete-branch`, then deploys and closes. The architect merges only a
  `State: landable` PR or one whose row is `handed-off`; a `needs-human` PR waits for the owner's handoff.

The merge is a GitHub squash of the PR, never a local squash pushed to `main`. Nobody pushes to `main`.

**CI replaces the local typecheck and test re-run.** `.github/workflows/ci.yml` runs the `gate` job on
every PR: `bunx moon run --concurrency 3 :typecheck :test`. A green `gate` check on the **current PR head SHA** is the gate for
those two tasks. Do not re-run them locally on either side: not the builder before the
push, not the architect before the merge. The local-only checks (listed in step 3) stay. A PR with no CI, a red `gate`,
or a `gate` that is missing or on an older SHA keeps the local gate.

There is no branch protection on this repo, so nothing enforces that green: the architect reads it on the PR head before
it merges (step 4b). In a repo that runs one, the other check GitHub runs on a PR is the UISlash UI review, and only on PRs that
touch the dashboard source (`apps/ob-dashboard/src/**` here). Step 4b waits for it before the merge.

Work these steps in order for your role. Each step ends when its criterion is true. Stop on a refuse.

## 1. Refuse

Stop (do not push, open or merge) when any of these is true:

- **State is `blocked` or `partial`, or missing.** Read `git log --format='%s%n%b' origin/main..<branch>`. No PR for those. `State: landable` is mergeable as-is; the older spelling `State: ready` on an older commit means the same. **`needs-human` waits:** the builder opens the PR; the architect merges only after the handoff (`/ob-spinoff-handoff`, row `handed-off`), which is the human yes. **`run` is not a verdict:** a builder's row also carries T3's run state in a separate field, and a `completed` run says the agent stopped: never that the work is landable. `State:` in git stays the only yes. **Every repo but OmniSlash:** the verdict is the one recorded on the row (`ob spinoff state`, printed by `ob spinoff show` / `gateable`), and git carries none.
- **`ob issue landed <n>` hits.** Mark the row landed (`ob spinoff reconcile`). Do not open a second PR.
- **A live hold by someone else** on `ticket:<n>` or `worktree:`. Never `--force`. Wait or stop. (A builder holds its own ticket from registration; the architect acquires both before it gates, step 2.)
- **Ops-only rebuild** (no product commit on the branch).

Criterion: every refuse is false, or you stopped.

## 2. Hold

**Builder:** your registration already holds `ticket:<n>` and `worktree:<wt>`. Keep them alive with
`ob agent heartbeat <branch>` through the gate and the PR's opening. Nothing to acquire. Your handoff
(`ob spinoff handoff`, after step 4a's `gh pr create`) releases them, and that is where your part ends.

**Architect:** before gating the PR head, merging or cleaning up, take both holds. If either reports `held by
<someone>`, a session is mid-gate: do not proceed and do not force it.

```
ob lease acquire ticket:<n> --holder architect-<team> --ttl 1800   # <n> = the row's ticket ref (a per-project ref, else the bare number)
ob lease acquire worktree:<builder-wt> --holder architect-<team> --ttl 1800
# only when the row is NOT already handed-off and the human has said land:
ob spinoff handoff <n> --no-note   # the CI guard applies: stamp only once the PR head's CI is green
```

Same `--holder` on every later lease command. Heartbeat on a long gate. **`--no-note` when the architect
stamps:** the note goes into the architect thread, and when you ARE that thread it is a message
to yourself, delivered after the land. A builder's own handoff keeps announcing: that note is how the
architect learns the PR exists.

Criterion: builder, you hold the ticket and worktree; architect, you hold both under `architect-<team>`.

## 3. Rebase and gate

**Builder:** rebase before the push; CI gates the pushed head. **Architect:** check the PR head's CI gate and run the
local-only checks (step 4b), and bring a PR that conflicts or overlaps `main` up to date yourself: rebase it or merge `origin/main` into it, resolve the conflicts (`ob-resolving-merge-conflicts`), push, and re-gate the new head (the gating thread owns this, not the builder). A PR that is only behind, with no overlap, merges as it stands (below).

```
git fetch origin
git rebase origin/main          # your own commits only; resolve conflicts by hand (ob-resolving-merge-conflicts)
```

**Never `git reset --soft`, `commit-tree` or `checkout <branch> -- .`** to build the PR's content:
that keeps a stale tree and turns what `main` gained since the fork into your diff, which is how one land
once undid an earlier one. A rebase is a replay of your commits and cannot do that.

If the rebase brought anything in, the push puts the new tree in front of CI, which runs on that head. Re-run the
**local-only checks** below on the rebased tree; the typecheck and test targets are CI's.

- **Typecheck and test: CI's, not a local re-run.** `ci.yml` runs `bunx moon run --concurrency 3 :typecheck :test` on the PR head.
  A green `gate` on the current head SHA is the gate for those two targets (step 4b reads it). Your local run while
  building is your own feedback, not a second required pass. Only when there is no CI, the `gate` is red, or it is
  missing or on an older SHA: run the local gate, `taskslash moon :typecheck :test` where `taskslash status --json` exits 0
  (the TaskSlash daemon admits each task against the machine; the client on PATH is used only when its `status --json` answers),
  else `bunx moon run --concurrency 3 :typecheck :test` (unchanged tasks are cache hits; `TMPDIR=~/.cache/tmp` for a long run).
- **A cache hit IS a gate result, local or remote.** moon keys each task on a hash of its command, args, declared inputs, env, dependencies and toolchain, and replays the recorded result, so a task shown as `cached` means *exactly these inputs already passed here*, and `cached from remote` means *exactly these inputs already passed in main's CI* (only a push to `main` can write the remote cache host; a pull request or a local run cannot). Reach for `--force` only on a *suspected* stale or foreign cache (a moon upgrade, a remote entry you have reason to doubt). What no cache answers stays below: the docs, the migration fingerprint read, the second cli-db run and the visual gates.
- **Local-only checks, run by hand on every land (CI does not run them):**
  - App change: `bunx moon run <app>:build`.
  - CLI db/store (`apps/cli/src/db/**`, the store, or `platform/cli-db`): `bunx moon run cli-db:test` **twice**, the second with `--force` (otherwise it is a cache hit). CI runs it once; the second run is the flake check.
  - The CLI docs surface matches (`ob --help` + `apps/cli/README.md`); the migration fingerprint moved only additively; the `State:` line is landable.
  - Visual gates, where the repo has one (step 6 and the repo's `AGENTS.md`).
  - When you ran the local gate instead of CI: that the affected *set* is the one you meant, and that any failing test NAMES match `origin/main`'s (run main's failing projects: that turns "3 tasks failed" into "no new failures").

**An architect** takes a compressed verdict (pass/fail, failing target, error text) and
does not paste moon output into its transcript.

Then **run the land guard against the subject the squash will carry**:

```
bun platform/cli-coord/src/land-guard.ts --branch <branch> --base <row base_sha> \
  --subject "feat(OB-N): <title> (#<pr>)"     # before the PR exists, check it without the (#<pr>) suffix
```

The guard compares HEAD with `origin/main` (exit 0 ok, 1 refused, 2 could not check; a 2 is "unknown",
never "fine"). It refuses when HEAD restores the pre-image of a path one of the last 100 `origin/main`
commits changed (the stale-tree shape above) and, given `--branch`, when it touches a path outside the builder's own
diff. `--base` is the row's `base_sha` (`ob spinoff show <n> --json`). `--subject` checks the squash
subject GitHub will write rather than your head commit's, by the same validator the repo's commit-msg
hook runs. **This is the only place the guard runs on a PR land:** the pre-push hook fires only for a push
to `main`, and a GitHub squash never pushes `main` from a checkout. `--allow-revert <sha>` is for a land
that deliberately undoes that commit.

**A PR does not have to be on the latest `main` to merge, as long as there are no conflicts.** GitHub's squash is a three-way merge, so commits that reached `main` after the branch was cut are kept, not undone. The architect does not run `gh pr update-branch` or send a PR back just because it is behind. What it needs: no conflicts (`gh pr view <n> --json mergeable -q .mergeable` reads `MERGEABLE`), no overlap, and a green `gate` on the PR head. **Rebase only on overlap.** Overlap is a path in both `git diff --name-only $(git merge-base origin/main <head>) origin/main` (what `main` gained) and `git diff --name-only origin/main...<head>` (what the PR changes), or a change on `main` to code the PR imports or a fixture its tests read. With an overlap, rebase and re-gate first; without one, merge on the gate the PR already has. A builder still rebases before its first push, as above.

Criterion: the builder rebased on `origin/main` before its push (the architect merges a PR that is behind but has no conflict and no overlap); the local-only checks pass on that tree; typecheck and test are green
on CI's `gate` for the pushed head (or, with no usable CI, on the local gate); guard exit 0; docs match if the CLI changed.

**A flaky test.** A test that fails and then passes on the same code is not a gate result either
way. The builder reports it to the architect (`ob-spinoff`, step 3) instead of rerunning past it; the architect tickets it at
priority `flake` (its own level, between urgent and high) and puts it at the front of the queue, behind only an urgent (`ob-architect`, Flaky tests come first).

## 4a. Builder: push, open, hand off, stop

```
git push -u origin <branch>      # a rebased branch that was pushed before: --force-with-lease, never --force
gh pr create --base main --head <branch> --title "<type>(<REF>-N): <title>" --body-file <file>
```

The PR title is the squash subject, so it is a ticket-scoped Conventional Commit and keeps the builder's
type (`feat` / `fix` / `chore` / …; the scope may be the per-project ref, `feat(<REF>-12)`). The body
is the commit body: what changed and why, the `State:` and `Gate:` lines. **No AI attribution** in the
title or the body. A builder on a T3 thread then registers the PR with `link_pull_request`. Then mark the row
as waiting on CI (OS-183), so the dashboard shows it: `ob spinoff phase <REF>-N pr_ci`. Run it again after every later push
to the open PR (a review round, a sendback fix). A refusal is noted, not a stop.

**Every repo except OmniSlash: nothing of ob in the PR.** The title is `<type>(<area>): <subject>` with no ticket ref.
The body is the problem, the change and how it was tested, with no `State:`, `Gate:` or `Visual:` line, no architect, builder, spinoff, OmniSlash, `ob` or `AGENTS.md`.
The verdict goes on the row (`ob spinoff state <ticket> <verdict> --gate '<line>'`), and the Done check and review go on the
ticket with `ob spinoff handoff <ticket> --report <file>`, where the architect reads them (`ob-spinoff` §4c). The handoff
refuses a branch, commit or PR that carries ob, and the land guard refuses the same in a squash subject or body.

**Wait for CI before the handoff.** `gh pr checks <N> --watch` until every check on the PR head is green. A failing check
is fixed on the branch (push, watch again) or reported as a flake (`ob-spinoff` §3), never handed off, and "I think it is done" is not
the trigger. `ob spinoff handoff` reads the rollup and refuses a pending or failing PR, a PR head that is not your HEAD and a `gh` it
cannot read (`COULD NOT READ CI`); `--ci-unchecked '<why>'` is the recorded override for a CI that cannot be read at all.

Then `ob spinoff handoff <n> --note '<one-line summary>'` for `State: landable` (a `needs-human` row waits for
the human's `/ob-spinoff-handoff`), and **hand off with the PR URL. Stop.** The builder runs no `gh pr merge`,
no `ob deploy run` and no `ob close`, however green its gate and however much of the turn is left. If it
merged, it skipped the architect's gate (one builder merged its own PR past the PixelSlash check this way).
`blocked` / `partial` open no PR.

Criterion: the PR is open, its CI is green on the head, the handoff is sent with the PR URL, you have stopped.

## 4b. Architect: gate, wait, merge

**A model trial pair (the trial has ended, so this applies only to a pair still recorded): land the winner only.** `ob spinoff gateable` lists a pair as one entry with both row ids. Record the
blind verdict first (`ob spinoff trial record <ref> ...`, see `ob-architect`, Model trial); it marks the loser's row failed with
`lost trial pair <n>`. Close the loser's PR with `gh pr close <pr> --delete-branch --comment 'lost trial pair <n>'`, then gate and
merge the winner's PR as below. Never merge both legs.

Merge only when the State is `landable`, or the row is `handed-off`, the PR head passed the CI gate (below) and the
local-only checks in step 3, plus any visual gate the repo's `AGENTS.md` names, and the UI review wait (if it applied)
passed.

**Planned files against merged files.** Compare the PR's files (`gh pr diff <pr> --name-only`) with the
`files` on both sealed sheets of the ticket's last `go` check. `ob spinoff gateable` and `ob spinoff show` print that
comparison against the branch diff as a `files:` line, with `(read why: under half the planned files touched)` when under half were touched. When under half the planned files were touched, or the
PR touches files the ticket's `## Box` or `## Do not` rules out, read why before you merge and say it in the close note.
File drift was the one mechanical signal in the audit that tracked misses (12.5% with under half touched, against 4%
with all of them).

**CI gate.** Read the `gate` check on the PR head SHA, not on a branch name or an older push:

```
SHA=$(gh pr view <pr> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" -q '.check_runs[] | select(.name=="gate") | "\(.status) \(.conclusion)"'
```

- **`completed success`:** typecheck and test are gated. Skip the local typecheck and test run; still run the
  local-only checks from step 3.
- **`completed failure`:** back to the builder: `ob spinoff sendback <ref> --note '<the failing check and what to fix>'`. It moves the row to
  building, posts the note into the builder's thread and takes the row off `ob spinoff gateable`; release your `ticket:` and `worktree:` holds with the same `--holder` (the builder's
  step 1 waits on a live hold); the builder fixes on the branch, pushes, and runs
  `ob spinoff handoff` again, which sends you a new note (the note is keyed on the head SHA, so the new commit is never dropped as a repeat).
- **No `gate` line, `in_progress`, or a SHA that is not the head:** not a pass and not a failure. Wait and read again,
  or, if the repo has no CI at all, run the local gate and say so in the close note. An empty result is never a pass.

- **A failure that is a known flake** (an open flake ticket names it, or the same code went green on a rerun): you may
  rerun the job (`gh run rerun <id> --failed`) to read a real result, but a green rerun does not clear the merge. Merge past a
  known flake only with the owner's go for that PR, asked through a push notification; without it the PR waits for the flake's fix. A flake not
  yet ticketed is ticketed first, at priority `flake` (between urgent and high), with the output and the run id.

A repo or PR with no CI keeps the local gate in full.

**UI review wait.** If `git diff --name-only origin/main...<pr head> -- apps/ob-dashboard/src` prints
any file, the PR touches the dashboard, so run `gh pr checks <pr> --watch` and wait for it to finish before the
merge. It waits on every check on the PR, the UISlash UI review included. Otherwise skip the wait.

Read the result of `gh pr checks`:

- **Every check passed:** go on to the merge.
- **A check failed:** exit 1 with a listed failing check is a failure. **Layer 1 (a raw colour, a local
  stylesheet, a look-alike `@hackcove/ui` component) means send it back to the builder (`ob spinoff sendback <ref> --note '<the failing rule and the lines>'`) to fix on the branch,
  not merge:** the fix is the lines the PR adds; the gate runs again, the builder pushes, and you wait again.
- **A rule is a false positive:** leave the PR open and unmerged and file the rule to the UISlash architect.
  The architect decides; a `needs-human` handoff would merge past the failure.
- **No checks listed yet:** the check can take a few seconds to appear after `gh pr create`. Run it again.
  An empty list is not a pass and not a failure.

Layer 2 (the model review) is advisory and warns or skips, so it never fails the wait.

```
gh pr merge <pr> --squash --delete-branch \
  --subject "<type>(<REF>-N): <title> (#<pr>)" --body-file <file>
```

A `/ob-spinoff-handoff` land adds `Approved by <owner> via /ob-spinoff-handoff <YYYY-MM-DD>.` to the body.

**Every repo except OmniSlash:** the subject is the PR title plus ` (#<pr>)`, with no ticket ref. `--body-file` holds the PR body
and nothing else: no `State:` line, no approval line, nothing of ob. Read the Done check and review from the ticket
(`ob show <ticket>`), not the PR. A PR whose title or body leaks ob goes back to the builder, or you fix the title and body
with `gh pr edit` before the merge. Run the land guard with the same text it will write:
`bun platform/cli-coord/src/land-guard.ts --repo <checkout> --head <pr head> --squash --subject '<subject>' --body-file <file>`
(`--squash` reads it as GitHub's three-way squash, so a PR that is only behind `main` is not a revert; it reads the origin url to tell a clean repo; `--clean` forces the check; `--keys OB,PS,...` narrows a ref to the `ob project` keys, and without it any `[A-Z]{2,4}-<n>` counts, the stricter reading). A hit refuses the merge, naming each one.
The verdict is the row's (`ob spinoff gateable` / `show` print it), not a `State:` line in git.

`--delete-branch` removes the remote branch (the repo's `delete_branch_on_merge` setting stays off unless
the owner turns it on). From a linked worktree `gh` may refuse to delete the LOCAL branch, because it is
checked out there; the merge has still happened. Delete the remote branch by hand if it survived
(`git push origin --delete <branch>`), and leave the local one to the worktree cleanup.

**Run each command bare and let its status gate the next.** No `| tail`, no `|| true`: a pipeline reports
the LAST command's status, so a failed merge looks like a successful step, and step 5 then deploys,
closes and announces a commit that never reached `main`.

Criterion: the PR is merged, its squash commit is on `origin/main`, the remote branch is gone.

## 5. Architect: deploy and close

The builder's part is over at step 4a; this step is the architect's.

Confirm the landing first:

```
git fetch origin
git log --oneline -1 origin/main   # must name the ticket you are landing
```

**Then deploy that SHA. Deploy is the last step of a land, not a timer.** The thread that gated and merged the PR runs it (the team's sentinel), along with any repo-specific deploy its `repos/<project>/AGENTS.md` names:

```
ob deploy run --sha <the squash SHA>
```

**Production is the gating thread's call, not the owner's.** A ticket or rule that says only the owner deploys a site or service does not hold: the gating thread decides whether a merged change goes to production, runs the deploy itself (`deploy.sh --production`, `wrangler deploy`, the repo's own), then runs the post-deploy smoke and reads the live result. Deploy when the change is merged, gated and safe to show; hold it, and say why on the ticket, when it is not (a half-built feature, a data migration that needs a backup first). Asking the owner whether to deploy is not needed; a cost or account change (a plan upgrade, a new paid service) still is.

Do it **before** `ob close`, so a refused or failed deploy is visible while the ticket is still held. It is an API call, so it needs no ssh. If the API is down, the last resort is `ob deploy run --ssh --sha <the squash SHA>`; if the kick's answer was lost, read `ob deploy status` first, because it may have started. The kick returns immediately; the proof is `ob deploy status` reading `result ok` at that SHA. If the
server **refuses** because `origin/main` has moved past your SHA (another land went first), nothing was
fetched, built or restarted. That refusal also opens a job-failed ticket, which the next good deploy closes, so it is not a separate fault to chase. Deploy the current tip deliberately with its SHA; never re-push and never
reach for a timer.

Then:

```
ob close <n> --note 'gate: CI gate success on <sha> (typecheck+test); local-only: <what ran>; done: <checked myself>; on builder evidence: <items>; taste: <whose yes>; waived: <none or what, why>; <PR URL>'
ob spinoff reconcile
ob lease release ticket:<n> --holder architect-<team>
ob lease release worktree:<wt> --holder architect-<team>
```

The builder's own holds were already released by its handoff (`ob lease status` shows what is left; release
only what is still yours). When the builder is gone, also run `ob agent done <builder> --note '<what it left behind>'`.

`ob close` closes the linked GitHub issue too, and **records WHY on the ticket's Decisions trail**,
which `ob show <n>` prints. Say what was gated and anything waived in one line. The note stays local.

**That note is the sign-off.** Read the PR's `## Done check` against the ticket's `## Done when` before you merge: each item is either passed with evidence or sent back. The note names what you checked yourself, what you took on the builder's evidence, anything waived and why, and whose yes each taste item got.

**A gap beside the change: ticket it and merge, or send it back.** When the gate turns up something the Done items did not ask for (a test that cannot catch a regression, a bug the change did not cause, an extra fix or install step another repo needs), the gating thread decides itself. When the change is wrong or a Done item is unmet, send it back (`ob spinoff sendback`). When the change is right and the gap sits beside it, file the follow-up ticket yourself on that repo's tracker (`ob add ... --project <slug>`, with what you saw and its own `## Done when`), merge the change, and name the new ticket in the close note. Do not leave it as a suggestion for another thread to file.

**Record a miss the check let through.** When a Done item is unmet at the gate, or you send a PR back for something the ticket text should have said, add one line to the ticket: `ob note <ticket> 'check-miss: <criterion> <pattern>'` (for example `check-miss: done needs-outside-access`). The next audit reads misses from the store instead of rebuilding them from close notes.

`ob close` runs from the architect's checkout, so it withdraws a readying note still queued in the architect thread,
tells each builder thread it landed (with an "end your turn now" stop), then settles those
threads. (The skip for a close run from the builder's own worktree stays in the code, but a builder
no longer runs the close.)

**A late note is stale, and it says so itself.** The note carries `row: <id> · <status> (as
composed)` and `composed: <iso>`, and names the checks that settle it (`ob spinoff show <row>`, `ob spinoff
gateable`). An architect that reads one for a ticket already merged and closed has nothing to gate.

Report the PR URL and the merge SHA.

Criterion: the squash SHA is deployed and recorded `ok` (`ob deploy status`), item closed, leases
released under the same holder, the PR URL reported.
