import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fakeRepoDir, freshDb, freshDbPath, psTable, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import {
  acquireLease,
  acquireLeases,
  appLeaseKey,
  foreignHold,
  formatHold,
  formatNotHeld,
  heartbeatLeasesByHolder,
  holderRemedy,
  leaseHolderId,
  leaseKeyClass,
  leaseStatus,
  liveHold,
  normalizeLeaseResource,
  recordedHold,
  releaseLeasesByHolder,
  ticketLeaseKey,
  worktreeLeaseKey,
} from "../src/lease.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { __setFetchIssue } from "../../../apps/cli/src/github-issues.ts";
import {
  __setSh,
  cleanupLeaseKeys,
  cleanupWorktrees,
  drainSpinoffs,
  enqueueSpinoff,
  launchClaimKeys,
  listSpinoffs,
  reconcileSpinoffs,
  spinoffLeaseKeys,
} from "../src/commands/spinoff.ts";
import { registerAgent } from "../src/agent.ts";
import { claimTicketLease, finishAgent } from "../src/agent-register.ts";

// #97: tickets/worktrees/apps lease like ports (decision #37). Two concurrent architect sessions had no
// mutual exclusion over a ticket or its worktree; one removed a worktree, deleted its branch and landed
// the ticket while another was mid-review + mid-gate on it. These tests pin the key shapes, the
// contention rule (live vs expired vs free), and the guards on the DESTRUCTIVE paths.

function pastIso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/** Insert a lease row directly so a test can control acquired_at/heartbeat_at (liveness). */
function seedLease(
  db: ReturnType<typeof freshDb>,
  resource: string,
  holder: string,
  ttlS: number,
  beatAt: string,
): void {
  db.query("INSERT INTO lease(resource, holder, acquired_at, ttl_s, heartbeat_at) VALUES(?, ?, ?, ?, ?)").run(
    resource,
    holder,
    beatAt,
    ttlS,
    beatAt,
  );
}

