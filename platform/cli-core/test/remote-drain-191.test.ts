import { describe, expect, test } from "bun:test";
import { syncAwait } from "../../../apps/cli/test/sync-await.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { run } from "../../../apps/cli/src/cli.ts";
import { openDb, nowIso } from "../../../apps/cli/src/db.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { lease as leaseTable, spinoff } from "../../../apps/cli/src/db/schema.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { doneAgent, getAgent } from "../../cli-coord/src/agent.ts";
import { acquireLeases, recordedHold, releaseLeasesByHolder, ticketLeaseKey } from "../../cli-coord/src/lease.ts";
import { dumpReplicaBytes, expectedFingerprint, gunzip, replicaPath, replicaToken, schemaCachePath } from "../../../apps/cli/src/replica.ts";
import type { RemoteExec } from "../../../apps/cli/src/remote.ts";
import { fakeRepoDir, freshDb, freshDbPath, migratedDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import {
  CLAIM_TTL_S,
  claimSpinoffRow,
  drainSpinoffs,
  enqueueSpinoff,
  landSpinoff,
  listSpinoffs,
  reclaimSpinoffs,
  spinoffClaimKey,
  stampSpinoff,
  __setSh,
  type SpinoffRow,
} from "../../cli-coord/src/commands/spinoff.ts";

// ob 191: `spinoff drain` as a SPLIT command. 189 refused it, because its database half was a per-row
// claim/lease/launch/stamp pass in one sweep; here that sweep is separated into a CLAIM and a STAMP that
// each cross the wire, with the launch itself staying on the machine that has the tabs.
//
// Nothing in this file shells out to ssh, spawns a real agent or touches the network: the spawn is
// seamed, and every remote interaction goes through 183's injected RemoteExec. The "server" is a second
// real database in a temp dir, and the step sub-invocations are applied to it by the same functions the
// CLI handlers call.

interface StepServer extends RemoteExec {
  calls: string[][];
  events: string[];
  db: Database;
  reachable: boolean;
  failStamp: boolean;
}

function argAt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** A server that really applies the step commands to its own database, so assertions read real rows. */
function stepServer(serverDbPath: string): StepServer {
  const db = openDb(serverDbPath);
  const server: StepServer = {
    calls: [],
    events: [],
    db,
    reachable: true,
    failStamp: false,
    stream(_host, argv) {
      server.calls.push(argv);
      return server.reachable ? { code: 0, connectionFailed: false } : { code: 255, connectionFailed: true };
    },
    capture(_host, argv) {
      server.calls.push(argv);
      if (!server.reachable) return { code: 255, connectionFailed: true, stdout: "", stderr: "" };
      const ok = (value: unknown) => ({ code: 0, connectionFailed: false, stdout: JSON.stringify(value), stderr: "" });
      if (argv[0] === "replica" && argv[1] === "token") return ok(replicaToken(serverDbPath));
      if (argv[0] === "spinoff" && argv[1] === "reclaim") return ok({ reclaimed: syncAwait(reclaimSpinoffs(db)) });
      if (argv[0] === "spinoff" && argv[1] === "claim") {
        server.events.push("claim");
        const outcome = syncAwait(claimSpinoffRow(db, Number(argAt(argv, "id")), argAt(argv, "holder") ?? ""));
        return ok({ claimed: outcome.claimed, error: outcome.error });
      }
      if (argv[0] === "spinoff" && argv[1] === "stamp") {
        server.events.push("stamp");
        if (server.failStamp) return { code: 1, connectionFailed: false, stdout: "", stderr: "error: the server said no\n" };
        syncAwait(stampSpinoff(db, {
          id: Number(argAt(argv, "id")),
          outcome: argAt(argv, "outcome") === "launched" ? "launched" : "failed",
          worktree: argAt(argv, "worktree") ?? null,
          base_sha: argAt(argv, "base-sha") ?? null,
          launcher: argAt(argv, "launcher") ?? null,
          session_id: argAt(argv, "session") ?? null,
          t3_thread_id: argAt(argv, "t3-thread") ?? null,
          t3_run_id: argAt(argv, "t3-run") ?? null,
          model: argAt(argv, "model") ?? null,
          error: argAt(argv, "error") ?? null,
        }));
        return ok({ id: Number(argAt(argv, "id")) });
      }
      if (argv[0] === "spinoff" && argv[1] === "land") {
        syncAwait(landSpinoff(db, Number(argAt(argv, "id")), {
          inputTokens: Number(argAt(argv, "input-tokens") ?? 0),
          outputTokens: Number(argAt(argv, "output-tokens") ?? 0),
          cacheCreationTokens: Number(argAt(argv, "cache-creation-tokens") ?? 0),
          cacheReadTokens: Number(argAt(argv, "cache-read-tokens") ?? 0),
          totalTokens: Number(argAt(argv, "total-tokens") ?? 0),
        }));
        return ok({ id: Number(argAt(argv, "id")) });
      }
      if (argv[0] === "agent" && argv[1] === "done") {
        server.events.push("agent done");
        if (server.failStamp) return { code: 1, connectionFailed: false, stdout: "", stderr: "error: the server said no\n" };
        const id = argv[2]!;
        const done = syncAwait(doneAgent(db, id));
        const released = syncAwait(releaseLeasesByHolder(db, id));
        return ok({ id, done, released });
      }
      return ok({});
    },
    fetch(_host, argv) {
      server.calls.push(argv);
      if (!server.reachable) return { code: 255, connectionFailed: true, stderr: "", bytes: new Uint8Array() };
      return { code: 0, connectionFailed: false, stderr: "", bytes: dumpReplicaBytes(db) };
    },
  };
  return server;
}

/**
 * OB-2023: the replica's expected schema fingerprint, cached beside each client database. Without it every
 * fresh client dir migrates a third scratch database just to fingerprint it, so it is computed for real once
 * per file (on a primer client) and the cache file is copied to the rest.
 */
let schemaCache: string | null = null;
function primeSchemaCache(dbPath: string): void {
  if (schemaCache === null) {
    // expectedFingerprint migrates its own scratch database; the primer path only says where the cache goes.
    const primer = join(mkdtempSync(join(tmpdir(), "ob-191-primer-")), "omnislash.sqlite");
    expectedFingerprint(primer);
    schemaCache = readFileSync(schemaCachePath(primer), "utf8");
  }
  writeFileSync(schemaCachePath(dbPath), schemaCache);
}

/** A client pointed at `host`, with its replica seeded from the server so no refresh is needed mid-test. */
async function client(host: string, server: StepServer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ob-191-"));
  const dbPath = migratedDbPath(join(dir, "omnislash.sqlite"));
  primeSchemaCache(dbPath);
  const db = openDb(dbPath);
  await setConfig(db, "remote_host", host);
  db.close();
  await Bun.write(replicaPath(dbPath), gunzip(dumpReplicaBytes(server.db)));
  return dbPath;
}

function serverDbPath(): string {
  return migratedDbPath();
}

/** A queued row whose worktree already exists, so the launch needs no git at all. */
/** Every repo a row was queued against, so the fake T3 has a project for each (1589). */
const queuedRepos: string[] = [];

function queueRow(db: Database, ticket = "#191"): { row: SpinoffRow; worktree: string } {
  const worktree = mkdtempSync(join(tmpdir(), "ob-191-wt-"));
  const repo = fakeRepoDir();
  queuedRepos.push(repo);
  const { row } = syncAwait(enqueueSpinoff(db, {
    ticketRef: ticket,
    repo,
    branch: `build-${ticket.replace("#", "")}`,
    worktree,
    mode: "agent",
    brief: "b",
  }));
  return { row, worktree };
}

/** The t3 launcher's seams (1589): a fake T3 that records each thread it opens, and no git. */
async function withLaunchSeams<T>(fn: (spawned: string[], events: string[]) => T | Promise<T>): Promise<T> {
  const spawned: string[] = [];
  const events: string[] = [];
  const restoreSh = __setSh(() => ({ ok: true, err: "", out: "" }));
  const t3 = installFakeT3(queuedRepos, (input) => {
    events.push("launch");
    spawned.push(input.title);
  });
  try {
    return await fn(spawned, events);
  } finally {
    t3.restore();
    restoreSh();
  }
}

/** `runCli`, plus the injected ssh seam. */
async function runCliWith(dbPath: string, args: string[], exec: RemoteExec): Promise<Promise<{ code: number; out: string; err: string }>> {
  const prevDb = process.env.OMNISLASH_DB;
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    err += chunk;
    return true;
  };
  process.env.OMNISLASH_DB = dbPath;
  try {
    const code = await run(args, { exec });
    return { code, out, err };
  } finally {
    console.log = origLog;
    (process.stderr.write as unknown) = origErr;
    if (prevDb === undefined) delete process.env.OMNISLASH_DB;
    else process.env.OMNISLASH_DB = prevDb;
  }
}

