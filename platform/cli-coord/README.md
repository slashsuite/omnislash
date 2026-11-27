# cli-coord

Coordination for agents that work the same repos at once: leases, the agent registry, spinoffs, the
daemon job list and the checks a builder's work passes before it lands. It is part of the `ob` command.
`apps/cli/src/cli.ts` maps the `daemon`, `lease`, `agent`, `agents` and `spinoff` commands to it.

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for how it fits with the rest.

## Main modules

- `src/lease.ts`: one live holder per resource (`ticket:<ref>`, `worktree:<path>`, `cpu:browser` and so
  on), with a time to live.
- `src/lease-run.ts`, `src/lease-run-shim.ts`, `src/lease-wait-title.ts`: `ob lease run <resource> --
  <cmd>`, which holds a lease for the length of a command and always releases it.
- `src/agent.ts`, `src/agent-register.ts`: the agent registry. Registering claims the ticket lease, and
  `ob agent done` releases only that agent's own leases.
- `src/commands/coord.ts`: the `daemon`, `lease`, `agent` and `agents` commands, and `daemonJobs()`, the
  one list of scheduled jobs.
- `src/commands/spinoff.ts`: the spinoff lifecycle. It hands a ticket to a builder in its own git
  worktree on a T3 Code thread and tracks it to close. State changes go through the spinoff machine in
  `state-machine` (`applyMove`).
- `src/spinoff-*.ts`: the parts of a spinoff, such as `spinoff-check.ts` (is the ticket ready to
  build), `spinoff-sendback.ts`, `spinoff-reopen.ts`, `spinoff-abandon.ts`, `spinoff-conflicts.ts`,
  `spinoff-overlap.ts` and `spinoff-tokens.ts`.
- `src/commands/handoff-ci.ts`: a handoff needs the pull request's CI to be green.
- `src/land-guard.ts`, `src/clean-repo.ts`, `src/conventional-commit.ts`: checks on a branch and its
  commit before it lands.

## Dependencies

- Imports `apps/cli` (the store, config, T3 client and errors) and `platform/state-machine`, by
  relative path.
- Imported by `apps/cli`, `apps/ob-dashboard`, and the tests in `cli-core`, `cli-db` and
  `state-machine`.

## Tests

```sh
bunx moon run cli-coord:test
```

Tests run with `bun test` and preload `apps/cli/test/preload.ts`, which gives each run a temp
directory and a temp SQLite store. This package has no Postgres preload. Its Postgres tests live in
`platform/cli-db` (`pg-coord-*`, `pg-spinoff-*`).

## Gotchas

- `src/commands/spinoff.ts` is several thousand lines long. Look for the right `spinoff-*.ts` module
  before adding to it.
- `apps/cli` and this package import each other. Keep shared types in `apps/cli` so the cycle stays
  limited to runtime calls.
- A move of a spinoff row must go through the state machine. `state-machine`'s parity test reads this
  package, so a new edge needs a matching change there.
- `ob daemon install` writes only the client jobs (today `role-tick` and `settle-sweep`), not the whole list in
  `daemonJobs()`.