describe("lease key classes (#97): pure", () => {
  test("ticketLeaseKey normalises the ref forms an architect actually types", () => {
    expect(ticketLeaseKey("#96")).toBe("ticket:96");
    expect(ticketLeaseKey("96")).toBe("ticket:96");
    expect(ticketLeaseKey(" #96 ")).toBe("ticket:96");
    expect(ticketLeaseKey("CUE-1234")).toBe("ticket:cue-1234");
    expect(ticketLeaseKey("gh#97")).toBe("ticket:gh-97");
    expect(ticketLeaseKey("")).toBeNull();
    expect(ticketLeaseKey(null)).toBeNull();
    expect(ticketLeaseKey("###")).toBeNull();
  });

  test("worktreeLeaseKey keeps an unresolvable path literal, minus trailing slashes", () => {
    expect(worktreeLeaseKey("/nope/omnislash.build-96")).toBe("worktree:/nope/omnislash.build-96");
    expect(worktreeLeaseKey("/nope/omnislash.build-96/")).toBe("worktree:/nope/omnislash.build-96");
    expect(worktreeLeaseKey("  ")).toBeNull();
    expect(worktreeLeaseKey(undefined)).toBeNull();
  });

  test("worktreeLeaseKey resolves symlinks so /var and /private/var name ONE key (macOS: $PWD vs git)", () => {
    // The real defect this fixes: a lease taken on `$PWD` (/var/folders/...) did not guard the same tree
    // that `git worktree list --porcelain` reports (/private/var/folders/...), so cleanup removed it anyway.
    const dir = mkdtempSync(join(tmpdir(), "ob-lease-"));
    const resolved = realpathSync(dir);
    expect(worktreeLeaseKey(dir)).toBe(`worktree:${resolved}`);
    expect(worktreeLeaseKey(resolved)).toBe(worktreeLeaseKey(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  test("normalizeLeaseResource canonicalises what a caller typed into the key a guard derives", () => {
    expect(normalizeLeaseResource("ticket:#96")).toBe("ticket:96");
    expect(normalizeLeaseResource("ticket:CUE-1234")).toBe("ticket:cue-1234");
    expect(normalizeLeaseResource("app:Widget")).toBe("app:widget");
    expect(normalizeLeaseResource("worktree:/nope/w/")).toBe("worktree:/nope/w");
    expect(normalizeLeaseResource("port:3000")).toBe("port:3000"); // untouched
    expect(normalizeLeaseResource("whatever")).toBe("whatever"); // unknown class passes through
  });

  test("appLeaseKey names a single-instance GUI app (incident 1: two sessions drove one instance)", () => {
    expect(appLeaseKey("Widget")).toBe("app:widget");
    expect(appLeaseKey("")).toBeNull();
  });

  test("leaseKeyClass classifies known prefixes only", () => {
    expect(leaseKeyClass("ticket:96")).toBe("ticket");
    expect(leaseKeyClass("worktree:/a/b")).toBe("worktree");
    expect(leaseKeyClass("app:widget")).toBe("app");
    expect(leaseKeyClass("port:3000")).toBe("port");
    expect(leaseKeyClass("nonsense:1")).toBeNull();
    expect(leaseKeyClass("bare")).toBeNull();
    expect(leaseKeyClass(":leading")).toBeNull();
  });
});

describe("contention rule (#97): held-by-live vs expired-reclaimable vs free", () => {
  test("liveHold reports a live holder, ignores an expired one, and null when free", async () => {
    const db = freshDb();
    seedLease(db, "ticket:96", "architect-a", 900, pastIso(10)); // beaten 10s ago, ttl 900 -> live
    seedLease(db, "ticket:97", "architect-b", 1, pastIso(600)); // beaten 600s ago, ttl 1 -> expired
    const live = (await liveHold(db, "ticket:96"));
    expect(live?.holder).toBe("architect-a");
    expect(live?.ttl_s).toBe(900);
    expect((await liveHold(db, "ticket:97"))).toBeNull(); // expired -> reclaimable
    expect((await liveHold(db, "ticket:99"))).toBeNull(); // free
  });

  test("foreignHold: a live OTHER holder blocks; self and expired do not", async () => {
    const db = freshDb();
    seedLease(db, "worktree:/w/96", "architect-a", 900, pastIso(5));
    expect((await foreignHold(db, ["worktree:/w/96"], ["architect-b"]))?.holder).toBe("architect-a");
    expect((await foreignHold(db, ["worktree:/w/96"], ["architect-a"]))).toBeNull(); // ours
    expect((await foreignHold(db, [null, "worktree:/free"], ["architect-b"]))).toBeNull(); // nulls + free ignored
    // once expired, the same key no longer blocks anyone
    db.query("UPDATE lease SET ttl_s = 1, heartbeat_at = ?, acquired_at = ? WHERE resource = 'worktree:/w/96'").run(
      pastIso(600),
      pastIso(600),
    );
    expect((await foreignHold(db, ["worktree:/w/96"], ["architect-b"]))).toBeNull();
  });

  test("formatHold is the one-line 'held by <holder> since <ts>' message", () => {
    const msg = formatHold({ resource: "ticket:96", holder: "architect-a", since: "2026-07-27T10:00:00Z", ttl_s: 900 });
    expect(msg).toBe("ticket:96 held by architect-a since 2026-07-27T10:00:00Z (ttl 900s)");
  });

  test("acquireLeases is all-or-nothing: a denial acquires NOTHING", async () => {
    const db = freshDb();
    expect((await acquireLease(db, "worktree:/w/96", "architect-a", 900)).ok).toBe(true);
    const r = (await acquireLeases(db, ["ticket:96", "worktree:/w/96"], "architect-b", 900));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hold).toMatchObject({ resource: "worktree:/w/96", holder: "architect-a" });
    // ticket:96 was NOT half-acquired by architect-b
    expect((await leaseStatus(db)).map((l) => l.resource)).toEqual(["worktree:/w/96"]);
  });

  test("acquireLeases grants a free set, refreshes its own, and reclaims an expired one", async () => {
    const db = freshDb();
    expect((await acquireLeases(db, ["ticket:96", "worktree:/w/96", null], "architect-a", 900)).ok).toBe(true);
    expect((await leaseStatus(db)).map((l) => l.resource)).toEqual(["ticket:96", "worktree:/w/96"]);
    expect((await acquireLeases(db, ["ticket:96"], "architect-a", 900)).ok).toBe(true); // own -> refresh
    db.query("UPDATE lease SET ttl_s = 1, heartbeat_at = ?, acquired_at = ? WHERE resource = 'ticket:96'").run(
      pastIso(600),
      pastIso(600),
    );
    expect((await acquireLeases(db, ["ticket:96"], "architect-b", 900)).ok).toBe(true); // expired -> reclaimable
    expect((await liveHold(db, "ticket:96"))?.holder).toBe("architect-b");
    expect((await acquireLeases(db, [null], "architect-b", 900)).ok).toBe(true); // nothing to take
  });

  test("releaseLeasesByHolder / heartbeatLeasesByHolder act on the whole holder's set", async () => {
    const db = freshDb();
    (await acquireLeases(db, ["ticket:96", "worktree:/w/96"], "a1", 900));
    (await acquireLeases(db, ["ticket:97"], "a2", 900));
    const beaten = (await heartbeatLeasesByHolder(db, "a1"));
    expect(beaten).toEqual({ beat: ["ticket:96", "worktree:/w/96"], reacquired: [] });
    expect((await heartbeatLeasesByHolder(db, "nobody"))).toEqual({ beat: [], reacquired: [] });
    expect((await releaseLeasesByHolder(db, "a1"))).toEqual(["ticket:96", "worktree:/w/96"]);
    expect((await leaseStatus(db)).map((l) => l.resource)).toEqual(["ticket:97"]); // a2 untouched
    expect((await releaseLeasesByHolder(db, "a1"))).toEqual([]);
  });
});

// --- the destructive paths -------------------------------------------------
// A fixture git seam mirroring spinoff.test.ts's: read-only queries answered from a model, mutations
// recorded. NO real git ever runs, so "did it try to remove the worktree?" is directly observable.
interface GitModel {
  worktrees: Array<{ path: string; branch: string | null }>;
  merged: string[];
  branches: string[];
}
function fakeGit(model: GitModel) {
  const mutations: string[][] = [];
  const restore = __setSh((cmd) => {
    if (cmd[0] === "ps") return { ok: true, err: "", out: psTable() };
    if (cmd.includes("status") && cmd.includes("--porcelain")) return { ok: true, err: "", out: "" };
    if (cmd.includes("worktree") && cmd.includes("list")) {
      return {
        ok: true,
        err: "",
        out: model.worktrees
          .map((w) => `worktree ${w.path}\nHEAD deadbeef${w.branch ? `\nbranch refs/heads/${w.branch}` : "\ndetached"}`)
          .join("\n\n"),
      };
    }
    if (cmd.includes("branch") && cmd.includes("--merged")) return { ok: true, err: "", out: model.merged.join("\n") };
    if (cmd.includes("for-each-ref")) return { ok: true, err: "", out: model.branches.join("\n") };
    if (cmd.includes("worktree") && cmd.includes("remove")) {
      mutations.push(cmd);
      return { ok: true, err: "", out: "" };
    }
    if (cmd.includes("branch") && (cmd.includes("-d") || cmd.includes("-D"))) {
      mutations.push(cmd);
      return { ok: true, err: "", out: "" };
    }
    return { ok: true, err: "", out: "" };
  });
  return { mutations, restore };
}

// Named omnislash (OB-1992): these suites test omnislash's branch-named builders; any other name is a clean repo.
const REPO = "/r/omnislash";
const WT96 = `${REPO}.build-96`;
const model = (): GitModel => ({
  worktrees: [
    { path: REPO, branch: "main" },
    { path: WT96, branch: "build-96" },
  ],
  merged: ["main", "build-96", "dangling-96"],
  branches: ["main", "build-96", "dangling-96"],
});

describe("cleanup guard (#97): never remove a worktree / delete a branch under a live foreign lease", () => {
  test("cleanupLeaseKeys covers the worktree path AND every ticket mapped to the branch", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, { ticketRef: "#96", repo: REPO, branch: "build-96", mode: "agent", brief: "b", worktree: WT96 }));
    (await registerAgent(db, { id: "architect-omnislash", ticket: "CUE-1", worktree: WT96, ttlS: 900 }));
    const keys = (await cleanupLeaseKeys(db, "build-96", WT96));
    expect(keys).toContain(`worktree:${WT96}`);
    expect(keys).toContain("ticket:96"); // via the spinoff queue
    expect(keys).toContain("ticket:cue-1"); // via the live agent registry (adopted worktree, #61)
  });

  test("a live foreign worktree lease SKIPS the removal with a 'held by' reason and issues no git mutation", async () => {
    const db = freshDb();
    (await acquireLeases(db, [worktreeLeaseKey(WT96)], "architect-reviewing", 900));
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      const skip = res.skipped.find((e) => e.branch === "build-96");
      expect(skip?.reason).toContain("held by architect-reviewing");
      expect(res.removed.some((e) => e.branch === "build-96")).toBe(false);
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(WT96))).toBe(true);
    expect(mutations.every((m) => !m.includes("build-96"))).toBe(true);
  });

  test("a live foreign TICKET lease (architect holds ticket:96, not the path) also blocks it", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, { ticketRef: "#96", repo: REPO, branch: "build-96", mode: "agent", brief: "b", worktree: WT96 }));
    (await acquireLeases(db, [ticketLeaseKey("#96")], "architect-reviewing", 900));
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.skipped.find((e) => e.branch === "build-96")?.reason).toContain("ticket:96 held by architect-reviewing");
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(WT96))).toBe(true);
  });

  test("--force overrides dirty/unmerged but NEVER a live lease", async () => {
    const db = freshDb();
    (await acquireLeases(db, [worktreeLeaseKey(WT96)], "architect-reviewing", 900));
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO, force: true }));
      expect(res.skipped.find((e) => e.branch === "build-96")?.reason).toContain("held by architect-reviewing");
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(WT96))).toBe(true);
  });

  test("released → the same cleanup proceeds and removes the worktree + branch", async () => {
    const db = freshDb();
    (await acquireLeases(db, [worktreeLeaseKey(WT96)], "architect-reviewing", 900));
    expect((await releaseLeasesByHolder(db, "architect-reviewing"))).toEqual([`worktree:${WT96}`]);
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.removed.map((e) => e.branch).sort()).toEqual(["build-96", "dangling-96"]);
    } finally {
      restore();
    }
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", WT96]);
    expect(mutations).toContainEqual(["git", "-C", REPO, "branch", "-D", "build-96"]);
  });

  test("an EXPIRED lease is reclaimable, so cleanup proceeds (a dead session cannot wedge a worktree)", async () => {
    const db = freshDb();
    seedLease(db, `worktree:${WT96}`, "architect-dead", 1, pastIso(600));
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.removed.some((e) => e.branch === "build-96")).toBe(true);
    } finally {
      restore();
    }
    expect(mutations).toContainEqual(["git", "-C", REPO, "worktree", "remove", WT96]);
  });

  test("a dangling merged branch is protected by the ticket lease mapped to it", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, { ticketRef: "#42", repo: REPO, branch: "dangling-96", mode: "agent", brief: "b" }));
    (await acquireLeases(db, [ticketLeaseKey("#42")], "architect-reviewing", 900));
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.skipped.find((e) => e.branch === "dangling-96")?.reason).toContain("held by architect-reviewing");
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes("dangling-96"))).toBe(true);
  });

  test("a LIVE lease held by the branch's own agent also blocks cleanup (that agent is still working)", async () => {
    const db = freshDb();
    (await acquireLeases(db, [worktreeLeaseKey(WT96)], "build-96", 900)); // the branch id IS the agent's holder id
    const { mutations, restore } = fakeGit(model());
    try {
      const res = (await cleanupWorktrees(db, { repo: REPO }));
      expect(res.skipped.find((e) => e.branch === "build-96")?.reason).toContain("held by build-96");
    } finally {
      restore();
    }
    expect(mutations.every((m) => !m.includes(WT96))).toBe(true);
  });

  test("removing a worktree clears its stale lease rows (no litter blocking a future tree at that path)", async () => {
    const db = freshDb();
    seedLease(db, `worktree:${WT96}`, "build-96", 1, pastIso(600)); // expired -> reclaimable
    seedLease(db, "ticket:96", "build-96", 1, pastIso(600));
    const { restore } = fakeGit(model());
    try {
      expect((await cleanupWorktrees(db, { repo: REPO })).removed.some((e) => e.branch === "build-96")).toBe(true);
    } finally {
      restore();
    }
    expect((await leaseStatus(db))).toHaveLength(0);
  });
});