/** Back-date a claim so it reads as lapsed, which is what a drain that never came back leaves behind. */
function expireClaim(db: Database, id: number): void {
  const past = new Date(Date.now() - (CLAIM_TTL_S + 60) * 1000).toISOString();
  orm(db)
    .update(leaseTable)
    .set({ acquired_at: past, heartbeat_at: past })
    .where(eq(leaseTable.resource, spinoffClaimKey(id)))
    .run();
}

describe("drain as a split command: the round trip (191)", () => {
  test("CLAIM there, LAUNCH here, STAMP there -- in that order", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { row, worktree } = queueRow(server.db);
    const dbPath = await client("ob@server", server);

    const res = await withLaunchSeams(async (spawned, events) => {
      server.events = events; // one shared timeline, so the ORDER is what is asserted
      const r = await runCliWith(dbPath, ["spinoff", "drain", "--all", "--json"], server);
      return { ...r, spawned };
    });
    rmSync(worktree, { recursive: true, force: true });

    expect(res.code).toBe(0);
    expect(server.events).toEqual(["claim", "launch", "stamp"]);
    // the local half really happened HERE
    expect(res.spawned).toHaveLength(1);
    // and the row moved on the SERVER, not on this machine
    const landed = syncAwait(listSpinoffs(server.db, "launched"));
    expect(landed.map((s) => s.ticket_ref)).toEqual([row.ticket_ref]);
    expect(landed[0]!.t3_thread_id).toBe("t3-1"); // the T3 thread id, stamped on the SERVER in the same pass (1589)
    expect(landed[0]!.launcher).toBe("t3");
    // 1189: the launcher registers the row but claims NO workflow word (the spinoff row says a launch is
    // in flight); `?.status` is null only if the row exists, so this asserts both.
    expect(syncAwait(getAgent(server.db, row.branch))?.status).toBeNull();
    const clientDb = openDb(dbPath);
    expect(syncAwait(listSpinoffs(clientDb, "launched"))).toEqual([]);
    clientDb.close();
    // the claim is answered, so nothing waits on its TTL
    expect(syncAwait(recordedHold(server.db, spinoffClaimKey(row.id)))).toBeNull();
  });

  test("the sweep itself is never dispatched: only its steps cross the wire", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { worktree } = queueRow(server.db);
    const dbPath = await client("ob@server", server);
    await withLaunchSeams(async (_w, events) => {
      server.events = events;
      return await runCliWith(dbPath, ["spinoff", "drain", "--all", "--json"], server);
    });
    rmSync(worktree, { recursive: true, force: true });

    const dispatched = server.calls.filter((c) => c[0] === "spinoff").map((c) => c[1]);
    expect(dispatched).not.toContain("drain");
    expect(dispatched).toContain("reclaim");
    expect(dispatched).toContain("claim");
    expect(dispatched).toContain("stamp");
  });
});

