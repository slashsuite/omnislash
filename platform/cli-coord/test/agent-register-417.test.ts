import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP } from "../../../apps/cli/src/cli.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

// 417 — register ≠ launch. `ob agent register --id 415` (and 416) without a real
// `ob spinoff` created tree rows, and the interactive app opened empty-session tabs because
// opencode cannot pre-mint a session id (384). Register is a registry write.
// It must never launch anything. Only `ob spinoff` starts an agent.
//
// 417 also locked V2 `permissions` deny `subagent` in the repo-root opencode.json, so an
// OpenCode architect could not quietly re-enable the in-process Task/subagent tool (it blocks
// the parent session until the child returns). **Retired 2026-10-17 (ob 1134):** delegation
// is app-owned now — a T3 thread or `delegate_task` runs in its own workspace while this
// session stays free to capture — so the lock buys nothing and is gone from the config. This
// test is the regression guard: if the lock comes back, an architect blocks again.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const README = readFileSync(join(import.meta.dir, "..", "..", "..", "apps/cli/README.md"), "utf8");
const COORD_SRC = readFileSync(join(import.meta.dir, "..", "src/commands/coord.ts"), "utf8");
const API_AGENT_SRC = readFileSync(join(import.meta.dir, "..", "..", "..", "apps/cli/src/api/client-handlers.ts"), "utf8");

describe("ob agent register ≠ launch (417)", () => {
  test("register under an architect hold launches nothing", async () => {
    // A fake T3 that records every launch: register must leave it untouched (T3 is the only launcher, 1589).
    const t3 = installFakeT3([REPO_ROOT]);
    try {
      const dbPath = freshDbPath();
      expect(
        (await runCli(dbPath, ["lease", "acquire", "ticket:417", "--holder", "architect-acme", "--ttl", "1800"])).code,
      ).toBe(0);

      const reg = await runCli(dbPath, [
        "agent",
        "register",
        "--id",
        "417",
        "--ticket",
        "417",
        "--holder",
        "architect-acme",
        "--launcher",
        "t3",
        "--status",
        "working",
      ]);
      expect(reg.code).toBe(0);
      expect(reg.out).toContain("registered 417");
      expect(t3.launches).toEqual([]);
    } finally {
      t3.restore();
    }
  });

  test("register handlers never reach for a launcher", () => {
    expect(COORD_SRC).not.toContain("headlessLauncher");
    expect(COORD_SRC).not.toContain("agentSpawn");
    const start = API_AGENT_SRC.indexOf("async function apiAgent");
    expect(start).toBeGreaterThan(-1);
    const next = API_AGENT_SRC.indexOf("\nasync function ", start + 1);
    const body = next === -1 ? API_AGENT_SRC.slice(start) : API_AGENT_SRC.slice(start, next);
    expect(body).not.toContain("launchRowIn");
    expect(body).not.toContain("headlessLauncher");
  });

  test("HELP and README say register ≠ launch", () => {
    expect(HELP).toContain("register ≠ launch");
    expect(README).toContain("Register ≠ launch");
  });
});

