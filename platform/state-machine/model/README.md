# The state machine models

TLC checks two TLA+ models here, each with its own `.cfg`:

- `Spinoff.tla` is the spinoff row lifecycle. It models one row, the commits its branch has past main, its PR and its recorded verdict. Its `Edges` set is `SPINOFF_EDGES` (`../src/spinoff.ts`) written out as triples.
- `TeamRestart.tla` is the team restart lifecycle (OS-249): one role seat, the threads T3 has made for it, their queues and turns, the handoffs they wrote, two `ob t3 team restart` runs at once that may stop at any step and run again, and senders using `ob t3 team forward`.

## Run it

```sh
bunx moon run state-machine:tlc     # both models, then the mutants
bash platform/state-machine/model/tlc.sh TeamRestart   # one model
bun platform/state-machine/model/mutants.ts            # the mutants alone
```

`tlc.sh` fetches `tla2tools.jar` v1.7.4 into `~/.cache/tla` on its first run and checks the file's sha256. It uses the `java` on PATH, and falls back to mise's `temurin-17` when there is none. To use another copy of the jar, set `TLA2TOOLS_JAR`. Each model takes a second or two, and the mutants about ten seconds.

## What keeps them honest

- `../test/tla-parity.test.ts` runs in `state-machine:test` and fails when `Spinoff.tla`'s `Edges`, `States` or `Events` differ from the machine. An edge added in `spinoff.ts` therefore fails the gate until the model has the same edge.
- `mutants.ts` removes each guard `TeamRestart.tla` models, one at a time (the lines tagged `\* guard:<name>`), and fails unless TLC then breaks the rule that guard keeps. A guard the model stops covering fails the check.
- CI's `tla` job runs both models and the mutants on every PR. A lifecycle change that breaks one of the rules fails that job and prints TLC's shortest trace.

## The spinoff rules

| Rule | Kind | What it says |
|---|---|---|
| `HandedOffHasPR` | invariant | A handed-off row has an open PR, unless its branch has no commit past main (a scan or measurement run). |
| `VerdictFresh` | invariant | A recorded verdict judges the current round of work. A send-back, resume or reopen clears it. |
| `FailedTerminal` | property | Once a row has failed, it stays failed. |
| `MergedLeavesByReopen` | property | A landed row leaves only by `reopen`, back to building. |

To check that the model catches real breaks, delete the handoff's PR guard: TLC then breaks `HandedOffHasPR` in 5 steps. Keep a send-back's verdict instead of clearing it, and TLC breaks `VerdictFresh` in 6.

## The team restart rules

| Rule | Kind | What it says |
|---|---|---|
| `SeatLive` | invariant | The seat always has a live thread: the replacement is bound before the old thread is settled. |
| `SettledHoldsNothing` | invariant | A settled thread holds no queued message and runs no turn, so nothing sent to the seat is stranded. |
| `ConsumedOnlyRetired` | invariant | A handoff is marked consumed only once the thread that wrote it is settled, so a re-run still finishes the retire. |
| `OneSeedPerHandoff` | invariant | One handoff seeds one replacement: two restarts never open two threads from it. |
| `NoStrayHandoff` | invariant | Only a thread a restart asked writes a handoff: the replacement is never told to hand off and delete its scheduled tasks. |
| `NoNoticeToSeat` | invariant | The seat's current thread never holds a retired notice: only a retired thread is told it is retired. |
| `RetiredStaysSettled` | property | A retired thread, once settled, stays settled: nothing wakes it back into the sidebar. |

`SeatLive` holds by the order of the steps, since the model has only one place that settles a thread. It stays in as a sanity check.

The guards, and the rule TLC breaks when `mutants.ts` removes each:

| Guard | Code | Rule broken |
|---|---|---|
| `replacing` | `ensureTeamThread` reads a row naming another live thread as the seat's, and opens nothing (`t3/dispatch.ts`) | `OneSeedPerHandoff` |
| `drain` | `settleWhenIdle` waits while the thread holds queued messages | `SettledHoldsNothing` |
| `idle` | `settleWhenIdle` waits while a run is live | `SettledHoldsNothing` |
| `consume` | the handoff is consumed only when `retired.settled` | `ConsumedOnlyRetired` |
| `dedup` | the retired notice's request id `ob-retired-<old>`, so T3 drops a second restart's copy | `RetiredStaysSettled` |
| `redirect` | `resolveForward` sends to the current thread, redirects a retired id and refuses any other | `RetiredStaysSettled` |
| `withdraw-ask` | `moveQueuedMessages` withdraws a queued handoff request instead of moving it | `NoStrayHandoff` |
| `keep-notice` | `moveQueuedMessages` leaves a queued retired notice where it is | `NoNoticeToSeat` |

`mutants.ts` prints the steps of each trace, and fails when a line in the model is tagged `\* guard:<name>` with no mutant for it.

TLC found the last two. Before OS-249, a handoff request a second restart (or a `--force` re-run) left queued in the old thread was moved to the replacement, which would then hand off and delete its own scheduled tasks. And a re-run that resumed a retire whose settle had run out moved the earlier run's queued retired notice to the replacement, telling the seat's current thread it was retired.

## Not modelled

- The ticket lease and the close. Those are in the OS-104 spike's model (OS-109, OS-110).
- The send-back restore. It undoes a send-back the builder could not be told about, so it puts the row back where it was.
- Races inside one guarded `UPDATE`. Each step of the model is atomic, as `moveSpinoff`'s `WHERE status = <read>` is.
- The overrides around the PR guard: a spike hands off without one (it commits no code), and `--ci-unchecked '<why>'` records a reason and skips the CI read. The model's `HandedOffHasPR` is the rule for a build that uses neither.
- The guards' code. The parity test checks the spinoff edges, states and events; that `noPr` and the verdict clear are wired in is pinned by `platform/cli-coord/test/spinoff-lifecycle-os211.test.ts` and `handoff-ci-2044.test.ts`, and the team restart's guards by `platform/cli-core/test/team-restart-2257.test.ts`. Nothing reads the restart code into its model, so a change to `team-restart.ts` must update `TeamRestart.tla` by hand.
- The team restart's forward as two steps. `resolveForward` reads the seat, then `forwardToSeat` sends. A restart that settles the old thread between the two lets the send wake it (TLC breaks `RetiredStaysSettled` in 13 steps with the steps split). The window is one store read against a restart that takes minutes; OS-282 owns it, and the model keeps forward as one step until then.
- In the restart: pending owner requests (they only make a thread busy), the self-restart refusal, a human or T3's auto-settle settling the bound thread by hand (and the resume path that follows it), a send by thread id that skips `forward`, message order inside a queue, and more than one seat.
- Whether T3 drops a repeated request id once the first copy has run or been withdrawn. The model takes it as dropped for good (`noticed`); the `dedup` mutant's trace depends on that.
- Timing, in both models.
