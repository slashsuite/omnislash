import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { originRepo } from "../../../apps/cli/src/project.ts";

// Triage inbox (issue #56): an architect in another repo hands work over with `ob add --triage`; the
// acme architect works the inbox via `ob triage` (+ clear/reject). Setting a priority triages an item.

async function triageJson(dbPath: string): Promise<Array<{ id: string; title: string; origin_repo: string | null; note: string }>> {
  const r = await runCli(dbPath, ["triage", "--json"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

describe("triage inbox (#56)", () => {
  test("ob add --triage --from sets the flag and captures the origin repo", async () => {
    const db = freshDbPath();
    const add = await runCli(db, ["add", "Fix the flaky deploy hook", "--triage", "--from", "cue-frontend", "--project", "inbox", "--kind", "side"]);
    expect(add.code).toBe(0);

    const inbox = await triageJson(db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.title).toBe("Fix the flaky deploy hook");
    expect(inbox[0]!.origin_repo).toBe("cue-frontend");
  });

  test("a plain ob add (no --triage) never lands in the inbox", async () => {
    const db = freshDbPath();
    expect((await runCli(db, ["add", "Normal task", "--project", "inbox", "--kind", "side"])).code).toBe(0);
    expect(await triageJson(db)).toHaveLength(0);
  });

  test("ob triage lists only still-flagged items (setting a priority clears the flag)", async () => {
    const db = freshDbPath();
    const a = await runCli(db, ["add", "Item A", "--triage", "--from", "repo-a", "--project", "inbox", "--kind", "side", "--json"]);
    const b = await runCli(db, ["add", "Item B", "--triage", "--from", "repo-b", "--project", "inbox", "--kind", "side", "--json"]);
    const idA = JSON.parse(a.out).id as string;
    JSON.parse(b.out); // second item id unused

    // both awaiting triage, newest-first (B added after A)
    let inbox = await triageJson(db);
    expect(inbox.map((i) => i.title)).toEqual(["Item B", "Item A"]);

    // triage A by setting a priority → it leaves the inbox, its priority sticks
    expect((await runCli(db, ["edit", idA, "--priority", "high"])).code).toBe(0);
    inbox = await triageJson(db);
    expect(inbox.map((i) => i.title)).toEqual(["Item B"]);

    const showA = await runCli(db, ["show", idA, "--json"]);
    expect(JSON.parse(showA.out).priority).toBe("high");
  });

  test("ob triage clear removes the flag but keeps the item open", async () => {
    const db = freshDbPath();
    const a = await runCli(db, ["add", "Clear me", "--triage", "--project", "inbox", "--kind", "side", "--json"]);
    const id = JSON.parse(a.out).id as string;

    expect((await runCli(db, ["triage", "clear", id])).code).toBe(0);
    expect(await triageJson(db)).toHaveLength(0);

    const show = JSON.parse((await runCli(db, ["show", id, "--json"])).out);
    expect(show.status).toBe("open");
  });

  test("ob triage reject removes the flag AND closes the item", async () => {
    const db = freshDbPath();
    const a = await runCli(db, ["add", "Reject me", "--triage", "--project", "inbox", "--kind", "side", "--json"]);
    const id = JSON.parse(a.out).id as string;

    expect((await runCli(db, ["triage", "reject", id])).code).toBe(0);
    expect(await triageJson(db)).toHaveLength(0);

    const show = JSON.parse((await runCli(db, ["show", id, "--json"])).out);
    expect(show.status).toBe("done");
  });

  test("empty inbox reports so, in human mode", async () => {
    const db = freshDbPath();
    const r = await runCli(db, ["triage"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("empty");
  });

  test("ob next shows the banner only when the inbox is non-empty", async () => {
    const db = freshDbPath();
    // no triage items yet → no banner (a plain open item so next has content)
    expect((await runCli(db, ["add", "Plain", "--project", "inbox", "--kind", "side"])).code).toBe(0);
    const before = await runCli(db, ["next"]);
    expect(before.out).not.toContain("Triage inbox:");

    // add a triage item → banner appears
    expect((await runCli(db, ["add", "Handoff", "--triage", "--from", "repo-x", "--project", "inbox", "--kind", "side"])).code).toBe(0);
    const after = await runCli(db, ["next"]);
    expect(after.out).toContain("Triage inbox: 1 item(s) awaiting triage");
  });

  test("ob status shows the banner only when the inbox is non-empty", async () => {
    const db = freshDbPath();
    const before = await runCli(db, ["status"]);
    expect(before.code).toBe(0);
    expect(before.out).not.toContain("Triage inbox:");

    expect((await runCli(db, ["add", "Handoff", "--triage", "--from", "repo-y", "--project", "inbox", "--kind", "side"])).code).toBe(0);
    const after = await runCli(db, ["status"]);
    expect(after.out).toContain("Triage inbox: 1 item(s) awaiting triage");
  });

  test("originRepo() returns the git repo-root basename, or '' outside a git repo", () => {
    const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? "";

    // a fresh git repo → its directory basename
    const gitDir = mkdtempSync(join(tmpdir(), "ob-origin-git-"));
    execSync("git init -q", { cwd: gitDir });
    expect(originRepo(gitDir)).toBe(basename(gitDir));

    // a plain (non-git) temp dir is not itself a git-repo root → originRepo must not report its name
    const plainDir = mkdtempSync(join(tmpdir(), "ob-origin-plain-"));
    expect(originRepo(plainDir)).not.toBe(basename(plainDir));
  });
});
