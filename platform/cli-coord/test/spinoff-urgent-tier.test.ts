import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { spinoffLaunchable, spinoffStamp } from "../../../apps/cli/src/api/handlers.ts";
import { TIER_COMPLEXITY } from "../../../apps/cli/src/models-file.ts";
import { PRIORITY_CRITICAL, PRIORITY_FLAKE, PRIORITY_HIGH, PRIORITY_LOW, PRIORITY_MEDIUM, PRIORITY_URGENT } from "../../../apps/cli/src/priority.ts";
import { __setSh, claimSpinoffRow, drainSpinoffs, enqueueSpinoff, launchedUrgentNote, listSpinoffs, renderLaunchedLine, renderQueuedLine, stampArgv, urgentLaunchRow, type SpinoffRow } from "../src/commands/spinoff.ts";

// OB-2075: a ticket at priority `urgent` always builds on the complex tier (Opus), whatever `--tier` named.
// Enforced at queue time (the row records complex) and again at launch (a priority raised after queueing).

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function fixture(): { repo: string; t3: FakeT3Install } {
  const repo = join(mkdtempSync(join(tmpdir(), "ob-urgent-tier-")), "acme");
  mkdirSync(join(repo, ".git"), { recursive: true });
  cleanup.push(() => rmSync(join(repo, ".."), { recursive: true, force: true }));
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  cleanup.push(restoreSh);
  const t3 = installFakeT3([repo]);
  cleanup.push(t3.restore);
  return { repo, t3 };
}

async function ticket(db: ReturnType<typeof freshDb>, priority: number, title = "A ticket"): Promise<string> {
  const ref = await createItem(db, { type: "task", title });
  await editItem(db, ref, { priority });
  return ref;
}

async function queue(db: ReturnType<typeof freshDb>, repo: string, ref: string, tier?: "complex" | "medium" | "simple", complexity?: number) {
  const branch = `ob-${ref}`;
  const worktree = `${repo}.${branch}`;
  mkdirSync(worktree, { recursive: true });
  cleanup.push(() => rmSync(worktree, { recursive: true, force: true }));
  return enqueueSpinoff(db, { ticketRef: ref, repo, branch, worktree, mode: "interactive", brief: "do it", launcher: "t3", ...(tier !== undefined ? { tier } : {}), ...(complexity !== undefined ? { complexity } : {}) });
}

