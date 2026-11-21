// OB-2230: `ob spinoff` runs one flake fix at a time on the whole machine (the `flake:slot` lease) and tells a
// flake builder to test inside `flake-box`. In-process against fresh SQLite databases, a fake T3 and a faked
// shell: no network, no live store, no real box. That the box itself enforces its cpuset and memory is not ob's
// code and was checked live by the architect.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeRepoDir, freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { renderCommandHelp } from "../../../apps/cli/src/cli.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { PRIORITY_FLAKE, PRIORITY_MEDIUM } from "../../../apps/cli/src/priority.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { enqueue as apiEnqueue } from "../../../apps/cli/src/api/handlers.ts";
import { registerAgent } from "../src/agent.ts";
import { finishAgent } from "../src/agent-register.ts";
import { acquireLeases, liveHold } from "../src/lease.ts";
import { abandonSpinoff } from "../src/spinoff-abandon.ts";
import {
  __setSh,
  claimSpinoffRow,
  drainSpinoffs,
  enqueueSpinoff,
  landSpinoff,
  listSpinoffs,
  markSpinoffReady,
  markSpinoffSentBack,
  spinoffAskFor,
  withFlakeBoxBrief,
  type SpinoffRow,
} from "../src/commands/spinoff.ts";
import { __setFlakeBoxPresent, FLAKE_SLOT_KEY, FLAKE_SLOT_TTL_S, recordNoFlakeSlot } from "../src/spinoff-flake.ts";

const DIRECTIVE = "Run the `ob-spinoff` skill now and follow it end to end (it is in your skills; invoke it).";
const NO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** The faked shell and box every test runs under; T3 is installed by the caller that needs it. */
function seams(box = true): void {
  cleanup.push(__setSh(() => ({ ok: true, err: "", out: "" })));
  cleanup.push(__setFlakeBoxPresent(() => box));
}

async function ticket(db: Parameters<typeof createItem>[0], priority: number, title = "A ticket"): Promise<string> {
  const id = await createItem(db, { type: "task", title, body: "## Drilled\n- read\n\n## Done when\n- a test" });
  await editItem(db, id, { priority });
  return id;
}

// ---------------------------------------------------------------------------------------------------------
// Dispatch, through the real `ob spinoff <ref>` handler.

async function cliTicket(dbPath: string, priority: number): Promise<string> {
  const db = openDb(dbPath);
  try {
    return await ticket(db, priority);
  } finally {
    db.close();
  }
}

async function dispatch(dbPath: string, repo: string, id: string, ...extra: string[]) {
  const t3 = installFakeT3([repo]);
  const wt = mkdtempSync(join(tmpdir(), "ob-2230-"));
  try {
    const r = await runCli(dbPath, ["spinoff", id, "--repo", repo, "--branch", `build-${id}`, "--worktree", wt, "--brief", "b", "--no-check", "test", ...extra]);
    return { ...r, launches: t3.launches };
  } finally {
    t3.restore();
    rmSync(wt, { recursive: true, force: true });
  }
}

const rowCount = async (dbPath: string): Promise<number> => JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out).length;

async function slotHolder(dbPath: string): Promise<string | null> {
  const db = openDb(dbPath);
  try {
    return (await liveHold(db, FLAKE_SLOT_KEY))?.holder ?? null;
  } finally {
    db.close();
  }
}

