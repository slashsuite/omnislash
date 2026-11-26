import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeartbeatHooks } from "../../../apps/cli/opencode/plugins/ob-heartbeat.ts";

const WT = "/wt/80";

function calls(log: string): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function fixtureOb(agents: unknown[]): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "ob-80-"));
  const log = join(dir, "log");
  const agentsJson = join(dir, "agents.json");
  writeFileSync(agentsJson, JSON.stringify(agents));
  writeFileSync(log, "");
  const bin = join(dir, "ob");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "agents") process.stdout.write(readFileSync(${JSON.stringify(agentsJson)}, "utf8"));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const prevBin = process.env.OB_BIN;
afterEach(() => {
  if (prevBin === undefined) delete process.env.OB_BIN;
  else process.env.OB_BIN = prevBin;
});

describe("opencode heartbeat plugin stamps waiting-for-you (80)", () => {
  test("session.idle registers needs-human", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks.event({ event: { type: "session.idle" } });
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "80", "--status", "needs-human"],
    ]);
  });

  test("chat.message registers working", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks["chat.message"]();
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "80", "--status", "working"],
    ]);
  });

  test("chat.message registers planning for architect-* ids", async () => {
    const { bin, log } = fixtureOb([{ id: "architect-omnibus", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks["chat.message"]();
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "architect-omnibus", "--status", "planning"],
    ]);
  });

  test("a session with no agent row is silent on idle and chat.message", async () => {
    const { bin, log } = fixtureOb([{ id: "other", worktree: "/wt/other" }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks.event({ event: { type: "session.idle" } });
    await hooks["chat.message"]();
    const argv = calls(log);
    expect(argv.every((a) => a[0] === "agents")).toBe(true);
    expect(argv.some((a) => a[0] === "agent")).toBe(false);
  });

  test("tool.after still does not stamp needs-human or working", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks["tool.execute.after"]({ tool: "bash", args: { command: "ls" } }, { title: "ls" });
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([]);
  });

  test("idle status is not coalesced away inside 15s", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks["tool.execute.after"]({ tool: "bash", args: { command: "ls" } }, { title: "ls" });
    await hooks.event({ event: { type: "session.idle" } });
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "80", "--status", "needs-human"],
    ]);
  });

  test("session.status idle does not stamp", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks.event({ event: { type: "session.status" } });
    const argv = calls(log);
    expect(argv.some((a) => a[0] === "agent")).toBe(false);
  });

  test("dispose does not stamp idle or working", async () => {
    const { bin, log } = fixtureOb([{ id: "80", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks.dispose();
    await hooks.event({ event: { type: "session.idle" } });
    await hooks["chat.message"]();
    expect(readFileSync(log, "utf8")).toBe("");
  });

});
