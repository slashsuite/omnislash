// 1201 — reconcile marked a spinoff row `merged` when a CHART commit named the ticket, mid-flight.
//
// On 2026-10-18 the drain printed "reconciled 1 merged: 738": row 601 went `merged` while its builder was
// STILL RUNNING and its work was unlanded, and item 738 was (and is) `open`. What main carried was
// `docs(ob 738): Hermes loop map (decision #57)` — the CHART commit for the ticket, which wayfinder lands
// BEFORE the build starts, by design. The signal said "a commit names the ticket"; it must say "a commit
// LANDS the ticket": a merge subject or a conventional-commit scope (`feat(ob N)`, `chore(ob N)`), never a
// `docs(`/`chart(` note, and never a commit older than the row's own `base_sha` (a chart that landed before
// the dispatch cannot be its land). The two unambiguous signals — the branch is merged into main, the
// ticket is `done` — are untouched.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import {
  commitsSinceBase,
  landsTicket,
  workHasLanded,
  type Commit,
} from "../../../apps/cli/src/tracker-link.ts";
import { listAgents, registerAgent } from "../src/agent.ts";
import {
  enqueueSpinoff,
  listSpinoffs,
  localSpinoffSteps,
  reconcileSpinoffs,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";

const README = readFileSync(join(import.meta.dir, "..", "..", "..", "apps/cli/README.md"), "utf8");

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "738",
  repo: "/r/acme",
  branch: "738",
  mode: "interactive",
  brief: "the Hermes loop map",
  ...over,
});

/** A launched row with a live agent and the base sha its launch captured, as reconcile finds it. */
async function seedLaunched(
  db: ReturnType<typeof freshDb>,
  opts: { ticket?: string; branch?: string; baseSha?: string | null } = {},
): Promise<number> {
  const ticket = opts.ticket ?? "738";
  const branch = opts.branch ?? ticket;
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ticket, branch }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, base_sha = ? WHERE id = ?").run(
    branch,
    opts.baseSha ?? null,
    row.id,
  );
  await registerAgent(db, { id: branch, ticket, branch, status: "working", ttlS: 900 });
  return row.id;
}

// 738's row, verbatim: the chart commit landed, main moved, and the dispatch captured that tip as its base.
const CHART_738: Commit = { sha: "dd4fe956", subject: "docs(ob 738): Hermes loop map (decision #57)", body: "" };
const BASE_738: Commit = { sha: "base0738", subject: "overnight(2026-10-18): the 738 dispatch", body: "" };

/** The reconcile with every other signal OFF: nothing is merged locally, no branch has unique commits. */
const reconcile = (db: ReturnType<typeof freshDb>, commits: Commit[]) =>
  reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => commits);

describe("reconcile does not retire a row on a chart/docs commit naming the ticket (1201)", () => {
  test("738's exact case: chart on main, launched row, work in progress → the row stays launched", async () => {
    const db = freshDb();
    await seedLaunched(db, { baseSha: BASE_738.sha });
    const rec = await reconcile(db, [BASE_738, CHART_738]); // newest first, as `git log` gives them
    expect(rec.merged).toEqual([]);
    const rows = await listSpinoffs(db, "launched");
    expect(rows.map((r) => r.ticket_ref)).toEqual(["738"]);
    expect(rows[0]!.status).toBe("launched");
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["738"]); // its agent is not deregistered either
  });

  test("a docs note that lands MID-FLIGHT (newer than the base) is still not a land", async () => {
    const db = freshDb();
    await seedLaunched(db, { baseSha: BASE_738.sha });
    const note: Commit = { sha: "beef738", subject: "docs(ob 738): in-progress + work log", body: "" };
    const rec = await reconcile(db, [note, BASE_738, CHART_738]);
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["738"]);
  });

  test("a real `feat(ob 738)` land still retires it", async () => {
    const db = freshDb();
    await seedLaunched(db, { baseSha: BASE_738.sha });
    const land: Commit = { sha: "6d053dd8", subject: "feat(ob 738): /ob-refine force-runs the Hermes learning loop", body: "" };
    const rec = await reconcile(db, [land, { ...CHART_738, sha: "chart2" }, BASE_738]);
    expect(rec.merged).toEqual(["738"]);
    expect(await listSpinoffs(db, "launched")).toHaveLength(0);
    expect(await listAgents(db)).toHaveLength(0);
  });

  test("a landing commit older than the base does not retire the RE-dispatched row", async () => {
    const db = freshDb();
    await seedLaunched(db, { baseSha: BASE_738.sha });
    // Same ticket, landed once before, reopened and dispatched again: the old land proves nothing about
    // the work THIS row dispatched.
    const old: Commit = { sha: "old738", subject: "feat(ob 738): the first landing", body: "" };
    const rec = await reconcile(db, [BASE_738, CHART_738, old]);
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["738"]);
  });

  test("two rows for ONE ticket: each row is judged by its OWN base, so a newer dispatch is not retired", async () => {
    const db = freshDb();
    // Two live rows for 738, seeded directly: the enqueue dedupe now reuses any live row, so only a row left from
    // before that (or a direct write) gives two, and reconcile must still judge each by its own base.
    const older = await seedLaunched(db, { branch: "738", baseSha: BASE_738.sha });
    const newer = await seedLaunched(db, { branch: "738-again", baseSha: "base-again" });
    const commits: Commit[] = [
      { sha: "base-again", subject: "overnight(2026-10-18): the RE-dispatch", body: "" },
      { sha: "land0738", subject: "feat(ob 738): the loop", body: "" }, // after the FIRST dispatch, before the second
      BASE_738,
      CHART_738,
    ];
    const rec = await reconcile(db, commits);
    expect(rec.merged).toEqual(["738"]); // the older row's land
    expect((await listSpinoffs(db, "merged")).map((r) => r.id)).toEqual([older]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.id)).toEqual([newer]); // its own base outdates the land
  });

  test("a `chore(ob N)` land still retires it — the gate is the docs/chart types, not an allow-list", async () => {
    const db = freshDb();
    await seedLaunched(db, { ticket: "915", branch: "915" });
    const land: Commit = { sha: "chore915", subject: "chore(ob 915): delete the leftover visual-gate app", body: "" };
    expect((await reconcile(db, [land])).merged).toEqual(["915"]);
  });

  test("an unknown base drops only the ordering gate, not the landing signal (932 stays)", async () => {
    const db = freshDb();
    await seedLaunched(db, {}); // a pre-#61 row: no base_sha captured
    const land: Commit = { sha: "fix922", subject: "fix(ob 738): paint nested rows", body: "" };
    expect((await reconcile(db, [land])).merged).toEqual(["738"]);
  });

  test("a RECORDED base the read does not contain claims no landing at all", async () => {
    const db = freshDb();
    await seedLaunched(db, { baseSha: "a-base-not-in-this-log" });
    // Nothing here is provably newer than the row's start, so no commit is allowed to retire it — the
    // conservative direction: an unfound base can leave a row un-retired, never retire one mid-flight.
    const land: Commit = { sha: "land0738", subject: "feat(ob 738): the loop", body: "" };
    expect((await reconcile(db, [land])).merged).toEqual([]);
    expect((await listSpinoffs(db, "launched")).map((r) => r.ticket_ref)).toEqual(["738"]);
  });

  test("the branch-merged and ticket-done paths are unchanged", async () => {
    const branchDb = freshDb();
    await seedLaunched(branchDb, {});
    const byBranch = await reconcileSpinoffs(branchDb, () => true, undefined, () => 1, "", localSpinoffSteps(branchDb), () => []);
    expect(byBranch.merged).toEqual(["738"]);

    const doneDb = freshDb();
    const done = await createItem(doneDb, { type: "task", title: "landed", status: "done" });
    await seedLaunched(doneDb, { ticket: done, branch: done });
    const byDone = await reconcile(doneDb, []);
    // The row carries the item's ref (1949): enqueue renames a numbered ticket to it.
    expect(byDone.merged).toEqual(["OB-1"]);
  });
});

