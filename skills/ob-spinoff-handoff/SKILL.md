---
name: ob-spinoff-handoff
description: >
  Human hands an interactive spinoff to the architect to gate. Triggers:
  /ob-spinoff-handoff, /ob-spinoff-done (old name, still works), spinoff
  handoff, spinoff done, hand this to the architect, declare this spinoff
  finished. Not for one-shot builds (those end with a State: commit) and not
  itself a merge: after it, the ARCHITECT gates and merges the PR.
argument-hint: "[ticket|spinoff-id]"
---

A spinoff (`ob spinoff`) is finished when the HUMAN says so. This skill is that gesture. It runs `ob spinoff handoff`, which moves the row to **handed-off**. That handoff is the human land yes: `needs-human` on the last commit does not block land. `blocked` / `partial` / missing State still do not land. It does not merge by itself: the builder never merges its own PR; the architect gates and merges it once the row is handed off (`skills/ob-land`). This is step (d) of the builder's finish sequence in `skills/ob-spinoff/SKILL.md` §4: the human runs it in place of the builder when the commit says `needs-human`, or whenever the owner declares the spinoff finished.

**One word per step:** the builder's verdict is `State: landable`, the human's gesture is `ob spinoff handoff` (row `handed-off`), and the architect's PR merge makes the row `landed`. The old spellings (`/ob-spinoff-done`, `ob spinoff ready`, `State: ready`) stay accepted as aliases; the output always uses the new words.

## Why `ob spinoff handoff`

The durable signal is the row's `handed-off` status. Under T3 the architect does not run a watcher: it learns from the readying note this command sends into its thread, then confirms with `ob spinoff gateable`. Rejected alternatives:

- `ob agent register --status readying`: already the builder's in-progress gate phase.
- `ob spinoff stamp`: the drain's launch-outcome write, not a human gesture.

The branch need not be on main.

## Steps

1. Resolve the target: `$ARGUMENTS` if given (ticket or spinoff id), else this worktree/branch. The ticket may be the item's per-project ref (`ABC-12`), an alias a move left, or its legacy number.
2. Run `ob spinoff handoff` with that ref (no arg when resolving from cwd). `--json` if you need the machine shape.
   **Do not pass `--no-note` here**: this is a builder's (or the human's) declaration, and the note is
   the handoff the architect reads. `--no-note` exists for the architect stamping on the human's behalf in
   `ob-land`, where the note would go to the architect's own thread.
2a. **CI must have passed.** With an open PR for the branch, `ob spinoff handoff` reads its checks and refuses a pending
   or failing PR, a PR head that is not the branch HEAD, and a `gh` it cannot read (`COULD NOT READ CI`). Wait with
   `gh pr checks <N> --watch` and fix a failure on the branch, then hand off again. This applies to the human's `/ob-spinoff-handoff`
   too. `--ci-unchecked '<why>'` is the override: it hands off anyway and puts the reason on the ticket's trail and in the readying
   note, use it only when CI truly cannot be read or waited for, never to get past a red or running check. The guard does not enforce that (the recorded reason is the control), so the architect sees `ci: UNCHECKED` and judges it.
3. Pass `--note '<one line>'` when you have one: that is the **decision record** on the ticket's trail
   (`ob show <ticket>` prints it), separate from the readying note the architect receives. Optional: the
   handoff is recorded either way.
3a. **Rate the tier, if you built the work.** Pass `--tier-fit <lower|right|higher> --tier-fit-why '<one line>'`,
   candidly: `lower` = a cheaper tier would have done it, `right` = it fit, `higher` = you struggled, needed retries
   or guessed. Overstating difficulty wastes money, so do not rate up to look thorough. If you are an architect or a fresh
   session with no build context, omit the flag rather than guess.
4. Print the command's report as-is. It already names ticket, branch, worktree, the last `State:` verdict with its reason on one marked line (`🙋 needs you: …`), `landable: yes`, `next:      the sentinel gates and merges the PR (the handoff is the human yes)`, and the line that says whether the **readying note was queued for the sentinel** (`note:      queued for <sha7> on <thread id>`: T3 does not report a dropped repeat, so this is never "told"), was a **named skip** (`<project> is in no team: ob t3 team join <team> <project>, or ob t3 architect in its checkout`, or a headless row), or failed (a warning, exit 1, handoff still applied). The note carries this builder's `readying` register text, so make sure that text is the real handoff before you run this.
5. Then the architect gates and merges (it reads CI's `gate` on the head SHA and runs the local-only checks, not a re-run of typecheck and test). The command released the builder's `ticket:`/`worktree:` holds (never an `architect-*` hold); the builder stops (it runs no `gh pr merge`, deploy or `ob close`), and the architect loads `ob-land` and runs its architect steps for the PR the builder opened: gate the PR head, `gh pr merge --squash --delete-branch`, `ob deploy run --sha`, `ob close`. Do not refuse on `needs-human`: the handoff is the yes.

If the command refuses because the worktree is dirty, print the dirty paths and stop. Do not invent a commit. The owner commits, then hands off again. It also refuses when that worktree **does not exist**, or when the row has **already landed** (`nothing to gate; <ticket> landed as <sha>`) and both mean no handoff and no note: a woken builder announcing merged work to the architect is the hazard those guards close, so never work around them. (One exception you do not have to do anything about: re-running `handoff` on a row already `handed-off` while its checkout is gone still releases the builder's leftover holds and skips the announce.) If it refuses (`not building`, `no building spinoff matching`), say so and stop. Do not invent a row.
