// ob 1803: a repo's private agent rules + opencode wiring are served from omnislash's `repos/<project>/`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installOpencodeWiring,
  readProjectRules,
  rulesBlock,
} from "../../../apps/cli/src/repo-private.ts";
import { spinoffAskFor } from "../src/commands/spinoff.ts";
import { planExecution } from "../../../apps/cli/src/remote.ts";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { registerProject, updateProject } from "../../../apps/cli/src/project.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-private-"));
});
afterEach(() => {
  delete process.env.OB_REPOS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

function seed(project: string, rules: string | null, wiring: Record<string, string> = {}): void {
  process.env.OB_REPOS_DIR = join(tmp, "repos");
  const dir = join(tmp, "repos", project);
  mkdirSync(dir, { recursive: true });
  if (rules !== null) writeFileSync(join(dir, "AGENTS.md"), rules);
  for (const [rel, body] of Object.entries(wiring)) {
    mkdirSync(join(dir, "opencode", rel, ".."), { recursive: true });
    writeFileSync(join(dir, "opencode", rel), body);
  }
}

describe("readProjectRules / rulesBlock", () => {
  test("a project without rules reads null and adds nothing", () => {
    seed("empty", null);
    expect(readProjectRules("empty")).toBeNull();
    expect(readProjectRules("nope")).toBeNull();
    expect(rulesBlock("nope")).toBe("");
  });

  test("a name that is not a plain slug cannot reach outside repos/", () => {
    seed("p", "x");
    writeFileSync(join(tmp, "secret"), "nope");
    expect(readProjectRules("../")).toBeNull();
    expect(readProjectRules("a/b")).toBeNull();
  });
});

describe("the launch prompt (1803)", () => {
  test("a launch from a worktree still finds the repo's rules", async () => {
    seed("hackcove", "## Tracker\nprivate");
    mkdirSync(join(tmp, "hackcove", ".git"), { recursive: true });
    const worktree = join(tmp, "hackcove.9");
    mkdirSync(worktree);
    const ask = await spinoffAskFor(null, worktree, "9", { brief: "do the thing" });
    expect(ask).toContain("## Tracker\nprivate");
  });

  test("the project is the repo slug, not the basename of whatever checkout it resolved to", async () => {
    seed("hackcove", "## Tracker\nprivate");
    const ask = await spinoffAskFor(null, "/home/owner/dev/hackcove-2", "9", { brief: "b", project: "hackcove" });
    expect(ask).toContain("## Tracker\nprivate");
  });

  test("a repo with no rules and no stage source gets the prompt it always got", async () => {
    const ask = await spinoffAskFor(null, "/home/owner/dev/omnislash", "9", { brief: "do the thing" });
    expect(ask).toBe("do the thing");
  });
});

// OB-2103: the stage line rides at the top of the block, for every repo, AGENTS.md or not.
describe("the stage in the launch prompt (OB-2103)", () => {
  const ALPHA = "Stage: alpha (anything may break, no compatibility work owed)";
  const BETA = "Stage: not set, treat as beta (breaks allowed, each flagged with ! and a Breaking: line)";

  test("rulesBlock puts the stage line first, with rules or without", () => {
    seed("toggleslash", null);
    seed("hackcove", "## Tracker\nprivate");
    const bare = rulesBlock("toggleslash", "alpha");
    expect(bare).toBe(`\n\n---\n\n# Repo-private rules for toggleslash (ob project rules toggleslash)\n\n${ALPHA}\n`);
    const withRules = rulesBlock("hackcove", "alpha");
    expect(withRules).toContain(`(ob project rules hackcove)\n\n${ALPHA}\n\n## Tracker\nprivate\n`);
    expect(rulesBlock("toggleslash", null)).toContain(BETA);
    // a stage nobody could read leaves the block as it was: rules alone, or nothing
    expect(rulesBlock("toggleslash")).toBe("");
    expect(rulesBlock("hackcove")).not.toContain("Stage:");
  });

  test("a hand-written stage that is not one of the five reads as not set", () => {
    expect(rulesBlock("nope", "gamma")).toContain(BETA);
  });

  test("spinoffAskFor reads the stage from the store, or the API read with no store", async () => {
    const db = freshDb();
    await registerProject(db, { name: "toggleslash", kind: "side" });
    await updateProject(db, "toggleslash", { stage: "alpha" });
    expect(await spinoffAskFor(db, "/nowhere/toggleslash", "TS-1", { brief: "b" })).toContain(ALPHA);
    // a project the store has no row for is not set
    expect(await spinoffAskFor(db, "/nowhere/omnislash", "OB-1", { brief: "b" })).toBe(`b${rulesBlock("omnislash", null)}`);
    const viaApi = await spinoffAskFor(null, "/nowhere/omnislash", "OB-1", { brief: "b", readStage: async (slug) => (slug === "omnislash" ? "stable" : null) });
    expect(viaApi).toContain("Stage: stable (no break on the current version; a break waits for the next major)");
    // a failed read is a warning, and the prompt goes without the line
    const failed = await spinoffAskFor(null, "/nowhere/omnislash", "OB-1", { brief: "b", readStage: async () => { throw new Error("down"); } });
    expect(failed).toBe("b");
  });
});

describe("installOpencodeWiring", () => {
  const wiring = { "SOUL.md": "soul", "plugins/ob-x.ts": "plugin" };

  test("a checkout with no .opencode gets all of it, and git stays clean", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    mkdirSync(dir);
    Bun.spawnSync(["git", "init", "-q", dir]);
    const res = installOpencodeWiring("proj", dir);
    expect(res.installed.sort()).toEqual(["SOUL.md", "plugins/ob-x.ts"]);
    expect(res.excludeFailed).toBe(false);
    expect(readFileSync(join(dir, ".opencode/plugins/ob-x.ts"), "utf8")).toBe("plugin");
    const status = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]).stdout.toString();
    expect(status).toBe("");
  });

  test("a repo that still commits its own file keeps it", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(join(dir, ".opencode/SOUL.md"), "theirs");
    Bun.spawnSync(["git", "-C", dir, "add", ".opencode/SOUL.md"]); // tracked = the repo's own
    const res = installOpencodeWiring("proj", dir);
    expect(res.kept).toEqual(["SOUL.md"]);
    expect(res.installed).toEqual(["plugins/ob-x.ts"]);
    expect(res.excludeFailed).toBe(false);
    expect(readFileSync(join(dir, ".opencode/SOUL.md"), "utf8")).toBe("theirs");
  });

  test("ob's own untracked copy is refreshed when the source changes", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    mkdirSync(dir);
    Bun.spawnSync(["git", "init", "-q", dir]);
    installOpencodeWiring("proj", dir);
    writeFileSync(join(tmp, "repos/proj/opencode/SOUL.md"), "soul v2");
    const res = installOpencodeWiring("proj", dir);
    expect(res.kept).toEqual([]);
    expect(readFileSync(join(dir, ".opencode/SOUL.md"), "utf8")).toBe("soul v2");
    expect(Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]).stdout.toString()).toBe("");
  });

  test("not a git checkout: the files still land, and the exclude failure is reported", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    mkdirSync(dir);
    const res = installOpencodeWiring("proj", dir);
    expect(res.excludeFailed).toBe(true);
    expect(readFileSync(join(dir, ".opencode/plugins/ob-x.ts"), "utf8")).toBe("plugin");
  });

  test("a project with no wiring installs nothing and creates no .opencode", () => {
    seed("proj", "r");
    const dir = join(tmp, "checkout");
    mkdirSync(dir);
    expect(installOpencodeWiring("proj", dir)).toEqual({ installed: [], kept: [], excludeFailed: false });
    expect(existsSync(join(dir, ".opencode"))).toBe(false);
  });

  test("--dir in a subdirectory excludes the files from the checkout root, so git stays clean", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    const sub = join(dir, "apps/x");
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", dir]);
    const res = installOpencodeWiring("proj", sub);
    expect(res.excludeFailed).toBe(false);
    expect(readFileSync(join(dir, ".git/info/exclude"), "utf8")).toContain("/apps/x/.opencode/SOUL.md");
    expect(Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]).stdout.toString()).toBe("");
  });

  test("a second run does not duplicate the exclude lines", () => {
    seed("proj", "r", wiring);
    const dir = join(tmp, "checkout");
    mkdirSync(dir);
    Bun.spawnSync(["git", "init", "-q", dir]);
    installOpencodeWiring("proj", dir);
    installOpencodeWiring("proj", dir);
    const exclude = readFileSync(join(dir, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.opencode/SOUL.md")).toHaveLength(1);
  });
});

