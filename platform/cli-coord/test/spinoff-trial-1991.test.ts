// OB-1991: the model trial. The next N medium dispatches run twice (leg a, leg b), a blind review picks the
// winner, and only the winner lands. In-process against fresh SQLite databases, a fake T3 seam and a faked
// shell: no network, no live store, no live opencode or Claude data (fixtures under the test scratch).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { PRIORITY_FLAKE } from "../../../apps/cli/src/priority.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { __setSh, moveSpinoff, ownLegFirst, pickSpinoffForState, tokensForRow, trialStoreDeps } from "../src/commands/spinoff.ts";
import { encodeCwd, readOpencodeSpinoffUsage, readSpinoffTokens, tokenSourceFor } from "../src/spinoff-tokens.ts";
import {
  blindPair,
  buildTrialReport,
  collectLegMeasures,
  dispatchTrialPair,
  lateLegs,
  noteLegHandoff,
  openPair,
  parseNotesFile,
  parseScore,
  pickWinner,
  renderBlindPair,
  renderTrialReport,
  runTrialOp,
  type PairRow,
  type TrialOpRequest,
} from "../src/spinoff-trial.ts";
import { liveMeasureDeps, runTrialCli } from "../src/spinoff-trial-cli.ts";

const BODY = "Need.\n\n## Drilled\n- read\n\n## Done when\n- one\n- two\n- three\n\n## Out of scope\nnothing";
const A = "claudeAgent:claude-sonnet-5-5";
const B = "opencode:opencode-go/deepseek-v4.1-flash#high";
const OPENCODE = [
  {
    providerInstanceId: "opencode",
    displayName: "OpenCode",
    models: [{ id: "opencode-go/deepseek-v4.1-flash", options: [{ id: "variant", values: ["low", "medium", "high"] }] }],
  },
];
const MODEL_WORDS = /sonnet|deepseek|claudeAgent|opencode|claude-|leg a|leg b|"a"|"b"/i;

async function ticket(dbPath = freshDbPath(), body = BODY): Promise<{ dbPath: string; id: string }> {
  const db = openDb(dbPath);
  const id = await createItem(db, { type: "task", title: "trialled", body });
  db.close();
  return { dbPath, id };
}

const start = (dbPath: string, ...extra: string[]) => runCli(dbPath, ["spinoff", "trial", "start", "--a", A, "--b", B, ...extra]);

type Launch = { title: string; message?: string; modelSelection: { instanceId: string; model: string; options?: unknown } };

/** `ob spinoff <id>` with T3 and the shell faked: a launch is recorded, never made. */
async function dispatch(dbPath: string, id: string, repo: string, extra: string[] = [], onLaunch?: (i: Launch) => void) {
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3([repo], onLaunch as never, {}, OPENCODE);
  const wt = mkdtempSync(join(tmpdir(), "ob-1991-"));
  mkdirSync(`${wt}-b`);
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "same brief", "--no-check", "fixture", ...extra]);
    return { ...r, launches: t3.launches as Launch[], wt };
  } finally {
    t3.restore();
    restoreSh();
  }
}

interface Row {
  id: number;
  ticket_ref: string;
  branch: string;
  worktree: string;
  status: string;
  model: string | null;
  effort: string | null;
  trial_leg: string | null;
  agent_id: string | null;
  brief: string;
  error: string | null;
}
const rowsOf = async (dbPath: string): Promise<Row[]> => (JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as Row[]).sort((a, b) => a.id - b.id);

/** The store op, as the local CLI runs it. */
async function op(dbPath: string, req: TrialOpRequest, now?: () => number) {
  const db = openDb(dbPath);
  try {
    return await runTrialOp(db, req, { ...trialStoreDeps(db), ...(now ? { now } : {}) });
  } finally {
    db.close();
  }
}

async function pairRow(dbPath: string): Promise<PairRow> {
  const res = await op(dbPath, { op: "report" });
  void res;
  const db = openDb(dbPath);
  try {
    return db.query("SELECT * FROM spinoff_trial_pair ORDER BY id DESC LIMIT 1").get() as PairRow;
  } finally {
    db.close();
  }
}

