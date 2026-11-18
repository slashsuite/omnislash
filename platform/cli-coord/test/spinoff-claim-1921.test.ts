// OB-1921: the launch claim. A claim lease that cannot be taken leaves the row queued; a `launching` row
// whose claim lease is gone is reclaimed once it is older than the claim TTL; a running launch heartbeats
// its claim so it is not reclaimed underneath itself; `launch_attempts` is counted once per attempt, at
// the claim, on every path; and a row with no `base_sha` still auto-lands once its branch has merged.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { freshDb, fakeRepoDir } from "../../../apps/cli/test/helpers.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { lease as leaseTable, spinoff } from "../../../apps/cli/src/db/schema.ts";
import { acquireLeases, recordedHold } from "../src/lease.ts";
import {
  CLAIM_TTL_S,
  MAX_LAUNCH_ATTEMPTS,
  claimSpinoffRow,
  enqueueSpinoff,
  getSpinoffRow,
  launchQueuedRow,
  localSpinoffSteps,
  reclaimSpinoffs,
  reconcileSpinoffs,
  recordSpinoffSpawnFailure,
  remoteSpinoffSteps,
  spinoffClaimKey,
  stampSpinoff,
  withClaimHeartbeat,
  type SpinoffRow,
} from "../src/commands/spinoff.ts";

type Db = ReturnType<typeof freshDb>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function queue(db: Db, ticket = "#1921", repo?: string, branch = "build-1921"): Promise<SpinoffRow> {
  const r = repo ?? fakeRepoDir();
  dirs.push(r);
  const { row } = await enqueueSpinoff(db, { ticketRef: ticket, repo: r, branch, worktree: join(r, "wt"), mode: "agent", brief: "b" });
  return row;
}

const past = (s: number) => new Date(Date.now() - s * 1000).toISOString();

function expireClaim(db: Db, id: number): void {
  const at = past(CLAIM_TTL_S + 60);
  orm(db).update(leaseTable).set({ acquired_at: at, heartbeat_at: at }).where(eq(leaseTable.resource, spinoffClaimKey(id))).run();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the claim lease is checked (OB-1921)", () => {
  test("a claim lease held live by someone else leaves the row pending, counts nothing, and says why", async () => {
    const db = freshDb();
    const row = await queue(db);
    expect((await acquireLeases(db, [spinoffClaimKey(row.id)], "someone-else", CLAIM_TTL_S)).ok).toBe(true);
    const outcome = await claimSpinoffRow(db, row.id);
    expect(outcome.claimed).toBeNull();
    expect(outcome.error).toContain("someone-else");
    const after = (await getSpinoffRow(db, row.id))!;
    expect(after.status).toBe("pending");
    expect(after.launch_attempts ?? 0).toBe(0);
  });

  test("the drain's per-row launch reports that refusal as not-ready, never as a launching row", async () => {
    const db = freshDb();
    const row = await queue(db);
    await acquireLeases(db, [spinoffClaimKey(row.id)], "someone-else", CLAIM_TTL_S);
    const r = await launchQueuedRow(db, row, "", localSpinoffSteps(db), () => []);
    expect(r.kind).toBe("not-ready");
    expect((await getSpinoffRow(db, row.id))!.status).toBe("pending");
  });
});

describe("reclaim takes a launching row with no claim lease (OB-1921)", () => {
  test("older than the claim TTL: back to pending", async () => {
    const db = freshDb();
    const row = await queue(db);
    orm(db).update(spinoff).set({ status: "launching", launched_at: past(CLAIM_TTL_S + 60), launch_attempts: 1 }).where(eq(spinoff.id, row.id)).run();
    expect(await recordedHold(db, spinoffClaimKey(row.id))).toBeNull();
    const got = await reclaimSpinoffs(db);
    expect(got).toEqual([{ id: row.id, ticket: row.ticket_ref, status: "pending", attempts: 1 }]);
    const after = (await getSpinoffRow(db, row.id))!;
    expect(after.status).toBe("pending");
    expect(after.error).toContain("no claim on record");
  });

  test("with no launched_at, the request time ages it (a row moved by hand, or from before 191)", async () => {
    const db = freshDb();
    const row = await queue(db);
    orm(db).update(spinoff).set({ status: "launching", request_at: past(3600) }).where(eq(spinoff.id, row.id)).run();
    expect((await reclaimSpinoffs(db)).map((e) => e.status)).toEqual(["pending"]);
  });

  test("inside the claim TTL it is left alone: it may still be launching", async () => {
    const db = freshDb();
    const row = await queue(db);
    orm(db).update(spinoff).set({ status: "launching", launched_at: past(10) }).where(eq(spinoff.id, row.id)).run();
    expect(await reclaimSpinoffs(db)).toEqual([]);
    expect((await getSpinoffRow(db, row.id))!.status).toBe("launching");
  });
});