describe("ob project rules / wire (1803)", () => {
  // OB-2103: rules opens with the stage line; a fresh store has no row for the project, which reads as not set.
  const BETA = "Stage: not set, treat as beta (breaks allowed, each flagged with ! and a Breaking: line)";

  test("rules prints the stage line then the file; json wraps both", async () => {
    seed("proj", "# rules\nbe good\n");
    const r = await runCli(freshDbPath(), ["project", "rules", "proj"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${BETA}\n\n# rules\nbe good\n`);
    const j = await runCli(freshDbPath(), ["project", "rules", "proj", "--json"]);
    expect(JSON.parse(j.out)).toEqual({ project: "proj", stage: null, stage_line: BETA, rules: "# rules\nbe good\n" });
  });

  test("a project with no rules prints only the stage line and exits 0; json says rules null", async () => {
    seed("proj", null);
    const r = await runCli(freshDbPath(), ["project", "rules", "omnislash"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${BETA}\n`);
    const j = await runCli(freshDbPath(), ["project", "rules", "omnislash", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toEqual({ project: "omnislash", stage: null, stage_line: BETA, rules: null });
  });

  test("on an API client the rules are read here and only the stage crosses the wire (one GET /projects)", async () => {
    seed("proj", "local rules");
    const calls: string[] = [];
    const transport = async (req: { url: string; method: string }) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      const body = { projects: [{ id: "proj", name: "proj", kind: "side", git_remote: null, created_at: "", key: null, icon: null, display_name: null, stage: "rc" }] };
      return { status: 200, body: JSON.stringify(body) };
    };
    const r = await runCli(freshDbPath(), ["project", "rules", "proj"], {
      api: { base: "http://api.invalid", transport, token: "t" },
    } as never);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Stage: rc (very cautious: a break needs an impact note and the owner's yes before dispatch)\n\nlocal rules\n`);
    expect(calls).toEqual(["GET /api/ob/projects"]);
  });

  test("on an API client whose read fails, the rules still print and stderr says why", async () => {
    seed("proj", "local rules");
    const transport = async () => {
      throw new Error("the tracker is down");
    };
    const r = await runCli(freshDbPath(), ["project", "rules", "proj"], {
      api: { base: "http://api.invalid", transport, token: "t" },
    } as never);
    expect(r.code).toBe(0);
    expect(r.out).toBe("local rules\n");
    expect(r.err).toContain("could not read proj's stage");
  });

  test("a store that cannot be opened still prints the rules, and stderr says why the stage is missing", async () => {
    seed("proj", "local rules");
    const prev = process.env.OMNISLASH_DB_CREATE;
    process.env.OMNISLASH_DB_CREATE = "0"; // openDb refuses to create the missing file (198)
    try {
      const r = await runCli(join(tmp, "no-such.sqlite"), ["project", "rules", "proj"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("local rules\n");
      expect(r.err).toContain("could not read proj's stage");
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_DB_CREATE;
      else process.env.OMNISLASH_DB_CREATE = prev;
    }
  });

  test("over an ssh remote_host the stage is not read: the rules alone, nothing on stderr", async () => {
    seed("proj", "local rules");
    const db = freshDbPath();
    expect((await runCli(db, ["config", "set", "remote_host", "ob-host"])).code).toBe(0);
    const r = await runCli(db, ["project", "rules", "proj"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("local rules\n");
    expect(r.err).not.toContain("stage");
  });

  test("planExecution gives rules/wire no database, with or without a remote host; other subs are unchanged", () => {
    for (const host of [null, "ob-host"]) {
      for (const sub of ["rules", "wire"]) {
        expect(planExecution({ command: "project", args: [sub, "x"], flags: {}, host }).mode).toBe("nodb");
      }
    }
    expect(planExecution({ command: "project", args: ["list"], flags: {}, host: null }).mode).toBe("local");
  });
});
