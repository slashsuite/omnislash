# state-machine

The lifecycles `ob` enforces, written as XState v5 machines: items, spinoffs and team roles. The
machines are used as pure functions. Nothing here starts an actor, reads the store or writes it. The
caller passes in the current state and an event and gets back the next state or a refusal.

This package imports nothing else from the repo.

## Main modules

- `src/item.ts`: the item lifecycle. `apps/cli/src/workflow.ts` checks item moves against it.
- `src/spinoff.ts`: `SPINOFF_EDGES` and `spinoffMachine`, the spinoff row lifecycle.
  `platform/cli-coord` moves spinoff rows through it.
- `src/spinoff-phase.ts`: the role phase of a spinoff row, a sub-state of its status kept in
  `spinoff.phase`.
- `src/role.ts`: `roleMachine`, the lifecycle of a team role.
- `src/decide.ts`: `decide`, which applies an event to a stored state and returns the next state or why
  the move is refused.
- `src/apply.ts`: `applyMove`. The caller supplies the read and the write, and `applyMove` runs the
  machine between them.
- `src/export.ts`: writes `docs/role-state-machine.json` and `docs/role-state-machine.mmd` from
  `role.ts`.
- `model/`: a TLA+ model of the spinoff row and the script that runs TLC on it. See
  [model/README.md](model/README.md).

## Dependencies

- Package: `xstate`.
- Imported by `apps/cli`, `platform/cli-coord` and `apps/ob-dashboard`.

## Tests and tasks

```sh
bunx moon run state-machine:test        # vitest
bunx moon run state-machine:export      # rewrite docs/role-state-machine.*
bunx moon run state-machine:export -- --check   # fail if those files are out of date
bunx moon run state-machine:tlc         # run TLC on model/Spinoff.tla (needs java)
```

The gate runs `test` and `export -- --check`. CI also runs `tlc` on every pull request.

## Gotchas

- `test/parity.test.ts` reads `apps/cli/src/status.ts` and `platform/cli-coord`, and checks that the
  code and the machines agree. A new status or move needs both sides.
- `test/tla-parity.test.ts` checks that `model/Spinoff.tla` has the same edges, states and events as
  `SPINOFF_EDGES`. A new spinoff edge must be added to the model too.
- After changing `role.ts`, run `state-machine:export` and commit the two files under `docs/`, or the
  gate fails.
- This package uses vitest, not `bun test`.
