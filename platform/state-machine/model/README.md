# The spinoff row model

`Spinoff.tla` is the spinoff row lifecycle in TLA+, and TLC checks it. It models one row, the commits its branch has past main, its PR and its recorded verdict. Its `Edges` set is `SPINOFF_EDGES` (`../src/spinoff.ts`) written out as triples.

## Run it

```sh
bunx moon run state-machine:tlc     # or: bash platform/state-machine/model/tlc.sh
```

`tlc.sh` fetches `tla2tools.jar` v1.7.4 into `~/.cache/tla` on its first run and checks the file's sha256. It uses the `java` on PATH, and falls back to mise's `temurin-17` when there is none. To use another copy of the jar, set `TLA2TOOLS_JAR`. The check takes about a second.

## What keeps it honest

- `../test/tla-parity.test.ts` runs in `state-machine:test` and fails when `Edges`, `States` or `Events` differ from the machine. An edge added in `spinoff.ts` therefore fails the gate until the model has the same edge.
- CI's `tla` job runs TLC on every PR. A lifecycle change that breaks one of the rules fails that job and prints TLC's shortest trace.

## The rules

| Rule | Kind | What it says |
|---|---|---|
| `HandedOffHasPR` | invariant | A handed-off row has an open PR, unless its branch has no commit past main (a scan or measurement run). |
| `VerdictFresh` | invariant | A recorded verdict judges the current round of work. A send-back, resume or reopen clears it. |
| `FailedTerminal` | property | Once a row has failed, it stays failed. |
| `MergedLeavesByReopen` | property | A landed row leaves only by `reopen`, back to building. |

To check that the model catches real breaks, delete the handoff's PR guard: TLC then breaks `HandedOffHasPR` in 5 steps. Keep a send-back's verdict instead of clearing it, and TLC breaks `VerdictFresh` in 6.

## Not modelled

- The ticket lease and the close. Those are in the OS-104 spike's model (OS-109, OS-110).
- The send-back restore. It undoes a send-back the builder could not be told about, so it puts the row back where it was.
- Races inside one guarded `UPDATE`. Each step of the model is atomic, as `moveSpinoff`'s `WHERE status = <read>` is.
- The overrides around the PR guard: a spike hands off without one (it commits no code), and `--ci-unchecked '<why>'` records a reason and skips the CI read. The model's `HandedOffHasPR` is the rule for a build that uses neither.
- The guards' code. The parity test checks the edges, states and events; that `noPr` and the verdict clear are wired in is pinned by `platform/cli-coord/test/spinoff-lifecycle-os211.test.ts` and `handoff-ci-2044.test.ts`.
- Timing, and more than one row.