/** One trial, one paired dispatch: the db, the ticket id, the pair, and leg a's / leg b's labels. */
async function pairedTicket(target = 20, extra: string[] = [], handedOff = true) {
  const { dbPath, id } = await ticket();
  expect((await start(dbPath, "--target", String(target), ...extra)).code).toBe(0);
  const d = await dispatch(dbPath, id, fakeRepoDir());
  expect(d.code).toBe(0);
  if (handedOff) {
    // both legs handed off, so the pair can be judged
    const opened = await pairRow(dbPath);
    const db = openDb(dbPath);
    try {
      for (const rowId of [opened.row_a, opened.row_b]) await noteLegHandoff(db, { id: Number(rowId) });
    } finally {
      db.close();
    }
  }
  const pair = await pairRow(dbPath);
  const labelA = pair.label_a as "X" | "Y";
  const labelB = labelA === "X" ? "Y" : "X";
  // trial commands name the pair by its ticket ref (OB-n), not the internal item id
  return { dbPath, id: pair.ticket_ref, itemId: id, pair, labelA, labelB, d };
}

/** Scores for leg a and leg b, written as the reviewer writes them: by label. */
const scoresFor = (labelA: string, a: string, b: string) => (labelA === "X" ? { x: a, y: b } : { x: b, y: a });

describe("Done when 1: a paired dispatch makes two rows (OB-1991)", () => {
  test("<ref> and <ref>-b, distinct leases, the same brief, model and effort stamped", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "20");
    const repo = fakeRepoDir();
    const d = await dispatch(dbPath, id, repo);
    expect(d.code).toBe(0);
    expect(d.out).toContain("two legs, same brief");
    const rows = await rowsOf(dbPath);
    expect(rows.length).toBe(2);
    const [a, b] = rows as [Row, Row];
    expect(a.ticket_ref).toBe(b.ticket_ref);
    expect(a.branch).toBe(`build-${id}`);
    expect(b.branch).toBe(`build-${id}-b`);
    expect(b.worktree).toBe(`${a.worktree}-b`);
    expect(a.agent_id).toBe(`build-${id}`);
    expect(b.agent_id).toBe(`build-${id}-b`);
    expect([a.trial_leg, b.trial_leg]).toEqual(["a", "b"]);
    // the same brief, on both rows and in both launch messages
    expect(a.brief).toBe(b.brief);
    expect(d.launches.length).toBe(2);
    expect(d.launches[0]!.message).toBe(d.launches[1]!.message);
    // model and effort stamped per leg; leg b launched on opencode at variant high
    expect(a.model).toBe(A);
    expect(b.model).toBe("opencode:opencode-go/deepseek-v4.1-flash");
    expect(b.effort).toBe("high");
    expect(d.launches[1]!.modelSelection).toEqual({ instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash", options: [{ id: "variant", value: "high" }] });
    // distinct ticket: leases
    const leases = (await runCli(dbPath, ["lease", "status"])).out;
    const ref = a.ticket_ref;
    expect(leases).toMatch(new RegExp(`ticket:${ref}\\s`, "i"));
    expect(leases).toMatch(new RegExp(`ticket:${ref}-b\\s`, "i"));
  });
});

describe("Done when 2: one row when there is no pairing (OB-1991)", () => {
  test("no trial", async () => {
    const { dbPath, id } = await ticket();
    expect((await dispatch(dbPath, id, fakeRepoDir())).code).toBe(0);
    expect((await rowsOf(dbPath)).length).toBe(1);
  });
  test("--no-trial", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "20");
    expect((await dispatch(dbPath, id, fakeRepoDir(), ["--no-trial"])).code).toBe(0);
    const rows = await rowsOf(dbPath);
    expect(rows.length).toBe(1);
    expect(rows[0]!.trial_leg).toBeNull();
  });
  test("a flake ticket (OB-2230: two legs would be two flake fixes on one machine)", async () => {
    const { dbPath, id } = await ticket();
    const db = openDb(dbPath);
    await editItem(db, id, { priority: PRIORITY_FLAKE });
    db.close();
    await start(dbPath, "--target", "20");
    expect((await dispatch(dbPath, id, fakeRepoDir())).code).toBe(0);
    const rows = await rowsOf(dbPath);
    expect(rows.length).toBe(1);
    expect(rows[0]!.trial_leg).toBeNull();
  });
  test("another tier (simple, complex)", async () => {
    for (const tier of ["simple", "complex"]) {
      const { dbPath, id } = await ticket();
      await start(dbPath, "--target", "20");
      expect((await dispatch(dbPath, id, fakeRepoDir(), ["--tier", tier])).code).toBe(0);
      expect((await rowsOf(dbPath)).length).toBe(1);
    }
  });
  test("OS-177: a trial started with --range 4-4 pairs a score of 4 only; 3 and 7 dispatch single", async () => {
    for (const [score, legs] of [["4", 2], ["3", 1], ["7", 1]] as const) {
      const { dbPath, id } = await ticket();
      expect((await start(dbPath, "--target", "20", "--range", "4-4")).code).toBe(0);
      const d = await dispatch(dbPath, id, fakeRepoDir(), ["--complexity", score]);
      expect(d.code).toBe(0);
      expect(d.launches.length).toBe(legs);
      expect((await rowsOf(dbPath)).length).toBe(legs);
    }
  });
});

