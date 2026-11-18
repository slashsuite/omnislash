import { describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "./helpers.ts";

// #134 — help that was asked for is not an error.
// `ob --help` used to exit 2, so the natural "does ob load?" probe
// (`ob --help >/dev/null && echo OK`) reported a failure on a healthy CLI, and that probe is
// what this repo's own pre-land gate runs. Requested help now exits 0; exit 2 stays reserved for
// a genuine usage error (bad flag, unknown command, or no command at all).

describe("ob exit codes (#134)", () => {
  test("--help prints the help on stdout and exits 0", async () => {
    const r = await runCli(freshDbPath(), ["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OmniSlash personal task tracker");
    expect(r.err).toBe("");
  });

  test("-h exits 0", async () => {
    const r = await runCli(freshDbPath(), ["-h"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: ob <command>");
  });

  test("the `help` command exits 0", async () => {
    const r = await runCli(freshDbPath(), ["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OmniSlash personal task tracker");
    expect(r.err).toBe("");
  });

  test("a command's own --help exits 0 without running the command", async () => {
    const r = await runCli(freshDbPath(), ["close", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OmniSlash personal task tracker");
    expect(r.err).toBe("");
  });

  test("no command at all is a usage error: help on stdout, exit 2", async () => {
    const r = await runCli(freshDbPath(), []);
    expect(r.code).toBe(2);
    expect(r.out).toContain("OmniSlash personal task tracker");
  });

  test("an unknown command is a usage error on stderr, exit 2", async () => {
    const r = await runCli(freshDbPath(), ["definitely-not-a-command"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'definitely-not-a-command'");
  });

  test("an unknown flag is a usage error, exit 2", async () => {
    const r = await runCli(freshDbPath(), ["list", "--nope"]);
    expect(r.code).toBe(2);
    expect(r.err.toLowerCase()).toContain("nope");
  });

  test("a real command still exits 0", async () => {
    const r = await runCli(freshDbPath(), ["list", "--json"]);
    expect(r.code).toBe(0);
  });
});
