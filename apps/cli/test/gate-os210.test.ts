// OS-210: `ob gate run` runs the repo's gate.json, caches by HEAD sha plus the file's hash, and CI runs the same file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateLine, parseGateFile, runGate, type GateStep } from "../src/commands/gate.ts";
import { planExecution } from "../src/remote.ts";

const REPO = join(import.meta.dir, "../../..");

let dir: string;
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const GATE = JSON.stringify({ steps: [{ name: "a", run: "true" }, { name: "b", run: "true", env: { X: "1" } }] });

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-gate-"));
  git("init", "-q");
  writeFileSync(join(dir, "gate.json"), GATE);
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function counting(codes: Record<string, number> = {}) {
  const ran: GateStep[] = [];
  return { ran, runStep: async (s: GateStep) => (ran.push(s), codes[s.name] ?? 0) };
}
const quiet = { log: () => {} };

describe("gate.json", () => {
  test("parses steps with env, and refuses an empty list, a missing run, a repeated name and a non-string env", () => {
    expect(parseGateFile(GATE)).toEqual([{ name: "a", run: "true" }, { name: "b", run: "true", env: { X: "1" } }]);
    expect(() => parseGateFile("{")).toThrow("not JSON");
    expect(() => parseGateFile('{"steps":[]}')).toThrow("non-empty");
    expect(() => parseGateFile('{"steps":[{"name":"a"}]}')).toThrow("needs a \"run\"");
    expect(() => parseGateFile('{"steps":[{"name":"a","run":"x"},{"name":"a","run":"y"}]}')).toThrow("twice");
    expect(() => parseGateFile('{"steps":[{"name":"a","run":"x","env":{"A":1}}]}')).toThrow("env");
  });

  test("the repo's own gate.json parses, and CI's gate job runs it through `ob gate run` and nothing else", () => {
    const steps = parseGateFile(readFileSync(join(REPO, "gate.json"), "utf8"));
    expect(steps.map((s) => s.name)).toEqual(["moon", "state-machine", "workflows"]);
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  gate:"), ci.indexOf("\n  tla:"));
    const runs = [...job.matchAll(/- run: (.+)/g)].map((m) => m[1]!.trim());
    expect(runs).toEqual(["bun install --frozen-lockfile", "bun apps/cli/src/index.ts gate run"]);
  });

  test("`ob gate` runs with no tracker, so CI needs no database", () => {
    expect(planExecution({ command: "gate", args: ["run"], flags: {}, host: "server.test" }).mode).toBe("nodb");
  });
});

describe("runGate", () => {
  test("a second run at the same sha and file hash returns the cached result without running a step", async () => {
    const first = counting();
    const a = await runGate(dir, { ...quiet, runStep: first.runStep });
    expect(a.cached).toBe(false);
    expect(a.result.ok).toBe(true);
    expect(first.ran.map((s) => s.name)).toEqual(["a", "b"]);
    const second = counting();
    const b = await runGate(dir, { ...quiet, runStep: second.runStep });
    expect(b.cached).toBe(true);
    expect(second.ran).toEqual([]);
    expect(b.result).toEqual(a.result);
    expect(gateLine(b)).toContain("cached from");
  });

  test("--force reruns; a new commit or a changed gate.json misses the cache", async () => {
    await runGate(dir, { ...quiet, runStep: counting().runStep });
    const forced = counting();
    expect((await runGate(dir, { ...quiet, force: true, runStep: forced.runStep })).cached).toBe(false);
    expect(forced.ran).toHaveLength(2);
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ steps: [{ name: "a", run: "true" }] }));
    git("commit", "-qam", "one step");
    const changed = counting();
    expect((await runGate(dir, { ...quiet, runStep: changed.runStep })).cached).toBe(false);
    expect(changed.ran.map((s) => s.name)).toEqual(["a"]);
  });

  test("a dirty worktree runs and is never cached", async () => {
    writeFileSync(join(dir, "new.txt"), "x");
    const a = await runGate(dir, { ...quiet, runStep: counting().runStep });
    expect(a.uncached).toContain("uncommitted");
    const again = counting();
    expect((await runGate(dir, { ...quiet, runStep: again.runStep })).cached).toBe(false);
    expect(again.ran).toHaveLength(2);
  });

  test("a red step stops the gate, names the step, and the red result is cached", async () => {
    const red = counting({ a: 3 });
    const r = await runGate(dir, { ...quiet, runStep: red.runStep });
    expect(r.result).toMatchObject({ ok: false, failed: "a" });
    expect(red.ran.map((s) => s.name)).toEqual(["a"]);
    expect(gateLine(r)).toContain("step 'a' exited 3");
    expect((await runGate(dir, { ...quiet, runStep: counting().runStep })).cached).toBe(true);
  });

  test("the live runner runs the step with its env in the repo root", async () => {
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ steps: [{ name: "env", run: 'test "$X" = 1 && test -f gate.json', env: { X: "1" } }] }));
    git("commit", "-qam", "env");
    expect((await runGate(join(dir), quiet)).result.ok).toBe(true);
  });

  test("a repo with no gate.json is refused by name", async () => {
    git("rm", "-q", "gate.json");
    git("commit", "-qm", "no gate");
    await expect(runGate(dir, quiet)).rejects.toThrow("no gate.json");
  });
});
