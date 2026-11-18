#!/usr/bin/env bun
import { run } from "./cli.ts";
import { flushStdout } from "./output.ts";

// `process.exit` does not wait for a pipe to drain, so a large printRaw (`ob secret get`) was cut at the
// pipe buffer (131072 bytes) while the exit code still said 0 (OB-1829). Wait for the write, then exit.
const code = await run(process.argv.slice(2));
await flushStdout();
process.exit(code);
