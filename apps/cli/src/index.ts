#!/usr/bin/env bun
import { run } from "./cli.ts";
import { flushStdout } from "./output.ts";
import { migrateOmnibusHomeOnStartup } from "./home-migrate.ts";

// `process.exit` does not wait for a pipe to drain, so a large printRaw (`ob secret get`) was cut at the
// pipe buffer (131072 bytes) while the exit code still said 0 (OB-1829). Wait for the write, then exit.
// A machine moved from omnibus: copy its T3 credential and Google OAuth state into ~/.omnislash once (OS-215).
migrateOmnibusHomeOnStartup();
const code = await run(process.argv.slice(2));
await flushStdout();
process.exit(code);
