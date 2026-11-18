import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { WORK_TAGS, isWorkTag } from "../../../apps/cli/src/work-tags.ts";

async function showJson(dbPath: string, id: string) {
  const r = await runCli(dbPath, ["show", id, "--json"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

describe("work-tags vocabulary", () => {
  test("canonical list + isWorkTag advisory check", () => {
    expect(WORK_TAGS).toContain("frontend");
    expect(WORK_TAGS).toContain("based-off-acs");
    expect(WORK_TAGS.length).toBe(9);
    expect(isWorkTag("rework")).toBe(true);
    expect(isWorkTag("REWORK")).toBe(true);
    expect(isWorkTag("not-a-work-tag")).toBe(false);
  });
});

describe("flat tags — applied, never rejected", () => {
  test("ob tag applies canonical + free-form tags (no rejection)", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "proj", "--kind", "side"]);
    const add = await runCli(db, ["add", "a task", "--project", "proj", "-q"]);
    const id = add.out.trim();

    const r = await runCli(db, ["tag", id, "frontend", "rework", "totally-free-form"]);
    expect(r.code).toBe(0);

    const shown = await showJson(db, id);
    expect(shown.tags).toEqual(["frontend", "rework", "totally-free-form"].sort());
  });

  test("ob add --tag accepts canonical + free-form", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "proj", "--kind", "side"]);
    const add = await runCli(db, [
      "add",
      "b task",
      "--project",
      "proj",
      "--tag",
      "backend",
      "--tag",
      "some-adhoc-tag",
      "-q",
    ]);
    expect(add.code).toBe(0);
    const shown = await showJson(db, add.out.trim());
    expect(shown.tags).toEqual(["backend", "some-adhoc-tag"].sort());
  });
});

describe("--repo records tags + repo together (headline command)", () => {
  test("ob tag <id> frontend rework --repo cue-frontend sets tags AND project, creating it", async () => {
    const db = freshDbPath();
    // linear_ref-style item; no project yet
    const add = await runCli(db, ["add", "CUE ticket", "--type", "linear_ref", "--project", "placeholder", "-q"]);
    const id = add.out.trim();

    const r = await runCli(db, ["tag", id, "frontend", "rework", "--repo", "cue-frontend"]);
    expect(r.code).toBe(0);

    const shown = await showJson(db, id);
    expect(shown.tags).toEqual(["frontend", "rework"].sort());
    expect(shown.project).toBe("cue-frontend");

    // project was created
    const projects = await runCli(db, ["project", "list", "--json"]);
    expect(projects.out).toContain("cue-frontend");
  });
});

describe("--repo on add / edit sets the project", () => {
  test("ob add --repo creates + assigns the project", async () => {
    const db = freshDbPath();
    const add = await runCli(db, ["add", "task", "--repo", "my-repo", "-q"]);
    expect(add.code).toBe(0);
    const shown = await showJson(db, add.out.trim());
    expect(shown.project).toBe("my-repo");
  });

  test("ob edit --repo reassigns the project", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "orig", "--kind", "side"]);
    const add = await runCli(db, ["add", "task", "--project", "orig", "-q"]);
    const id = add.out.trim();
    const e = await runCli(db, ["edit", id, "--repo", "moved-repo"]);
    expect(e.code).toBe(0);
    const shown = await showJson(db, id);
    expect(shown.project).toBe("moved-repo");
  });

  test("--repo wins when both --repo and --project are given and differ", async () => {
    const db = freshDbPath();
    const add = await runCli(db, ["add", "task", "--project", "loser", "--repo", "winner", "-q"]);
    const shown = await showJson(db, add.out.trim());
    expect(shown.project).toBe("winner");
  });
});

describe("git-remote inference still works when --repo/--project omitted", () => {
  test("cwd git remote infers the project", async () => {
    const db = freshDbPath();
    const dir = mkdtempSync(join(tmpdir(), "ob-worktag-git-"));
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin git@github.com:owner/acme.git", { cwd: dir });
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const add = await runCli(db, ["add", "task", "-q"]);
      expect(add.code).toBe(0);
      const shown = await showJson(db, add.out.trim());
      expect(shown.project).toBe("acme");
      expect(shown.kind).toBe("side");
    } finally {
      process.chdir(prev);
    }
  });
});

describe("list --tag × --repo slice", () => {
  test("ob list --tag rework --repo cue-frontend returns only the matching item", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "cue-frontend", "--kind", "side"]);
    await runCli(db, ["project", "add", "cue-backend", "--kind", "side"]);

    const t1 = (await runCli(db, ["add", "fe rework", "--project", "cue-frontend", "-q"])).out.trim();
    const t2 = (await runCli(db, ["add", "fe new", "--project", "cue-frontend", "-q"])).out.trim();
    const t3 = (await runCli(db, ["add", "be rework", "--project", "cue-backend", "-q"])).out.trim();

    await runCli(db, ["tag", t1, "rework"]);
    await runCli(db, ["tag", t2, "new-work"]);
    await runCli(db, ["tag", t3, "rework"]);

    const r = await runCli(db, ["list", "--tag", "rework", "--repo", "cue-frontend", "--json"]);
    expect(r.code).toBe(0);
    const items = JSON.parse(r.out);
    expect(items.map((i: { id: string }) => i.id)).toEqual([t1]);
  });
});