describe("the claim is atomic (191)", () => {
  test("two drains against one claimable row: exactly one gets it", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    const first = syncAwait(claimSpinoffRow(db, row.id));
    const second = syncAwait(claimSpinoffRow(db, row.id));
    rmSync(worktree, { recursive: true, force: true });
    expect(first.claimed?.id).toBe(row.id);
    expect(second.claimed).toBeNull();
    expect(second.error).toBeNull(); // losing the race is not a failure, it is somebody else's launch
  });

  test("the property directly: the claim is ONE conditional statement, not a read then a write", async () => {
    // Two SEPARATE connections to the same file, which is what two machines draining at once actually
    // are. If the claim read the row and then wrote it, an interleaved pair would both see `pending`;
    // because it is a single conditional UPDATE, the second one matches no row and returns nothing.
    const path = freshDbPath();
    const seed = openDb(path);
    const { row, worktree } = queueRow(seed);
    seed.close();
    const a = openDb(path);
    const b = openDb(path);
    const outcomes = [syncAwait(claimSpinoffRow(a, row.id)), syncAwait(claimSpinoffRow(b, row.id))];
    const launchable = outcomes.filter((o) => o.claimed !== null);
    const status = (orm(a).select().from(spinoff).where(eq(spinoff.id, row.id)).get() as SpinoffRow).status;
    a.close();
    b.close();
    rmSync(worktree, { recursive: true, force: true });
    expect(launchable).toHaveLength(1);
    expect(status).toBe("launching");
  });

  test("a claimed row is never launched twice, even by a second full drain pass", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    const launches = await withLaunchSeams(async (spawned) => {
      syncAwait(drainSpinoffs(db));
      syncAwait(drainSpinoffs(db));
      return spawned;
    });
    rmSync(worktree, { recursive: true, force: true });
    expect(launches).toHaveLength(1);
    expect(syncAwait(listSpinoffs(db, "launched")).map((s) => s.ticket_ref)).toEqual([row.ticket_ref]);
  });
});

