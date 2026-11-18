// ob 337: the coordination core (leases, the agent registry, the spinoff queue) on BOTH engines.
//
// The sibling of pg-items-337: the item core is what makes `ob` readable, this is what makes it
// WORKABLE, and it is the half where a silent difference costs the most. A lease is how two sessions
// avoid clobbering each other's worktrees and gates, so a lease that reads "free" on one engine and
// "held" on the other is not a wrong number on a screen, it is two agents in one checkout.
//
// Same method and same reason as pg-items-337: every failure this phase risks is silent, so "it did not
// throw on Postgres" proves nothing. Only running the identical sequence on both engines and diffing the
// RESULTS does. The four documented differences all have somewhere to bite here:
//   - count() arrives from Postgres as a STRING, and agentsActiveWithin's answer is compared with `> 0`
//     ("0" is truthy, "0" > 0 is false), so the un-coerced form is right in one place and wrong in the
//     next. Asserted by value AND by typeof.
//   - booleans are 0/1 integers. Nothing on lease/agent/spinoff stores one, and this test is what says
//     so rather than assuming it: `expired` is COMPUTED from timestamps on both engines.
//   - json columns are text. Again none here, and the round-tripped rows say so.
//   - ORDER BY puts NULLs FIRST on Postgres and LAST on SQLite. Every ordering in these modules is on a
//     NOT NULL column (lease.resource is the PK, agent.started_at is NOT NULL, spinoff.id is the PK) --
//     which is a claim, so the orderings are compared here rather than reasoned about.
//
// It uses the ob 325 harness: a real local cluster over a unix socket, no network and no live database.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import {
  acquireLease,
  acquireLeases,
  heartbeatLease,
  heartbeatLeasesByHolder,
  leaseStatus,
  liveHold,
  recordedHold,
  releaseLease,
  releaseLeasesByHolder,
} from "../../cli-coord/src/lease.ts";
import { agentsActiveWithin, doneAgent, getAgent, heartbeatAgent, listAgents, registerAgent } from "../../cli-coord/src/agent.ts";
import {
  claimSpinoffRow,
  enqueueSpinoff,
  landSpinoff,
  listSpinoffs,
  liveBuildAgentsByRepo,
  reclaimSpinoffs,
  recordSpinoffSpawnFailure,
  spinoffClaimKey,
  stampSpinoff,
} from "../../cli-coord/src/commands/spinoff.ts";

const PG_BUDGET = spawnBudget(3);

/**
 * One realistic pass over the ported coordination core: take a lease, contend for it, register an agent
 * that claims a ticket, queue a spinoff and run it through claim -> stamp -> land. Returns plain
 * JSON-able values so a mismatch reads as a diff of holders and ids.
 *
 * Timestamps are deliberately NOT compared: `acquired_at`/`heartbeat_at` are `nowIso()` and differ
 * between the two passes by milliseconds. What is compared is everything the two engines could disagree
 * about structurally -- who holds what, in what order, and with what type.
 */