describe("reconcile guard (#97): a ticket is not marked landed under a foreign lease", () => {
  async function launchedRow(db: ReturnType<typeof freshDb>): Promise<void> {
    (await enqueueSpinoff(db, { ticketRef: "#96", repo: REPO, branch: "build-96", mode: "agent", brief: "b", worktree: WT96 }));
    db.query("UPDATE spinoff SET status='launched', agent_id='build-96', base_sha='base' WHERE ticket_ref='#96'").run();
    (await registerAgent(db, { id: "build-96", ticket: "#96", worktree: WT96, branch: "build-96", ttlS: 900 }));
  }

  test("spinoffLeaseKeys is the row's ticket + worktree", () => {
    expect(spinoffLeaseKeys({ ticket_ref: "#96", worktree: WT96 })).toEqual(["ticket:96", `worktree:${WT96}`]);
  });

  test("an architect holding the ticket blocks the landing and reports it (not silent)", async () => {
    const db = freshDb();
    await launchedRow(db);
    (await acquireLeases(db, [ticketLeaseKey("#96")], "architect-reviewing", 900));
    const rec = (await reconcileSpinoffs(db, () => true, undefined, () => 3));
    expect(rec.merged).toEqual([]);
    expect(rec.blocked).toEqual([{ ticket: "#96", resource: "ticket:96", holder: "architect-reviewing" }]);
    expect(db.query("SELECT status FROM spinoff WHERE ticket_ref='#96'").get()).toMatchObject({ status: "launched" });
  });

  test("the row's OWN agent lease is not foreign: reconcile lands it and releases the lease", async () => {
    const db = freshDb();
    await launchedRow(db);
    (await acquireLeases(db, [ticketLeaseKey("#96"), worktreeLeaseKey(WT96)], "build-96", 900));
    const rec = (await reconcileSpinoffs(db, () => true, undefined, () => 3));
    expect(rec.merged).toEqual(["#96"]);
    expect(rec.blocked).toEqual([]);
    expect((await leaseStatus(db))).toHaveLength(0); // agent done -> its ticket + worktree are free again
  });

  test("once the architect releases, the next reconcile lands it", async () => {
    const db = freshDb();
    await launchedRow(db);
    (await acquireLeases(db, [ticketLeaseKey("#96")], "architect-reviewing", 900));
    expect((await reconcileSpinoffs(db, () => true, undefined, () => 3)).merged).toEqual([]);
    (await releaseLeasesByHolder(db, "architect-reviewing"));
    expect((await reconcileSpinoffs(db, () => true, undefined, () => 3)).merged).toEqual(["#96"]);
  });
});

describe("drain guard (#97): a leased ticket stays PENDING, it never fails", () => {
  test("a foreign lease leaves the row pending and reports it; releasing lets the next drain launch", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, { ticketRef: "#96", repo: REPO, branch: "build-96", mode: "agent", brief: "b", worktree: WT96 }));
    (await acquireLeases(db, [ticketLeaseKey("#96")], "architect-reviewing", 900));
    const r = (await drainSpinoffs(db));
    expect(r.launched).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.blocked).toEqual([{ ticket: "#96", resource: "ticket:96", holder: "architect-reviewing" }]);
    expect(r.remaining_pending).toBe(1); // still pending, not failed, so it self-heals on a later drain
  });
});