describe("a running launch heartbeats its claim (OB-1921)", () => {
  test("a long launch with heartbeats is not reclaimed", async () => {
    const db = freshDb();
    const row = await queue(db);
    const claimed = (await claimSpinoffRow(db, row.id)).claimed!;
    const steps = localSpinoffSteps(db);
    const seen = await withClaimHeartbeat(
      () => steps.heartbeatClaim(claimed),
      async () => {
        expireClaim(db, row.id); // the launch has run past one whole TTL ...
        await sleep(60); // ... and the beats keep coming: OB-1922 takes the lapsed claim again, fresh
        return reclaimSpinoffs(db);
      },
      10,
    );
    expect(seen).toEqual([]);
    expect((await getSpinoffRow(db, row.id))!.status).toBe("launching");
  });

  test("the same launch without heartbeats is reclaimed, which is the race the beat closes", async () => {
    const db = freshDb();
    const row = await queue(db);
    await claimSpinoffRow(db, row.id);
    expireClaim(db, row.id);
    expect((await reclaimSpinoffs(db)).map((e) => e.id)).toEqual([row.id]);
  });

  test("the heartbeat stops when the launch throws", async () => {
    let beats = 0;
    const err = await withClaimHeartbeat(
      async () => {
        beats++;
      },
      async () => {
        await sleep(25);
        throw new Error("launcher blew up");
      },
      5,
    ).catch((e) => e as Error);
    expect(err.message).toBe("launcher blew up");
    const at = beats;
    expect(at).toBeGreaterThan(0);
    await sleep(25);
    expect(beats).toBe(at);
  });

  test("over the remote seam the beat is `ob lease heartbeat spinoff:<id> --holder <branch>`", async () => {
    const calls: string[][] = [];
    const steps = remoteSpinoffSteps({ write: (argv: string[]) => (calls.push(argv), { ok: true, stdout: "", message: "" }) } as never);
    await steps.heartbeatClaim({ id: 7, branch: "ob-7" } as SpinoffRow);
    expect(calls).toEqual([["lease", "heartbeat", "spinoff:7", "--holder", "ob-7", "--json"]]);
  });

  test("a lapsed claim the beat cannot revive is taken again with a fresh acquire (OB-1922)", async () => {
    const db = freshDb();
    const row = await queue(db);
    const claimed = (await claimSpinoffRow(db, row.id)).claimed!;
    expireClaim(db, row.id);
    await localSpinoffSteps(db).heartbeatClaim(claimed);
    const hold = (await recordedHold(db, spinoffClaimKey(row.id)))!;
    expect(hold.holder).toBe(row.branch);
    expect(new Date(hold.since!).getTime()).toBeGreaterThan(Date.now() - 5_000); // a fresh lease, not the old one revived
    expect(await reclaimSpinoffs(db)).toEqual([]);
  });

  test("a claim another holder took live is not taken back by the beat (OB-1922)", async () => {
    const db = freshDb();
    const row = await queue(db);
    const claimed = (await claimSpinoffRow(db, row.id)).claimed!;
    expireClaim(db, row.id);
    expect((await acquireLeases(db, [spinoffClaimKey(row.id)], "someone-else", CLAIM_TTL_S)).ok).toBe(true);
    await localSpinoffSteps(db).heartbeatClaim(claimed);
    expect((await recordedHold(db, spinoffClaimKey(row.id)))!.holder).toBe("someone-else");
  });

  test("over the remote seam a beat refused as expired falls back to `ob lease acquire` (OB-1922)", async () => {
    const calls: string[][] = [];
    const answer = JSON.stringify({ resource: "spinoff:7", beat: false, error: "LeaseExpiredError" });
    const steps = remoteSpinoffSteps({
      write: (argv: string[]) => (calls.push(argv), argv[1] === "heartbeat" ? { ok: false, stdout: answer, message: "x" } : { ok: true, stdout: "", message: null }),
    } as never);
    await steps.heartbeatClaim({ id: 7, branch: "ob-7" } as SpinoffRow);
    expect(calls).toEqual([
      ["lease", "heartbeat", "spinoff:7", "--holder", "ob-7", "--json"],
      ["lease", "acquire", "spinoff:7", "--holder", "ob-7", "--ttl", String(CLAIM_TTL_S)],
    ]);
  });

  test("over the remote seam a beat refused for any other reason does not re-acquire (OB-1922)", async () => {
    const calls: string[][] = [];
    const answer = JSON.stringify({ resource: "spinoff:7", beat: false, recorded: null });
    const steps = remoteSpinoffSteps({ write: (argv: string[]) => (calls.push(argv), { ok: false, stdout: answer, message: "x" }) } as never);
    await steps.heartbeatClaim({ id: 7, branch: "ob-7" } as SpinoffRow);
    expect(calls).toHaveLength(1);
  });
});

