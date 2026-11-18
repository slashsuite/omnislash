# OmniSlash facts

Checked against main at bfb32ac on 2026-11-18.

## What it is
OmniSlash is a command-line tool for keeping track of tasks, projects and the agents that work on them.
It is in alpha, so anything may change or break.

## Today
- `help-command`: `bun apps/cli/src/index.ts --help` prints the command reference from a checkout of main.
- `item-tracking`: with `OMNISLASH_STORE=sqlite`, `OMNISLASH_DB_CREATE=1` and `OMNISLASH_DB` set to a new path, `bun apps/cli/src/index.ts add "<title>" --project <name> --kind side` and `list` create and list work items in that new SQLite file. Postgres is the default store and needs a connection URL.
- `drilled-ticket-gate`: the first dispatch (`spinoff <ticket>`) of a ticket not tagged `spike` is refused, with nothing queued, when the ticket has no `## Drilled` section or no `## Done when` item, and when no `go` check is recorded on the ticket's current text, unless the dispatcher overrides it with `--no-check '<why>'`; a `spike` ticket is refused instead without `## Questions`, `## Box`, `## Done when` and a link to the ticket it serves (platform/cli-coord/src/spinoff-check.ts:352-399; `bun test test/spinoff-drilled-1980.test.ts test/spinoff-check-1825.test.ts` in platform/cli-coord passes).
- `agent-build-worktree`: a dispatch opens the builder in a git worktree on the ticket's own branch: it reuses the worktree already checked out on that branch, or else runs `git worktree add <path> -b <branch>` from `origin/main` (local `main` when the repo has no `origin/main` or its local `main` is ahead), and launches the builder as a T3 Code thread, the only launcher, so it needs T3 Code (platform/cli-coord/src/commands/spinoff.ts:1195-1209 and 1528-1536).
- `leases`: a lease on a resource such as `ticket:<ref>` or `worktree:<path>` has one live holder at a time, and a second holder is refused until it is released or expires (platform/cli-coord/src/lease.ts:175-189 and 466-467; `bun apps/cli/src/index.ts --help` lists `lease acquire`, `lease run` and `lease release`; `bun test test/lease.test.ts test/lease-tickets.test.ts` in platform/cli-coord passes).
- `review-merge-skills`: agent skills gate a builder's pull request before merge: `ob-skeptical-review` (read-only reviewers that presume every changed line is wrong), `ob-babysit-pr` (the watch on a handed-off pull request) and `ob-land` (the builder opens the pull request, another role gates and merges it) (skills/README.md:46-48).
- `role-skills`: agent skills prime a thread for each role: `ob-architect` (plans, drills and dispatches every build, then gates and merges), `ob-sentinel` (verifies, merges and deploys every pull request) and `ob-muse` (explores and hands over a design once confirmed) (skills/README.md:39, 51 and 58).
- `role-runs`: `role start <team> <role>` keeps one T3 Code run per team role (architect, sentinel or muse): it reuses the open run while its thread is live, and otherwise opens a new pinned thread on claude-opus-5-5 at the model's default effort; `role status` and `role end` read and end it. Each run is a row in `role_run`, whose partial unique index on (team, role) where `ended_at` is null keeps one open run (apps/cli/src/commands/role.ts, apps/cli/src/role-run.ts; `bun test test/role-run.test.ts` in platform/cli-core passes, locally and over the API).
- `compared-linear`: Linear ships agents on issues: an issue is delegated by assigning it to Linear's own agent or an installed third-party agent, and Linear's agent writes code in a sandbox and creates branches (https://linear.app/docs/agents-in-linear, https://linear.app/docs/assigning-issues and https://linear.app/changelog, read 2026-11-18). Those pages name no check on what an issue says before it is delegated; OmniSlash refuses the first dispatch of a ticket that has no drilled section, no done-when item or no recorded check, unless overridden, as `drilled-ticket-gate` says (platform/cli-coord/src/spinoff-check.ts:352-399). OmniSlash makes no other claim beyond what Linear ships.
- `compared-jira`: Jira ships Rovo agents on work items, in beta: an agent is added to the assignee field, mentioned in a comment, or set on a workflow transition or board column, and the Rovo Dev coding agent has a CLI worktree mode that creates a branch (https://support.atlassian.com/rovo/docs/collaborate-with-your-rovo-agent-on-work-items/ and https://support.atlassian.com/rovo/docs/use-worktree-mode-in-rovo-dev-cli/, read 2026-11-18). Those pages name no check on what a work item says before an agent takes it; OmniSlash refuses the first dispatch of a ticket that has no drilled section, no done-when item or no recorded check, unless overridden, as `drilled-ticket-gate` says (platform/cli-coord/src/spinoff-check.ts:352-399). OmniSlash makes no other claim beyond what Jira ships.

## Planned
- `role-runs-on-demand`: role runs started on demand, and an inbox for each role.
- `parallel-conflict-checks`: checks for conflicts between builders working in parallel.
- `team-server`: a team server with per-user access.

## Licence
- `licence`: source available under the Elastic License 2.0 (not open source)

## Where it runs
- `checkout-linux`: a fresh clone with Bun 1.4.2 runs `bun install`, then `bun apps/cli/src/index.ts --help` (checked on Linux).
