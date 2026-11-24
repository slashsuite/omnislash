import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferProjectSpec } from "../../../apps/cli/src/project.ts";

function gitCheckout(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-infer-"));
  execSync("git init -q", { cwd: dir });
  execSync(`git remote add origin ${remote}`, { cwd: dir });
  return dir;
}

describe("inferProjectSpec", () => {
  test("owner remote -> side kind", () => {
    const dir = gitCheckout("https://github.com/owner/myrepo.git");
    expect(inferProjectSpec(dir)).toEqual({
      name: "myrepo",
      kind: "side",
      remote: "https://github.com/owner/myrepo.git",
    });
  });

  test("acmecorp remote is not classified as cue", () => {
    const dir = gitCheckout("git@github.com:acmecorp/cue-app.git");
    expect(inferProjectSpec(dir)).toBeNull();
  });

  test("unknown org is not inferred", () => {
    const dir = gitCheckout("https://github.com/someone/widgets.git");
    expect(inferProjectSpec(dir)).toBeNull();
  });
});

// ob 1621: project edit / rm and the add-on-existing refusal. Fresh temp DBs only.
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

describe("ob project edit / rm (1621)", () => {
  const mk = async (db: string) => {
    await runCli(db, ["project", "add", "Alpha", "--kind", "side"]);
    return db;
  };

  test("edit sets the remote and kind; list shows them", async () => {
    const db = await mk(freshDbPath());
    const r = await runCli(db, ["project", "edit", "alpha", "--remote", "git@github.com:x/alpha.git", "--kind", "home"]);
    expect(r.code).toBe(0);
    const l = await runCli(db, ["project"]);
    expect(l.out).toContain("alpha\thome\tAlpha\tgit@github.com:x/alpha.git");
  });

  test("edit: unknown name exits 1 naming it; no flags is a usage error; bad kind is a usage error", async () => {
    const db = await mk(freshDbPath());
    const unknown = await runCli(db, ["project", "edit", "nope", "--remote", "u"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no project 'nope'");
    const none = await runCli(db, ["project", "edit", "alpha"]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("at least one of --remote");
    const bad = await runCli(db, ["project", "edit", "alpha", "--kind", "zzz"]);
    expect(bad.code).not.toBe(0);
  });

  test("add on an existing name: same spec answers with the id, a differing one refuses and names edit", async () => {
    const db = await mk(freshDbPath());
    const same = await runCli(db, ["project", "add", "Alpha", "--kind", "side"]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("alpha");
    const diff = await runCli(db, ["project", "add", "Alpha", "--kind", "side", "--remote", "git@github.com:x/alpha.git"]);
    expect(diff.code).toBe(1);
    expect(diff.err).toContain("ob project edit alpha");
    const l = await runCli(db, ["project"]);
    expect(l.out).not.toContain("x/alpha.git");
  });

  test("rm: unknown name exits 1; removes a project with no items", async () => {
    const db = await mk(freshDbPath());
    const unknown = await runCli(db, ["project", "rm", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no project 'nope'");
    const ok = await runCli(db, ["project", "rm", "alpha"]);
    expect(ok.code).toBe(0);
    expect((await runCli(db, ["project"])).out).not.toContain("alpha");
  });

  test("rm refuses while an open item references it (naming the count); --force detaches and removes; done items alone do not block", async () => {
    const db = await mk(freshDbPath());
    const a = (await runCli(db, ["add", "one", "--project", "alpha", "-q"])).out.trim();
    const b = (await runCli(db, ["add", "two", "--project", "alpha", "-q"])).out.trim();
    await runCli(db, ["close", b]);
    const refused = await runCli(db, ["project", "rm", "alpha"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("1 open item;");
    expect((await runCli(db, ["project"])).out).toContain("alpha");
    await runCli(db, ["close", a]);
    const ok = await runCli(db, ["project", "rm", "alpha"]);
    expect(ok.code).toBe(0);
    expect((await runCli(db, ["project"])).out).not.toContain("alpha");
    expect((await runCli(db, ["show", a, "--json"])).code).toBe(0);
  });

  test("rm --force removes past an open item", async () => {
    const db = await mk(freshDbPath());
    const a = (await runCli(db, ["add", "one", "--project", "alpha", "-q"])).out.trim();
    expect((await runCli(db, ["project", "rm", "alpha", "--force"])).code).toBe(0);
    expect((await runCli(db, ["project"])).out).not.toContain("alpha");
    expect((await runCli(db, ["show", a])).code).toBe(0);
  });
});

// The served half (1621): the same store functions behind the handlers the API mounts, on a fresh sqlite.
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { projectCreate, projectEdit, projectRemove, projectRename } from "../../../apps/cli/src/api/handlers.ts";
import { ApiFault } from "../../../apps/cli/src/api/fault.ts";
import { freshDb } from "../../../apps/cli/test/helpers.ts";

describe("project handlers (1621)", () => {
  const fault = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as ApiFault;
    }
    throw new Error("expected an ApiFault");
  };

  test("edit: patches, 404 on unknown, 400 on no flags", async () => {
    const store = asStore(freshDb());
    await projectCreate(store, { name: "Alpha", kind: "side" });
    const edited = await projectEdit(store, "alpha", { remote: "git@github.com:x/alpha.git" });
    expect(edited.project.git_remote).toBe("git@github.com:x/alpha.git");
    expect(edited.project.kind).toBe("side");
    expect((await fault(projectEdit(store, "nope", { remote: "u" }))).status).toBe(404);
    expect((await fault(projectEdit(store, "alpha", {}))).status).toBe(400);
  });

  test("create on an existing name: same spec returns it, a different remote is a 409 naming edit", async () => {
    const store = asStore(freshDb());
    await projectCreate(store, { name: "Alpha", kind: "side" });
    expect((await projectCreate(store, { name: "Alpha", kind: "side" })).project.id).toBe("alpha");
    const f = await fault(projectCreate(store, { name: "Alpha", kind: "side", remote: "u" }));
    expect(f.status).toBe(409);
    expect(f.message).toContain("ob project edit alpha");
  });

  test("remove: 409 with the count while open items reference it, force detaches, 404 on unknown", async () => {
    const db = freshDb();
    const store = asStore(db);
    await projectCreate(store, { name: "Alpha", kind: "side" });
    await store.q.insert(store.t.item).values({ id: "1", type: "task", title: "t", status: "open", project_id: "alpha", created_at: "x", updated_at: "x" });
    const f = await fault(projectRemove(store, "alpha", false));
    expect(f.status).toBe(409);
    expect(f.message).toContain("1 open item;");
    const done = await projectRemove(store, "alpha", true);
    expect(done.project.id).toBe("alpha");
    expect((await fault(projectRemove(store, "alpha", false))).status).toBe(404);
  });

  test("--key (1949): create and edit set it, a malformed key is a 400, a taken one a 409", async () => {
    const store = asStore(freshDb());
    expect((await projectCreate(store, { name: "Alpha", kind: "side", key: "al" })).project.key).toBe("AL");
    expect((await fault(projectCreate(store, { name: "Beta", kind: "side", key: "b1" }))).status).toBe(400);
    await projectCreate(store, { name: "Beta", kind: "side" });
    expect((await fault(projectEdit(store, "beta", { key: "AL" }))).status).toBe(409);
    expect((await projectEdit(store, "beta", { key: "be" })).project.key).toBe("BE");
    // an agreed key is the default for a project created without one
    expect((await projectCreate(store, { name: "pixelslash", kind: "side" })).project.key).toBe("PS");
  });
});

// OB-1846: rename in place. Same key, every item follows, every ref still resolves.
describe("ob project rename (OB-1846)", () => {
  test("renames in place: list shows the new name with the old key, and every ref still resolves", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "oldname", "--kind", "side", "--remote", "git@github.com:x/oldname.git", "--key", "ON"]);
    const a = (await runCli(db, ["add", "one", "--project", "oldname", "-q"])).out.trim();
    const b = (await runCli(db, ["add", "two", "--project", "oldname", "-q"])).out.trim();
    await runCli(db, ["close", b]);
    await runCli(db, ["focus", "oldname"]);
    const r = await runCli(db, ["project", "rename", "oldname", "newname"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("newname");
    const l = (await runCli(db, ["project"])).out;
    expect(l).toContain("newname\tside\tnewname\tgit@github.com:x/oldname.git\tON");
    expect(l).not.toContain("oldname\tside");
    for (const ref of [a, b, "ON-1", "ON-2"]) {
      const s = await runCli(db, ["show", ref, "--json"]);
      expect(s.code).toBe(0);
      expect(JSON.parse(s.out).project).toBe("newname");
    }
    expect((await runCli(db, ["add", "three", "--project", "newname", "-q"])).out.trim()).toBe("ON-3");
    expect((await runCli(db, ["focus"])).out).toContain("newname");
  });

  test("refuses an unknown old name and a taken new name, naming which, and changes nothing", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "Alpha", "--kind", "side", "--key", "AL"]);
    await runCli(db, ["project", "add", "Beta", "--kind", "home", "--key", "BE"]);
    const before = (await runCli(db, ["project"])).out;
    const unknown = await runCli(db, ["project", "rename", "nope", "gamma"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("no project 'nope'");
    const taken = await runCli(db, ["project", "rename", "alpha", "Beta"]);
    expect(taken.code).toBe(1);
    expect(taken.err).toContain("project 'Beta' already exists");
    expect((await runCli(db, ["project"])).out).toBe(before);
  });

  test("a case-only rename keeps the id and changes the name", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "alpha", "--kind", "side"]);
    expect((await runCli(db, ["project", "rename", "alpha", "Alpha"])).code).toBe(0);
    expect((await runCli(db, ["project"])).out).toContain("alpha\tside\tAlpha");
  });

  test("handler: 404 on unknown, 409 on taken", async () => {
    const store = asStore(freshDb());
    await projectCreate(store, { name: "Alpha", kind: "side" });
    await projectCreate(store, { name: "Beta", kind: "side" });
    const fault = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected an ApiFault"); }, (e) => e as ApiFault);
    expect((await fault(projectRename(store, "nope", "x"))).status).toBe(404);
    expect((await fault(projectRename(store, "alpha", "beta"))).status).toBe(409);
  });
});

// OB-2116: the architect thread title's icon and display name live on the project row.
describe("project --icon / --display-name (OB-2116)", () => {
  test("edit sets both, list and --json show them, and '' clears each", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "pixelslash", "--kind", "side"]);
    const set = await runCli(db, ["project", "edit", "pixelslash", "--icon", "🖼️", "--display-name", "PixelSlash"]);
    expect(set.code).toBe(0);
    const listed = await runCli(db, ["project", "list"]);
    expect(listed.out).toContain("pixelslash\tside\tpixelslash\t\tPS\t🖼️\tPixelSlash");
    const json = JSON.parse((await runCli(db, ["project", "list", "--json"])).out) as Array<{ id: string; icon: string | null; display_name: string | null }>;
    expect(json.find((p) => p.id === "pixelslash")).toMatchObject({ icon: "🖼️", display_name: "PixelSlash" });

    expect((await runCli(db, ["project", "edit", "pixelslash", "--icon", ""])).code).toBe(0);
    const cleared = JSON.parse((await runCli(db, ["project", "list", "--json"])).out) as Array<{ id: string; icon: string | null; display_name: string | null }>;
    expect(cleared.find((p) => p.id === "pixelslash")).toMatchObject({ icon: null, display_name: "PixelSlash" });
    expect((await runCli(db, ["project", "edit", "pixelslash", "--display-name", "  "])).code).toBe(0);
    const bare = await runCli(db, ["project", "list"]);
    // neither set: both columns are empty (OB-2103 writes every column, so the stage stays the eighth)
    expect(bare.out).toContain("pixelslash\tside\tpixelslash\t\tPS\t\t\t-\tactive\n");
  });

  test("add takes both; a ZWJ flag fits the icon cap, an over-long icon or name is a usage error", async () => {
    const db = freshDbPath();
    const add = await runCli(db, ["project", "add", "hackcove", "--kind", "side", "--icon", "🏴‍☠️", "--display-name", "Hack Cove"]);
    expect(add.code).toBe(0);
    expect((await runCli(db, ["project", "list"])).out).toContain("\t🏴‍☠️\tHack Cove");
    // a re-add naming a different icon refuses and points at edit, rather than exiting 0 unchanged
    const readd = await runCli(db, ["project", "add", "hackcove", "--kind", "side", "--icon", "⚓"]);
    expect(readd.code).toBe(1);
    expect(readd.err).toContain("icon is 🏴‍☠️, not ⚓");
    expect((await runCli(db, ["project", "add", "hackcove", "--kind", "side", "--icon", "🏴‍☠️"])).code).toBe(0);
    const longIcon = await runCli(db, ["project", "edit", "hackcove", "--icon", "x".repeat(17)]);
    expect(longIcon.code).toBe(2);
    expect(longIcon.err).toContain("--icon must be at most 16");
    const longName = await runCli(db, ["project", "edit", "hackcove", "--display-name", "y".repeat(41)]);
    expect(longName.code).toBe(2);
    expect(longName.err).toContain("--display-name must be at most 40");
  });

  test("the API handlers carry both fields, '' clears, and an over-long value is a 400", async () => {
    const store = asStore(freshDb());
    const created = await projectCreate(store, { name: "flakeslash", kind: "side", icon: "❄️", display_name: "FlakeSlash" });
    expect(created.project).toMatchObject({ icon: "❄️", display_name: "FlakeSlash" });
    const cleared = await projectEdit(store, "flakeslash", { icon: "" });
    expect(cleared.project).toMatchObject({ icon: null, display_name: "FlakeSlash" });
    const fault = await projectEdit(store, "flakeslash", { display_name: "z".repeat(41) }).then(
      () => null,
      (e) => e as ApiFault,
    );
    expect(fault?.status).toBe(400);
  });
});

