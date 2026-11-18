// Build this process's Postgres cluster and the real-schema template BEFORE any test runs (OB-2021).
//
// The first lease in a process starts the cluster and applies the whole chain to the template. That work used
// to land inside whichever test leased first: 31 s at load 115 on this desktop (initdb and the postmaster boot
// 10.7 s, the chain and its shape query 20.3 s) while that test's own assertions took 0.3 s. bun gives a test
// 5 s, so `api-deploy-run-1809 > a start that fails records refused` timed out on work that is not its own. No
// test budget can cover a fixture build whose cost is the machine's load.
//
// A preload is where the cost belongs: it runs once per process, before any test file, with no budget at all.
// It cannot live in `real-schema.ts` as a `beforeAll`: the dashboard's visual tool imports that module for
// `applyPgChain` (`apps/dashboard/visual/fixture-db.ts`, run by plain `bun`), where registering a hook throws
// ("Cannot use beforeAll() outside of the test runner"), and a hook registered on import would bind to
// whichever test file imported the module first.
//
// Listed by the bunfig.toml of every project whose tests lease these databases (cli-core, cli-db, cli-sources,
// cli-whatsapp; `pg-warm-preload-2167.test.ts` keeps that true). Every other project never loads this file and
// never starts a cluster. A single file run in those projects pays the build too, which is the price of the build being setup: at idle it is
// about a second, and the alternative is a test's 5 s holding a number that belongs to the machine.
import { leaseRealPgDb } from "./real-schema.ts";

const lease = await leaseRealPgDb();
await lease.release();
