---
name: ob-babysit-pr
description: Monitor an OmniSlash pull request after a builder hands it off. The ARCHITECT owns the watch; builders never watch or merge. Use when the architect has a PR URL to gate, or the user asks to watch, monitor or babysit a PR.
---

# Babysit PR

Adapted from [t3dotgg/tstack](https://github.com/t3dotgg/tstack) `babysit-pr` (see `skills/README.md`).
OmniSlash runs no review bots. Its PR checks are `gate` (`.github/workflows/ci.yml`) and, in a repo that has one, `ui-review`
(UISlash rules, plus an advisory model review, on PRs that touch the dashboard source). The watch exists to tell the architect when a PR
head is ready to gate, and when it has come back to its builder.

## Who watches

- **The architect watches.** After a builder hands off a PR URL (`ob spinoff handoff`, the readying note), the
  architect calls `watch_pull_request` on that PR and ends its turn. The watch is per PR, owned by the architect thread.
- **Builders never watch and never merge.** A builder opens its PR, hands off with the URL and stops (ob-land
  step 4a). A builder that calls `watch_pull_request` is wrong: the architect owns the PR. Its one foreground `pr-wait --until green` for the CI wait before the handoff is not a watch.
- **Child tasks never watch.** A `delegate_task` child (a skeptical reader, for example) does not own a PR.
- **Only one watcher per PR, and none on the same PR from two places.** Every watcher on a GitHub account shares one
  rate limit.

Watch the PR, not the spinoff row: the readying note already tells the architect about the row, and
`ob spinoff gateable` answers "is it ready" (architect skill, Step 3).

## What counts as ready

A PR is ready to gate when **the `gate` check and every other check on the PR head are green and the PR is mergeable** (`CLEAN`,
`HAS_HOOKS` or `UNSTABLE`). A pending PixelSlash review is not a check that has to finish (below). `gate` is the CI gate for typecheck and test (the comment at the top of `ci.yml`), so a
green `gate` wakes the architect. Before the merge the architect reads that check on the head SHA (ob-land step 4b) and runs
the local-only checks (step 3): typecheck and test are not re-run. Do not invent a green.

## PixelSlash is a review, not CI

This is the one rule every check wait follows; the other skills point here.

- **A PixelSlash status** is one whose name is `PixelSlash` or starts with it (`PixelSlash / hackcove-ui-actions`). It
  waits on a human review in PixelSlash, not on a runner, so a pending one never completes on its own.
- **Pending: not waited on, and not a failure.** It is reported on its own line, `PixelSlash review owed: <status> <link>`,
  so the architect still sees the review it owes. The handoff goes through with that line in its report and on the trail.
- **Failed or errored: it still blocks.** That is a broken upload, not a review (file it as a PixelSlash failure, `ob-spinoff` §3).
- **Never `gh pr checks <N> --watch`, and never "wait for all checks":** both wait on a pending PixelSlash review for ever.
  Wait with `pr-wait <N> --until green` (below), which applies this rule. `ob spinoff handoff` applies it too
  (`isPixelSlashCheck` in `platform/cli-coord/src/commands/handoff-ci.ts`).

## Routing a wake

A wake is news, not a merge decision. Check the state yourself before you act.

| Wake | Action |
| --- | --- |
| `gate` check green on the head SHA, PR mergeable | Run the local-only checks (ob-land step 3), plus any visual gate the repo's `AGENTS.md` names. If `State: landable` or the row is `handed-off`, merge with ob-land step 4b. |
| `PixelSlash review owed: ...` lines on a green wake | The visual review is yours: review it in PixelSlash (the link) as the repo's `AGENTS.md` "Visual check" says, then merge. |
| `gate` (or another check) failed | Back to the builder. Send the failing check and its link; the builder fixes it on the branch, re-gates, pushes and hands off again. |
| `DIRTY` (conflicts with base) or `BEHIND` | The gating thread updates it itself: rebase it or merge `origin/main` into it, resolve the conflicts (`ob-resolving-merge-conflicts`), push, and re-gate the new head (`ob-land` step 3; this replaces sending it back to the builder). The `pr-wait` script's wording still says "back to the builder". |
| A comment or review from someone else | Read it. Act only on comments newer than the latest push. Verify a finding against the source before you change code. |
| Merged or closed | Stop. A merge runs ob-land step 5 (deploy and close); a close without merge is the owner's call. |

Keep the PR at the size the goal needs. Decline a finding that widens scope with a written reason
(`ob-leaving-pr-comments`), and list it as a follow-up.

## Waiting by hand: `pr-wait`

Outside a T3 thread, wait with `scripts/pr-wait` from this skill's directory (use its absolute path):

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change] [--gate gate]
```

It prints one line per real event and exits: `0` when the `--until` condition is met or the PR merged, `1` when it
needs action (a check failed, a failed PixelSlash status included, conflicts, BEHIND, closed); `green` and `ready` print a `PixelSlash review owed:` line for each pending PixelSlash status before the last line, `2` on bad input or when another `pr-wait` already watches
the PR. Run it under a monitor, or as one long command; it ends on its own. Start it again after a push or a resume;
it remembers what it already reported. A second `pr-wait` on the same PR exits at once. Do not start a second one.
On start it moves a building spinoff row whose branch is the PR head to phase `pr_ci` (OS-285); a handed-off row is
left alone, so the architect's watch changes nothing.

**Only the architect runs it as a watch**, and never beside `watch_pull_request` on the same PR. The one builder use is the CI wait before its handoff: `pr-wait <N> --until green` in the foreground (`ob-spinoff` §3).

## Unwatch before you stop

A watched thread stays in Working and out of the user's inbox. When the architect stops (gate handed back, merged,
or asking the owner a question), call `unwatch_pull_request` first. A merge or close ends the watch on its own.

- **"Stopped watching, could not read it"** usually means GitHub's GraphQL rate limit is used up. Check
  `gh api rate_limit --jq .resources.graphql`. If `remaining` is near 0, wait for `reset` once, then watch again.
  Never watch again in a tight loop.
- `gh pr create`, `gh pr view` and `gh pr checks` use GraphQL. `gh api repos/<owner>/<repo>/pulls/<n>` and
  `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` use REST, which has its own limit.

## Stay quiet

When an event needs no action, end the turn without a message. Never post or say "still waiting". Never write a
watcher, polling loop or `sleep` loop of your own.
