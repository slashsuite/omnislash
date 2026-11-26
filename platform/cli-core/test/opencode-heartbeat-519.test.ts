import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeartbeatHooks, HEARTBEAT_MIN_MS } from "../../../apps/cli/opencode/plugins/ob-heartbeat.ts";

const WT = "/wt/519";

function calls(log: string): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function fixtureOb(agents: unknown[]): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "ob-519-"));
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

async function fireAfter(
  hooks: ReturnType<typeof createHeartbeatHooks>,
  tool = "bash",
  title = "ls",
  args: Record<string, unknown> = { command: "ls" },
) {
  await hooks["tool.execute.after"]({ tool, args }, { title });
}

describe("opencode heartbeat plugin (519)", () => {
  test(
    "tool.after heartbeats; a second fire inside 15s does not",
    async () => {
      const { bin, log } = fixtureOb([{ id: "519", worktree: WT }]);
      process.env.OB_BIN = bin;
      const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
      await fireAfter(hooks);
      await fireAfter(hooks, "read", "foo.ts", { filePath: "foo.ts" });
      const argv = calls(log);
      expect(argv.filter((a) => a[0] === "agent" && a[1] === "heartbeat")).toEqual([["agent", "heartbeat", "519"]]);
      expect(HEARTBEAT_MIN_MS).toBe(15_000);
      const notes = argv.filter((a) => a[0] === "agent" && a[1] === "register");
      expect(notes[0]).toEqual(["agent", "register", "--id", "519", "--note", "bash ls"]);
      expect(notes.every((a) => !a.includes("--status"))).toBe(true);
      expect(notes[1]).toEqual(["agent", "register", "--id", "519", "--note", "read foo.ts"]);
    },
  );

  test(
    "a session with no agent row is silent",
    async () => {
      const { bin, log } = fixtureOb([{ id: "other", worktree: "/wt/other" }]);
      process.env.OB_BIN = bin;
      const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
      await fireAfter(hooks);
      await hooks["chat.message"]();
      const argv = calls(log);
      expect(argv.every((a) => a[0] === "agents")).toBe(true);
      expect(argv.some((a) => a[0] === "agent")).toBe(false);
    },
  );

  test(
    "dispose does not heartbeat a dead session and does not agent done",
    async () => {
      const { bin, log } = fixtureOb([{ id: "519", worktree: WT }]);
      process.env.OB_BIN = bin;
      const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
      await hooks.dispose();
      await fireAfter(hooks);
      await hooks["chat.message"]();
      expect(readFileSync(log, "utf8")).toBe("");
    },
  );
});