describe("a crash between claim and stamp is recoverable (191)", () => {
  test("the row goes back to pending once the claim lapses, and a later drain launches it", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    syncAwait(claimSpinoffRow(db, row.id)); // ... and the machine never comes back

    expect(syncAwait(reclaimSpinoffs(db))).toEqual([]); // still inside its TTL: nothing is taken from a live drain
    expireClaim(db, row.id);
    const recovered = syncAwait(reclaimSpinoffs(db));
    expect(recovered).toEqual([{ id: row.id, ticket: row.ticket_ref, status: "pending", attempts: 1 }]);
    expect(syncAwait(listSpinoffs(db, "pending")).map((s) => s.id)).toEqual([row.id]);

    const launches = await withLaunchSeams(async (spawned) => {
      syncAwait(drainSpinoffs(db));
      return spawned;
    });
    rmSync(worktree, { recursive: true, force: true });
    expect(launches).toHaveLength(1);
  });

  test("a second abandonment is terminal, so a deterministic crash cannot relaunch forever", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    for (let i = 0; i < 2; i++) {
      syncAwait(claimSpinoffRow(db, row.id));
      expireClaim(db, row.id);
      syncAwait(reclaimSpinoffs(db));
    }
    rmSync(worktree, { recursive: true, force: true });
    const after = syncAwait(listSpinoffs(db)).find((s) => s.id === row.id)!;
    expect(after.status).toBe("failed");
    expect(after.launch_attempts).toBe(2);
    expect(after.error).toContain("never stamped");
  });

  test("the drain reclaims at the head of every pass, and says so", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    syncAwait(claimSpinoffRow(db, row.id));
    expireClaim(db, row.id);
    const r = await withLaunchSeams(async () => syncAwait(drainSpinoffs(db)));
    rmSync(worktree, { recursive: true, force: true });
    expect(r.reclaimed.map((e) => e.ticket)).toEqual([row.ticket_ref]);
    expect(r.launched).toEqual([row.ticket_ref]); // reclaimed and relaunched in the same pass, locally
  });
});

