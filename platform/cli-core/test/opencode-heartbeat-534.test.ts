import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeartbeatHooks, parseCommitState } from "../../../apps/cli/opencode/plugins/ob-heartbeat.ts";

const WT = "/wt/534";

function calls(log: string): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function fixtureOb(agents: unknown[]): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "ob-534-"));
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

function commitCmd(stateLine: string): string {
  return `git add -A && git commit -m "$(cat <<'EOF'
feat(ob 534): x

${stateLine}
EOF
)"`;
}

async function fireCommit(hooks: ReturnType<typeof createHeartbeatHooks>, stateLine: string) {
  const command = commitCmd(stateLine);
  await hooks["tool.execute.after"]({ tool: "bash", args: { command } }, { title: "git commit" });
}

describe("opencode heartbeat plugin stamps State: (534)", () => {
  test("commit with State: ready registers readying and spinoff ready", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: ready — gate green");
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "readying"],
    ]);
    expect(argv.filter((a) => a[0] === "spinoff")).toEqual([["spinoff", "ready"]]);
    expect(argv.some((a) => a[0] === "close" || a[1] === "done")).toBe(false);
  });

  test("commit with State: landable (the current spelling of ready) registers readying", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: landable");
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "readying"],
    ]);
    expect(argv.filter((a) => a[0] === "spinoff")).toEqual([["spinoff", "ready"]]);
  });

  test("commit with State: needs-human registers needs-human and spinoff ready", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: needs-human — wording");
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "needs-human"],
    ]);
    expect(argv.filter((a) => a[0] === "spinoff")).toEqual([["spinoff", "ready"]]);
  });

  test("a session with no agent row is silent", async () => {
    const { bin, log } = fixtureOb([{ id: "other", worktree: "/wt/other" }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: ready");
    const argv = calls(log);
    expect(argv.every((a) => a[0] === "agents")).toBe(true);
    expect(argv.some((a) => a[0] === "agent" || a[0] === "spinoff")).toBe(false);
  });

  test("State: blocked registers blocked and does not spinoff ready", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: blocked — waiting on access");
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "blocked"],
    ]);
    expect(argv.some((a) => a[0] === "spinoff")).toBe(false);
  });

  test("State: partial registers needs-human and does not spinoff ready", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "State: partial — docs still missing");
    const argv = calls(log);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "needs-human"],
    ]);
    expect(argv.some((a) => a[0] === "spinoff")).toBe(false);
  });

  test("git commit with no State: line heartbeats only", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await fireCommit(hooks, "not a state line");
    const argv = calls(log);
    expect(argv.filter((a) => a[0] === "agent" && a[1] === "heartbeat")).toEqual([["agent", "heartbeat", "534"]]);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([]);
    expect(argv.some((a) => a[0] === "spinoff")).toBe(false);
  });

  test("status stamp is not coalesced away inside 15s", async () => {
    const { bin, log } = fixtureOb([{ id: "534", worktree: WT }]);
    process.env.OB_BIN = bin;
    const hooks = createHeartbeatHooks({ directory: WT, worktree: WT });
    await hooks["tool.execute.after"]({ tool: "bash", args: { command: "ls" } }, { title: "ls" });
    await fireCommit(hooks, "State: ready");
    const argv = calls(log);
    expect(argv.filter((a) => a[0] === "agent" && a[1] === "heartbeat")).toEqual([["agent", "heartbeat", "534"]]);
    expect(argv.filter((a) => a[1] === "register" && a.includes("--status"))).toEqual([
      ["agent", "register", "--id", "534", "--status", "readying"],
    ]);
    expect(argv.filter((a) => a[0] === "spinoff")).toEqual([["spinoff", "ready"]]);
  });

  test("parseCommitState ignores non-commits and unknown tokens", () => {
    expect(parseCommitState("ls")).toBe(null);
    expect(parseCommitState("git log -1")).toBe(null);
    expect(parseCommitState("git commit -m 'feat'\n\nState: mystery")).toBe(null);
    expect(parseCommitState("git commit -m 'State: ready'")).toBe("ready");
  });
});
