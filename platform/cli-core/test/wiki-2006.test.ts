// OB-2006: `ob wiki`, the project wiki. Pages are files in OB_WIKI_DIR; the facts come from a test DB.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { localCheckout, nearestNames, renderFacts, replaceFacts, runWiki, type WikiCtx } from "../../../apps/cli/src/commands/wiki.ts";
import type { Project } from "../../../apps/cli/src/project.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
let tmp: string;
let db: string;

const realHome = process.env.HOME;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-"));
  process.env.HOME = join(tmp, "home"); // so "not found on this machine" never depends on a ~/dev/<slug> here
  process.env.OB_WIKI_DIR = join(tmp, "wiki");
  process.env.OB_REPOS_DIR = join(tmp, "repos");
  db = freshDbPath();
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.OB_WIKI_DIR;
  delete process.env.OB_REPOS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

async function seedProjects(): Promise<void> {
  await runCli(db, ["project", "add", "alpha", "--kind", "side", "--remote", "git@example.com:a/alpha.git", "--key", "AL"]);
  await runCli(db, ["project", "add", "beta", "--kind", "home"]);
}
const page = (slug: string) => join(tmp, "wiki", "projects", `${slug}.md`);

describe("ob wiki refresh", () => {
  test("the facts block carries the stage, and 'not set' when there is none (OB-2103)", async () => {
    await seedProjects();
    await runCli(db, ["project", "edit", "alpha", "--stage", "alpha"]);
    expect((await runCli(db, ["wiki", "refresh"])).code).toBe(0);
    expect(readFileSync(page("alpha"), "utf8")).toContain("- key: AL\n- stage: alpha\n");
    expect(readFileSync(page("beta"), "utf8")).toContain("- stage: not set\n");
    expect((await runCli(db, ["wiki", "check"])).code).toBe(0);
    // a stage changed after the refresh is drift that check reports
    await runCli(db, ["project", "edit", "beta", "--stage", "stable"]);
    expect((await runCli(db, ["wiki", "check"])).code).toBe(1);
  });

  test("creates a page per project with the facts block and an empty Notes section", async () => {
    await seedProjects();
    const r = await runCli(db, ["wiki", "refresh"]);
    expect(r.code).toBe(0);
    const text = readFileSync(page("alpha"), "utf8");
    expect(text).toContain("<!-- ob:facts:start -->");
    expect(text).toContain("- key: AL");
    expect(text).toContain("- remote: git@example.com:a/alpha.git");
    expect(text).toContain("- private agent rules: none");
    expect(text.endsWith("## Notes\n\n")).toBe(true);
    expect(readFileSync(page("beta"), "utf8")).toContain("- key: none");
  });

  test("the committed block has no path, count or date", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    for (const slug of ["alpha", "beta"]) {
      const text = readFileSync(page(slug), "utf8");
      const block = text.slice(text.indexOf("<!-- ob:facts:start -->"), text.indexOf("<!-- ob:facts:end -->"));
      expect(block).not.toContain("/home/");
      expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(block).not.toMatch(/open|closed/i);
    }
  });

  test("is idempotent and leaves text outside the markers byte-identical", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    const edited = readFileSync(page("alpha"), "utf8").replace("## Notes\n\n", "## Notes\n\nDeploys with `wrangler`.\n\n  odd   spacing\t\n");
    writeFileSync(page("alpha"), "intro line above\n" + edited);
    const before = readFileSync(page("alpha"), "utf8");
    const second = await runCli(db, ["wiki", "refresh"]);
    expect(second.out).toContain("unchanged 2");
    expect(readFileSync(page("alpha"), "utf8")).toBe(before);
    // a stale block is rewritten, the notes and intro are kept byte for byte
    writeFileSync(page("alpha"), before.replace("- key: AL", "- key: STALE"));
    await runCli(db, ["wiki", "refresh", "alpha"]);
    expect(readFileSync(page("alpha"), "utf8")).toBe(before);
  });

  test("refuses a page that lost its markers, and an unknown project", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    writeFileSync(page("alpha"), "# alpha\n\nno markers\n");
    const r = await runCli(db, ["wiki", "refresh", "alpha"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("facts:start");
    expect((await runCli(db, ["wiki", "refresh", "nope"])).code).toBe(1);
    expect(readFileSync(page("alpha"), "utf8")).toBe("# alpha\n\nno markers\n");
  });
});

