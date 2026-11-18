import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import {
  addTags,
  createItem,
  getItem,
  getTags,
  queryItems,
  setBlocked,
} from "../../../apps/cli/src/items.ts";
import { inferProject, parseRemote, registerProject } from "../../../apps/cli/src/project.ts";

describe("createItem + getItem", () => {
  test("assigns sequential ids and defaults", async () => {
    const db = freshDb();
    await registerProject(db, { name: "foo", kind: "side" });
    const id1 = await createItem(db, { type: "task", title: "one", projectId: "foo" });
    const id2 = await createItem(db, { type: "task", title: "two", projectId: "foo" });
    expect(id1).toBe("1");
    expect(id2).toBe("2");
    const item = (await getItem(db, "1"))!;
    expect(item.title).toBe("one");
    expect(item.status).toBe("open");
    expect(item.project_kind).toBe("side");
  });
});

describe("queryItems filters", () => {
  test("open and status filters", async () => {
    const db = freshDb();
    await registerProject(db, { name: "foo", kind: "side" });
    const a = await createItem(db, { type: "task", title: "a", projectId: "foo" });
    await createItem(db, { type: "task", title: "b", projectId: "foo" });
    await setBlocked(db, a, "waiting", "sam");
    const blocked = await queryItems(db, { status: "blocked" });
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.block_reason).toBe("waiting");
    expect(blocked[0]!.block_owner).toBe("sam");
  });

  test("tag filter", async () => {
    const db = freshDb();
    await registerProject(db, { name: "foo", kind: "side" });
    const a = await createItem(db, { type: "task", title: "a", projectId: "foo" });
    await createItem(db, { type: "task", title: "b", projectId: "foo" });
    await addTags(db, a, ["security"]);
    const tagged = await queryItems(db, { tag: "security" });
    expect(tagged.map((i) => i.id)).toEqual([a]);
    expect(await getTags(db, a)).toEqual(["security"]);
  });
});

describe("parseRemote", () => {
  test("https and ssh forms", async () => {
    expect(parseRemote("https://github.com/acmecorp/cue-app.git")).toMatchObject({
      org: "acmecorp",
      repo: "cue-app",
    });
    expect(parseRemote("git@github.com:owner/foo.git")).toMatchObject({
      org: "owner",
      repo: "foo",
    });
    expect(parseRemote("https://gitlab.com/x/y.git")).toBeNull();
  });
});

describe("inferProject", () => {
  test("owner remote -> side kind, auto-registered", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-git-"));
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin https://github.com/owner/myrepo.git", {
      cwd: dir,
    });
    const project = (await inferProject(db, dir))!;
    expect(project.kind).toBe("side");
    expect(project.name).toBe("myrepo");
  });

  test("acmecorp remote is not classified as cue", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-git-"));
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin git@github.com:acmecorp/cue-app.git", { cwd: dir });
    expect(await inferProject(db, dir)).toBeNull();
  });

  test("no remote -> null", async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "ob-git-"));
    execSync("git init -q", { cwd: dir });
    expect(await inferProject(db, dir)).toBeNull();
  });
});
