// OB-1980: `ob spinoff <ref>` / `ob spinoff queue <ref>` refuse a new dispatch whose ticket has no `## Drilled`
// content, as they do for a missing `## Done when`. In-process against a fresh SQLite database and a fake T3:
// no network, no live store. The API path is covered in platform/cli-core/test/decisions-1515.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, addTags } from "../../../apps/cli/src/items.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { __setSh } from "../src/commands/spinoff.ts";
import { doneWhenItems } from "../src/spinoff-check.ts";
import { sectionItems } from "../src/spinoff-spike.ts";

const DONE = "## Done when\n- a test shows it";
const DRILLED = "## Drilled\n- cause read in the code";
const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };
const side = () => ({ does: "Adds a gate.", files: ["platform/cli-coord/src/spinoff-check.ts"], questions: [], scores: ALL_TWO });
const sheets = () => ["--architect", JSON.stringify(side()), "--checker", JSON.stringify(side())];

async function ticket(body: string, tags: string[] = []): Promise<{ dbPath: string; id: string; repo: string }> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  const id = await createItem(db, { type: "task", title: "gated", body });
  if (tags.length > 0) await addTags(db, id, tags);
  db.close();
  return { dbPath, id, repo: fakeRepoDir() };
}

const rowCount = async (dbPath: string): Promise<number> => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out).length;

async function dispatch(dbPath: string, id: string, repo: string, ...extra: string[]) {
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3([repo]);
  const wt = mkdtempSync(join(tmpdir(), "ob-1980-"));
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", ...extra]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
    rmSync(wt, { recursive: true, force: true });
  }
}

async function expectRefused(dbPath: string, id: string, repo: string, ...needles: string[]) {
  const r = await dispatch(dbPath, id, repo);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("not dispatched");
  expect(r.err).toContain("Nothing was queued");
  for (const n of needles) expect(r.err).toContain(n);
  expect(r.launches).toBe(0);
  expect(await rowCount(dbPath)).toBe(0);
  return r;
}

describe("the Drilled gate (OB-1980)", () => {
  test("a go for the current body but no `## Drilled`: refused by name, no row, on spinoff and spinoff queue", async () => {
    const { dbPath, id, repo } = await ticket(`Need.\n\n${DONE}`);
    expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets()])).code).toBe(0);
    const r = await expectRefused(dbPath, id, repo, "'## Drilled' section", "--no-check");
    expect(r.err).not.toContain("no '## Done when'");
    const queue = await runCli(dbPath, ["spinoff", "queue", id, "--repo", repo, "--brief", "b"]);
    expect(queue.code).not.toBe(0);
    expect(queue.err).toContain("'## Drilled' section");
    expect(await rowCount(dbPath)).toBe(0);
  });

  test("an empty `## Drilled`, or one holding only a sub-heading, is refused the same way", async () => {
    for (const body of [`Need.\n\n## Drilled\n\n- \n\n${DONE}`, `Need.\n\n## Drilled\n### only a sub-heading\n\n${DONE}`]) {
      const { dbPath, id, repo } = await ticket(body);
      await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
      await expectRefused(dbPath, id, repo, "'## Drilled' section");
    }
  });

  test("missing both sections: one refusal names both", async () => {
    const { dbPath, id, repo } = await ticket("Only prose.");
    await expectRefused(dbPath, id, repo, "'## Drilled' section", "'## Done when' item");
  });

  test("a spike with no Drilled still dispatches", async () => {
    const { dbPath, id, repo } = await ticket("## Questions\n- why\n\n## Box\n- an hour\n\n## Done when\n- answered", ["spike"]);
    const parent = openDb(dbPath);
    const p = await createItem(parent, { type: "task", title: "parent" });
    parent.close();
    expect((await runCli(dbPath, ["link", id, "spun_off_from", p])).code).toBe(0);
    const r = await dispatch(dbPath, id, repo);
    expect(r.err).not.toContain("Drilled");
    expect(r.code).toBe(0);
    expect(r.launches).toBe(1);
  });

  test("a re-dispatch of a ticket with a live row is not gated", async () => {
    const { dbPath, id, repo } = await ticket("Only prose.");
    expect((await dispatch(dbPath, id, repo, "--no-check", "seed the row")).launches).toBe(1);
    const again = await runCli(dbPath, ["spinoff", "queue", id, "--repo", repo, "--brief", "b", "--holder", `build-${id}`]);
    expect(again.err).not.toContain("not dispatched");
    expect(again.code).toBe(0);
  });
});

describe("the section reader (OB-1980)", () => {
  test("doneWhenItems and the Drilled gate share it, and a heading suffix still counts", () => {
    const body = "## Drilled:\n- a\n\n## Done when (live)\n- [ ] b\n2. c\n### kept\n## Next\n- no";
    expect(sectionItems(body, "Drilled")).toEqual(["a"]);
    expect(doneWhenItems(body)).toEqual(["b", "c"]);
    expect(sectionItems("## Done whenever\n- x", "Done when")).toEqual([]);
  });
});
