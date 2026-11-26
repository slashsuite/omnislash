// OS-217: `ob project wire` builds a checkout's `.opencode/` from the public repo alone (no `repos/`), and a
// private `repos/<project>/opencode/` file still wins over the built one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtWiring, installOpencodeWiring, OB_PLUGINS, opencodeSourceDir } from "../../../apps/cli/src/repo-private.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { linkedWorktreeWarning } from "../../../apps/cli/src/commands/admin.ts";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "project-wire-"));
  process.env.OB_REPOS_DIR = join(tmp, "repos"); // no repos/ at all: a fresh public clone
  dir = join(tmp, "checkout");
  mkdirSync(dir);
  Bun.spawnSync(["git", "init", "-q", dir]);
});
afterEach(() => {
  delete process.env.OB_REPOS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

const ALL = [
  "SOUL.md",
  "agents/architect.md",
  "architect-tui.sh",
  "commands/ob-architect.md",
  ...OB_PLUGINS.map((id) => `plugins/${id}.ts`),
].sort();

describe("builtWiring", () => {
  test("every plugin shim re-exports a shipped plugin that exists", () => {
    for (const f of builtWiring("proj").filter((f) => f.rel.startsWith("plugins/"))) {
      const target = f.content.match(/from "(.+)";/)?.[1];
      expect(target).toBe(resolve(opencodeSourceDir(), f.rel));
      expect(existsSync(target as string)).toBe(true);
    }
  });

  test("the templates carry the project name and no placeholder", () => {
    for (const f of builtWiring("hackcove").filter((f) => f.seed)) {
      expect(f.content).not.toContain("{{project}}");
    }
    expect(builtWiring("hackcove").find((f) => f.rel === "agents/architect.md")?.content).toContain("hackcove");
  });
});

describe("installOpencodeWiring with built (ob project wire)", () => {
  test("a fresh clone with no repos/ gets the plugins, launcher and starting points, and git stays clean", () => {
    const res = installOpencodeWiring("proj", dir, { built: true });
    expect(res.installed.sort()).toEqual(ALL);
    expect(res.excludeFailed).toBe(false);
    expect(statSync(join(dir, ".opencode/architect-tui.sh")).mode & 0o111).not.toBe(0);
    expect(Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]).stdout.toString()).toBe("");
  });

  test("a spinoff launch (no built) still installs nothing without repos/", () => {
    expect(installOpencodeWiring("proj", dir)).toEqual({ installed: [], kept: [], excludeFailed: false });
    expect(existsSync(join(dir, ".opencode"))).toBe(false);
  });

  test("an edited SOUL.md or agent survives a second wire; plugins and launcher are refreshed", () => {
    installOpencodeWiring("proj", dir, { built: true });
    writeFileSync(join(dir, ".opencode/SOUL.md"), "mine");
    writeFileSync(join(dir, ".opencode/plugins/ob-soul.ts"), "stale");
    const res = installOpencodeWiring("proj", dir, { built: true });
    expect(res.kept.sort()).toEqual(["SOUL.md", "agents/architect.md", "commands/ob-architect.md"]);
    expect(readFileSync(join(dir, ".opencode/SOUL.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, ".opencode/plugins/ob-soul.ts"), "utf8")).toContain("export { default }");
    const exclude = readFileSync(join(dir, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.opencode/architect-tui.sh")).toHaveLength(1);
  });

  test("a private repos/<project>/opencode file replaces the built one of the same path", () => {
    mkdirSync(join(tmp, "repos/proj/opencode/agents"), { recursive: true });
    writeFileSync(join(tmp, "repos/proj/opencode/agents/architect.md"), "private agent");
    writeFileSync(join(tmp, "repos/proj/opencode/extra.md"), "extra");
    const res = installOpencodeWiring("proj", dir, { built: true });
    expect(res.installed.sort()).toEqual([...ALL, "extra.md"].sort());
    expect(readFileSync(join(dir, ".opencode/agents/architect.md"), "utf8")).toBe("private agent");
  });

  test("a bad project name builds nothing", () => {
    expect(installOpencodeWiring("../x", dir, { built: true }).installed).toEqual([]);
  });
});

describe("ob project wire", () => {
  test("prints what it installed in a fresh clone", async () => {
    const r = await runCli(freshDbPath(), ["project", "wire", "proj", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`proj: installed ${ALL.length}, kept 0`);
    expect(existsSync(join(dir, ".opencode/plugins/ob-heartbeat.ts"))).toBe(true);
  });
});

// OS-246: the linked-worktree warning `ob project wire` prints after installing.
describe("linkedWorktreeWarning", () => {
  test("a linked worktree (.git is a file) is warned about, naming the checkout", () => {
    writeFileSync(join(tmp, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const w = linkedWorktreeWarning(tmp);
    expect(w).toContain(`the plugins point into ${tmp}, a linked worktree`);
    expect(w).toContain("re-run 'ob project wire' from the main checkout");
  });

  test("a main checkout (.git is a directory) and no checkout at all are not", () => {
    expect(linkedWorktreeWarning(dir)).toBeNull();
    expect(linkedWorktreeWarning(join(tmp, "nowhere"))).toBeNull();
  });
});