describe("an urgent ticket builds on complex (OB-2075)", () => {
  test.each([["medium"], ["simple"], [undefined]] as const)("queue time: urgent with --tier %s records complex and launches on Opus", async (named) => {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const ref = await ticket(db, PRIORITY_URGENT);
    const { row, urgent, raisedFrom } = await queue(db, repo, ref, named);
    expect(row.tier).toBe("complex");
    expect(urgent).toBe(true);
    expect(row.complexity).toBe(7);
    expect(raisedFrom).toBe(named ? TIER_COMPLEXITY[named] : null);

    const res = await drainSpinoffs(db);
    expect(res.failed).toEqual([]);
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]!.modelSelection.model).toBe(OPUS);
    const after = (await listSpinoffs(db))[0] as SpinoffRow;
    expect(after.tier).toBe("complex");
    expect(after.model).toBe(OPUS);
  });

  test("OS-108: a critical ticket, which ranks above urgent, records complex too", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_CRITICAL);
    const { row, urgent, raisedFrom } = await queue(db, repo, ref, "simple");
    expect(row.tier).toBe("complex");
    expect(urgent).toBe(true);
    expect(raisedFrom).toBe(2);
  });

  test("OS-177: urgent raises a score to max(score, 7): 4 dispatches at 7, 9 stays 9", async () => {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const four = await queue(db, repo, await ticket(db, PRIORITY_URGENT, "four"), undefined, 4);
    expect(four.row.complexity).toBe(7);
    expect(four.row.tier).toBe("complex");
    expect(four.raisedFrom).toBe(4);
    const nine = await queue(db, repo, await ticket(db, PRIORITY_URGENT, "nine"), undefined, 9);
    expect(nine.row.complexity).toBe(9);
    expect(nine.raisedFrom).toBeNull();
    const plain = await queue(db, repo, await ticket(db, PRIORITY_HIGH, "plain"), undefined, 4);
    expect(plain.row.complexity).toBe(4);
    expect(plain.urgent).toBe(false);
    const res = await drainSpinoffs(db);
    expect(res.failed).toEqual([]);
    const byTitle = new Map(t3.launches.map((l) => [l.title, l.modelSelection.model]));
    expect([...byTitle.values()].filter((m) => m === OPUS)).toHaveLength(2);
    expect([...byTitle.values()]).toContain(SONNET);
  });

  test("the queue line says the tier was raised, and from what", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_URGENT);
    const { row } = await queue(db, repo, ref, "medium");
    expect(renderQueuedLine(row, false, true, { from: 5 })).toContain("complexity 7/10 (complex, urgent, raised from 5)");
    expect(renderQueuedLine(row, false, false, { from: null })).toContain("complexity 7/10 (complex, urgent)");
    expect(renderQueuedLine(row, false, false, { from: null })).not.toContain("(default)");
  });

  test("the launched line carries the urgent note, and a plain one does not", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_URGENT);
    const { row } = await queue(db, repo, ref, "medium");
    expect(renderLaunchedLine(row, "t3-1", OPUS, false, true, null, { from: 5 })).toContain("complexity 7/10 (complex, urgent, raised from 5)");
    expect(renderLaunchedLine(row, "t3-1", SONNET, false, true, null, null)).not.toContain("urgent");
    // an urgent ref queued with no --tier and then adopted onto a thread prints complex, never "complex (default)"
    expect(renderLaunchedLine(row, "t3-1", SONNET, false, false, null, null)).toMatch(/complexity 7\/10 \(complex\)$/);
    expect(launchedUrgentNote({ from: 5 }, false)).toEqual({ from: 5 });
    expect(launchedUrgentNote({ from: 5 }, true)).toBeNull();
  });

  test("launch time: a medium row whose item is made urgent afterwards launches on Opus and reads complex", async () => {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const ref = await ticket(db, PRIORITY_MEDIUM);
    const { row, urgent } = await queue(db, repo, ref, "medium");
    expect(urgent).toBe(false);
    expect(row.tier).toBe("medium");

    await editItem(db, ref, { priority: PRIORITY_URGENT });
    const res = await drainSpinoffs(db);
    expect(res.failed).toEqual([]);
    expect(t3.launches[0]!.modelSelection.model).toBe(OPUS);
    const after = (await listSpinoffs(db))[0] as SpinoffRow;
    expect(after.tier).toBe("complex");
    expect(after.model).toBe(OPUS);
  });

  test("a re-dispatch of a still-pending urgent row re-rates it to complex", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_MEDIUM);
    const first = await queue(db, repo, ref, "simple");
    expect(first.row.tier).toBe("simple");
    await editItem(db, ref, { priority: PRIORITY_URGENT });
    const again = await queue(db, repo, ref, "medium");
    expect(again.deduped).toBe(true);
    expect(again.row.tier).toBe("complex");
    expect(again.raisedFrom).toBe(5);
  });

  test("a re-dispatch with no --tier still says which tier an urgent pending row was raised from", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_MEDIUM);
    await queue(db, repo, ref, "simple");
    await editItem(db, ref, { priority: PRIORITY_URGENT });
    const again = await queue(db, repo, ref, undefined);
    expect(again.row.tier).toBe("complex");
    expect(again.raisedFrom).toBe(2);
  });

  test.each([
    ["flake", PRIORITY_FLAKE],
    ["high", PRIORITY_HIGH],
    ["low", PRIORITY_LOW],
  ])("a %s ticket keeps the tier it was given", async (_name, priority) => {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const ref = await ticket(db, priority);
    const { row, urgent, raisedFrom } = await queue(db, repo, ref, "medium");
    expect(row.tier).toBe("medium");
    expect(urgent).toBe(false);
    expect(raisedFrom).toBeNull();
    const drained = await drainSpinoffs(db);
    expect(drained.failed).toEqual([]);
    expect(t3.launches[0]!.modelSelection.model).toBe(SONNET);
    expect(((await listSpinoffs(db))[0] as SpinoffRow).tier).toBe("medium");
  });

  test("a trial leg and a ref with no item keep the tier they were given", async () => {
    const db = freshDb();
    const { repo } = fixture();
    const ref = await ticket(db, PRIORITY_URGENT);
    const leg = await enqueueSpinoff(db, { ticketRef: ref, repo, branch: `${ref.toLowerCase()}-b`, mode: "interactive", brief: "b", launcher: "t3", tier: "medium", trialLeg: "b", trialModel: "opencode:x" });
    expect(leg.row.tier).toBe("medium");
    expect((await urgentLaunchRow(db, leg.row)).raisedFrom).toBeNull();

    const noItem = await enqueueSpinoff(db, { ticketRef: "zz-no-such", repo, branch: "zz-no-such", mode: "interactive", brief: "b", launcher: "t3", tier: "simple" });
    expect(noItem.row.tier).toBe("simple");
    expect(noItem.urgent).toBe(false);
  });
});

