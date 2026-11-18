# OmniSlash facts

Checked against main at 6fb9d18 on 2026-11-18.

## What it is
OmniSlash is a command-line tool for keeping track of tasks, projects and the agents that work on them.
It is in alpha, so anything may change or break.

## Today
- `help-command`: `bun apps/cli/src/index.ts --help` prints the command reference from a checkout of main.
- `item-tracking`: with `OMNISLASH_STORE=sqlite`, `OMNISLASH_DB_CREATE=1` and `OMNISLASH_DB` set to a new path, `bun apps/cli/src/index.ts add "<title>" --project <name> --kind side` and `list` create and list work items in that new SQLite file. Postgres is the default store and needs a connection URL.

## Planned

## Licence
- `licence`: source available under the Elastic License 2.0 (not open source)

## Where it runs
- `checkout-linux`: a fresh clone with Bun 1.4.2 runs `bun install`, then `bun apps/cli/src/index.ts --help` (checked on Linux).