describe("ob wiki check", () => {
  test("exits 1 naming the page after a hand edit, 0 after refresh; topics are ignored", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    mkdirSync(join(tmp, "wiki", "topics"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "topics", "notes.md"), "# no block here\n");
    expect((await runCli(db, ["wiki", "check"])).code).toBe(0);
    writeFileSync(page("beta"), readFileSync(page("beta"), "utf8").replace("- kind: home", "- kind: side"));
    const bad = await runCli(db, ["wiki", "check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("wiki/projects/beta.md");
    expect(bad.out).not.toContain("alpha.md");
    await runCli(db, ["wiki", "refresh"]);
    expect((await runCli(db, ["wiki", "check"])).code).toBe(0);
  });

  test("a second facts block is flagged by check and refused by refresh", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    writeFileSync(page("beta"), `${readFileSync(page("beta"), "utf8")}\n${renderFacts({ id: "beta", name: "beta", kind: "home", git_remote: null, created_at: "", key: null } as Project)}\n`);
    const c = await runCli(db, ["wiki", "check"]);
    expect(c.code).toBe(1);
    expect(c.out).toContain("wiki/projects/beta.md: more than one facts block");
    const r = await runCli(db, ["wiki", "refresh", "beta"]);
    expect(r.code).toBe(1);
    // a stray end marker after a good block is caught too
    await runCli(db, ["wiki", "refresh", "alpha"]);
    writeFileSync(page("alpha"), `${readFileSync(page("alpha"), "utf8")}\n<!-- ob:facts:end -->\n`);
    expect((await runCli(db, ["wiki", "check"])).out).toContain("wiki/projects/alpha.md: more than one facts block or stray marker");
    // show does not splice into such a page: the fresh block, then the file as it is
    const shown = (await runCli(db, ["wiki", "alpha"])).out;
    expect(shown.split("<!-- ob:facts:start -->").length - 1).toBe(2);
  });

  test("refresh goes on past a page it cannot refresh, then names it and exits 1", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    // listProjects orders by kind then name: beta (home) is processed BEFORE alpha (side)
    writeFileSync(page("beta"), "# beta\n\nno markers\n");
    writeFileSync(page("alpha"), readFileSync(page("alpha"), "utf8").replace("- kind: side", "- kind: STALE"));
    const r = await runCli(db, ["wiki", "refresh"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refreshed 1 (alpha)");
    expect(r.err).toContain("wiki/projects/beta.md has no");
    expect(readFileSync(page("alpha"), "utf8")).toContain("- kind: side"); // alpha, after the bad page, was still refreshed
  });

  test("names a project with no page and a page for no project", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    rmSync(page("alpha"));
    writeFileSync(page("ghost"), "# ghost\n");
    const r = await runCli(db, ["wiki", "check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("wiki/projects/alpha.md: missing");
    expect(r.out).toContain("wiki/projects/ghost.md: no such project");
  });
});

describe("ob wiki <name> and list", () => {
  test("lists projects then topics, --json too", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    mkdirSync(join(tmp, "wiki", "topics"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "topics", "ha.md"), "# Home Assistant\n");
    const r = await runCli(db, ["wiki"]);
    expect(r.out.trimEnd().split("\n")).toEqual(["projects:", "  alpha", "  beta", "topics:", "  ha"]);
    expect(JSON.parse((await runCli(db, ["wiki", "list", "--json"])).out)).toEqual({ projects: ["alpha", "beta"], topics: ["ha"] });
  });

  test("a project page prints a live block and the Live section; the file is untouched", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    const a = await runCli(db, ["add", "first", "--project", "alpha", "--priority", "high"]);
    const b = await runCli(db, ["add", "second", "--project", "alpha", "--priority", "low"]);
    await runCli(db, ["add", "third", "--project", "alpha"]);
    const idOf = (o: string) => o.trim().split(/\s+/)[0]!;
    await runCli(db, ["close", idOf(a.out)]);
    await runCli(db, ["close", idOf(b.out)]);
    writeFileSync(page("alpha"), readFileSync(page("alpha"), "utf8").replace("- key: AL", "- key: STALE"));
    const stale = readFileSync(page("alpha"), "utf8");
    const r = await runCli(db, ["wiki", "alpha"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("- key: AL"); // regenerated in the output
    expect(readFileSync(page("alpha"), "utf8")).toBe(stale); // not in the file
    expect(r.out).toContain("## Live (this machine, now)");
    expect(r.out).toContain("- local path: not found on this machine");
    expect(r.out).toContain("- open: 1 (none 1)");
    const closed = r.out.split("- last closed:\n")[1]!.trim().split("\n");
    expect(closed.length).toBe(2);
    expect(closed[0]).toContain("second"); // newest first
    expect(closed[1]).toContain("first");
    const j = JSON.parse((await runCli(db, ["wiki", "alpha", "--json"])).out);
    expect(j.type).toBe("project");
    expect(j.live.open).toBe(1);
  });

  test("a project with no page prints the block, Live and a hint, exit 0", async () => {
    await seedProjects();
    const r = await runCli(db, ["wiki", "beta"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no page yet: run ob wiki refresh beta");
    expect(r.out).toContain("- slug: beta");
    expect(r.out).toContain("## Live");
    expect(existsSync(page("beta"))).toBe(false);
  });

  test("a topic prints as written", async () => {
    await seedProjects();
    mkdirSync(join(tmp, "wiki", "topics"), { recursive: true });
    writeFileSync(join(tmp, "wiki", "topics", "ha.md"), "# Home Assistant\n\nit zigbees\n");
    expect((await runCli(db, ["wiki", "ha"])).out).toContain("it zigbees");
  });

  test("an unknown name exits 1 with the nearest names; a path-like name is refused", async () => {
    await seedProjects();
    const r = await runCli(db, ["wiki", "alp"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nearest: alpha");
    expect((await runCli(db, ["wiki", "../etc"])).code).toBe(2);
    expect((await runCli(db, ["wiki", "a/b"])).code).toBe(2);
  });

  test("an empty AGENTS.md still counts as existing", async () => {
    await seedProjects();
    mkdirSync(join(tmp, "repos", "alpha"), { recursive: true });
    writeFileSync(join(tmp, "repos", "alpha", "AGENTS.md"), "\n");
    await runCli(db, ["wiki", "refresh", "alpha"]);
    expect(readFileSync(page("alpha"), "utf8")).toContain("- private agent rules: yes (repos/alpha/AGENTS.md)");
  });

  test("a page with broken markers still prints the fresh block; an orphan page is readable", async () => {
    await seedProjects();
    mkdirSync(join(tmp, "wiki", "projects"), { recursive: true });
    writeFileSync(page("alpha"), "# alpha\n\nno markers here\n");
    const r = await runCli(db, ["wiki", "alpha"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("- key: AL");
    expect(r.out).toContain("no markers here");
    writeFileSync(page("ghost"), "# ghost\n\nold notes\n");
    const g = await runCli(db, ["wiki", "ghost"]);
    expect(g.code).toBe(0);
    expect(g.out).toContain("old notes");
    expect(g.out).toContain("no such project in the tracker");
  });
});

describe("pure helpers", () => {
  test("nearestNames: substring, else first 3 chars, else all", () => {
    const names = ["alpha", "beta", "alphabet", "hackcove"];
    expect(nearestNames("alph", names)).toEqual(["alpha", "alphabet"]);
    expect(nearestNames("hacxyz", names)).toEqual(["hackcove"]);
    expect(nearestNames("zzz", names)).toEqual(names);
  });

  test("localCheckout ignores the cwd: a mapped or ~/dev git repo, else null", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, "dev", "gamma", ".git"), { recursive: true });
    mkdirSync(join(tmp, "mapped", ".git"), { recursive: true });
    expect(localCheckout({}, "gamma", home)).toBe(join(home, "dev", "gamma"));
    expect(localCheckout({ gamma: join(tmp, "mapped") }, "gamma", home)).toBe(join(tmp, "mapped"));
    expect(localCheckout({ nope: "relative" }, "nope", home)).toBeNull();
    expect(localCheckout({}, "nope", home)).toBeNull();
  });

  test("replaceFacts only touches the span between the markers", () => {
    const p = { id: "x", name: "x", kind: "side", git_remote: null, created_at: "", key: null } as Project;
    const text = `top\n${renderFacts(p)}\nbottom`;
    expect(replaceFacts(text, "<!-- ob:facts:start -->\nnew\n<!-- ob:facts:end -->")).toBe(
      "top\n<!-- ob:facts:start -->\nnew\n<!-- ob:facts:end -->\nbottom",
    );
    expect(replaceFacts("no markers", "x")).toBeNull();
  });

  test("a failed repo_checkouts read keeps the page and says the path is unknown", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: unknown) => void lines.push(String(m));
    try {
      await runWiki({
        args: ["gamma"],
        mode: "human",
        src: {
          projects: async () => [{ id: "gamma", name: "gamma", kind: "side", git_remote: null, created_at: "", key: null, icon: null, display_name: null, stage: null, team_name: null }],
          checkouts: async () => {
            throw new Error("config down");
          },
          tasks: async () => [],
        },
      });
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain("- local path: unknown (repo_checkouts could not be read)");
  });

  test("runWiki reads the facts from any WikiSource (the API client path)", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    try {
      const ctx: WikiCtx = {
        args: ["gamma"],
        mode: "human",
        src: {
          projects: async () => [{ id: "gamma", name: "gamma", kind: "side", git_remote: null, created_at: "", key: "GA", icon: null, display_name: null, stage: null, team_name: null }],
          checkouts: async () => ({}),
          tasks: async () => [
            { id: "1", type: "task", ref: "GA-1", title: "done one", status: "done", priority: "high", closed_at: "2026-01-02T00:00:00Z" },
            { id: "2", type: "task", ref: "GA-2", title: "open one", status: "open", priority: "urgent", closed_at: null },
          ],
        },
      };
      await runWiki(ctx);
    } finally {
      console.log = orig;
    }
    const text = out.join("\n");
    expect(text).toContain("- open: 1 (urgent 1)");
    expect(text).toContain("GA-1 done one");
  });
});

describe("ob wiki over the API (no database on this machine)", () => {
  test("the facts come from projects, config and items, and the pages are the local files", async () => {
    await seedProjects();
    await runCli(db, ["wiki", "refresh"]);
    const BASE = "https://ob.example.test";
    const answers: Record<string, unknown> = {
      "GET /projects": {
        projects: [{ id: "alpha", name: "alpha", kind: "side", git_remote: "git@example.com:a/alpha.git", created_at: "", key: "AL" }],
      },
      "GET /config": { config: [{ key: "repo_checkouts", value: JSON.stringify({ alpha: join(tmp, "nowhere") }) }] },
      "GET /items": {
        focus_project: null,
        items: [
          { id: "1", type: "task", ref: "AL-1", title: "open one", status: "open", priority: "high", closed_at: null },
          { id: "2", type: "task", ref: null, title: "open none", status: "open", priority: null, closed_at: null },
          { id: "3", type: "task", ref: "AL-3", title: "old close", status: "done", priority: "low", closed_at: "2026-01-01T00:00:00Z" },
          { id: "5", type: "reference", ref: "AL-5", title: "a doc", status: "open", priority: "urgent", closed_at: null },
          { id: "4", type: "learning", ref: "AL-4", title: "new close", status: "done", priority: "low", closed_at: "2026-02-01T00:00:00Z" },
        ],
      },
    };
    const urls: string[] = [];
    const transport = async (req: { url: string; method: string }) => {
      urls.push(req.url);
      const key = `${req.method} ${req.url.slice(`${BASE}/api/v1`.length).split("?")[0]}`;
      return key in answers
        ? { status: 200, body: JSON.stringify(answers[key]) }
        : { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: key } }) };
    };
    const r = await runCli(db, ["wiki", "alpha"], { api: { base: BASE, token: "t", transport } } as never);
    expect(r.code).toBe(0);
    expect(r.out).toContain("- key: AL");
    expect(r.out).toContain("- local path: not found on this machine");
    expect(r.out).toContain("- open: 2 (high 1, none 1)");
    expect(r.out.split("- last closed:\n")[1]!.trim().split("\n")[0]).toContain("AL-4 new close");
    expect(urls.some((u) => u.includes("project=alpha") && !u.includes("type="))).toBe(true);
    // check over the API: beta is a page for no project there
    const c = await runCli(db, ["wiki", "check"], { api: { base: BASE, token: "t", transport } } as never);
    expect(c.code).toBe(1);
    expect(c.out).toContain("wiki/projects/beta.md: no such project");
  });
});

describe("the seeded wiki", () => {
});