describe("CLI: register implies the ticket lease, done releases it (#97)", () => {
  test("a second agent on the same ticket is refused with 'held by', and freed by 'agent done'", async () => {
    const dbPath = freshDbPath();
    const first = await runCli(dbPath, ["agent", "register", "--id", "a1", "--ticket", "#96"]);
    expect(first.code).toBe(0);

    const leases = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(leases.map((l: { resource: string }) => l.resource)).toEqual(["ticket:96"]);
    expect(leases[0].holder).toBe("a1");

    const second = await runCli(dbPath, ["agent", "register", "--id", "a2", "--ticket", "#96"]);
    expect(second.code).toBe(1);
    expect(second.err).toContain("held by a1");
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)).toHaveLength(1); // a2 not registered

    // the same agent re-registering (the heartbeat form, no --ticket) refreshes its own lease
    expect((await runCli(dbPath, ["agent", "register", "--id", "a1", "--status", "readying"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(1);

    const done = await runCli(dbPath, ["agent", "done", "a1", "--json"]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out).released).toEqual(["ticket:96"]);
    expect((await runCli(dbPath, ["agent", "register", "--id", "a2", "--ticket", "#96"])).code).toBe(0);
  });

  test("agent heartbeat keeps the ticket lease alive through a long build", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["agent", "register", "--id", "a1", "--ticket", "#96", "--ttl", "600"]);
    const before = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].heartbeat_at;
    await Bun.sleep(5);
    expect((await runCli(dbPath, ["agent", "heartbeat", "a1"])).code).toBe(0);
    const after = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].heartbeat_at;
    expect(Date.parse(after)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  test("agents on DIFFERENT tickets coexist (the registry is not a per-worktree mutex)", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["agent", "register", "--id", "architect-omnislash"])).code).toBe(0); // no ticket, claims nothing
    expect((await runCli(dbPath, ["agent", "register", "--id", "a1", "--ticket", "#96"])).code).toBe(0);
    expect((await runCli(dbPath, ["agent", "register", "--id", "a2", "--ticket", "#97"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)).toHaveLength(3);
  });

  test("--no-lease registers without claiming anything", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["agent", "register", "--id", "a1", "--ticket", "#96"])).code).toBe(0);
    const r = await runCli(dbPath, ["agent", "register", "--id", "a2", "--ticket", "#96", "--no-lease"]);
    expect(r.code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)).toHaveLength(2);
  });
});