describe("an urgent row meets a thread that already exists (OB-2075)", () => {
  async function medium() {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const ref = await ticket(db, PRIORITY_MEDIUM);
    const { row } = await queue(db, repo, ref, "medium");
    t3.threads.push({
      threadId: "t3-old", projectId: "proj-0", title: `${row.ticket_ref} · old`, status: "running", worktreePath: row.worktree, branch: row.branch,
      settled: false, archived: false, model: SONNET, providerInstanceId: "claudeAgent", activeRunId: "run-old", latestRunId: "run-old",
    });
    await editItem(db, ref, { priority: PRIORITY_URGENT });
    return { db, t3, row };
  }

  test("an unsettled Sonnet thread is adopted on its own model and the row keeps its tier", async () => {
    const { db, t3, row } = await medium();
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    let res;
    try {
      res = await drainSpinoffs(db);
    } finally {
      process.stderr.write = write;
    }
    expect(err.join("")).toContain(`${row.ticket_ref} is urgent, but its adopted T3 thread keeps its model`);
    expect(res.failed).toEqual([]);
    expect(t3.launches).toHaveLength(0);
    const after = (await listSpinoffs(db)).find((r) => r.id === row.id) as SpinoffRow;
    expect(after.status).toBe("launched");
    expect(after.t3_thread_id).toBe("t3-old");
    expect(after.model).toBe(SONNET);
    expect(after.tier).toBe("medium");
  });

  test("over the API the list hands the client the raised row without writing it, and the stamp of a non-adopted launch records the raise", async () => {
    const { db, row } = await medium();
    const store = asStore(db);
    const listed = await spinoffLaunchable(store, {});
    expect(listed.rows[0]!.row.tier).toBe("complex");
    expect(listed.rows[0]!.raised_from).toBe(5);
    expect(((await listSpinoffs(db)).find((r) => r.id === row.id) as SpinoffRow).tier).toBe("medium");

    await claimSpinoffRow(db, row.id);
    await spinoffStamp(store, { id: row.id, outcome: "launched", model: OPUS, raised: true });
    expect(((await listSpinoffs(db)).find((r) => r.id === row.id) as SpinoffRow).tier).toBe("complex");
  });

  test("over the API the stamp of an adopted launch leaves the row's tier alone", async () => {
    const { db, row } = await medium();
    await claimSpinoffRow(db, row.id);
    await spinoffStamp(asStore(db), { id: row.id, outcome: "launched", model: SONNET, raised: false });
    expect(((await listSpinoffs(db)).find((r) => r.id === row.id) as SpinoffRow).tier).toBe("medium");
  });

  test("a row queued urgent (already complex) meets an unsettled Sonnet thread: adopted, not refused", async () => {
    const db = freshDb();
    const { repo, t3 } = fixture();
    const ref = await ticket(db, PRIORITY_URGENT);
    const { row } = await queue(db, repo, ref, "medium");
    expect(row.tier).toBe("complex");
    t3.threads.push({
      threadId: "t3-old", projectId: "proj-0", title: `${row.ticket_ref} · old`, status: "running", worktreePath: row.worktree, branch: row.branch,
      settled: false, archived: false, model: SONNET, providerInstanceId: "claudeAgent", activeRunId: "run-old", latestRunId: "run-old",
    });
    const res = await drainSpinoffs(db);
    expect(res.failed).toEqual([]);
    expect(t3.launches).toHaveLength(0);
    const after = (await listSpinoffs(db)).find((r) => r.id === row.id) as SpinoffRow;
    expect(after.t3_thread_id).toBe("t3-old");
    expect(after.model).toBe(SONNET);
  });

  test("the stamp argv carries --raised, so a remote stamp records the raise", () => {
    expect(stampArgv({ id: 3, outcome: "launched", raised: true })).toContain("--raised");
    expect(stampArgv({ id: 3, outcome: "launched" })).not.toContain("--raised");
  });
});