describe("Done when 3: blind labels (OB-1991)", () => {
  test("the legs get different labels, and the pair output names no model", async () => {
    const { dbPath, id, pair } = await pairedTicket();
    expect(["X", "Y"]).toContain(pair.label_a);
    const out = (await runCli(dbPath, ["spinoff", "trial", "pair", id])).out;
    expect(out).toContain("X: spinoff #");
    expect(out).toContain("Y: spinoff #");
    expect(out).not.toMatch(MODEL_WORDS);
    const json = (await runCli(dbPath, ["spinoff", "trial", "pair", id, "--json"])).out;
    expect(json).not.toMatch(MODEL_WORDS);
    expect(JSON.parse(json).legs.map((l: { label: string }) => l.label)).toEqual(["X", "Y"]);
  });

  test("labels are drawn per pair, so either leg can be X", async () => {
    const { dbPath } = await ticket();
    expect((await start(dbPath, "--target", "20")).code).toBe(0);
    const db = openDb(dbPath);
    try {
      const trialId = Number((db.query("SELECT id FROM spinoff_trial LIMIT 1").get() as { id: number }).id);
      const draw = async (r: number) => (await openPair(db, { trial_id: trialId, ticket_ref: `OB-${r}`, repo: "acme" }, () => r)).label_a;
      expect(await draw(0.1)).toBe("X");
      expect(await draw(0.9)).toBe("Y");
    } finally {
      db.close();
    }
  });
});