describe("CLI: ob lease --holder / heartbeat / release --force (#97)", () => {
  test("acquire without --ttl uses the 20-minute default (ob 561)", async () => {
    const dbPath = freshDbPath();
    const a = await runCli(dbPath, ["lease", "acquire", "ticket:561", "--holder", "h"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("ttl 1200s");
    const rows = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(rows[0].ttl_s).toBe(1200);
  });

  test("a denied acquire prints the holder and EXITS 1", async () => {
    const dbPath = freshDbPath();
    const a = await runCli(dbPath, ["lease", "acquire", "ticket:96", "--holder", "architect-a", "--ttl", "900"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("acquired ticket:96");

    const b = await runCli(dbPath, ["lease", "acquire", "ticket:96", "--holder", "architect-b"]);
    expect(b.code).toBe(1);
    expect(b.out).toContain("denied");
    expect(b.out).toContain("held by architect-a");
  });

  test("--holder makes the lease outlive the ob process: a later invocation heartbeats + releases it", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "app:widget", "--holder", "architect-a", "--ttl", "600"]);
    const beat = await runCli(dbPath, ["lease", "heartbeat", "app:widget", "--holder", "architect-a"]);
    expect(beat.code).toBe(0);
    const wrong = await runCli(dbPath, ["lease", "heartbeat", "app:widget", "--holder", "architect-b"]);
    expect(wrong.code).toBe(1);
    const rel = await runCli(dbPath, ["lease", "release", "app:widget", "--holder", "architect-a"]);
    expect(rel.code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(0);
  });

  test("release --force is the one documented way to break another holder's lease", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:96", "--holder", "architect-a"]);
    const plain = await runCli(dbPath, ["lease", "release", "ticket:96", "--holder", "architect-b"]);
    expect(plain.out).toContain("nothing released");
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(1);
    const forced = await runCli(dbPath, ["lease", "release", "ticket:96", "--holder", "architect-b", "--force"]);
    expect(forced.out).toContain("forced");
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(0);
  });

  test("an unknown lease subcommand is a usage error naming heartbeat", async () => {
    const r = await runCli(freshDbPath(), ["lease", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("heartbeat");
  });
});

// #75: the documented gate flow was not performable. `ob lease acquire ticket:<n> --holder
// architect-omnislash` followed by the documented `ob lease release ticket:<n>` printed "not held by
// <pid>@<host>, nothing released (use --force ...)" and left the lease held for its whole TTL, and while
// the architect held that ticket, `ob agent register --ticket <n>` for a builder was refused outright. Both
// failure messages named only `--force`, i.e. the one move decisions #56/#97 forbid, so the tool taught
// the forbidden habit to anyone who just forgot a flag. These tests pin both halves and the new text.
describe("recordedHold + the not-yours message text (#75): pure", () => {
  test("recordedHold names the holder of a LIVE row and of an EXPIRED one alike", async () => {
    const db = freshDb();
    seedLease(db, "ticket:96", "architect-omnislash", 1800, pastIso(10));
    seedLease(db, "ticket:97", "architect-gone", 1, pastIso(600));
    expect((await recordedHold(db, "ticket:96"))).toMatchObject({ holder: "architect-omnislash", expired: false });
    expect((await recordedHold(db, "ticket:97"))).toMatchObject({ holder: "architect-gone", expired: true });
    expect((await recordedHold(db, "ticket:98"))).toBeNull(); // liveHold's null means "free"; this one means "no row"
  });

  test("holderRemedy leads with --holder <recorded> and demotes --force to the dead-holder case", () => {
    const live = holderRemedy("ob lease release ticket:96", "architect-omnislash");
    expect(live).toContain("--holder architect-omnislash");
    expect(live).toContain("ONLY if that holder is gone");
    expect(live.indexOf("--holder")).toBeLessThan(live.indexOf("--force")); // the safe move comes FIRST
    expect(holderRemedy("ob lease release ticket:96", "architect-gone", true)).toContain("--force is safe on this one");
  });

  test("formatNotHeld names the row's holder, the caller, and the retry that works", () => {
    const msg = formatNotHeld("release", "ticket:96", "48468@host", { holder: "architect-omnislash", expired: false });
    expect(msg).toContain("ticket:96 is held by architect-omnislash, not 48468@host, nothing released");
    expect(msg).toContain("'ob lease release ticket:96 --holder architect-omnislash'");
    expect(formatNotHeld("heartbeat", "ticket:96", "x", { holder: "p", expired: false })).toContain("nothing beaten");
    expect(formatNotHeld("release", "ticket:96", "x", null)).toBe("ticket:96 is not held by anyone, nothing released");
  });
});

describe("CLI (#75): a --holder acquire is released by a --holder release", () => {
  test("the documented pair works, and a holder-less release fails LOUDLY naming the holder", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["lease", "acquire", "ticket:75", "--holder", "architect-test", "--ttl", "1800"])).code).toBe(0);

    // the exact defect: `ob lease release ticket:75` with no --holder defaults to <pid>@<host>
    const defaulted = await runCli(dbPath, ["lease", "release", "ticket:75"]);
    expect(defaulted.code).toBe(1); // NOT a silent no-op: "release on land" must not look like it worked
    expect(defaulted.out).toContain("ticket:75 is held by architect-test");
    expect(defaulted.out).toContain("not " + leaseHolderId());
    expect(defaulted.out).toContain("'ob lease release ticket:75 --holder architect-test'");
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(1); // still held

    const proper = await runCli(dbPath, ["lease", "release", "ticket:75", "--holder", "architect-test"]);
    expect(proper.code).toBe(0);
    expect(proper.out).toContain("released ticket:75");
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toHaveLength(0);
  });

  test("releasing an EXPIRED lease needs no --holder match and no --force", async () => {
    const dbPath = freshDbPath();
    seedLease(openDb(dbPath), "app:widget", "architect-gone", 1, pastIso(600));
    const r = await runCli(dbPath, ["lease", "release", "app:widget", "--holder", "architect-other"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("released app:widget");
    expect(r.out).not.toContain("forced");
  });

  test("a not-held heartbeat names the recorded holder too", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "worktree:/nope/x", "--holder", "architect-test", "--ttl", "900"]);
    const r = await runCli(dbPath, ["lease", "heartbeat", "worktree:/nope/x"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("worktree:/nope/x is held by architect-test");
    expect(r.out).toContain("'ob lease heartbeat worktree:/nope/x --holder architect-test'");
  });

  test("a release with nothing recorded at all still exits 1, without suggesting --force", async () => {
    const r = await runCli(freshDbPath(), ["lease", "release", "ticket:75", "--holder", "architect-test"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("ticket:75 is not held by anyone, nothing released\n");
  });
});

describe("CLI (#75): 'agent register --holder' registers UNDER a lease the caller holds", () => {
  test("the architect's own ticket lease is compatible, and is left untouched", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:75", "--holder", "architect-omnislash", "--ttl", "1800"]);
    const before = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0];

    const reg = await runCli(dbPath, [
      "agent", "register", "--id", "75-lease-release-holder", "--ticket", "75", "--holder", "architect-omnislash",
    ]);
    expect(reg.code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)).toHaveLength(1);

    // the hold is still the ARCHITECT's, with its own long TTL: the builder must not shorten or steal it
    const after = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(after).toHaveLength(1);
    expect(after[0].holder).toBe("architect-omnislash");
    expect(after[0].ttl_s).toBe(1800);
    expect(after[0].acquired_at).toBe(before.acquired_at);

    // and the architect still releases it itself (the builder's `agent done` has nothing to release)
    const done75 = JSON.parse((await runCli(dbPath, ["agent", "done", "75-lease-release-holder", "--json"])).out);
    expect(done75.released).toEqual([]);
    expect(done75.kept).toEqual(["ticket:75"]);
    expect((await runCli(dbPath, ["lease", "release", "ticket:75", "--holder", "architect-omnislash"])).code).toBe(0);
  });

  test("a DIFFERENT live holder still blocks, and the refusal leads with --holder, not --force", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:75", "--holder", "architect-other", "--ttl", "1800"]);
    const r = await runCli(dbPath, ["agent", "register", "--id", "b1", "--ticket", "75", "--holder", "architect-omnislash"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("held by architect-other");
    expect(r.err).toContain("register under it with --holder architect-other");
    expect(r.err.indexOf("--holder")).toBeLessThan(r.err.indexOf("--force"));
    expect(r.err).toContain("ONLY if that holder is gone");
    expect(JSON.parse((await runCli(dbPath, ["agents", "--json"])).out)).toHaveLength(0);
  });

  test("--holder naming a holder that does NOT hold the ticket claims it as the agent (no free pass)", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:75", "--holder", "architect-other", "--ttl", "1800"]);
    // "architect-omnislash" holds nothing here, so naming it grants nothing: the live foreign hold still wins
    expect((await runCli(dbPath, ["agent", "register", "--id", "b1", "--ticket", "75", "--holder", "nobody"])).code).toBe(1);
    // with the ticket free, the agent claims it under its OWN id, exactly as before #75
    await runCli(dbPath, ["lease", "release", "ticket:75", "--holder", "architect-other"]);
    expect((await runCli(dbPath, ["agent", "register", "--id", "b1", "--ticket", "75", "--holder", "nobody"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].holder).toBe("b1");
  });

  test("--holder equal to the agent's OWN id is the plain claim, so its lease still refreshes", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["agent", "register", "--id", "b1", "--ticket", "75", "--ttl", "600"]);
    const before = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].heartbeat_at;
    await Bun.sleep(5);
    expect((await runCli(dbPath, ["agent", "register", "--id", "b1", "--holder", "b1", "--ttl", "600"])).code).toBe(0);
    const after = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0];
    expect(after.holder).toBe("b1");
    expect(Date.parse(after.heartbeat_at)).toBeGreaterThan(Date.parse(before));
  });

  test("an EXPIRED foreign ticket lease is reclaimed by the registering agent (a dead session cannot wedge it)", async () => {
    const dbPath = freshDbPath();
    seedLease(openDb(dbPath), "ticket:75", "architect-gone", 1, pastIso(600));
    expect((await runCli(dbPath, ["agent", "register", "--id", "b1", "--ticket", "75"])).code).toBe(0);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].holder).toBe("b1");
  });
});