// OB-2103: the release stage lives on the project row; tests on a throwaway store only.
describe("project --stage (OB-2103)", () => {
  test("edit --stage alpha shows in list; a wrong value names the five; none clears", async () => {
    const db = freshDbPath();
    expect((await runCli(db, ["project", "add", "toggleslash", "--kind", "side"])).code).toBe(0);
    const unset = await runCli(db, ["project", "list"]);
    expect(unset.out.split("\n").find((l) => l.startsWith("toggleslash\t"))?.split("\t")[7]).toBe("-");

    const set = await runCli(db, ["project", "edit", "toggleslash", "--stage", "alpha"]);
    expect(set.code).toBe(0);
    const row = (await runCli(db, ["project", "list"])).out.split("\n").find((l) => l.startsWith("toggleslash\t"));
    expect(row?.split("\t")[7]).toBe("alpha");
    // the first four fields are where they always were
    expect(row?.split("\t").slice(0, 4)).toEqual(["toggleslash", "side", "toggleslash", ""]);
    const json = JSON.parse((await runCli(db, ["project", "list", "--json"])).out) as Array<{ id: string; stage: string | null }>;
    expect(json.find((p) => p.id === "toggleslash")?.stage).toBe("alpha");

    const wrong = await runCli(db, ["project", "edit", "toggleslash", "--stage", "wrong"]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain("alpha, beta, rc, stable, legacy");
    // a refused value changes nothing
    expect(JSON.parse((await runCli(db, ["project", "list", "--json"])).out).find((p: { id: string }) => p.id === "toggleslash").stage).toBe("alpha");

    expect((await runCli(db, ["project", "edit", "toggleslash", "--stage", "none"])).code).toBe(0);
    const cleared = JSON.parse((await runCli(db, ["project", "list", "--json"])).out) as Array<{ id: string; stage: string | null }>;
    expect(cleared.find((p) => p.id === "toggleslash")?.stage).toBeNull();
  });

  test("the no-flag refusal names --stage, and rename keeps the stage", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "advisor-quotes", "--kind", "side"]);
    const none = await runCli(db, ["project", "edit", "advisor-quotes"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("--stage <s>");
    expect((await runCli(db, ["project", "edit", "advisor-quotes", "--stage", "Legacy"])).code).toBe(0);
    expect((await runCli(db, ["project", "rename", "advisor-quotes", "quotes"])).code).toBe(0);
    const json = JSON.parse((await runCli(db, ["project", "list", "--json"])).out) as Array<{ id: string; stage: string | null }>;
    expect(json.find((p) => p.id === "quotes")?.stage).toBe("legacy");
  });

  test("project rules opens with the Stage line, set or not", async () => {
    const db = freshDbPath();
    await runCli(db, ["project", "add", "toggleslash", "--kind", "side"]);
    const before = await runCli(db, ["project", "rules", "toggleslash"]);
    expect(before.code).toBe(0);
    expect(before.out.split("\n")[0]).toBe("Stage: not set, treat as beta (breaks allowed, each flagged with ! and a Breaking: line)");
    await runCli(db, ["project", "edit", "toggleslash", "--stage", "alpha"]);
    const after = await runCli(db, ["project", "rules", "toggleslash"]);
    expect(after.out.split("\n")[0]).toBe("Stage: alpha (anything may break, no compatibility work owed)");
    const json = JSON.parse((await runCli(db, ["project", "rules", "toggleslash", "--json"])).out) as { stage: string | null; stage_line: string };
    expect(json.stage).toBe("alpha");
    // a project the tracker does not know reads as not set
    expect((await runCli(db, ["project", "rules", "nosuch"])).out.split("\n")[0]).toStartWith("Stage: not set, treat as beta");
  });

  test("the API handler sets, refuses with a 400 and clears", async () => {
    const store = asStore(freshDb());
    await projectCreate(store, { name: "toggleslash", kind: "side" });
    expect((await projectEdit(store, "toggleslash", { stage: "alpha" })).project.stage).toBe("alpha");
    const fault = await projectEdit(store, "toggleslash", { stage: "wrong" }).then(
      () => null,
      (e) => e as ApiFault,
    );
    expect(fault?.status).toBe(400);
    expect(fault?.message).toContain("alpha, beta, rc, stable, legacy");
    // the CLI's parsed patch carries "" for none over the wire; the handler takes both
    expect((await projectEdit(store, "toggleslash", { stage: "" })).project.stage).toBeNull();
    await projectEdit(store, "toggleslash", { stage: "rc" });
    expect((await projectEdit(store, "toggleslash", { stage: "none" })).project.stage).toBeNull();
  });
});

describe("stageIn (OB-2103)", () => {
  test("matches a project by id or name, as getProject does; unknown or unset is null", async () => {
    const { stageIn } = await import("../../../apps/cli/src/stage.ts");
    const projects = [{ id: "advisor-quotes", name: "Advisor Quotes", stage: "legacy" }, { id: "acme", name: "acme", stage: null }];
    expect(stageIn(projects, "advisor-quotes")).toBe("legacy");
    expect(stageIn(projects, "Advisor Quotes")).toBe("legacy");
    expect(stageIn(projects, "acme")).toBeNull();
    expect(stageIn(projects, "nosuch")).toBeNull();
  });
});