describe("Done when 4: the verdict (OB-1991)", () => {
  test("pure rules: higher wins, a tie goes to a, blocked and partial score 0", () => {
    expect(pickWinner(7, 5)).toBe("a");
    expect(pickWinner(5, 7)).toBe("b");
    expect(pickWinner(6, 6)).toBe("a");
    expect(parseScore("blocked", "X")).toEqual({ score: 0, word: "blocked" });
    expect(parseScore("partial", "Y")).toEqual({ score: 0, word: "partial" });
    expect(() => parseScore("11", "X")).toThrow(/0 to 10/);
  });

  test("the higher label wins, the loser is retired as lost trial pair 1", async () => {
    const { dbPath, id, labelA } = await pairedTicket();
    const s = scoresFor(labelA, "4", "8"); // leg b scores higher
    const r = await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", s.x, "--y", s.y]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${labelA === "X" ? "Y" : "X"} wins`);
    expect(r.out).not.toMatch(/sonnet|deepseek/i);
    const [a, b] = (await rowsOf(dbPath)) as [Row, Row];
    expect(a.status).toBe("failed");
    expect(a.error).toContain("lost trial pair 1");
    expect(b.status).not.toBe("failed");
  });

  test("a tie goes to leg a", async () => {
    const { dbPath, id } = await pairedTicket();
    expect((await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", "6", "--y", "6"])).code).toBe(0);
    const [a, b] = (await rowsOf(dbPath)) as [Row, Row];
    expect(a.status).not.toBe("failed");
    expect(b.status).toBe("failed");
    expect(b.error).toContain("lost trial pair 1");
  });

  test("blocked scores 0 and loses to any score", async () => {
    const { dbPath, id, labelA } = await pairedTicket();
    const s = scoresFor(labelA, "blocked", "1");
    expect((await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", s.x, "--y", s.y])).code).toBe(0);
    const pair = await pairRow(dbPath);
    expect(pair.score_a).toBe(0);
    expect(pair.winner).toBe("b");
  });

  test("a leg more than 24 hours late scores 0", () => {
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const iso = (h: number) => new Date(t0 + h * 3_600_000).toISOString();
    expect(lateLegs({ a_handoff_at: iso(0), b_handoff_at: iso(25) }, t0)).toEqual(["b"]);
    expect(lateLegs({ a_handoff_at: iso(0), b_handoff_at: null }, t0 + 25 * 3_600_000)).toEqual(["b"]);
    expect(lateLegs({ a_handoff_at: null, b_handoff_at: iso(0) }, t0 + 25 * 3_600_000)).toEqual(["a"]);
    expect(lateLegs({ a_handoff_at: iso(0), b_handoff_at: iso(23) }, t0)).toEqual([]);
  });
});

describe("Done when 5: capacity, a failed launch, forfeit (OB-1991)", () => {
  test("at capacity the dispatch is single", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "1");
    const repo = fakeRepoDir();
    await dispatch(dbPath, id, repo);
    const { id: id2 } = await ticket(dbPath);
    expect((await dispatch(dbPath, id2, repo)).code).toBe(0);
    const second = (await rowsOf(dbPath)).filter((r) => r.branch.startsWith(`build-${id2}`));
    expect(second.length).toBe(1);
    expect(second[0]!.trial_leg).toBeNull();
  });

  test("leg b's launch fails: the pair is void, leg a goes on single, and the output says so", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "20");
    const d = await dispatch(dbPath, id, fakeRepoDir(), [], (i) => {
      if (i.modelSelection.instanceId === "opencode") throw new Error("opencode is down");
    });
    expect(d.err).toMatch(/void: leg b did not launch.*Leg a goes on as a single build/s);
    const pair = await pairRow(dbPath);
    expect(pair.status).toBe("void");
    const rows = await rowsOf(dbPath);
    expect(rows.find((r) => r.trial_leg === "a")!.status).toBe("building");
    expect(rows.find((r) => r.trial_leg === "b")!.status).toBe("failed");
    // a void pair does not count toward the target
    expect((await runCli(dbPath, ["spinoff", "trial", "status"])).out).toContain("0/20");
  });

  test("leg a's launch fails: the pair is void and leg b goes on single", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "20");
    const d = await dispatch(dbPath, id, fakeRepoDir(), [], (i) => {
      if (i.modelSelection.instanceId === "claudeAgent") throw new Error("claude is down");
    });
    expect(d.err).toMatch(/void: leg a did not launch.*Leg b goes on as a single build/s);
    expect((await pairRow(dbPath)).status).toBe("void");
    expect((await rowsOf(dbPath)).find((r) => r.trial_leg === "b")!.status).toBe("building");
  });

  test("dispatchTrialPair: a deduped leg a stops the pair without launching leg b", async () => {
    const launched: string[] = [];
    const pair = { id: 9, ticket_ref: "OB-1" } as PairRow;
    const out = await dispatchTrialPair({
      plan: async () => ({ trial: { id: 1, target: 20 } as never, a: { model: A, effort: null }, b: { model: B, effort: "high" } }),
      open: async () => pair,
      leg: async (leg) => {
        launched.push(leg);
        return { row: null, launched: false, error: "already queued", settled: true };
      },
      void: async () => {},
      attach: async () => {},
      say: () => {},
      warn: () => {},
    });
    expect(out).toMatchObject({ kind: "void", single: null });
    expect(launched).toEqual(["a"]);
  });

  test("--forfeit scores the named leg 0 and the other wins", async () => {
    const { dbPath, id, labelA } = await pairedTicket();
    const r = await runCli(dbPath, ["spinoff", "trial", "record", id, "--forfeit", labelA]);
    expect(r.code).toBe(0);
    const pair = await pairRow(dbPath);
    expect(pair.score_a).toBe(0);
    expect(pair.winner).toBe("b");
    const a = (await rowsOf(dbPath)).find((x) => x.trial_leg === "a")!;
    expect(a.status).toBe("failed");
    expect(a.error).toContain("forfeited trial pair 1");
  });

  test("--void voids an open pair and it stops counting", async () => {
    const { dbPath, id } = await pairedTicket(20);
    expect((await runCli(dbPath, ["spinoff", "trial", "record", id, "--void", "--reason", "stale 48h"])).code).toBe(0);
    const pair = await pairRow(dbPath);
    expect(pair.status).toBe("void");
    expect(pair.void_reason).toBe("stale 48h");
  });
});

