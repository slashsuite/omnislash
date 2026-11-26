# Contributing to OmniSlash

OmniSlash is alpha: anything may change or break, and there is no compatibility promise yet. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first for how the pieces fit, and [GLOSSARY.md](GLOSSARY.md)
for the words the code, the docs and the tickets use.

## Set up

You need Bun at the version pinned in `.bun-version`.

```sh
bun install
bun apps/cli/src/index.ts --help
```

The workspace is run by [moon](https://moonrepo.dev): `apps/` holds the CLI and the dashboard,
`platform/` the packages they share. Each package's README says what it owns.

## The gate

Every pull request must pass the gate. CI runs it on the pull request head, and you can run the same
steps locally:

```sh
bun apps/cli/src/index.ts gate run
```

The steps are listed in [`gate.json`](gate.json): moon's typecheck, test and lint for every project, the
dashboard's Storybook build, the state-machine export check and the workflow check. While you work, the
fast loop is:

```sh
bunx moon run --concurrency 3 :typecheck :test
bunx moon run <project>:test          # one project, e.g. cli-core:test
```

Tests use fresh in-memory or temporary databases only. They never reach the network or a live database.
A test that fails and then passes on the same code is a flake: report it with the failing output, never
rerun it until it passes.

## Changing the code

- **Keep pull requests small and focused.** One change per pull request, on its own branch, rebased on
  `main` before you open it. Pull requests are squash-merged.
- **Commit subjects are Conventional Commits** with the ticket ref as the scope when there is one:
  `feat(OS-217): ...`, `fix(OS-252): ...`. Use `fix` for a bug, `feat` for new behaviour, `docs` for
  documentation only and `chore` for removals and housekeeping.
- **No attribution lines.** Commits and pull requests carry no `Co-Authored-By` trailer and no AI or tool
  credit.
- **A CLI change updates its docs in the same pull request:** the `--help` text (`apps/cli/src/help.ts`)
  and the [command reference](apps/cli/docs/commands.md), plus the [guide](apps/cli/docs/guide.md) when
  it changes how things fit together. `apps/cli/test/docs-completeness.test.ts` fails when a command is
  missing from the docs.
- **A database change is additive.** A new table or column is a new migration; see "Adding a table or
  column" in the [guide](apps/cli/docs/guide.md#adding-a-table-or-column-schema-migration-snapshot).
- **A change to a lifecycle** (a status and its allowed moves) goes through `platform/state-machine`,
  whose TLA+ model CI checks.

## FACTS.md

A pull request that changes what the product does, where it runs or its licence also updates
`FACTS.md` in the same pull request. It bumps the "Checked against" line to the short sha of the
`main` commit the facts were checked against, and to the date of the change.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.