async function exercise(store: Store): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // --- `ob lease acquire` --------------------------------------------------------------------------
  out.firstAcquire = await acquireLease(store, "ticket:337", "architect-omnislash", 1800);
  // A live foreign holder is refused and the REFUSAL names the holder: this is the whole primitive.
  out.deniedToOther = await acquireLease(store, "ticket:337", "architect-other", 1800);
  // The same holder refreshes rather than being refused (the heartbeat form).
  out.refreshBySelf = await acquireLease(store, "ticket:337", "architect-omnislash", 1800);

  const held = await liveHold(store, "ticket:337");
  out.liveHold = held && { resource: held.resource, holder: held.holder, ttl_s: held.ttl_s };
  out.liveHoldTtlType = typeof held?.ttl_s;
  out.liveHoldFree = await liveHold(store, "ticket:never-taken");
  const recorded = await recordedHold(store, "ticket:337");
  out.recordedHold = recorded && { holder: recorded.holder, expired: recorded.expired };
  out.recordedHoldType = typeof recorded?.expired; // must be a real boolean, not a 0/1 from Postgres
  out.recordedHoldMissing = await recordedHold(store, "ticket:never-taken");

  // An EXPIRED lease is reclaimable by anyone (#75), and expiry is computed from the timestamps rather
  // than stored, so this is where a boolean-shaped difference between the engines would show up.
  await acquireLease(store, "ticket:lapsed", "architect-gone", 1);
  const lapsedAt = Date.now() + 2000;
  out.lapsedIsLive = await liveHold(store, "ticket:lapsed", lapsedAt);
  const lapsedRecord = await recordedHold(store, "ticket:lapsed", lapsedAt);
  out.lapsedRecorded = lapsedRecord && { holder: lapsedRecord.holder, expired: lapsedRecord.expired };
  out.lapsedReleasable = await releaseLease(store, "ticket:lapsed", "someone-else", false, lapsedAt);

  // --- `ob lease acquire` of a SET: a denial must acquire nothing (no half-held set) ----------------
  await acquireLeases(store, ["worktree:/w/337"], "architect-other", 1800);
  const denied = await acquireLeases(store, ["ticket:338", "worktree:/w/337"], "architect-omnislash", 1800);
  // `since` is nowIso() and so differs between the two passes by milliseconds; the rest of the refusal
  // is what the caller acts on and what the two engines must agree about.
  out.setDenied = denied.ok
    ? denied
    : { ok: denied.ok, hold: { resource: denied.hold.resource, holder: denied.hold.holder, ttl_s: denied.hold.ttl_s } };
  out.setDeniedTookNothing = await liveHold(store, "ticket:338"); // null: the denial rolled the whole set back
  out.setGranted = await acquireLeases(store, ["ticket:338", "ticket:339", null], "architect-omnislash", 1800);

  // --- `ob lease status` ---------------------------------------------------------------------------
  // resource is the PRIMARY KEY, so ASC is claimed to be identical on both engines. This is the claim.
  out.statusOrder = (await leaseStatus(store)).map((l) => l.resource);
  out.statusShape = (await leaseStatus(store)).map((l) => [l.resource, l.holder, l.ttl_s, l.expired]);
  out.statusExpiredTypes = [...new Set((await leaseStatus(store)).map((l) => typeof l.expired))];

  // --- `ob lease heartbeat` / release --------------------------------------------------------------
  out.beatMine = await heartbeatLease(store, "ticket:339", "architect-omnislash");
  out.beatNotMine = await heartbeatLease(store, "ticket:339", "architect-other");
  out.beatByHolder = await heartbeatLeasesByHolder(store, "architect-omnislash");
  out.releaseNotMine = await releaseLease(store, "worktree:/w/337", "architect-omnislash");
  out.releaseForced = await releaseLease(store, "worktree:/w/337", "architect-omnislash", true);
  out.releaseByHolder = await releaseLeasesByHolder(store, "architect-omnislash");
  out.leasesAfterRelease = (await leaseStatus(store)).map((l) => l.resource);

  // --- `ob agent active` on an EMPTY registry -- the half of the count() trap that bites -----------
  // Taken BEFORE anything is registered, because it must be a statement about the data and not about
  // how long the preceding queries took. count(*) is bigint on Postgres and arrives as a STRING, and it
  // is the ZERO that is dangerous: `"0" > 0` is false (so StayAwake would read dormant either way) but
  // `"0"` is TRUTHY, so any caller that tests the count itself flips. Both the value and the type.
  out.activeWithinEmpty = await agentsActiveWithin(store, 20 * 60 * 1000);
  out.activeWithinEmptyType = typeof (await agentsActiveWithin(store, 20 * 60 * 1000));
  out.activeWithinEmptyIsTruthy = Boolean(await agentsActiveWithin(store, 20 * 60 * 1000));

  // --- `ob agent register` -------------------------------------------------------------------------
  const registered = await registerAgent(store, {
    id: "build-337",
    ticket: "337",
    worktree: "/w/337",
    branch: "build-337",
    status: "readying",
    launcher: "warp",
    sessionId: "0f9f1d2c-0000-4000-8000-000000000001",
    ttlS: 900,
  });
  out.registered = {
    id: registered.id,
    ticket: registered.ticket,
    status: registered.status,
    launcher: registered.launcher,
    session_id: registered.session_id,
    ttl_s: registered.ttl_s,
  };
  out.registeredTtlType = typeof registered.ttl_s;
  out.startedIsBeat = registered.started_at === registered.heartbeat_at;

  // A bare re-register acts as a heartbeat: omitted fields are PRESERVED and started_at is kept.
  const refreshed = await registerAgent(store, { id: "build-337", status: "working", ttlS: 900 });
  out.refreshed = {
    ticket: refreshed.ticket,
    worktree: refreshed.worktree,
    status: refreshed.status,
    launcher: refreshed.launcher,
    session_id: refreshed.session_id,
  };
  out.startedPreserved = refreshed.started_at === registered.started_at;

  await registerAgent(store, { id: "architect-omnislash", status: "planning", ttlS: 900 });
  await registerAgent(store, { id: "build-338", ticket: "338", branch: "build-338", status: "working", ttlS: 900 });

  out.getAgent = (await getAgent(store, "build-337"))?.status;
  out.getAgentMissing = await getAgent(store, "no-such-agent");
  out.beatAgent = await heartbeatAgent(store, "build-337");
  out.beatAgentMissing = await heartbeatAgent(store, "no-such-agent");

  // --- `ob agents` ---------------------------------------------------------------------------------
  // started_at is NOT NULL, so ASC is claimed identical on both engines. This is the claim.
  out.agentOrder = (await listAgents(store)).map((a) => a.id);
  out.agentExpiredTypes = [...new Set((await listAgents(store)).map((a) => typeof a.expired))];
  out.agentsLiveOnly = (await listAgents(store)).length;
  out.agentsWithExpired = (await listAgents(store, { includeExpired: true })).length;

  // --- `ob agent active` -- the other half of the count() trap -------------------------------------
  // The window is 20 MINUTES rather than something tight, deliberately: a narrow window would be a
  // statement about how long the queries above took (and Postgres round trips are slower than sqlite
  // ones), which is a flaky test rather than an engine comparison. The zero case is the one asserted
  // above, on an empty registry, where it is a fact about the data.
  out.activeWithin = await agentsActiveWithin(store, 20 * 60 * 1000);
  out.activeWithinType = typeof (await agentsActiveWithin(store, 20 * 60 * 1000));

  // --- the spinoff queue: enqueue -> claim -> stamp -> land ----------------------------------------
  const queued = await enqueueSpinoff(store, {
    ticketRef: "#337",
    repo: "/dev/omnislash",
    branch: "build-337c",
    worktree: "/w/337c",
    mode: "agent",
    brief: "port the coordination core",
  });
  out.queued = { id: queued.row.id, status: queued.row.status, ticket: queued.row.ticket_ref, deduped: queued.deduped };
  out.queuedIdType = typeof queued.row.id;
  // Dedup on an active row for the same ticket: the SAME row comes back rather than a second launch.
  const again = await enqueueSpinoff(store, {
    ticketRef: "#337",
    repo: "/dev/omnislash",
    branch: "build-337c",
    mode: "agent",
    brief: "a second attempt at the same ticket",
  });
  out.dedup = { id: again.row.id, deduped: again.deduped };

  const second = await enqueueSpinoff(store, {
    ticketRef: "#340",
    repo: "/dev/omnislash",
    branch: "build-340",
    worktree: "/w/340",
    mode: "agent",
    brief: "another",
  });
  // id is the PRIMARY KEY, so DESC is claimed identical on both engines. This is the claim.
  out.listOrder = (await listSpinoffs(store)).map((s) => s.id);
  out.listPending = (await listSpinoffs(store, "pending")).map((s) => s.ticket_ref);

  // THE CLAIM: one conditional UPDATE ... RETURNING, so exactly one drain gets a row back.
  const claim = await claimSpinoffRow(store, queued.row.id);
  out.claim = { id: claim.claimed?.id, status: claim.claimed?.status, error: claim.error };
  out.claimTakesTheClaimLease = (await liveHold(store, spinoffClaimKey(queued.row.id)))?.holder;
  out.claimTakesTicketAndWorktree = [
    (await liveHold(store, "ticket:337"))?.holder,
    (await liveHold(store, "worktree:/w/337c"))?.holder,
  ];
  // A second claim of the same row gets NOTHING: the row is no longer pending.
  out.reclaimedByRace = (await claimSpinoffRow(store, queued.row.id)).claimed;

  await stampSpinoff(store, {
    id: queued.row.id,
    outcome: "launched",
    worktree: "/w/337c",
    base_sha: "abc123",
    launcher: "warp",
    session_id: "0f9f1d2c-0000-4000-8000-000000000002",
  });
  const stamped = (await listSpinoffs(store)).find((s) => s.id === queued.row.id)!;
  out.stamped = {
    status: stamped.status,
    agent_id: stamped.agent_id,
    launcher: stamped.launcher,
    base_sha: stamped.base_sha,
    session_id: stamped.session_id,
    attempts: stamped.launch_attempts,
  };
  out.stampedAttemptsType = typeof stamped.launch_attempts;
  out.stampRegisteredTheAgent = (await getAgent(store, "build-337c"))?.status;
  out.stampAnsweredTheClaim = await liveHold(store, spinoffClaimKey(queued.row.id)); // null: released

  // liveBuildAgentsByRepo counts live BUILD agents through the launched join; `architect-*` never counts.
  const byRepo = await liveBuildAgentsByRepo(store);
  out.perRepo = [...byRepo.perRepo.entries()].sort();
  out.perRepoTypes = [...new Set([...byRepo.perRepo.values()].map((n) => typeof n))];
  out.totalBuildAgents = byRepo.total;

  // `spinoff reclaim`: a launching row whose claim lease is recorded and LAPSED goes back to pending. The
  // one claimed above has a LIVE claim, so it must be left exactly as it is.
  await claimSpinoffRow(store, second.row.id);
  out.reclaimLeavesLiveClaims = await reclaimSpinoffs(store);

  // The app reports a spawn that produced no session: the row leaves `launched` and is re-queued.
  const failure = await recordSpinoffSpawnFailure(store, "build-337c", "the spawn produced no session");
  out.spawnFailure = failure && {
    ticket: failure.ticket,
    status: failure.status,
    attempts: failure.attempts,
    retrying: failure.retrying,
  };
  out.spawnFailureAttemptsType = typeof failure?.attempts;
  out.spawnFailureUnknownAgent = await recordSpinoffSpawnFailure(store, "never-launched", "nothing to re-queue");

  // `spinoff reconcile`'s write half: token totals off the transcript, and the agent deregistered.
  await claimSpinoffRow(store, queued.row.id);
  await stampSpinoff(store, { id: queued.row.id, outcome: "launched", worktree: "/w/337c" });
  await landSpinoff(store, queued.row.id, {
    inputTokens: 1000,
    outputTokens: 2500,
    cacheCreationTokens: 40,
    cacheReadTokens: 60,
    totalTokens: 3600,
  });
  const landed = (await listSpinoffs(store)).find((s) => s.id === queued.row.id)!;
  out.landed = {
    status: landed.status,
    input: landed.input_tokens,
    output: landed.output_tokens,
    total: landed.total_tokens,
  };
  // The tokens are stored INTEGER columns rather than aggregates, so they must come back as numbers on
  // both engines: a string here is what turns `opening + txns` into "10002500" further downstream.
  out.landedTokenTypes = [...new Set([landed.input_tokens, landed.output_tokens, landed.total_tokens].map((n) => typeof n))];
  out.landedSum = (landed.input_tokens ?? 0) + (landed.output_tokens ?? 0);
  out.landDeregisteredTheAgent = await getAgent(store, "build-337c");
  // `since` is nowIso() and differs between the two passes; land's contract is that the holds are gone
  // (null) or, if still recorded, name the same resource/holder/ttl.
  out.landFreedItsLeases = [await liveHold(store, "ticket:337"), await liveHold(store, "worktree:/w/337c")].map(
    (h) => h && { resource: h.resource, holder: h.holder, ttl_s: h.ttl_s },
  );

  // --- `ob agent done` -----------------------------------------------------------------------------
  out.doneAgent = await doneAgent(store, "build-337");
  out.doneAgentMissing = await doneAgent(store, "no-such-agent");
  out.agentsAtEnd = (await listAgents(store, { includeExpired: true })).map((a) => a.id);
  out.leasesAtEnd = (await leaseStatus(store)).map((l) => [l.resource, l.holder]);

  return out;
}