describe("Done when 6: --diffs writes only the two diffs (OB-1991)", () => {
  test("X.diff and Y.diff, and the output names labels only", async () => {
    const { dbPath, id } = await pairedTicket();
    const dir = mkdtempSync(join(tmpdir(), "ob-1991-diffs-"));
    const printed: string[] = [];
    const db = openDb(dbPath);
    try {
      await runTrialCli(
        { args: ["trial", "pair", id], flags: { diffs: dir }, mode: "human" as never },
        {
          op: (req) => runTrialOp(db, req, trialStoreDeps(db)),
          print: (t) => printed.push(t),
          measures: { tokens: () => null },
          diffOf: (leg) => `diff of ${leg.label}\n`,
          readFile: () => "",
          writeFile: (p, t) => writeFileSync(p, t),
        },
      );
    } finally {
      db.close();
    }
    expect(readdirSync(dir).sort()).toEqual(["X.diff", "Y.diff"]);
    expect(printed.join("\n")).not.toMatch(MODEL_WORDS);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Done when 7: the target ends the trial (OB-1991)", () => {
  test("the target-th verdict makes the trial inactive, and the next dispatch is single", async () => {
    const { dbPath, id } = await pairedTicket(1);
    const r = await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", "5", "--y", "3"]);
    expect(r.out).toContain("reached its target");
    expect((await runCli(dbPath, ["spinoff", "trial", "status"])).out).toMatch(/no model trial is active|not active|ended/i);
    const { id: id2 } = await ticket(dbPath);
    await dispatch(dbPath, id2, fakeRepoDir());
    expect((await rowsOf(dbPath)).filter((x) => x.branch.startsWith(`build-${id2}`)).length).toBe(1);
  });

  test("start refuses while a trial is active; stop voids open pairs and names them", async () => {
    const { dbPath, id } = await pairedTicket(20);
    const again = await start(dbPath, "--target", "5");
    expect(again.code).not.toBe(0);
    expect(again.err).toMatch(/still active/);
    const stop = await runCli(dbPath, ["spinoff", "trial", "stop"]);
    expect(stop.out).toContain("voided pair");
    const db = openDb(dbPath);
    const ticketRef = (db.query("SELECT ticket_ref FROM spinoff_trial_pair").get() as { ticket_ref: string }).ticket_ref;
    db.close();
    expect(stop.out).toContain(ticketRef);
    void id;
    expect((await pairRow(dbPath)).status).toBe("void");
  });
});

describe("Done when 8: the report (OB-1991)", () => {
  const notes = (labelA: string, aDone: boolean[], bDone: boolean[]) =>
    JSON.stringify(
      labelA === "X"
        ? { X: { done: aDone, defects: ["a defect"], notes: "a notes" }, Y: { done: bDone, defects: [], notes: "b notes" } }
        : { X: { done: bDone, defects: [], notes: "b notes" }, Y: { done: aDone, defects: ["a defect"], notes: "a notes" } },
    );

  test("contents and per-model totals; a measure not taken reads 'not recorded', never 0", async () => {
    const { dbPath, id, labelA, labelB } = await pairedTicket(20, ["--a-price", "3,15,3.75,0.3", "--b-price", "0.1,0.4,0,0.01"]);
    const s = scoresFor(labelA, "8", "6");
    const db = openDb(dbPath);
    const pair = db.query("SELECT * FROM spinoff_trial_pair").get() as PairRow;
    db.close();
    const measures = {
      [String(pair.row_a)]: { tokens: { inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 1100 } },
      [String(pair.row_b)]: { tokens: { inputTokens: 2000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 2200 }, opencode_cost: 0.0123 },
    };
    await op(dbPath, { op: "record", ref: id, ...s, notes: notes(labelA, [true, true, false], [true, false, false]), measures });
    await op(dbPath, { op: "feedback", ref: id, label: labelB, note: "too chatty", rating: 2 });
    await op(dbPath, { op: "fix", ref: id, note: "missed an edge" });

    const text = (await runCli(dbPath, ["spinoff", "trial", "report"])).out;
    expect(text).toContain("list price");
    expect(text).toContain("not the bill");
    expect(text).toContain(`winner ${labelA}`);
    expect(text).toContain("done when 2/3");
    expect(text).toContain("done when 1/3");
    expect(text).toContain("feedback 2/5: too chatty");
    expect(text).toContain("fix to the winner: missed an edge");
    expect(text).toContain("opencode reported $0.01");
    // no thread runs, no steers, no gate check read: not recorded, never 0
    expect(text).toContain("active not recorded");
    expect(text).toContain("steers not recorded");
    expect(text).toContain("gate first time not recorded");
    expect(text).not.toMatch(/active 0\.0h|steers 0/);

    const json = JSON.parse((await runCli(dbPath, ["spinoff", "trial", "report", "--json"])).out);
    const [p] = json.pairs;
    expect(p.winner_model).toBe(A);
    const legA = p.legs.find((l: { leg: string }) => l.leg === "a");
    const legB = p.legs.find((l: { leg: string }) => l.leg === "b");
    expect(legA.done).toEqual([true, true, false]);
    expect(legA.defects).toEqual(["a defect"]);
    expect(legA.tokens).toBe(1100);
    expect(legA.dollars).toBeCloseTo((1000 * 3 + 100 * 15) / 1e6, 9);
    expect(legB.tokens).toBe(2200);
    expect(legB.dollars).toBeCloseTo((2000 * 0.1 + 200 * 0.4) / 1e6, 9);
    expect(legB.opencode_cost).toBeCloseTo(0.0123, 9);
    expect(legA.wall_ms).toBeGreaterThanOrEqual(0);
    expect(legA.active_ms).toBeNull();
    const totA = json.totals.find((t: { model: string }) => t.model === A);
    const totB = json.totals.find((t: { model: string }) => t.model !== A);
    expect(totA).toMatchObject({ pairs: 1, wins: 1, mean_score: 8, fixes_7d: 1 });
    expect(totA.done_pct).toBeCloseTo(66.67, 1);
    expect(totB).toMatchObject({ pairs: 1, wins: 0, mean_score: 6, fixes_7d: 0 });
    expect(totB.feedback).toEqual(["too chatty (2/5)"]);
    expect(totB.mean_active_ms).toBeNull();
  });

  test("an empty report reads 'not recorded' for every mean", () => {
    const text = renderTrialReport(
      buildTrialReport(
        { id: 1, name: "t", tier: "medium", target: 20, a_model: A, a_effort: null, b_model: "opencode:x", b_effort: "high", a_price: null, b_price: null, active: 1, started_at: "", ended_at: null, end_reason: null },
        [],
      ),
      false,
    );
    expect(text).toContain("mean score not recorded");
    expect(text).toContain("mean not recorded list");
    expect(text).not.toMatch(/mean score 0/);
  });

  test("8a: a notes file whose count differs from ## Done when is refused, and nothing is recorded", async () => {
    const { dbPath, id, labelA } = await pairedTicket();
    const dir = mkdtempSync(join(tmpdir(), "ob-1991-notes-"));
    const file = join(dir, "notes.json");
    writeFileSync(file, notes(labelA, [true, true], [true, false]));
    const r = await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", "5", "--y", "4", "--notes", file]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/has 2 mark\(s\), but the ticket's ## Done when has 3/);
    expect((await pairRow(dbPath)).status).toBe("open");
    writeFileSync(file, notes(labelA, [true, true, true], [true, false, true]));
    expect((await runCli(dbPath, ["spinoff", "trial", "record", id, "--x", "5", "--y", "4", "--notes", file])).code).toBe(0);
    const stored = JSON.parse((await pairRow(dbPath)).legs!);
    expect(stored.find((l: { leg: string }) => l.leg === "a").done).toEqual([true, true, true]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("8a: parseNotesFile rules", () => {
    expect(() => parseNotesFile("not json", 2)).toThrow(/not JSON/);
    expect(() => parseNotesFile(JSON.stringify({ X: { done: [true] } }), 1)).toThrow(/no entry for Y/);
    expect(parseNotesFile(JSON.stringify({ X: { done: [true] }, Y: { done: [false] } }), null).Y).toEqual({ done: [false], defects: [], notes: "" });
  });

  test("8a: a fix after 7 days is refused", async () => {
    const { dbPath, id } = await pairedTicket();
    await op(dbPath, { op: "record", ref: id, x: "5", y: "4" });
    await expect(op(dbPath, { op: "fix", ref: id, note: "late" }, () => Date.now() + 8 * 24 * 3_600_000)).rejects.toThrow(/7 days/);
  });
});

describe("Done when 8b: tokens follow the model's provider (OB-1991)", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "ob-1991-tok-"));
  const opencodeDb = (path: string, tables: Array<"session" | "session_v2">, dir: string) => {
    const db = new Database(path);
    for (const t of tables) {
      db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, directory TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_write INTEGER, tokens_cache_read INTEGER, cost REAL)`);
      db.prepare(`INSERT INTO ${t} VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`${t}-1`, dir, 100, 10, 5, 1000, 0.25);
    }
    db.close();
  };
  const claudeTranscript = (home: string, worktree: string) => {
    const dir = join(home, ".claude", "projects", encodeCwd(worktree));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s.jsonl"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 40, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 400 } } }) + "\n",
    );
  };

  test("a claudeAgent: model stamped engine opencode reads the Claude transcripts (record time and an ordinary land)", () => {
    const row = { engine: "opencode", model: "claudeAgent:claude-sonnet-5-5" };
    expect(tokenSourceFor(row)).toBe("claude");
    expect(tokensForRow(row)).toBe(readSpinoffTokens);
    expect(tokenSourceFor({ engine: "claude", model: "opencode:opencode-go/deepseek-v4.1-flash" })).toBe("opencode");
    expect(tokenSourceFor({ engine: "opencode", model: null })).toBe("opencode");
    expect(tokenSourceFor({ engine: null, model: null })).toBe("claude");
  });

  test("opencode: only session_v2 reads; both tables sum", () => {
    const d = scratch();
    const wt = join(d, "wt");
    opencodeDb(join(d, "v2.db"), ["session_v2"], wt);
    opencodeDb(join(d, "both.db"), ["session", "session_v2"], wt);
    const v2 = readOpencodeSpinoffUsage(wt, join(d, "v2.db"));
    expect(v2.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheCreationTokens: 5, cacheReadTokens: 1000, totalTokens: 1115 });
    expect(v2.cost).toBeCloseTo(0.25, 9);
    const both = readOpencodeSpinoffUsage(wt, join(d, "both.db"));
    expect(both.usage.totalTokens).toBe(2230);
    expect(both.cost).toBeCloseTo(0.5, 9);
    rmSync(d, { recursive: true, force: true });
  });

  test("record time: tokens and dollars are stored for both legs, plus opencode's cost", async () => {
    const { dbPath, id } = await pairedTicket(20, ["--a-price", "3,15,3.75,0.3", "--b-price", "1,2,0,0.1"]);
    const rows = await rowsOf(dbPath);
    const a = rows.find((r) => r.trial_leg === "a")!;
    const b = rows.find((r) => r.trial_leg === "b")!;
    const d = scratch();
    claudeTranscript(d, a.worktree);
    opencodeDb(join(d, "oc.db"), ["session_v2"], b.worktree);
    // leg a's row is a T3 row stamped engine opencode on a claudeAgent: model
    const db = openDb(dbPath);
    db.query("UPDATE spinoff SET engine = 'opencode' WHERE id = ?").run(a.id);
    const blind = await blindPair(db, id);
    db.close();
    const measures = await collectLegMeasures(blind, liveMeasureDeps(null, { home: d, opencodeDb: join(d, "oc.db") }));
    await op(dbPath, { op: "record", ref: id, x: "5", y: "5", measures });
    const legs = JSON.parse((await pairRow(dbPath)).legs!) as Array<{ leg: string; tokens: number; dollars: number; opencode_cost: number | null }>;
    const la = legs.find((l) => l.leg === "a")!;
    const lb = legs.find((l) => l.leg === "b")!;
    expect(la.tokens).toBe(446);
    expect(la.dollars).toBeCloseTo((40 * 3 + 4 * 15 + 2 * 3.75 + 400 * 0.3) / 1e6, 9);
    expect(la.opencode_cost).toBeNull();
    expect(lb.tokens).toBe(1115);
    expect(lb.dollars).toBeCloseTo((100 * 1 + 10 * 2 + 5 * 0 + 1000 * 0.1) / 1e6, 9);
    expect(lb.opencode_cost).toBeCloseTo(0.25, 9);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("Done when 9: one counter across repos (OB-1991)", () => {
  test("a dispatch in a second repo counts toward the same target", async () => {
    const { dbPath, id } = await ticket();
    await start(dbPath, "--target", "1");
    await dispatch(dbPath, id, fakeRepoDir());
    const { id: id2 } = await ticket(dbPath);
    await dispatch(dbPath, id2, fakeRepoDir());
    expect((await rowsOf(dbPath)).filter((r) => r.branch.startsWith(`build-${id2}`)).length).toBe(1);
  });
});

describe("gateable and the leg's own row (OB-1991)", () => {
  test("gateable shows the pair as one entry with both row ids and a pair field, and no model", async () => {
    const { dbPath, pair } = await pairedTicket();
    const db = openDb(dbPath);
    await moveSpinoff(db, pair.row_a!, "handoff");
    await moveSpinoff(db, pair.row_b!, "handoff");
    db.close();
    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    try {
      const json = JSON.parse((await runCli(dbPath, ["spinoff", "gateable", "--json"])).out) as Array<{ ids?: number[]; pair?: unknown; model: string | null }>;
      expect(json.length).toBe(1);
      expect(json[0]!.ids!.sort((x, y) => x - y)).toEqual([pair.row_a!, pair.row_b!].sort((x, y) => x - y));
      expect(json[0]!.pair).toBeTruthy();
      expect(json[0]!.model).toBeNull();
      const text = (await runCli(dbPath, ["spinoff", "gateable"])).out;
      expect(text).toContain("land the winner only");
      expect(text).not.toMatch(/sonnet|deepseek/i);
    } finally {
      restoreSh();
    }
  });

  test("half a pair is one entry, not landable, naming the leg still building; record refuses it", async () => {
    const { dbPath, pair, labelA, id } = await pairedTicket(20, [], false);
    const db = openDb(dbPath);
    await moveSpinoff(db, pair.row_b!, "handoff");
    await noteLegHandoff(db, { id: pair.row_b! });
    db.close();
    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    try {
      const json = JSON.parse((await runCli(dbPath, ["spinoff", "gateable", "--json"])).out) as Array<{ landable: boolean; pair?: { building: string[] } }>;
      expect(json.length).toBe(1);
      expect(json[0]!.landable).toBe(false);
      expect(json[0]!.pair!.building).toEqual([labelA]);
      expect((await runCli(dbPath, ["spinoff", "gateable"])).out).toContain(`${labelA} still building`);
    } finally {
      restoreSh();
    }
    await expect(op(dbPath, { op: "record", ref: id, ...scoresFor(labelA, "5", "7") })).rejects.toThrow(`${labelA} not handed off yet`);
    expect((await pairRow(dbPath)).status).toBe("open");
  });

  test("a leg's own handoff or state picks its own row by worktree, then branch", () => {
    const rows = [
      { id: 1, worktree: "/w/a", branch: "ob-1" },
      { id: 2, worktree: "/w/a-b", branch: "ob-1-b" },
    ];
    expect(ownLegFirst(rows, { cwd: "/w/a-b" })!.id).toBe(2);
    expect(ownLegFirst(rows, { cwd: "/elsewhere", branch: "ob-1-b" })!.id).toBe(2);
    expect(ownLegFirst(rows, { cwd: "/elsewhere", branch: null })!.id).toBe(1);
    const full = rows.map((r) => ({ ...r, ticket_ref: "OB-1", status: "launched" })) as never[];
    expect(pickSpinoffForState(full, "OB-1", null, { cwd: "/w/a-b" }).id).toBe(2);
  });

  test("renderBlindPair never prints a branch, a model or a leg letter", () => {
    const leg = (label: "X" | "Y", n: number) => ({ label, row_id: n, branch: `secret-branch-${n}`, base_sha: null, worktree: "/w", status: "launched", handed_off: false, engine: "opencode", model: "opencode:deepseek", thread_id: "t", handoff_at: null });
    const out = renderBlindPair({ pair_id: 1, ticket: "OB-1", status: "open", legs: [leg("X", 1), leg("Y", 2)] }, false);
    expect(out).not.toMatch(/secret-branch|deepseek|opencode/);
  });
});