describe("partial failure: launched here, unrecorded there (191)", () => {
  test("the tab is open, the server refused the stamp, and the user is told how to finish it", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { row, worktree } = queueRow(server.db);
    const dbPath = await client("ob@server", server);
    server.failStamp = true;

    const res = await withLaunchSeams(async (_w, events) => {
      server.events = events;
      return await runCliWith(dbPath, ["spinoff", "drain", "--all"], server);
    });
    rmSync(worktree, { recursive: true, force: true });

    expect(res.code).toBe(1);
    const said = res.out + res.err;
    expect(said).toContain("NOT RECORDED");
    expect(said).toContain("LAUNCHED here");
    expect(said).toContain("the server said no");
    expect(said).toContain(`ob spinoff stamp --id ${row.id} --outcome launched`);
    expect(said).toContain("ob spinoff reclaim");
    // the row is left CLAIMED on the server, which is exactly what reclaim recovers
    expect(syncAwait(listSpinoffs(server.db, "launching")).map((s) => s.id)).toEqual([row.id]);
    expect(syncAwait(recordedHold(server.db, spinoffClaimKey(row.id)))?.expired).toBe(false);
  });

  test("an unreachable server stops the sweep before anything local happens", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { worktree } = queueRow(server.db);
    const dbPath = await client("ob@server", server);
    server.reachable = false;

    const res = await withLaunchSeams(async (spawned, events) => {
      server.events = events;
      const r = await runCliWith(dbPath, ["spinoff", "drain", "--all"], server);
      return { ...r, spawned };
    });
    rmSync(worktree, { recursive: true, force: true });

    expect(res.code).toBe(1);
    expect(res.err).toContain("the drain stopped");
    expect(res.spawned).toEqual([]); // nothing launched
    expect(syncAwait(listSpinoffs(server.db, "pending"))).toHaveLength(1);
  });

  test("a launcher that throws is stamped failed, with what the local half had resolved", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { row } = queueRow(server.db); // its worktree dir is removed below, so ensureWorktree fails
    const worktree = syncAwait(listSpinoffs(server.db, "pending"))[0]!.worktree;
    rmSync(worktree, { recursive: true, force: true });
    const dbPath = await client("ob@server", server);

    const res = await withLaunchSeams(async (_w, events) => {
      server.events = events;
      return await runCliWith(dbPath, ["spinoff", "drain", "--all", "--json"], server);
    });

    expect(res.code).toBe(0); // the row failed; the drain itself did what it was asked
    expect(server.events).toEqual(["claim", "stamp"]); // no launch between them
    const failed = syncAwait(listSpinoffs(server.db, "failed"));
    expect(failed.map((s) => s.id)).toEqual([row.id]);
    expect(failed[0]!.error).toContain("worktree create failed");
  });

  test("a row claimed under a foreign lease fails, and the message names the --holder retry", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const { row, worktree } = queueRow(server.db);
    // taken AFTER the replica snapshot, so the client's pre-check cannot see it: the authoritative check
    // is the one on the server, which is the point of doing it inside the claim.
    const dbPath = await client("ob@server", server);
    syncAwait(acquireLeases(server.db, [ticketLeaseKey(row.ticket_ref)], "architect-other", 1800));

    const res = await withLaunchSeams(async (_w, events) => {
      server.events = events;
      return await runCliWith(dbPath, ["spinoff", "drain", "--all"], server);
    });
    rmSync(worktree, { recursive: true, force: true });

    expect(server.events).toEqual(["claim", "stamp"]);
    expect(res.out).toContain("lease unavailable");
    expect(res.out).toContain("--holder architect-other");
    expect(syncAwait(listSpinoffs(server.db, "failed")).map((s) => s.id)).toEqual([row.id]);
  });
});