describe("launch_attempts counts once per attempt, on every path (OB-1921)", () => {
  test("claim then launched: 1, and the session re-stamp does not add one", async () => {
    const db = freshDb();
    const row = await queue(db);
    await claimSpinoffRow(db, row.id);
    expect((await getSpinoffRow(db, row.id))!.launch_attempts).toBe(1);
    await stampSpinoff(db, { id: row.id, outcome: "launched", worktree: row.worktree, launcher: "t3" });
    await stampSpinoff(db, { id: row.id, outcome: "launched", session_id: "ses-1" });
    expect((await getSpinoffRow(db, row.id))!.launch_attempts).toBe(1);
  });

  test("claim then a launcher that threw: 1", async () => {
    const db = freshDb();
    const row = await queue(db);
    await claimSpinoffRow(db, row.id);
    await stampSpinoff(db, { id: row.id, outcome: "failed", error: "boom" });
    const after = (await getSpinoffRow(db, row.id))!;
    expect(after.status).toBe("failed");
    expect(after.launch_attempts).toBe(1);
  });

  test("spawn failure: 1 then retry, 2 then terminal", async () => {
    const db = freshDb();
    const row = await queue(db);
    await claimSpinoffRow(db, row.id);
    await stampSpinoff(db, { id: row.id, outcome: "launched", worktree: row.worktree, launcher: "t3" });
    expect(await recordSpinoffSpawnFailure(db, row.branch, "no session")).toMatchObject({ status: "pending", attempts: 1 });
    await claimSpinoffRow(db, row.id);
    expect(await recordSpinoffSpawnFailure(db, row.branch, "no session")).toMatchObject({ status: "failed", attempts: MAX_LAUNCH_ATTEMPTS });
  });

  test("reclaim: 1 then retry, 2 then terminal (reclaim itself adds nothing)", async () => {
    const db = freshDb();
    const row = await queue(db);
    await claimSpinoffRow(db, row.id);
    expireClaim(db, row.id);
    expect(await reclaimSpinoffs(db)).toEqual([{ id: row.id, ticket: row.ticket_ref, status: "pending", attempts: 1 }]);
    await claimSpinoffRow(db, row.id);
    expireClaim(db, row.id);
    expect(await reclaimSpinoffs(db)).toEqual([{ id: row.id, ticket: row.ticket_ref, status: "failed", attempts: 2 }]);
  });
});

describe("a row with no base_sha auto-lands once its branch has merged (OB-1921, OB-1631)", () => {
  const git = (repo: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args]);
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };

  test("the fork point comes from the branch's reflog, so the merged branch counts its own commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-1921-repo-"));
    dirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "1");
    git(repo, "add", "a");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "branch", "ob-1631");
    git(repo, "checkout", "-q", "ob-1631");
    writeFileSync(join(repo, "a"), "2");
    git(repo, "commit", "-q", "-am", "fix(OB-1631): the work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "ob-1631");

    const db = freshDb();
    const row = await queue(db, "#1631", repo, "ob-1631");
    orm(db).update(spinoff).set({ status: "launched", agent_id: "ob-1631", base_sha: null }).where(eq(spinoff.id, row.id)).run();

    const zero = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    const rec = await reconcileSpinoffs(db, undefined, () => zero, undefined, "", localSpinoffSteps(db), () => []);
    expect(rec.merged).toEqual(["#1631"]);
    expect((await getSpinoffRow(db, row.id))!.status).toBe("merged");
  });
});
