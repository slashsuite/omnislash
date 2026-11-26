// OB-1825: `ob spinoff check` records a measure-twice verdict, and `ob spinoff <ref>` / `ob spinoff queue <ref>`
// refuse a new dispatch with no `## Done when` item or no `go` for the item's current body. In-process against
// a fresh SQLite database and a fake T3: no network, no live store. Tests cannot show a real dispatch passing
// through the real check; the architect does that once after deploy (the ticket's live Done-when item).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, editItem, getItem } from "../../../apps/cli/src/items.ts";
import { createHash } from "node:crypto";
import { decisionsForItem, recordDecision, renderDecision } from "../../../apps/cli/src/decisions.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { __setSh } from "../src/commands/spinoff.ts";
import { checkVerdict, doneWhenItems } from "../src/spinoff-check.ts";

const READY = "Need stated.\n\n## Drilled\n- cause read in the code\n\n## Done when\n- a test shows it\n\n## Out of scope\nnothing";
const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };

const side = (over: Record<string, unknown> = {}) => ({
  does: "Adds a gate. It refuses by name.",
  files: ["platform/cli-coord/src/spinoff-check.ts"],
  questions: [],
  scores: ALL_TWO,
  ...over,
});
const sheets = (architect = side(), checker = side()) => ["--architect", JSON.stringify(architect), "--reviewer", JSON.stringify(checker)];

async function ticket(body: string | null = READY): Promise<{ dbPath: string; id: string; repo: string }> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  const id = await createItem(db, { type: "task", title: "gated", ...(body === null ? {} : { body }) });
  db.close();
  return { dbPath, id, repo: fakeRepoDir() };
}

const rowCount = async (dbPath: string): Promise<number> => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out).length;

/** Every dispatch form, with T3 and the shell faked: a launch is recorded, never made. */
async function dispatch(dbPath: string, id: string, repo: string, ...extra: string[]) {
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3([repo]);
  const wt = mkdtempSync(join(tmpdir(), "ob-1825-"));
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", ...extra]);
    return { ...r, launches: t3.launches.length };
  } finally {
    t3.restore();
    restoreSh();
    rmSync(wt, { recursive: true, force: true });
  }
}

const trail = (dbPath: string, id: string) => {
  const db = openDb(dbPath);
  return decisionsForItem(db, id).finally(() => db.close());
};

describe("checkVerdict: the rules (OB-1825, OB-2131: gate on questions only)", () => {
  const go = { architectPct: 86, checkerPct: 79, zeros: [] as string[], sharedFiles: 1, questions: [] as string[], resolved: [] as number[] };
  const cases: Array<[string, Partial<typeof go>, string, string[]]> = [
    ["both at 70 is go with nothing to read", { architectPct: 70, checkerPct: 70 }, "go", []],
    ["the architect at 69 is go with a read line", { architectPct: 69, checkerPct: 79 }, "go", ["architect scored 69, under 70"]],
    ["the checker at 69 is go with a read line", { architectPct: 79, checkerPct: 69 }, "go", ["checker scored 69, under 70"]],
    ["a 0 is go and names the criterion", { architectPct: 93, checkerPct: 93, zeros: ["checker scope"] }, "go", ["a criterion scored 0 (checker scope)"]],
    ["a gap of 15 is go with nothing to read", { architectPct: 85, checkerPct: 70 }, "go", []],
    ["a gap of 16 is go with a read line", { architectPct: 86, checkerPct: 70 }, "go", ["scores are 16 apart, over 15"]],
    ["no shared file is go with a read line", { sharedFiles: 0 }, "go", ["the two file lists share no path"]],
    ["an unresolved question is no-go", { questions: ["a?", "b?"] }, "no-go", []],
    ["one of two resolved is still no-go", { questions: ["a?", "b?"], resolved: [1] }, "no-go", []],
    ["every question resolved is go", { questions: ["a?", "b?"], resolved: [1, 2] }, "go", []],
  ];
  for (const [label, over, verdict, read] of cases) {
    test(label, () => {
      const r = checkVerdict({ ...go, ...over });
      expect(r.verdict).toBe(verdict as never);
      expect(r.read).toEqual(read);
    });
  }
  test("a no-go names each unresolved question by number", () => {
    const r = checkVerdict({ ...go, questions: ["a?", "b?", "c?"], resolved: [2] });
    expect(r.unresolved).toEqual([{ q: 1, text: "a?" }, { q: 3, text: "c?" }]);
    expect(r.reasons[0]).toContain("questions 1, 3 not resolved");
    expect(r.reasons[0]).toContain("--resolutions");
  });
});