// 341: `ob agent done` released ticket:337 out from under the architect mid-gate. A builder that
// registered UNDER `--holder architect-omnislash` must not be able to drop that hold when it exits.
describe("finishAgent (341): releases only leases this agent acquired", () => {
  test("an inherited architect ticket is kept; the builder's own worktree is released", async () => {
    const db = freshDb();
    await acquireLeases(db, ["ticket:337"], "architect-omnislash", 1800);
    await registerAgent(db, { id: "337", ticket: "337", ttlS: 900 });
    await acquireLeases(db, ["worktree:/tmp/wt-337"], "337", 900);

    const r = await finishAgent(db, "337");
    expect(r.done).toBe(true);
    expect(r.released).toEqual(["worktree:/tmp/wt-337"]);
    expect(r.kept).toEqual(["ticket:337"]);
    expect((await liveHold(db, "ticket:337"))?.holder).toBe("architect-omnislash");
    expect(await liveHold(db, "worktree:/tmp/wt-337")).toBeNull();
  });

  test("done on the architect while a builder is live keeps that ticket, releases the rest", async () => {
    const db = freshDb();
    await registerAgent(db, { id: "architect-omnislash", status: "planning", ttlS: 1800 });
    await acquireLeases(db, ["ticket:337", "app:widget"], "architect-omnislash", 1800);
    await registerAgent(db, { id: "337", ticket: "337", ttlS: 900 });

    const r = await finishAgent(db, "architect-omnislash");
    expect(r.released).toEqual(["app:widget"]);
    expect(r.kept).toEqual(["ticket:337"]);
    expect((await liveHold(db, "ticket:337"))?.holder).toBe("architect-omnislash");
  });

  test("an agent that claimed the ticket itself still releases it", async () => {
    const db = freshDb();
    await acquireLeases(db, ["ticket:337"], "337", 900);
    await registerAgent(db, { id: "337", ticket: "337", ttlS: 900 });
    const r = await finishAgent(db, "337");
    expect(r.released).toEqual(["ticket:337"]);
    expect(r.kept).toEqual([]);
    expect(await liveHold(db, "ticket:337")).toBeNull();
  });

  test("re-register without --holder after register-under leaves the architect hold", async () => {
    const db = freshDb();
    await acquireLeases(db, ["ticket:337"], "architect-omnislash", 1800);
    expect(await claimTicketLease(db, { id: "337", ticket: "337", ttlS: 900, holder: "architect-omnislash" })).toBe("ticket:337");
    await registerAgent(db, { id: "337", ticket: "337", ttlS: 900 });
    expect(await claimTicketLease(db, { id: "337", ticket: "337", ttlS: 900 })).toBe("ticket:337");
    expect((await liveHold(db, "ticket:337"))?.holder).toBe("architect-omnislash");
  });

  test("--no-lease clears the row and touches no lease", async () => {
    const db = freshDb();
    await acquireLeases(db, ["ticket:337"], "337", 900);
    await registerAgent(db, { id: "337", ticket: "337", ttlS: 900 });
    const r = await finishAgent(db, "337", { noLease: true });
    expect(r).toEqual({ done: true, released: [], kept: [] });
    expect((await liveHold(db, "ticket:337"))?.holder).toBe("337");
  });
});

describe("CLI (341): agent done does not drop an inherited architect hold", () => {
  test("the 337-pass-5 sequence: register under, re-register without --holder, done, architect still holds", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["lease", "acquire", "ticket:337", "--holder", "architect-omnislash", "--ttl", "1800"])).code).toBe(0);

    const reg = await runCli(dbPath, [
      "agent", "register", "--id", "337", "--ticket", "337", "--holder", "architect-omnislash",
    ]);
    expect(reg.code).toBe(0);

    // heartbeat-form register without --holder must not collide or steal
    const refresh = await runCli(dbPath, ["agent", "register", "--id", "337", "--status", "readying", "--note", "gating"]);
    expect(refresh.code).toBe(0);

    const before = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(before).toHaveLength(1);
    expect(before[0].holder).toBe("architect-omnislash");
    expect(before[0].ttl_s).toBe(1800);

    const done = JSON.parse((await runCli(dbPath, ["agent", "done", "337", "--json"])).out);
    expect(done.done).toBe(true);
    expect(done.released).toEqual([]);
    expect(done.kept).toEqual(["ticket:337"]);

    const after = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(after).toHaveLength(1);
    expect(after[0].holder).toBe("architect-omnislash");
    expect(after[0].ttl_s).toBe(1800);
    expect(after[0].acquired_at).toBe(before[0].acquired_at);

    expect((await runCli(dbPath, ["lease", "release", "ticket:337", "--holder", "architect-omnislash"])).code).toBe(0);
  });

  test("done --holder architect-omnislash is not a release target: the architect hold stays", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:337", "--holder", "architect-omnislash", "--ttl", "1800"]);
    await runCli(dbPath, ["agent", "register", "--id", "337", "--ticket", "337", "--holder", "architect-omnislash"]);

    const done = JSON.parse((await runCli(dbPath, ["agent", "done", "337", "--holder", "architect-omnislash", "--json"])).out);
    expect(done.released).toEqual([]);
    expect(done.kept).toEqual(["ticket:337"]);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].holder).toBe("architect-omnislash");
  });

  test("the builder's own leases still release; only the inherited ticket is kept", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["lease", "acquire", "ticket:337", "--holder", "architect-omnislash", "--ttl", "1800"]);
    await runCli(dbPath, ["agent", "register", "--id", "337", "--ticket", "337", "--holder", "architect-omnislash"]);
    await runCli(dbPath, ["lease", "acquire", "worktree:/tmp/wt-337", "--holder", "337", "--ttl", "900"]);

    const done = JSON.parse((await runCli(dbPath, ["agent", "done", "337", "--json"])).out);
    expect(done.released).toEqual(["worktree:/tmp/wt-337"]);
    expect(done.kept).toEqual(["ticket:337"]);
    const left = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ resource: "ticket:337", holder: "architect-omnislash" });
  });

  test("done on the architect while a builder is still registered keeps that ticket", async () => {
    const dbPath = freshDbPath();
    await runCli(dbPath, ["agent", "register", "--id", "architect-omnislash", "--status", "planning"]);
    await runCli(dbPath, ["lease", "acquire", "ticket:337", "--holder", "architect-omnislash", "--ttl", "1800"]);
    await runCli(dbPath, ["lease", "acquire", "app:widget", "--holder", "architect-omnislash", "--ttl", "300"]);
    await runCli(dbPath, ["agent", "register", "--id", "337", "--ticket", "337", "--holder", "architect-omnislash"]);

    const done = JSON.parse((await runCli(dbPath, ["agent", "done", "architect-omnislash", "--json"])).out);
    expect(done.released).toEqual(["app:widget"]);
    expect(done.kept).toEqual(["ticket:337"]);
    const left = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(left.map((l: { resource: string }) => l.resource)).toEqual(["ticket:337"]);
    expect(left[0].holder).toBe("architect-omnislash");
  });

  test("an agent that claimed the ticket itself still releases it on done", async () => {
    const dbPath = freshDbPath();
    expect((await runCli(dbPath, ["agent", "register", "--id", "337", "--ticket", "337"])).code).toBe(0);
    const done = JSON.parse((await runCli(dbPath, ["agent", "done", "337", "--json"])).out);
    expect(done.released).toEqual(["ticket:337"]);
    expect(done.kept).toEqual([]);
    expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toEqual([]);
  });
});

