import { afterAll, afterEach } from "bun:test";
import { sweepStalePgClusters } from "./cluster.ts";
import { releasePgLeases, stopPgHarness } from "./harness.ts";

/**
 * Wire the Postgres harness into the run's lifecycle. Called from `test/preload.ts`, which is the only
 * scope whose hooks cover EVERY test file -- registering them from the harness module instead would cover
 * only the first file to import it, because a second import is served from the module cache and re-runs no
 * top-level code.
 *
 * Nothing here starts a cluster. `releasePgLeases` and `stopPgHarness` are both no-ops until a test has
 * actually asked for a database, so a run of the existing SQLite suite pays a function call per test and
 * nothing else.
 */
export function installPgTestHooks(): void {
  sweepStalePgClusters();
  afterEach(async () => {
    await releasePgLeases();
  });
  afterAll(async () => {
    await stopPgHarness();
  });
}