describe("doneWhenItems (OB-1825)", () => {
  test("reads items out of the section only, and a marker with no text is not one", () => {
    expect(doneWhenItems("## Done when\n- [ ] a\n2. b\nprose\n### kept\n## Next\n- not this")).toEqual(["a", "b", "prose"]);
    expect(doneWhenItems("## Done when\n### only a sub-heading\n")).toEqual([]);
  });
});

describe("ob spinoff check (OB-1825)", () => {
  test("a go is recorded on the trail with both sides and the full hash, and prints the verdict", async () => {
    const { dbPath, id } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side({ does: "architect's" }), side({ does: "checker's" }))]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("go:");
    const db = openDb(dbPath);
    const [event] = await eventsForItemFor(db, id, 1, { source: "ob", type: "transition" });
    const payload = parsePayload<Record<string, any>>(event!);
    expect(payload).toMatchObject({ from: "check", to: "go", planner_pct: 100, checker_pct: 100, gap: 0, questions_resolved: true, resolutions: [], read: [] });
    expect(payload.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.planner.does).toBe("architect's");
    expect(payload.checker.does).toBe("checker's");
    db.close();
  });

  test("architect scores under 2 with no why-low and raises-it line are refused, and nothing is recorded", async () => {
    const { dbPath, id } = await ticket();
    const lowered = side({ scores: { ...ALL_TWO, scope: 1 } });
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(lowered)]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("scope");
    expect(await trail(dbPath, id)).toHaveLength(0);

    const half = side({ scores: { ...ALL_TWO, scope: 1 }, low: { scope: { why: "not verified" } } });
    expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets(half)])).code).not.toBe(0);

    const explained = side({ scores: { ...ALL_TWO, scope: 1 }, low: { scope: { why: "not verified", raises: "read the file" } } });
    expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets(explained)])).code).toBe(0);
  });

  test("the file lists match whatever way a model writes a path", async () => {
    const { dbPath, id } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side({ files: ["./a.ts"] }), side({ files: ["`a.ts:12`"] }))]);
    expect(r.out).toContain("go:");
  });

  test("anything short of go exits 1 and is still recorded", async () => {
    const { dbPath, id } = await ticket();
    const r = await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ questions: ["which table?"] }))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no-go:");
    expect((await trail(dbPath, id))[0]).toMatchObject({ from: "check", to: "no-go" });
  });

  test("no score reaches what `ob show` prints: a checker on a recheck stays blind", async () => {
    const { dbPath, id } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ scores: { ...ALL_TWO, scope: 0 } }))]);
    const [decision] = await trail(dbPath, id);
    expect(decision).toMatchObject({ to: "go", note: null });
    expect(renderDecision(decision!)).not.toMatch(/architect|checker|apart/);
  });

  test("OS-243: --checker is the old name of --reviewer: it records with a note, and both together are refused", async () => {
    const { dbPath, id } = await ticket();
    const old = await runCli(dbPath, ["spinoff", "check", id, "--architect", JSON.stringify(side()), "--checker", JSON.stringify(side())]);
    expect(old.code).toBe(0);
    expect(old.err).toContain("note: --checker is now --reviewer");
    expect((await trail(dbPath, id))[0]).toMatchObject({ to: "go" });
    const both = await runCli(dbPath, ["spinoff", "check", id, ...sheets(), "--checker", JSON.stringify(side())]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("pass --reviewer only");
    const none = await runCli(dbPath, ["spinoff", "check", id, "--architect", JSON.stringify(side())]);
    expect(none.err).toContain("--reviewer <json|file>");
  });

  test("a ref with no item and a malformed sheet are refused by name", async () => {
    const dbPath = freshDbPath();
    const none = await runCli(dbPath, ["spinoff", "check", "ZZ-9", ...sheets()]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("no ob item for 'ZZ-9'");
    const { dbPath: db2, id } = await ticket();
    const bad = await runCli(db2, ["spinoff", "check", id, "--architect", "{\"files\":[]}", "--reviewer", JSON.stringify(side())]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("scores.problem");
    const missing = await runCli(db2, ["spinoff", "check", id, "--architect", "/nonexistent/sheet.json", "--reviewer", JSON.stringify(side())]);
    expect(missing.err).toContain("cannot read");
  });
});

describe("the dispatch gate (OB-1825)", () => {
  async function expectRefused(dbPath: string, id: string, repo: string, ...needles: string[]) {
    const launch = await dispatch(dbPath, id, repo);
    expect(launch.code).not.toBe(0);
    expect(launch.err).toContain("not dispatched");
    expect(launch.err).toContain("Nothing was queued");
    for (const needle of needles) expect(launch.err).toContain(needle);
    expect(launch.launches).toBe(0);
    expect(await rowCount(dbPath)).toBe(0);
  }

  test("no `## Done when`: refused, no row, the fix named", async () => {
    const { dbPath, id, repo } = await ticket("Only prose.");
    await expectRefused(dbPath, id, repo, "'## Done when'", "--no-check");
  });

  test("an empty `## Done when`: refused, even with a go", async () => {
    const { dbPath, id, repo } = await ticket("## Done when\n\n- \n\n## Next\n- x");
    await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
    await expectRefused(dbPath, id, repo, "'## Done when'");
  });

  test("no check: refused, naming `ob spinoff check` and `--no-check`", async () => {
    const { dbPath, id, repo } = await ticket();
    await expectRefused(dbPath, id, repo, "no measure-twice check", "ob spinoff check", "--no-check");
    // `queue` is the other call site.
    const queue = await runCli(dbPath, ["spinoff", "queue", id, "--repo", repo, "--brief", "b"]);
    expect(queue.code).not.toBe(0);
    expect(queue.err).toContain("not dispatched");
    expect(await rowCount(dbPath)).toBe(0);
  });

  test("a `no-go` check: refused with its reason", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ questions: ["which table?"] }))]);
    await expectRefused(dbPath, id, repo, "'no-go'", "--resolutions");
  });

  /** OB-2131: a check recorded before the change carries a word a new check never writes. */
  async function oldRecord(dbPath: string, id: string, to: string, extra: Record<string, unknown>) {
    const db = openDb(dbPath);
    const item = await getItem(db, id);
    const body_sha256 = createHash("sha256").update(item!.body ?? "").digest("hex");
    await recordDecision(db, id, "check", to, { extra: { body_sha256, ...extra } });
    db.close();
  }

  test("an old `investigate` record still refuses: names the low criteria and every route", async () => {
    const { dbPath, id, repo } = await ticket();
    await oldRecord(dbPath, id, "investigate", { reasons: ["a criterion scored 0"], low_criteria: ["scope (architect 2, checker 0)", "proof (architect 2, checker 1)"] });
    await expectRefused(dbPath, id, repo, "'investigate'", "scope (architect 2, checker 0)", "proof (architect 2, checker 1)", "drill down", "spike", "split", "--no-check");
  });

  test("an old `read the gap` record still refuses and says what the gap means", async () => {
    const { dbPath, id, repo } = await ticket();
    await oldRecord(dbPath, id, "read the gap", { reasons: ["scores are 43 apart, over 15"] });
    await expectRefused(dbPath, id, repo, "'read the gap'", "in your head");
  });

  test("a go on an older body: refused, an edited ticket needs a new check", async () => {
    const { dbPath, id, repo } = await ticket();
    expect((await runCli(dbPath, ["spinoff", "check", id, ...sheets()])).code).toBe(0);
    const db = openDb(dbPath);
    await editItem(db, id, { body: `${READY}\n\nNote added later.` });
    db.close();
    await expectRefused(dbPath, id, repo, "older body");
  });

  test("a go a later recheck overturned on the same body does not stand", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
    await Bun.sleep(2); // the trail orders by timestamp
    await runCli(dbPath, ["spinoff", "check", id, ...sheets(side(), side({ questions: ["which table?"] }))]);
    await expectRefused(dbPath, id, repo, "'no-go'");
  });

  test("a ref with no item: refused by name", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    await expectRefused(dbPath, "ZZ-9", repo, "'ZZ-9' resolves to no single ob item", "ob add", "--no-check");
  });

  test("a ref with no item is refused even when a row already has that name (OB-1834)", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    expect((await dispatch(dbPath, "status", repo, "--no-check", "seed the junk row")).launches).toBe(1);
    const db = openDb(dbPath);
    db.query("UPDATE spinoff SET status = 'failed'").run();
    db.close();
    const again = await dispatch(dbPath, "status", repo, "--holder", "build-status");
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("resolves to no single ob item");
    expect(again.launches).toBe(0);
    expect(await rowCount(dbPath)).toBe(1);
  });

  test("a `go` on the current body launches, and `queue` queues", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
    const launched = await dispatch(dbPath, id, repo);
    expect(launched.code).toBe(0);
    expect(launched.launches).toBe(1);

    const second = await ticket();
    await runCli(second.dbPath, ["spinoff", "check", second.id, ...sheets()]);
    const queued = await runCli(second.dbPath, ["spinoff", "queue", second.id, "--repo", second.repo, "--brief", "b"]);
    expect(queued.code).toBe(0);
    expect(await rowCount(second.dbPath)).toBe(1);
  });

  test("`--no-check '<why>'` launches with the reason on the trail, with no check and no Done when", async () => {
    const { dbPath, id, repo } = await ticket("Only prose.");
    const r = await dispatch(dbPath, id, repo, "--no-check", "tried a spike; waiting would not help");
    expect(r.code).toBe(0);
    expect(r.launches).toBe(1);
    const decisions = await trail(dbPath, id);
    expect(decisions.find((d) => d.to === "no-check")).toMatchObject({ from: "check", note: "tried a spike; waiting would not help" });
  });

  test("an empty `--no-check` reason is refused, blank or whitespace, leaving no row", async () => {
    const { dbPath, id, repo } = await ticket();
    for (const reason of ["", "   "]) {
      const r = await dispatch(dbPath, id, repo, "--no-check", reason);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--no-check needs a reason");
      expect(r.launches).toBe(0);
    }
    expect(await rowCount(dbPath)).toBe(0);
  });

  test("a refusal from another check leaves no stray `--no-check` on the trail", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["lease", "acquire", "ticket:" + (await refOf(dbPath, id)), "--holder", "architect-other", "--ttl", "1800"]);
    const r = await dispatch(dbPath, id, repo, "--no-check", "why");
    expect(r.err).toContain("architect-other");
    expect((await trail(dbPath, id)).filter((d) => d.to === "no-check")).toHaveLength(0);
  });

  test("`ob spinoff <ref>` on a building or handed-off row reuses it: exit 0, `already <status>` with its id and thread, one row", async () => {
    for (const [stored, word] of [["launched", "building"], ["ready-for-gate", "handed-off"]] as const) {
      const { dbPath, id, repo } = await ticket();
      await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
      expect((await dispatch(dbPath, id, repo)).launches).toBe(1);
      const db = openDb(dbPath);
      db.query("UPDATE spinoff SET status = ?").run(stored);
      const live = db.query("SELECT id, t3_thread_id FROM spinoff").get() as { id: number; t3_thread_id: string | null };
      db.close();
      expect(live.t3_thread_id).not.toBeNull();
      // Under the builder's own hold, the path the TLA+ trace took to a second live row.
      const again = await dispatch(dbPath, id, repo, "--holder", `build-${id}`);
      expect(again.code).toBe(0);
      expect(again.launches).toBe(0);
      expect(again.out).toContain(`already ${word}: ${await refOf(dbPath, id)} (#${live.id}) in T3 thread ${live.t3_thread_id}; nothing new was launched`);
      expect(await rowCount(dbPath)).toBe(1);
    }
  });

  test("a re-dispatch of a launched row with an old body is not refused, a failed or merged one needs a fresh check (OB-1924)", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
    expect((await dispatch(dbPath, id, repo)).launches).toBe(1);
    // The body moves on after the launch, so the go no longer matches it.
    const db = openDb(dbPath);
    await editItem(db, id, { body: `${READY}\n\nA note from the architect.` });
    expect((await getItem(db, id))!.body).toContain("A note");
    db.close();
    // Under the builder's own hold, so the only thing left to refuse it would be this gate.
    const queued = await runCli(dbPath, ["spinoff", "queue", id, "--repo", repo, "--brief", "b", "--holder", `build-${id}`]);
    expect(queued.err).not.toContain("not dispatched");
    expect(queued.code).toBe(0);
    // The re-dispatch reuses the building row: no second live row on the same worktree.
    expect(queued.out).toContain("already building:");
    expect(await rowCount(dbPath)).toBe(1);
    // OB-1924: only a LIVE row exempts. A failed-only or merged-only ticket is refused without a fresh check.
    for (const status of ["failed", "merged"]) {
      const dead = openDb(dbPath);
      dead.query("UPDATE spinoff SET status = ?").run(status);
      dead.close();
      const refused = await dispatch(dbPath, id, repo, "--holder", `build-${id}`);
      expect(refused.err).toContain("not dispatched");
      expect(refused.code).not.toBe(0);
    }
    // A live row (ready-for-gate) exempts again.
    const live = openDb(dbPath);
    live.query("UPDATE spinoff SET status = 'ready-for-gate'").run();
    live.close();
    const again = await dispatch(dbPath, id, repo, "--holder", `build-${id}`);
    expect(again.err).not.toContain("not dispatched");
    expect(again.code).toBe(0);
    expect(again.out).toContain("already handed-off:");
    expect(again.launches).toBe(0);
    expect(await rowCount(dbPath)).toBe(1);
  });

  test("a sendback of a handed-off row with an old body goes through", async () => {
    const { dbPath, id, repo } = await ticket();
    await runCli(dbPath, ["spinoff", "check", id, ...sheets()]);
    expect((await dispatch(dbPath, id, repo)).launches).toBe(1);
    const db = openDb(dbPath);
    await editItem(db, id, { body: `${READY}\n\nA note from the architect.` });
    db.query("UPDATE spinoff SET status = 'ready-for-gate'").run();
    db.close();
    const t3 = installFakeT3([repo]);
    const r = await runCli(dbPath, ["spinoff", "sendback", id, "--note", "fix the lint error"]);
    t3.restore();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("ob spinoff brief still prints the launch text (OB-1825 pins it)", () => {
  test("the text the checker is given, with no check needed and no row left", async () => {
    const { dbPath, id, repo } = await ticket("## What to build\nThe gate.\n\n## Done when\n- a test shows it");
    const r = await runCli(dbPath, ["spinoff", "brief", id, "--repo", repo]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("gated");
    expect(r.out).toContain("The gate.");
    expect(await rowCount(dbPath)).toBe(0);
  });
});

async function refOf(dbPath: string, id: string): Promise<string> {
  const db = openDb(dbPath);
  const item = await getItem(db, id);
  db.close();
  return item!.ref ?? id;
}