describe("the two pure gates (1201)", () => {
  test("workHasLanded: a docs/chart note never counts, however the ticket is named", () => {
    const opts = { status: "open" };
    expect(workHasLanded("738", { ...opts, commits: [CHART_738] })).toBe(false);
    expect(workHasLanded("911", { ...opts, commits: [{ sha: "c", subject: "chart(ob 911): out of scope", body: "" }] })).toBe(false);
    expect(workHasLanded("738", { ...opts, commits: [{ sha: "c", subject: "feat(ob 738): the loop", body: "" }] })).toBe(true);
    expect(workHasLanded("738", { ...opts, commits: [{ sha: "c", subject: "Merge ob 738: the loop", body: "" }] })).toBe(true);
  });

  test("landsTicket: a land is a merge subject or any conventional scope EXCEPT the documentation pair", () => {
    expect(landsTicket({ sha: "a", subject: "Merge ob 77: theme sync", body: "" })).toBe(true);
    expect(landsTicket({ sha: "a", subject: "feat(ob 77): paint", body: "" })).toBe(true);
    expect(landsTicket({ sha: "a", subject: "fix(#102): zoom", body: "" })).toBe(true);
    expect(landsTicket({ sha: "a", subject: "chore(ob 915): delete the app", body: "" })).toBe(true);
    expect(landsTicket({ sha: "a", subject: "docs(ob 738): the map", body: "" })).toBe(false);
    expect(landsTicket({ sha: "a", subject: "chart(ob 911): out of scope", body: "" })).toBe(false);
    expect(landsTicket({ sha: "a", subject: "not a conventional subject", body: "" })).toBe(false);
  });

  test("an explicit closing keyword still lands when the subject is not conventional (932 kept)", () => {
    const closes: Commit = { sha: "c", subject: "Update the thing", body: "Closes ob 738" };
    expect(landsTicket(closes)).toBe(true);
    expect(workHasLanded("738", { status: "open", commits: [closes] })).toBe(true);
    expect(workHasLanded("917", { status: "open", commits: [closes] })).toBe(false);
    // …and a docs/chart note claiming a close is still a note, never a land (1201's acceptance).
    expect(landsTicket({ sha: "d", subject: "docs(ob 738): the map", body: "Closes ob 738" })).toBe(false);
  });

  test("commitsSinceBase: newest-first, before the base is out; no base keeps all, an unfound base keeps none", () => {
    const commits: Commit[] = [
      { sha: "new", subject: "feat(ob 1): a", body: "" },
      BASE_738,
      CHART_738,
    ];
    expect(commitsSinceBase(commits, BASE_738.sha).map((c) => c.sha)).toEqual(["new"]);
    expect(commitsSinceBase(commits, null).map((c) => c.sha)).toEqual(["new", BASE_738.sha, CHART_738.sha]);
    expect(commitsSinceBase(commits, "not-in-this-log")).toEqual([]);
  });
});

describe("docs (1201)", () => {
  test("HELP and README say the signal is a LANDING commit, and name the docs/chart exclusion", () => {
    expect(HELP).toContain("never a 'chart('/'docs(' note");
    expect(HELP).toContain("never one older than the row's captured base_sha, 1201");
    expect(README).toContain("never a `docs(ob N): …` or `chart(…)` note");
    expect(README).toContain("never one older than the row's captured `base_sha`");
    expect(README).toContain("claims no landing at all");
    expect(README).toContain("never a `docs(ob N): …`/`chart(…)` note");
  });
});
