// OB-2007: the incident log. `ob wiki log` / `ob wiki incidents`, files in OB_WIKI_DIR (or the wiki/ of the checkout the cwd is in).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { incidentProblems, parseIncidents, wikiDir } from "../../../apps/cli/src/commands/wiki.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
let tmp: string;
let db: string;
const realHome = process.env.HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-inc-"));
  process.env.HOME = join(tmp, "home");
  process.env.OB_WIKI_DIR = join(tmp, "wiki");
  process.env.OB_REPOS_DIR = join(tmp, "repos");
  db = freshDbPath();
});
afterEach(() => {
  delete process.env.OB_WIKI_DIR;
  delete process.env.OB_REPOS_DIR;
  // OS-280: a HOME left pointing at the removed tmp dir broke later files that spawn with cwd: homedir().
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
});

const logFile = (area: string) => join(tmp, "wiki", "incidents", `${area}.md`);

describe("ob wiki log", () => {
  test("creates the area file with its heading and the entry, defaults cause and fix", async () => {
    const r = await runCli(db, ["wiki", "log", "network", "test", "--what", "x", "--date", "2026-11-14"]);
    expect(r.code).toBe(0);
    expect(readFileSync(logFile("network"), "utf8")).toBe(
      "# Incidents: network\n\n## 2026-11-14: test\n- what: x\n- cause: unknown\n- fix: open\n- tickets: none\n",
    );
  });

  test("a second entry goes above the first, with its cause, fix and tickets", async () => {
    await runCli(db, ["wiki", "log", "deploy", "first", "--what", "a", "--date", "2026-11-01"]);
    const r = await runCli(db, [
      "wiki", "log", "deploy", "second", "--what", "b", "--cause", "bad csv", "--fix", "reimported", "--ticket", "OB-12,OB-34", "--date", "2026-11-02",
    ]);
    expect(r.code).toBe(0);
    const text = readFileSync(logFile("deploy"), "utf8");
    expect(text.indexOf("## 2026-11-02: second")).toBeLessThan(text.indexOf("## 2026-11-01: first"));
    expect(text.startsWith("# Incidents: deploy\n\n## 2026-11-02: second\n")).toBe(true);
    expect(text).toContain("- cause: bad csv\n- fix: reimported\n- tickets: OB-12, OB-34\n");
    expect(parseIncidents(text).map((e) => e.date)).toEqual(["2026-11-02", "2026-11-01"]);
  });

  test("the date defaults to today", async () => {
    await runCli(db, ["wiki", "log", "ops", "t", "--what", "w"]);
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    expect(readFileSync(logFile("ops"), "utf8")).toContain(`## ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}: t`);
  });

  test("an unknown area is refused naming the nearest, writes nothing; --new-area accepts it", async () => {
    const r = await runCli(db, ["wiki", "log", "homeassitant", "t", "--what", "w"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("home-assistant");
    expect(r.err).toContain("--new-area");
    expect(existsSync(join(tmp, "wiki", "incidents"))).toBe(false);
    const ok = await runCli(db, ["wiki", "log", "homeassitant", "t", "--what", "w", "--new-area"]);
    expect(ok.code).toBe(0);
    expect(existsSync(logFile("homeassitant"))).toBe(true);
    // once it has a file it needs no flag
    expect((await runCli(db, ["wiki", "log", "homeassitant", "again", "--what", "w"])).code).toBe(0);
  });

  test("usage errors write nothing", async () => {
    for (const args of [
      ["wiki", "log", "network", "t"], // no --what
      ["wiki", "log", "network", "--what", "w"], // no title
      ["wiki", "log", "network", "t", "--what", "w", "--date", "2026-13-40"],
      ["wiki", "log", "network", "t", "--what", "w", "--ticket", "nope"],
      ["wiki", "log", "../etc", "t", "--what", "w", "--new-area"],
    ]) {
      expect((await runCli(db, args)).code).not.toBe(0);
    }
    expect(existsSync(join(tmp, "wiki", "incidents"))).toBe(false);
  });

  test("keeps a multi-line value on one line and ignores a hand-written preamble", async () => {
    mkdirSync(join(tmp, "wiki", "incidents"), { recursive: true });
    writeFileSync(logFile("daemon"), "# Incidents: daemon\n\nNotes by hand.\n\n## 2026-01-01: old\n- what: o\n");
    await runCli(db, ["wiki", "log", "daemon", "new", "--what", "line one\nline two", "--date", "2026-02-02"]);
    const text = readFileSync(logFile("daemon"), "utf8");
    expect(text).toContain("Notes by hand.\n\n## 2026-02-02: new\n- what: line one line two\n");
    expect(text.indexOf("2026-02-02")).toBeLessThan(text.indexOf("2026-01-01"));
  });
});

describe("ob wiki log: title and order", () => {
  test("an unquoted multi-word title is joined, not cut to its first word", async () => {
    await runCli(db, ["wiki", "log", "network", "Router", "rebooted", "twice", "--what", "w", "--date", "2026-11-01"]);
    expect(readFileSync(logFile("network"), "utf8")).toContain("## 2026-11-01: Router rebooted twice\n");
  });

  test("an existing but empty file gets the area heading", async () => {
    mkdirSync(join(tmp, "wiki", "incidents"), { recursive: true });
    writeFileSync(logFile("deploy"), "");
    await runCli(db, ["wiki", "log", "deploy", "t", "--what", "w", "--date", "2026-11-01"]);
    expect(readFileSync(logFile("deploy"), "utf8").startsWith("# Incidents: deploy\n\n## 2026-11-01: t\n")).toBe(true);
  });

  test("an older --date goes below newer entries, a same-day one above its peer", async () => {
    for (const [t, d] of [["mid", "2026-11-05"], ["new", "2026-11-09"], ["old", "2026-11-01"], ["mid2", "2026-11-05"]]) {
      await runCli(db, ["wiki", "log", "ops", t!, "--what", "w", "--date", d!]);
    }
    expect(parseIncidents(readFileSync(logFile("ops"), "utf8")).map((e) => e.title)).toEqual(["new", "mid2", "mid", "old"]);
  });
});

describe("ob wiki incidents", () => {
  test("lists each area with its count and latest entry, and prints one area", async () => {
    await runCli(db, ["wiki", "log", "network", "old", "--what", "w", "--date", "2026-10-01"]);
    await runCli(db, ["wiki", "log", "network", "router reset", "--what", "w", "--cause", "c", "--fix", "f", "--ticket", "OB-9", "--date", "2026-11-02"]);
    const list = await runCli(db, ["wiki", "incidents"]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/network\s+2 entries\s+latest 2026-11-02: router reset/);
    expect(list.out).toMatch(/deploy\s+0 entries/);
    const one = await runCli(db, ["wiki", "incidents", "network"]);
    expect(one.out).toContain("## 2026-11-02: router reset");
    expect(one.out).toContain("- cause: c");
    expect(one.out).toContain("- tickets: OB-9");
    const json = JSON.parse((await runCli(db, ["wiki", "incidents", "--json"])).out);
    expect(json.find((r: { area: string }) => r.area === "network")).toMatchObject({ entries: 2, latest: { date: "2026-11-02" } });
  });

  test("a starter area with no file says so; an unknown one names the nearest", async () => {
    const none = await runCli(db, ["wiki", "incidents", "deploy"]);
    expect(none.code).toBe(0);
    expect(none.out).toContain("no incidents logged for deploy yet");
    const bad = await runCli(db, ["wiki", "incidents", "netwrk"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("network");
  });
});

describe("ob wiki check on incident logs", () => {
  test("flags a malformed entry, passes a good one", async () => {
    await runCli(db, ["wiki", "log", "ops", "fine", "--what", "w"]);
    expect((await runCli(db, ["wiki", "check"])).code).toBe(0);
    writeFileSync(logFile("ops"), `${readFileSync(logFile("ops"), "utf8")}\n## no date here\n- what: w\n\n## 2026-01-01: no what\n- cause: c\n`);
    const bad = await runCli(db, ["wiki", "check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("wiki/incidents/ops.md");
    expect(bad.out).toContain("no date here");
    expect(bad.out).toContain("no '- what:' line");
    expect(incidentProblems("## 2026-01-01: ok\n- what: x\n")).toEqual([]);
    // a calendar date that does not exist is malformed; a `what` that runs onto the next line is fine
    expect(incidentProblems("## 2026-02-30: bad\n- what: x\n")).toHaveLength(1);
    expect(incidentProblems("## 2026-01-01: ok\n- what:\n  router crashed\n- cause: c\n")).toEqual([]);
    expect(incidentProblems("## 2026-01-01: empty\n- what:\n- cause: c\n")).toHaveLength(1);
    expect(incidentProblems("## 2026-01-01: stray\n- what:\nnot indented\n")).toHaveLength(1);
  });
});

describe("ob wiki <project> incidents line", () => {
  test("shows the incidents line only when the project's log exists", async () => {
    await runCli(db, ["project", "add", "deploy", "--kind", "side"]);
    expect((await runCli(db, ["wiki", "deploy"])).out).not.toContain("- incidents:");
    await runCli(db, ["wiki", "log", "deploy", "csv broke", "--what", "w", "--date", "2026-11-03"]);
    const out = (await runCli(db, ["wiki", "deploy"])).out;
    expect(out).toContain("- incidents: 1, latest 2026-11-03: csv broke (ob wiki incidents deploy)");
    const json = JSON.parse((await runCli(db, ["wiki", "deploy", "--json"])).out);
    expect(json.live.incidents).toMatchObject({ entries: 1 });
    // an existing file with no entries yet still shows the line
    writeFileSync(logFile("deploy"), "# Incidents: deploy\n");
    expect((await runCli(db, ["wiki", "deploy"])).out).toContain("- incidents: 0 (ob wiki incidents deploy)");
  });
});

describe("which checkout is written", () => {
  const cwd0 = process.cwd();
  afterEach(() => process.chdir(cwd0));

  function fakeOmnislash(root: string): void {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "wiki"), { recursive: true });
    writeFileSync(join(root, "wiki", "README.md"), "# wiki\n");
    mkdirSync(join(root, "apps", "cli", "src", "commands"), { recursive: true });
    writeFileSync(join(root, "apps", "cli", "src", "commands", "wiki.ts"), "");
  }

  test("wikiDir() is the wiki of the acme checkout containing the cwd", () => {
    delete process.env.OB_WIKI_DIR;
    const root = join(tmp, "worktree");
    fakeOmnislash(root);
    mkdirSync(join(root, "apps", "cli"), { recursive: true });
    process.chdir(join(root, "apps", "cli"));
    expect(wikiDir()).toBe(join(realpathSync(root), "wiki"));
  });

  test("a git repo that is not acme, or no repo, falls back to the wiki next to the source", () => {
    delete process.env.OB_WIKI_DIR;
    const other = join(tmp, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "wiki"), { recursive: true }); // OS-133: a wiki/ of its own takes only `wiki log`, never the reads
    process.chdir(other);
    expect(wikiDir()).toBe(join(REPO, "wiki"));
  });

  // OS-133: the core runs from omnislash, but an entry logged from omnibus belongs in omnibus's wiki.
  test("ob wiki log from a checkout with wiki/ writes that checkout's log, whatever checkout the core runs from", async () => {
    delete process.env.OB_WIKI_DIR;
    const omnibus = join(tmp, "omnibus");
    mkdirSync(join(omnibus, ".git"), { recursive: true });
    mkdirSync(join(omnibus, "wiki"), { recursive: true }); // no README, no ob source: any checkout with a wiki counts
    mkdirSync(join(omnibus, "apps"), { recursive: true });
    process.chdir(join(omnibus, "apps"));
    const before = existsSync(join(REPO, "wiki", "incidents", "ops.md")) ? readFileSync(join(REPO, "wiki", "incidents", "ops.md"), "utf8") : null;
    const r = await runCli(db, ["wiki", "log", "ops", "sentinel entry", "--what", "w", "--date", "2026-11-21"]);
    expect(r.code).toBe(0);
    const file = join(realpathSync(omnibus), "wiki", "incidents", "ops.md");
    expect(readFileSync(file, "utf8")).toContain("## 2026-11-21: sentinel entry\n");
    expect(r.out).toContain(file);
    // the checkout the core runs from is untouched
    const after = existsSync(join(REPO, "wiki", "incidents", "ops.md")) ? readFileSync(join(REPO, "wiki", "incidents", "ops.md"), "utf8") : null;
    expect(after).toBe(before);
  });

  test("ob wiki log outside any checkout with wiki/ refuses by name and writes nothing", async () => {
    delete process.env.OB_WIKI_DIR;
    const sourceLog = join(REPO, "wiki", "incidents", "ops.md");
    const before = existsSync(sourceLog) ? readFileSync(sourceLog, "utf8") : null;
    // a git checkout with no wiki/
    const bare = join(tmp, "nowiki");
    mkdirSync(join(bare, ".git"), { recursive: true });
    process.chdir(bare);
    const inRepo = await runCli(db, ["wiki", "log", "ops", "t", "--what", "w"]);
    expect(inRepo.code).toBe(1);
    expect(inRepo.err).toContain("ob wiki log writes into the checkout you stand in");
    expect(inRepo.err).toContain(`${realpathSync(bare)} has no wiki/`);
    expect(existsSync(join(bare, "wiki"))).toBe(false);
    // no git checkout at all
    const loose = join(tmp, "loose");
    mkdirSync(loose, { recursive: true });
    process.chdir(loose);
    const outside = await runCli(db, ["wiki", "log", "ops", "t", "--what", "w"]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("is in no git checkout");
    expect(existsSync(join(loose, "wiki"))).toBe(false);
    const after = existsSync(sourceLog) ? readFileSync(sourceLog, "utf8") : null;
    expect(after).toBe(before);
  });

});