describe("apps/cli's coordination core agrees across the two engines (337)", () => {
  test(
    "leases, the agent registry and the spinoff queue produce identical results on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-coord-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });

        expect(pg.kind).toBe("postgres");
        expect(pg.sqlite).toBeNull();
        expect(sqlite.kind).toBe("sqlite");

        const fromPg = await exercise(pg);
        const fromSqlite = await exercise(sqlite);

        // Key by key, so a failure names the value that moved rather than "two big objects differ".
        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.firstAcquire).toEqual({ ok: true, holder: "architect-omnislash" });
        expect(fromSqlite.deniedToOther).toEqual({ ok: false, holder: "architect-omnislash" });
        expect(fromSqlite.refreshBySelf).toEqual({ ok: true, holder: "architect-omnislash" });
        expect(fromSqlite.liveHoldTtlType).toBe("number");
        expect(fromSqlite.liveHoldFree).toBeNull();
        expect(fromSqlite.recordedHoldType).toBe("boolean");
        expect(fromSqlite.lapsedIsLive).toBeNull(); // expired: reclaimable, so no LIVE hold
        expect(fromSqlite.lapsedRecorded).toEqual({ holder: "architect-gone", expired: true });
        expect(fromSqlite.lapsedReleasable).toBe(true);
        expect(fromSqlite.setDeniedTookNothing).toBeNull(); // the denial acquired NOTHING
        expect(fromSqlite.setGranted).toEqual({ ok: true });
        expect(fromSqlite.statusExpiredTypes).toEqual(["boolean"]);
        expect(fromSqlite.beatMine).toBe(true);
        expect(fromSqlite.beatNotMine).toBe(false);
        expect(fromSqlite.releaseNotMine).toBe(false); // a LIVE foreign hold needs --force
        expect(fromSqlite.releaseForced).toBe(true);
        expect(fromSqlite.registeredTtlType).toBe("number");
        expect(fromSqlite.startedIsBeat).toBe(true);
        expect(fromSqlite.startedPreserved).toBe(true);
        expect(fromSqlite.refreshed).toEqual({
          ticket: "337",
          worktree: "/w/337",
          status: "working",
          launcher: "warp",
          session_id: "0f9f1d2c-0000-4000-8000-000000000001",
        });
        expect(fromSqlite.agentExpiredTypes).toEqual(["boolean"]);
        // The count trap, both halves: the right number AND the right type, and the ZERO is the one that
        // decides whether `Boolean(count)` is right or backwards.
        expect(fromSqlite.activeWithinEmpty).toBe(0);
        expect(fromSqlite.activeWithinEmptyType).toBe("number");
        expect(fromSqlite.activeWithinEmptyIsTruthy).toBe(false); // Boolean("0") would be TRUE
        expect(fromSqlite.activeWithin).toBe(3);
        expect(fromSqlite.activeWithinType).toBe("number");
        expect(fromSqlite.queuedIdType).toBe("number");
        expect(fromSqlite.dedup).toEqual({ id: 1, deduped: true });
        expect(fromSqlite.listOrder).toEqual([2, 1]); // newest first, on the PK
        expect(fromSqlite.claim).toEqual({ id: 1, status: "launching", error: null });
        expect(fromSqlite.claimTakesTheClaimLease).toBe("build-337c");
        expect(fromSqlite.claimTakesTicketAndWorktree).toEqual(["build-337c", "build-337c"]);
        expect(fromSqlite.reclaimedByRace).toBeNull(); // the second claimant gets nothing
        expect(fromSqlite.stamped).toEqual({
          status: "launched",
          agent_id: "build-337c",
          launcher: "warp",
          base_sha: "abc123",
          session_id: "0f9f1d2c-0000-4000-8000-000000000002",
          attempts: 1,
        });
        expect(fromSqlite.stampedAttemptsType).toBe("number");
        expect(fromSqlite.stampRegisteredTheAgent).toBeNull();
        expect(fromSqlite.stampAnsweredTheClaim).toBeNull();
        expect(fromSqlite.perRepo).toEqual([["/dev/omnislash", 1]]); // architect-* never counts
        expect(fromSqlite.perRepoTypes).toEqual(["number"]);
        expect(fromSqlite.reclaimLeavesLiveClaims).toEqual([]); // a LIVE claim is never taken back
        expect(fromSqlite.spawnFailure).toEqual({ ticket: "#337", status: "pending", attempts: 1, retrying: true });
        expect(fromSqlite.spawnFailureAttemptsType).toBe("number");
        expect(fromSqlite.spawnFailureUnknownAgent).toBeNull();
        expect(fromSqlite.landed).toEqual({ status: "merged", input: 1000, output: 2500, total: 3600 });
        expect(fromSqlite.landedTokenTypes).toEqual(["number"]);
        // 3500, not "10002500": the concatenation bug, asserted on real stored values.
        expect(fromSqlite.landedSum).toBe(3500);
        expect(fromSqlite.landDeregisteredTheAgent).toBeNull();
        // worktree is released; ticket:337 stays with the landed agent (build-337c) until agent done.
        expect(fromSqlite.landFreedItsLeases).toEqual([
          { resource: "ticket:337", holder: "build-337c", ttl_s: 900 },
          null,
        ]);
        expect(fromSqlite.doneAgent).toBe(true);
        expect(fromSqlite.doneAgentMissing).toBe(false);
      } finally {
        await pg?.close();
        await sqlite?.close();
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
        if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
        else process.env.OMNISLASH_DB_CREATE = previousCreate;
      }
    },
    PG_BUDGET,
  );
});