describe("cleanup is a split command with a local checkout by definition (191)", () => {
  test("the branch is removed HERE and its agent is deregistered THERE", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const repo = fakeRepoDir();
    const { row, worktree } = queueRow(server.db);
    syncAwait(claimSpinoffRow(server.db, row.id));
    syncAwait(stampSpinoff(server.db, { id: row.id, outcome: "launched", worktree, launcher: "headless" }));
    syncAwait(releaseLeasesByHolder(server.db, row.branch)); // the agent has finished; its registry row is the residue cleanup clears
    server.db.query("UPDATE spinoff SET status = 'merged' WHERE id = ?").run(row.id); // OB-2159: a live row is never swept
    const dbPath = await client("ob@server", server);

    const gitCalls: string[][] = [];
    const restoreSh = __setSh((cmd) => {
      gitCalls.push(cmd);
      if (cmd[3] === "branch" && cmd[4] === "--merged") return { ok: true, err: "", out: `${row.branch}\nmain\n` };
      if (cmd[3] === "for-each-ref") return { ok: true, err: "", out: `${row.branch}\nmain\n` };
      return { ok: true, err: "", out: "" };
    });
    let res;
    try {
      res = await runCliWith(dbPath, ["spinoff", "cleanup", "--repo", repo, "--json"], server);
    } finally {
      restoreSh();
      rmSync(worktree, { recursive: true, force: true });
    }

    expect(res.code).toBe(0);
    // the git half ran against the repo named HERE, and was never dispatched
    expect(gitCalls.some((c) => c[0] === "git" && c[3] === "branch" && c.includes(row.branch))).toBe(true);
    expect(server.calls.filter((c) => c[0] === "spinoff" && c[1] === "cleanup")).toEqual([]);
    // the database half is one `agent done` on the server
    expect(server.events).toContain("agent done");
    expect(syncAwait(getAgent(server.db, row.branch))).toBeNull();
  });

  test("a removal the server did not record is reported, with the command that finishes it", async () => {
    const serverPath = serverDbPath();
    const server = stepServer(serverPath);
    const repo = fakeRepoDir();
    const { row, worktree } = queueRow(server.db);
    syncAwait(claimSpinoffRow(server.db, row.id));
    syncAwait(stampSpinoff(server.db, { id: row.id, outcome: "launched", worktree, launcher: "headless" }));
    syncAwait(releaseLeasesByHolder(server.db, row.branch)); // the agent has finished; its registry row is the residue cleanup clears
    server.db.query("UPDATE spinoff SET status = 'merged' WHERE id = ?").run(row.id); // OB-2159: a live row is never swept
    const dbPath = await client("ob@server", server);
    server.failStamp = true;

    const restoreSh = __setSh((cmd) => {
      if (cmd[3] === "branch" && cmd[4] === "--merged") return { ok: true, err: "", out: `${row.branch}\nmain\n` };
      if (cmd[3] === "for-each-ref") return { ok: true, err: "", out: `${row.branch}\nmain\n` };
      return { ok: true, err: "", out: "" };
    });
    let res;
    try {
      res = await runCliWith(dbPath, ["spinoff", "cleanup", "--repo", repo], server);
    } finally {
      restoreSh();
      rmSync(worktree, { recursive: true, force: true });
    }

    expect(res.code).toBe(1);
    const said = res.out + res.err;
    expect(said).toContain("NOT RECORDED");
    expect(said).toContain("was REMOVED from");
    expect(said).toContain(`ob agent done ${row.branch}`);
  });
});