describe("one flake fix at a time (OB-2230)", () => {
  test("with one flake row building, a second flake dispatch exits 1 naming the holder and leaves no row", async () => {
    seams();
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const first = await cliTicket(dbPath, PRIORITY_FLAKE);
    const second = await cliTicket(dbPath, PRIORITY_FLAKE);

    const a = await dispatch(dbPath, repo, first);
    expect(a.code).toBe(0);
    expect(a.launches).toHaveLength(1);
    expect(await slotHolder(dbPath)).toBe(`build-${first}`);

    const b = await dispatch(dbPath, repo, second);
    expect(b.code).toBe(1);
    expect(b.err).toContain(`flake:slot held by build-${first} for OB-${first}; one flake fix at a time`);
    expect(b.err).toContain("Nothing was queued");
    expect(b.launches).toHaveLength(0);
    expect(await rowCount(dbPath)).toBe(1);
    expect(await slotHolder(dbPath)).toBe(`build-${first}`);
  });

  test("a non-flake dispatch while a flake row builds is unaffected", async () => {
    seams();
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const flake = await cliTicket(dbPath, PRIORITY_FLAKE);
    const plain = await cliTicket(dbPath, PRIORITY_MEDIUM);
    expect((await dispatch(dbPath, repo, flake)).code).toBe(0);

    const r = await dispatch(dbPath, repo, plain);
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    expect(await rowCount(dbPath)).toBe(2);
    // the plain build neither took nor touched the slot
    expect(await slotHolder(dbPath)).toBe(`build-${flake}`);
  });

  test("--no-flake-slot launches a second flake without the slot and puts the reason on the trail", async () => {
    seams();
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const first = await cliTicket(dbPath, PRIORITY_FLAKE);
    const second = await cliTicket(dbPath, PRIORITY_FLAKE);
    expect((await dispatch(dbPath, repo, first)).code).toBe(0);

    const r = await dispatch(dbPath, repo, second, "--no-flake-slot", "The owner said run both");
    expect(r.code).toBe(0);
    expect(r.launches).toHaveLength(1);
    expect(await slotHolder(dbPath)).toBe(`build-${first}`);
    const db = openDb(dbPath);
    try {
      const trail = await decisionsForItem(db, second);
      const override = trail.find((d) => d.to === "no-flake-slot");
      expect(override?.note).toBe("The owner said run both");
      expect(override?.spinoff_row).toBe((await listSpinoffs(db)).find((row) => row.ticket_ref === `OB-${second}`)!.id);
    } finally {
      db.close();
    }
  });

  test("a blank --no-flake-slot is refused", async () => {
    seams();
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const id = await cliTicket(dbPath, PRIORITY_FLAKE);
    const r = await dispatch(dbPath, repo, id, "--no-flake-slot", "  ");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--no-flake-slot needs a reason");
    expect(await rowCount(dbPath)).toBe(0);
  });

  test("a flake dispatch on a machine with no box warns and still launches", async () => {
    seams(false);
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const id = await cliTicket(dbPath, PRIORITY_FLAKE);
    const r = await dispatch(dbPath, repo, id);
    expect(r.code).toBe(0);
    expect(r.err).toContain("/usr/local/bin/flake-box is not on this machine");
    expect(r.launches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The claim, and every path that frees the slot.

function storeFixture(): { db: ReturnType<typeof freshDb>; repo: string } {
  seams();
  const db = freshDb();
  const repo = join(mkdtempSync(join(tmpdir(), "ob-2230-store-")), "acme");
  mkdirSync(join(repo, ".git"), { recursive: true });
  cleanup.push(() => rmSync(join(repo, ".."), { recursive: true, force: true }));
  return { db, repo };
}

async function queue(db: ReturnType<typeof freshDb>, repo: string, ref: string): Promise<SpinoffRow> {
  const branch = `ob-${ref}`;
  const worktree = `${repo}.${branch}`;
  mkdirSync(worktree, { recursive: true });
  cleanup.push(() => rmSync(worktree, { recursive: true, force: true }));
  return (await enqueueSpinoff(db, { ticketRef: ref, repo, branch, worktree, mode: "interactive", brief: "do it", launcher: "t3" })).row;
}

/** Queue and claim a flake row the way a launch does; registers its agent as the builder would. */
async function claimed(db: ReturnType<typeof freshDb>, repo: string, ref: string): Promise<SpinoffRow> {
  const row = await queue(db, repo, ref);
  const out = await claimSpinoffRow(db, row.id);
  expect(out.error).toBeNull();
  await registerAgent(db, { id: row.branch, ticket: ref, branch: row.branch, worktree: row.worktree, status: "working", ttlS: 900 });
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ? WHERE id = ?").run(row.branch, row.id);
  return { ...out.claimed!, status: "launched", agent_id: row.branch };
}

describe("the claim takes flake:slot (OB-2230)", () => {
  test("a flake row's claim holds the slot under its builder for 6 hours; a second flake's claim is refused", async () => {
    const { db, repo } = storeFixture();
    const a = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    const hold = await liveHold(db, FLAKE_SLOT_KEY);
    expect(hold?.holder).toBe(a.branch);
    expect(hold?.ttl_s).toBe(FLAKE_SLOT_TTL_S);

    const second = await ticket(db, PRIORITY_FLAKE);
    const b = await queue(db, repo, second);
    const out = await claimSpinoffRow(db, b.id);
    expect(out.error).toContain(`flake:slot held by ${a.branch} for ${a.ticket_ref}; one flake fix at a time`);
    // atomic with ticket:/worktree:, so the refused row took none of its own keys
    expect(await liveHold(db, `ticket:${second.toLowerCase()}`)).toBeNull();
  });

  test("a non-flake row's claim never takes the slot", async () => {
    const { db, repo } = storeFixture();
    const row = await queue(db, repo, await ticket(db, PRIORITY_MEDIUM));
    expect((await claimSpinoffRow(db, row.id)).error).toBeNull();
    expect(await liveHold(db, FLAKE_SLOT_KEY)).toBeNull();
  });

  test("a row a --no-flake-slot dispatch released claims without the slot", async () => {
    const { db, repo } = storeFixture();
    await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    const row = await queue(db, repo, await ticket(db, PRIORITY_FLAKE));
    await recordNoFlakeSlot(db, row, "both at once, his call");
    expect((await claimSpinoffRow(db, row.id)).error).toBeNull();
  });

  test("an architect already holding the slot dispatches under it and keeps it", async () => {
    const { db, repo } = storeFixture();
    await acquireLeases(db, [FLAKE_SLOT_KEY], "architect-acme", 3600);
    const row = await queue(db, repo, await ticket(db, PRIORITY_FLAKE));
    expect((await claimSpinoffRow(db, row.id, "architect-acme")).error).toBeNull();
    expect((await liveHold(db, FLAKE_SLOT_KEY))?.holder).toBe("architect-acme");
  });
});

describe("the slot is released so the next flake dispatches (OB-2230)", () => {
  async function nextFlakeClaims(db: ReturnType<typeof freshDb>, repo: string): Promise<void> {
    expect(await liveHold(db, FLAKE_SLOT_KEY)).toBeNull();
    const next = await queue(db, repo, await ticket(db, PRIORITY_FLAKE));
    expect((await claimSpinoffRow(db, next.id)).error).toBeNull();
    expect((await liveHold(db, FLAKE_SLOT_KEY))?.holder).toBe(next.branch);
  }

  test("by the handoff", async () => {
    const { db, repo } = storeFixture();
    const row = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    const res = await markSpinoffReady(db, row);
    expect(res.row.status).toBe("ready-for-gate");
    await nextFlakeClaims(db, repo);
  });

  test("a send-back takes it again, and is refused while another flake fix holds it", async () => {
    const { db, repo } = storeFixture();
    const a = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    const handed = (await markSpinoffReady(db, a)).row;
    const b = await queue(db, repo, await ticket(db, PRIORITY_FLAKE));
    expect((await claimSpinoffRow(db, b.id)).error).toBeNull();

    await expect(markSpinoffSentBack(db, handed)).rejects.toThrow(`flake:slot held by ${b.branch} for ${b.ticket_ref}; one flake fix at a time`);
    expect((await listSpinoffs(db)).find((r) => r.id === a.id)?.status).toBe("ready-for-gate");

    await finishAgent(db, b.branch); // B is abandoned or closed: its leases go
    const back = await markSpinoffSentBack(db, handed);
    expect(back.status).toBe("launched");
    expect((await liveHold(db, FLAKE_SLOT_KEY))?.holder).toBe(a.branch);
  });

  test("by ob close (the land)", async () => {
    const { db, repo } = storeFixture();
    const row = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    await landSpinoff(db, row.id, NO_TOKENS);
    await nextFlakeClaims(db, repo);
  });

  test("by ob spinoff abandon", async () => {
    const { db, repo } = storeFixture();
    const row = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    await abandonSpinoff(row, {
      commitsAhead: () => 0,
      stopThread: async () => ({ interrupted: true, settled: true, error: null }),
      stamp: async () => null,
      finishAgent: async (id) => ({ ...(await finishAgent(db, id)), error: null }),
    });
    await nextFlakeClaims(db, repo);
  });

  test("by a failed launch", async () => {
    const { db, repo } = storeFixture();
    const t3 = installFakeT3([repo], () => {
      throw new Error("T3 refused the launch");
    });
    cleanup.push(t3.restore);
    await queue(db, repo, await ticket(db, PRIORITY_FLAKE));
    const res = await drainSpinoffs(db);
    expect(res.failed).toHaveLength(1);
    t3.restore();
    await nextFlakeClaims(db, repo);
  });
});

describe("the API's enqueue refuses a held slot on the server (OB-2230)", () => {
  test("a second flake enqueue throws and leaves no row; --no-flake-slot goes on the trail", async () => {
    const { db, repo } = storeFixture();
    const store = asStore(db);
    const a = await claimed(db, repo, await ticket(db, PRIORITY_FLAKE));
    const second = await ticket(db, PRIORITY_FLAKE);
    const req = { ticket_ref: second, repo, branch: `ob-${second}`, mode: "interactive" as const, brief: "b", no_check: "test" };
    await expect(apiEnqueue(store, req)).rejects.toThrow(`flake:slot held by ${a.branch} for ${a.ticket_ref}; one flake fix at a time`);
    expect(await listSpinoffs(db)).toHaveLength(1);

    const out = await apiEnqueue(store, { ...req, no_flake_slot: "his call" });
    const trail = await decisionsForItem(db, second);
    expect(trail.find((d) => d.to === "no-flake-slot")?.spinoff_row).toBe(out.row.id);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The launch prompt.

describe("a flake row's launch prompt carries the flake-box paragraph (OB-2230)", () => {
  test("before the skill directive, with no lease and no time cap inside the box", async () => {
    seams();
    const db = freshDb();
    const id = await ticket(db, PRIORITY_FLAKE, "Fix the flaky lease test");
    const ask = await spinoffAskFor(db, null, id);
    expect(ask).toContain("`flake-box <command>`");
    expect(ask).toContain("no lease applies and there is no time cap");
    expect(ask).toContain("no `ob lease run cpu:browser`, no 10 minute limit");
    expect(ask).toContain("`flake-box taskset -c 4 <command>`");
    expect(ask).toContain("Never `systemd-run --user` inside the box");
    expect(ask.indexOf("flake-box <command>")).toBeLessThan(ask.indexOf(DIRECTIVE));
    expect(ask.trimEnd().endsWith(DIRECTIVE)).toBe(true);
    expect(ask).not.toContain("is not on this machine");
  });

  test("a caller's own --brief gets it too", async () => {
    seams();
    const db = freshDb();
    const id = await ticket(db, PRIORITY_FLAKE);
    expect(await spinoffAskFor(db, null, id, { brief: "fix it" })).toContain("`flake-box <command>`");
  });

  test("a non-flake row's prompt does not", async () => {
    seams();
    const db = freshDb();
    const id = await ticket(db, PRIORITY_MEDIUM);
    expect(await spinoffAskFor(db, null, id)).not.toContain("flake-box");
  });

  test("on a machine with no box the paragraph says so", async () => {
    seams(false);
    const db = freshDb();
    const id = await ticket(db, PRIORITY_FLAKE);
    expect(await spinoffAskFor(db, null, id)).toContain("`/usr/local/bin/flake-box` is not on this machine");
  });

  test("composed where the launching machine is unknown (a queue on the server), it tells the builder to check", () => {
    const brief = withFlakeBoxBrief(`x\n\n${DIRECTIVE}`, null);
    expect(brief).toContain("If `/usr/local/bin/flake-box` is not on the machine you run on");
    expect(brief).not.toContain("is not on this machine");
  });

  test("over the API the server's enqueue adds it, from the box presence the client sent, and only once", async () => {
    const { db, repo } = storeFixture();
    const store = asStore(db);
    const flake = await ticket(db, PRIORITY_FLAKE);
    const brief = `${flake} · fix it\n\n${DIRECTIVE}`;
    const req = { ticket_ref: flake, repo, branch: `ob-${flake}`, mode: "interactive" as const, brief, no_check: "test" };
    const out = await apiEnqueue(store, { ...req, flake_box: false });
    expect(out.flake).toBe(true);
    expect(out.row.brief).toContain("`flake-box <command>`");
    expect(out.row.brief).toContain("is not on this machine");
    expect(out.row.brief.indexOf("flake-box <command>")).toBeLessThan(out.row.brief.indexOf(DIRECTIVE));
    expect(withFlakeBoxBrief(out.row.brief, true)).toBe(out.row.brief);

    const plain = await ticket(db, PRIORITY_MEDIUM);
    const res = await apiEnqueue(store, { ...req, ticket_ref: plain, branch: `ob-${plain}`, flake_box: true });
    expect(res.flake).toBe(false);
    expect(res.row.brief).toBe(brief);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The heartbeat a flake builder relies on to keep the slot.

describe("ob agent heartbeat moves the expiry of every lease the agent holds (OB-2230)", () => {
  test("a 900 s lease read before and after the beat", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const stale = new Date(Date.now() - 600_000).toISOString();
    try {
      await registerAgent(db, { id: "ob-9", ticket: "9", branch: "ob-9", status: "working", ttlS: 900 });
      await acquireLeases(db, ["ticket:9", FLAKE_SLOT_KEY], "ob-9", 900);
      db.query("UPDATE lease SET heartbeat_at = ? WHERE holder = 'ob-9'").run(stale);
    } finally {
      db.close();
    }
    const expiry = async (resource: string): Promise<number> => {
      const d = openDb(dbPath);
      try {
        const row = d.query("SELECT heartbeat_at, ttl_s FROM lease WHERE resource = ?").get(resource) as { heartbeat_at: string; ttl_s: number };
        return new Date(row.heartbeat_at).getTime() + row.ttl_s * 1000;
      } finally {
        d.close();
      }
    };
    const before = { ticket: await expiry("ticket:9"), slot: await expiry(FLAKE_SLOT_KEY) };
    const r = await runCli(dbPath, ["agent", "heartbeat", "ob-9"]);
    expect(r.code).toBe(0);
    expect(await expiry("ticket:9")).toBeGreaterThan(before.ticket + 500_000);
    expect(await expiry(FLAKE_SLOT_KEY)).toBeGreaterThan(before.slot + 500_000);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The docs.

describe("the docs name flake:slot and --no-flake-slot (OB-2230)", () => {
  test("ob --help and the README", () => {
    const readme = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");
    for (const doc of [renderCommandHelp("spinoff"), readme]) {
      expect(doc).toContain("flake:slot");
      expect(doc).toContain("--no-flake-slot");
    }
  });
});