describe("e2e (#97): REAL git, a leased worktree survives 'spinoff cleanup --force'", () => {
  // The only test that drives real `git` (no `sh` seam) and the real CLI. It exists because the fake
  // seam CANNOT catch the path-alias class of bug: `git worktree list --porcelain` prints the resolved
  // /private/var path while `$PWD`/mktemp hands out the /var symlink, so a lease taken on one alias
  // guarded nothing and cleanup deleted the tree anyway. Local git only: no network, no live DB.
  function git(cwd: string, ...args: string[]): void {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  }

  test("leased → skipped with 'held by' even under --force; released → removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ob-e2e-"));
    const repo = join(root, "repo");
    const wt = join(root, "repo.build-96");
    try {
      git(root, "init", "-q", "repo");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      await Bun.write(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "init");
      git(repo, "branch", "-M", "main");
      git(repo, "worktree", "add", "-q", wt, "-b", "build-96", "main");

      const dbPath = freshDbPath();
      // the lease is taken on the /var alias; git will report /private/var, so one key must cover both
      const acq = await runCli(dbPath, ["lease", "acquire", `worktree:${wt}`, "--holder", "architect-reviewing", "--ttl", "1800"]);
      expect(acq.code).toBe(0);

      const guarded = await runCli(dbPath, ["spinoff", "cleanup", "--repo", repo, "--force", "--json"]);
      const g = JSON.parse(guarded.out);
      expect(g.removed).toEqual([]);
      expect(g.skipped[0].reason).toContain("held by architect-reviewing");
      expect(existsSync(wt)).toBe(true); // the tree the architect is reviewing is STILL THERE

      await runCli(dbPath, ["lease", "release", `worktree:${wt}`, "--holder", "architect-reviewing"]);
      const swept = JSON.parse((await runCli(dbPath, ["spinoff", "cleanup", "--repo", repo, "--json"])).out);
      expect(swept.removed.map((e: { branch: string }) => e.branch)).toEqual(["build-96"]);
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #136: the spinoff path had the same shape #75 fixed for `agent register`. The documented gate flow has
// the architect hold `ticket:<n>` for its review and THEN dispatch a builder for that same ticket, so a
// architect-held row was the one row its own drain could not launch: milder than the register bug (the row
// stayed pending and was reported, so it self-healed once the hold lapsed), but the same defect, and it
// meant the gate flow and the dispatch flow could never overlap. A hold by ANOTHER live session must
// still leave the row pending and reported (#97), which is what these tests pin either side of.
describe("launchClaimKeys (#136): a launch claims every key EXCEPT the ones its holder already holds", () => {
  test("a live hold by `under` is skipped; a foreign one, an expired one and a free key are all claimed", async () => {
    const db = freshDb();
    seedLease(db, "ticket:136", "architect-omnislash", 1800, pastIso(10)); // live, ours
    seedLease(db, "ticket:137", "architect-other", 1800, pastIso(10)); // live, foreign
    seedLease(db, "ticket:138", "architect-omnislash", 1, pastIso(600)); // ours but EXPIRED: protects nothing
    const keys = ["ticket:136", "ticket:137", "ticket:138", "ticket:139", null];

    expect((await launchClaimKeys(db, keys, "architect-omnislash"))).toEqual(["ticket:137", "ticket:138", "ticket:139", null]);
    expect((await launchClaimKeys(db, keys, ""))).toEqual(keys); // no holder named: the unchanged default claims all
  });
});

describe("drain --holder (#136): an architect drains the ticket it is holding for its gate", () => {
  /** A pending row whose worktree is a REAL directory, so `ensureWorktree` needs no git. */
  async function pendingRow(db: ReturnType<typeof freshDb>, worktree: string): Promise<void> {
    (await enqueueSpinoff(db, { ticketRef: "#136", repo: REPO, branch: "build-136", mode: "agent", brief: "b", worktree }));
  }
  /**
   * Every shell-out a launch makes succeeds (`git merge-base`), and T3 is a fake that records each thread
   * it is asked to open (1589: T3 is the only launcher). Nothing real starts.
   */
  function fakeLaunchSh(): { launches: ReturnType<typeof installFakeT3>["launches"]; restore: () => void } {
    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    const t3 = installFakeT3([REPO]);
    return {
      launches: t3.launches,
      restore: () => {
        t3.restore();
        restoreSh();
      },
    };
  }

  test("the architect's own hold blocks the drain WITHOUT the flag, and is compatible WITH it", async () => {
    const db = freshDb();
    const wt = mkdtempSync(join(tmpdir(), "ob-136-wt-"));
    const wtKey = worktreeLeaseKey(wt); // resolved while the dir still exists (the cleanup below removes it)
    await pendingRow(db, wt);
    (await acquireLeases(db, [ticketLeaseKey("#136")], "architect-omnislash", 1800));
    const before = (await leaseStatus(db)).find((l) => l.resource === "ticket:136")!;

    // the defect: the documented gate flow's own hold read as contention
    expect((await drainSpinoffs(db)).blocked).toEqual([
      { ticket: "#136", resource: "ticket:136", holder: "architect-omnislash" },
    ]);
    expect((await listSpinoffs(db, "pending"))).toHaveLength(1);

    const { launches, restore } = fakeLaunchSh();
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = (await drainSpinoffs(db, "architect-omnislash"));
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
    expect(r.launched).toEqual(["#136"]);
    expect(r.blocked).toEqual([]);
    expect(launches).toHaveLength(1); // the launch really went through the launcher
    expect((await listSpinoffs(db, "launched")).map((s) => s.ticket_ref)).toEqual(["#136"]);

    // the architect's hold is LEFT EXACTLY AS IT IS: not re-taken by the agent, TTL not shortened
    const after = (await leaseStatus(db)).find((l) => l.resource === "ticket:136")!;
    expect(after.holder).toBe("architect-omnislash");
    expect(after.ttl_s).toBe(1800);
    expect(after.acquired_at).toBe(before.acquired_at);
    expect(after.heartbeat_at).toBe(before.heartbeat_at);
    // and the key it did NOT hold is claimed under the agent id (the branch), as always
    expect((await leaseStatus(db)).find((l) => l.resource === wtKey)?.holder).toBe("build-136");
  });

  test("a hold by ANOTHER live session still leaves the row pending and reported, flag or no flag", async () => {
    const db = freshDb();
    const wt = mkdtempSync(join(tmpdir(), "ob-136-foreign-"));
    await pendingRow(db, wt);
    (await acquireLeases(db, [ticketLeaseKey("#136")], "architect-other", 1800));

    const { restore } = fakeLaunchSh();
    let r: Awaited<ReturnType<typeof drainSpinoffs>>;
    try {
      r = (await drainSpinoffs(db, "architect-omnislash")); // a holder that is NOT the one holding it
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
    expect(r.launched).toEqual([]);
    expect(r.failed).toEqual([]); // pending + reported, never failed (#97)
    expect(r.blocked).toEqual([{ ticket: "#136", resource: "ticket:136", holder: "architect-other" }]);
    expect((await listSpinoffs(db, "pending"))).toHaveLength(1);
    expect((await leaseStatus(db)).find((l) => l.resource === "ticket:136")?.holder).toBe("architect-other");
  });

  test("reconcile under the same --holder lands the ticket its reviewer is holding", async () => {
    const db = freshDb();
    (await enqueueSpinoff(db, { ticketRef: "#96", repo: REPO, branch: "build-96", mode: "agent", brief: "b", worktree: WT96 }));
    db.query("UPDATE spinoff SET status='launched', agent_id='build-96', base_sha='base' WHERE ticket_ref='#96'").run();
    (await registerAgent(db, { id: "build-96", ticket: "#96", worktree: WT96, branch: "build-96", ttlS: 900 }));
    (await acquireLeases(db, [ticketLeaseKey("#96")], "architect-omnislash", 1800));

    expect((await reconcileSpinoffs(db, () => true, undefined, () => 3)).merged).toEqual([]); // a THIRD party would block it
    const rec = (await reconcileSpinoffs(db, () => true, undefined, () => 3, "architect-omnislash"));
    expect(rec.merged).toEqual(["#96"]);
    expect(rec.blocked).toEqual([]);
    // landing releases the AGENT's leases; the architect's own hold is left for the architect to release
    expect((await leaseStatus(db)).map((l) => l.holder)).toEqual(["architect-omnislash"]);
  });

  test("CLI: 'spinoff drain' reports ⏸ for the held row, and '--holder' launches it", async () => {
    const dbPath = freshDbPath();
    const wt = mkdtempSync(join(tmpdir(), "ob-136-cli-"));
    (await enqueueSpinoff(openDb(dbPath), {
      ticketRef: "#136",
      repo: REPO,
      branch: "build-136",
      mode: "agent",
      brief: "b",
      worktree: wt,
    }));
    await runCli(dbPath, ["lease", "acquire", "ticket:136", "--holder", "architect-omnislash", "--ttl", "1800"]);

    // OB-1796: this test is about the holder, not the scope; the row's repo is a fake, so drain every repo.
    const blocked = await runCli(dbPath, ["spinoff", "drain", "--all"]);
    expect(blocked.out).toContain("⏸ #136: left queued, ticket:136 held by architect-omnislash");

    // The launch goes through the REAL t3 launcher here, with only T3 itself faked: the brief is the
    // thread's opening message and the thread is bound to the row's worktree.
    const { launches, restore } = fakeLaunchSh();
    let drained: Awaited<ReturnType<typeof runCli>>;
    try {
      drained = await runCli(dbPath, ["spinoff", "drain", "--all", "--holder", "architect-omnislash"]);
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
    expect(launches).toHaveLength(1);
    expect(JSON.stringify(launches[0]!.workspaceStrategy)).toContain(wt);
    expect(launches[0]!.message).toContain("b"); // the brief reaches the agent as its opening prompt
    expect(drained.out).toContain("launched 1");
    expect(drained.out).not.toContain("⏸");
    // the hold survives its own drain: the architect is still gating, and releases it itself on land
    const leases = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(leases.find((l: { resource: string }) => l.resource === "ticket:136").holder).toBe("architect-omnislash");
  });
});

describe("ob spinoff <ref> under a foreign hold refuses before it queues (1589)", () => {
  /**
   * Same fakes as the drain block above: every shell-out succeeds, T3 records each launch. The `#136`
   * ref is a GitHub issue, so the issue fetch is faked too (OB-1759): left live, these tests read a
   * token from `gh` and called GitHub, and failed on any machine without a `gh` login (CI).
   */
  function fakeLaunchSh(repo: string): { launches: ReturnType<typeof installFakeT3>["launches"]; restore: () => void } {
    const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
    const restoreIssue = __setFetchIssue(async (_db, _repo, number) => ({
      number,
      title: "Foreign hold",
      body: null,
      url: `https://github.com/x/issues/${number}`,
    }));
    const t3 = installFakeT3([repo]);
    return { launches: t3.launches, restore: () => (t3.restore(), restoreIssue(), restoreSh()) };
  }
  const spinoffArgv = (repo: string, wt: string, ...extra: string[]) =>
    ["spinoff", ...extra, "#136", "--repo", repo, "--branch", "build-136", "--worktree", wt, "--brief", "b"];

  for (const [label, extra] of [["ob spinoff <ref>", []], ["ob spinoff queue <ref> (the split server half)", ["queue"]]] as const) {
    test(`${label}: a named refusal, a non-zero exit, no row and no launch`, async () => {
      const dbPath = freshDbPath();
      const repo = fakeRepoDir();
      const wt = mkdtempSync(join(tmpdir(), "ob-1589-foreign-"));
      await runCli(dbPath, ["lease", "acquire", "ticket:136", "--holder", "architect-other", "--ttl", "1800"]);
      const { launches, restore } = fakeLaunchSh(repo);
      let r: Awaited<ReturnType<typeof runCli>>;
      try {
        r = await runCli(dbPath, spinoffArgv(repo, wt, ...extra));
      } finally {
        restore();
        rmSync(wt, { recursive: true, force: true });
      }
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("not dispatched");
      expect(r.err).toContain("architect-other");
      expect(launches).toHaveLength(0);
      expect(JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out)).toEqual([]);
    });
  }

  test("--holder naming the hold dispatches under it: launched, thread id stamped, hold untouched", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const wt = mkdtempSync(join(tmpdir(), "ob-1589-own-"));
    await runCli(dbPath, ["lease", "acquire", "ticket:136", "--holder", "architect-omnislash", "--ttl", "1800"]);
    const { launches, restore } = fakeLaunchSh(repo);
    let r: Awaited<ReturnType<typeof runCli>>;
    try {
      r = await runCli(dbPath, [...spinoffArgv(repo, wt), "--holder", "architect-omnislash", "--no-check", "a test fixture"]);
    } finally {
      restore();
      rmSync(wt, { recursive: true, force: true });
    }
    expect(r.code).toBe(0);
    expect(launches).toHaveLength(1);
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out);
    expect(rows.map((s: { status: string }) => s.status)).toEqual(["building"]); // the list's word for launched
    expect(rows[0].t3_thread_id).toBeTruthy();
    const leases = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
    expect(leases.find((l: { resource: string }) => l.resource === "ticket:136").holder).toBe("architect-omnislash");
  });
});