describe("INERT: with no remote_host nothing changed (191)", () => {
  test("`ob spinoff drain` writes to the local database and asks nobody", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row, worktree } = queueRow(db);
    db.close();

    const res = await withLaunchSeams(async (spawned) => {
      const r = await runCli(dbPath, ["spinoff", "drain", "--all", "--json"]);
      return { ...r, spawned };
    });
    rmSync(worktree, { recursive: true, force: true });

    expect(res.code).toBe(0);
    const report = JSON.parse(res.out) as { launched: string[]; db_failures: unknown[]; remote_error: string | null };
    expect(report.launched).toEqual([row.ticket_ref]);
    expect(report.db_failures).toEqual([]);
    expect(report.remote_error).toBeNull();
    const after = openDb(dbPath);
    expect(syncAwait(listSpinoffs(after, "launched")).map((s) => s.ticket_ref)).toEqual([row.ticket_ref]);
    // 1189: the launcher registers the row but claims NO workflow word.
    expect(syncAwait(getAgent(after, row.branch))?.status).toBeNull();
    after.close();
    // no replica, no staleness notice, no network: the pre-cutover path is untouched. stdout carries only
    // the `--json` report this test just parsed.
    expect(res.err).not.toContain("replica");
    expect(res.err).not.toContain("stale");
  });

  test("`ob spinoff list` still answers from the local database", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { worktree } = queueRow(db);
    db.close();
    const res = await runCli(dbPath, ["spinoff", "list", "--json"]);
    rmSync(worktree, { recursive: true, force: true });
    expect(res.code).toBe(0);
    expect((JSON.parse(res.out) as Array<{ status: string }>).map((r) => r.status)).toEqual(["queued"]);
    expect(res.err).toBe("");
  });

  test("the step commands are usable by hand, which is what the recovery messages promise", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row, worktree } = queueRow(db);
    db.close();

    const claimed = await runCli(dbPath, ["spinoff", "claim", "--id", String(row.id), "--json"]);
    expect(claimed.code).toBe(0);
    expect((JSON.parse(claimed.out) as { claimed: SpinoffRow }).claimed.status).toBe("launching");

    const stamped = await runCli(dbPath, [
      "spinoff",
      "stamp",
      "--id",
      String(row.id),
      "--outcome",
      "launched",
      "--worktree",
      worktree,
      "--launcher",
      "t3",
    ]);
    expect(stamped.code).toBe(0);
    const after = openDb(dbPath);
    expect(syncAwait(listSpinoffs(after, "launched"))).toHaveLength(1);
    after.close();

    const reclaimed = await runCli(dbPath, ["spinoff", "reclaim", "--json"]);
    rmSync(worktree, { recursive: true, force: true });
    expect(JSON.parse(reclaimed.out)).toEqual({ reclaimed: [] });
  });

  test("`spinoff stamp` without an outcome is a usage error, not a guess", async () => {
    const dbPath = freshDbPath();
    const res = await runCli(dbPath, ["spinoff", "stamp", "--id", "1"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("--outcome launched|failed");
  });
});

describe("the claim's bookkeeping (191)", () => {
  test("a claim takes the ticket/worktree leases the launch runs under, and the stamp frees only the claim", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    syncAwait(claimSpinoffRow(db, row.id));
    expect(syncAwait(recordedHold(db, spinoffClaimKey(row.id)))?.holder).toBe(row.branch);
    expect(syncAwait(recordedHold(db, ticketLeaseKey(row.ticket_ref)!))?.holder).toBe(row.branch);
    syncAwait(stampSpinoff(db, { id: row.id, outcome: "launched", worktree, launcher: "headless" }));
    rmSync(worktree, { recursive: true, force: true });
    expect(syncAwait(recordedHold(db, spinoffClaimKey(row.id)))).toBeNull();
    expect(syncAwait(recordedHold(db, ticketLeaseKey(row.ticket_ref)!))?.holder).toBe(row.branch); // the agent holds it now
  });

  test("the stamp records the launch time and the attempt, exactly as the one-pass sweep did", async () => {
    const db = freshDb();
    const { row, worktree } = queueRow(db);
    syncAwait(claimSpinoffRow(db, row.id));
    syncAwait(stampSpinoff(db, { id: row.id, outcome: "launched", worktree, base_sha: "abc123", launcher: "headless", session_id: "s-1" }));
    rmSync(worktree, { recursive: true, force: true });
    const after = syncAwait(listSpinoffs(db))[0]!;
    expect(after.status).toBe("launched");
    expect(after.agent_id).toBe(row.branch);
    expect(after.base_sha).toBe("abc123");
    expect(after.session_id).toBe("s-1");
    expect(after.launch_attempts).toBe(1);
    expect(after.launched_at).not.toBeNull();
    expect(new Date(after.launched_at!).getTime()).toBeLessThanOrEqual(new Date(nowIso()).getTime());
  });
});
