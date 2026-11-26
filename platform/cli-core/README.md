# cli-core

A test-only package. It holds the behaviour tests for the `ob` command in `apps/cli`. It has no `src/`
and nothing imports it.

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for how the CLI is put together.

## What it covers

About 145 test files, one per behaviour or ticket, under `test/`. Among them:

- the API server handler (`createObApi`), the API client and its routing;
- scoped API tokens;
- credentials, deploys, gate runs and job health;
- items, the queue, alerts, tags and usage;
- T3 Code roles, teams and the inbox;
- the connectors' commands, driven through `apps/cli`.

`test/fixtures/` holds the input files a few tests read.

## Dependencies

- Tests import `apps/cli/src`, `platform/cli-coord`, `platform/cli-sources` and
  `platform/cli-whatsapp` by relative path.
- moon `dependsOn`: `cli`.

## Tests

```sh
bunx moon run cli-core:test
```

The task runs `bun test ./` and preloads two files:

- `apps/cli/test/preload.ts`: a temp directory and a temp SQLite store per run;
- `apps/cli/test/pg/warm.ts`: a throwaway Postgres cluster built from the `@embedded-postgres`
  packages, on a unix socket with no TCP port, removed after the run.

Set `OB_TEST_REPORT_DIR` to write a JUnit report.

## Gotchas

- A test file name often ends in the ticket number that added it (`job-health-218.test.ts`). Search by
  the command or module name, not only by the number.
- Tests never reach the network. GitHub, T3 Code, Google and WhatsApp are replaced through the seams in
  `apps/cli/src` (`test-seams.ts` and the `__set*` functions).
- The default store under test is SQLite. A test that needs Postgres takes a fresh database from the warm cluster (`freshPgStore()` in `apps/cli/test/pg/store.ts`).
- Most of this suite tests code in `apps/cli`, so look there for the code under test.
