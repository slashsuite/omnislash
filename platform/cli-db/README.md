# cli-db

A test-only package for the store. It checks that the database layer in `apps/cli/src/db` behaves the
same on SQLite and Postgres, and that migrations apply safely. It has no `src/`.

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-store) for the store itself.

## What it covers

- `pg-*.test.ts`: the Postgres store: the schema, migrations and their lock, search, the pool, the
  connection URL, and items, jobs, leases and spinoffs on Postgres.
- `db-migration*.test.ts`, `db-snapshot-meta-*.test.ts`: the SQLite migration chain, run atomically,
  and the drizzle snapshots kept in step with the `.sql` files. `test/__snapshots__/` holds the
  expected output.
- `db-busy-retry-*.test.ts`, `db-create-guard-*.test.ts`: SQLite retries a busy database, and refuses
  to create a new file without `OMNISLASH_DB_CREATE=1`.
- `lease-race-*.test.ts`, `status-race-*.test.ts`: two writers racing for the same row.
- `queue-order-pg-*.test.ts`, `priority-trail-pg-*.test.ts`: queue order on Postgres.

## Dependencies

- Tests import `apps/cli/src` and `platform/cli-coord` by relative path.
- moon `dependsOn`: `cli`.

## Tests

```sh
bunx moon run cli-db:test
```

Tests run with `bun test` and preload `apps/cli/test/preload.ts` and `apps/cli/test/pg/warm.ts`. The
second starts a throwaway Postgres cluster on a unix socket and removes it after the run. Set
`OB_TEST_REPORT_DIR` to write a JUnit report.

## Gotchas

- A schema change needs both chains: `src/db/schema.ts` with `drizzle.config.ts`, and
  `src/db/pg/schema.ts` with `drizzle.pg.config.ts`. Generate migrations with `drizzle-kit generate`.
  Do not write the `.sql`, journal or snapshot files by hand.
- Store code awaits every query builder and never calls `.all()`, `.get()` or `.run()`, or it will only
  work on SQLite. The tests here catch that.
- The Postgres cluster needs the `@embedded-postgres` package for your platform, an optional
  dependency of `apps/cli`.
