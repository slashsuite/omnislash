// ob 352 -- the ticket-lease claim that registering an agent performs (#97), as a core both `ob agent
// register` and `POST /api/ob/agents` call.
//
// This is the D1 argument at its sharpest. Registering an agent is not "write a row": it is "claim the
// ticket, and refuse if another live session already holds it". A generic endpoint that wrote the agent
// row would have moved that judgement onto the client, where it would eventually be skipped, and two
// sessions in one worktree is the exact failure the lease exists to prevent.
//
// ob 341 -- finishing an agent is the matching half: it may release only leases THIS agent acquired.
// A builder that registered UNDER an architect hold (decision #56/#97, `--holder architect-<team>`) must
// not drop that hold on the way out. Hit during ob 337 pass 5: `ob agent done` released ticket:337
// out from under the architect mid-gate.
import type { Database } from "bun:sqlite";
import { and, eq, inArray, or } from "drizzle-orm";
import { doneAgent, getAgent, listAgents } from "./agent.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { builderIdOf, legRef } from "./clean-repo.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
  acquireLeases,
  formatHold,
  leaseKeyClass,
  listLeasesByHolder,
  liveHold,
  releaseLease,
  ticketLeaseKey,
} from "./lease.ts";

export interface TicketClaim {
  /** The agent id claiming, which becomes the lease holder. */
  id: string;
  /** The ticket ref, or null for an agent that is not on one. */
  ticket: string | null;
  ttlS: number;
  /** A lease the CALLER already holds; a hold of the caller's own is compatible, not a collision (#75). */
  holder?: string | null;
  /** The deliberate second registrant: write the row, claim nothing. */
  noLease?: boolean;
}

/**
 * Claim `ticket:<ref>` for this agent, or leave an existing compatible hold exactly as it is.
 *
 * Returns the lease key that ended up covering this registration (null when nothing was claimed, i.e. no
 * ticket, `noLease`, or a ready-for-gate spinoff for this builder — 577). THROWS when a live FOREIGN
 * holder has it -- refusing loudly is the whole primitive, and the message carries the way forward
 * rather than pointing at `--force`.
 */
export async function claimTicketLease(db: Database | Store, claim: TicketClaim): Promise<string | null> {
  if (claim.noLease) return null;
  const key = ticketLeaseKey(claim.ticket);
  if (!key) return null;
  // `--holder <this agent's own id>` is NOT the register-under case: it is the plain claim, which must
  // keep refreshing its own lease (the heartbeat form), so it falls through to acquireLeases.
  const under = typeof claim.holder === "string" ? claim.holder.trim() : "";
  const hold = await liveHold(db, key);
  const ours = hold !== null && under !== "" && under !== claim.id && hold.holder === under;
  // A hold named this way is LEFT EXACTLY AS IT IS, not re-taken: rewriting it would shorten the
  // architect's TTL to the agent's, and only its holder should heartbeat it.
  if (ours) return key;
  // 341: a re-register (the heartbeat / status-update form) of an agent already on this ticket must
  // not try to steal a foreign hold it registered under. Without this, `ob agent register --id 337
  // --status readying` after a `--holder architect-acme` first register is a collision, and the
  // refusal is what pushed the 337 builder toward a release.
  if (hold !== null && hold.holder !== claim.id) {
    const existing = await getAgent(db, claim.id);
    if (existing && ticketLeaseKey(existing.ticket) === key) return key;
  }
  // 577: `spinoff handoff` (alias `spinoff ready`) already released ticket:/worktree: (426). OpenCode's heartbeat plugin then
  // runs `ob agent register --id <builder> --note …` (and later session.idle `--status needs-human`),
  // which used to re-claim. A ready-for-gate builder must not take those keys back; register still
  // writes note/status. Architect-* holds are untouched. Not agent done, not --force.
  if (await builderSpinoffIsReadyForGate(db, claim.id, key)) return null;
  const got = await acquireLeases(db, [key], claim.id, claim.ttlS);
  if (!got.ok) {
    throw new AppError(
      `cannot register '${claim.id}': ${formatHold(got.hold)}. If that holder is you, register under it with --holder ${got.hold.holder}; otherwise wait for it, and 'ob lease release ${got.hold.resource} --force' ONLY if that holder is gone`,
    );
  }
  return key;
}

async function builderSpinoffIsReadyForGate(
  db: Database | Store,
  agentId: string,
  ticketKey: string,
): Promise<boolean> {
  const s = asStore(db);
  const rows = (await s.q
    .select({
      ticket_ref: s.t.spinoff.ticket_ref,
      agent_id: s.t.spinoff.agent_id,
      branch: s.t.spinoff.branch,
      trial_leg: s.t.spinoff.trial_leg,
    })
    .from(s.t.spinoff)
    .where(
      and(
        eq(s.t.spinoff.status, "ready-for-gate"),
        or(eq(s.t.spinoff.agent_id, agentId), eq(s.t.spinoff.branch, agentId)),
      ),
    )) as Array<{ ticket_ref: string; agent_id: string | null; branch: string; trial_leg: string | null }>;
  return rows.some((r) => ticketLeaseKey(legRef(r.ticket_ref, r.trial_leg)) === ticketKey);
}

/**
 * OB-1991: the ticket an agent registers on. A model trial's leg b is told nothing of the trial, so its builder
 * runs `ob agent register --id <ref>-b --ticket <ref>` like any other; this maps that to `<ref>-b`, so leg b holds
 * `ticket:<ref>-b` and leg a's `ticket:<ref>` is never contended. Anything that is not the builder of a live
 * leg b row keeps the ticket it named.
 */
export async function legTicketFor(db: Database | Store, agentId: string, ticket: string | null): Promise<string | null> {
  const key = ticketLeaseKey(ticket);
  if (!ticket || !key) return ticket;
  const s = asStore(db);
  const rows = (await s.q
    .select({
      ticket_ref: s.t.spinoff.ticket_ref,
      agent_id: s.t.spinoff.agent_id,
      branch: s.t.spinoff.branch,
      repo: s.t.spinoff.repo,
      trial_leg: s.t.spinoff.trial_leg,
    })
    .from(s.t.spinoff)
    .where(and(eq(s.t.spinoff.trial_leg, "b"), inArray(s.t.spinoff.status, ["launching", "launched", "ready-for-gate"])))) as Array<{
    ticket_ref: string;
    agent_id: string | null;
    branch: string;
    repo: string;
    trial_leg: string | null;
  }>;
  const mine = rows.find((r) => builderIdOf(r) === agentId && ticketLeaseKey(r.ticket_ref) === key);
  return mine ? legRef(ticket, "b") : ticket;
}

export interface FinishAgentResult {
  done: boolean;
  /** Lease keys this agent held and that we released. */
  released: string[];
  /** Lease keys this agent must not drop: inherited, or still covering another live agent (341). */
  kept: string[];
}

/**
 * Deregister an agent and release only the leases it itself acquired.
 *
 * A ticket lease held by someone else (the architect the builder registered under) is left exactly
 * as it is and reported in `kept`. So is a ticket: key this holder recorded that another live
 * agent is still registered on: `ob agent done architect-acme` must not sweep ticket:337 out
 * from under a builder that registered under that hold.
 */
export async function finishAgent(
  db: Database | Store,
  id: string,
  opts: { noLease?: boolean } = {},
): Promise<FinishAgentResult> {
  const agent = await getAgent(db, id);
  const protectedKeys = new Set<string>();
  if (!opts.noLease) {
    for (const resource of await listLeasesByHolder(db, id)) {
      if (leaseKeyClass(resource) === "ticket" && (await otherLiveAgentOnTicket(db, resource, id))) {
        protectedKeys.add(resource);
      }
    }
    const key = ticketLeaseKey(agent?.ticket);
    if (key) {
      const hold = await liveHold(db, key);
      if (hold && hold.holder !== id) protectedKeys.add(key);
    }
  }
  const removed = await doneAgent(db, id);
  if (opts.noLease) return { done: removed, released: [], kept: [] };
  const released: string[] = [];
  for (const resource of await listLeasesByHolder(db, id)) {
    if (protectedKeys.has(resource)) continue;
    if (await releaseLease(db, resource, id)) released.push(resource);
  }
  return { done: removed, released, kept: [...protectedKeys].sort() };
}

/** Another live agent (not `exceptId`) whose recorded ticket is this key. */
async function otherLiveAgentOnTicket(
  db: Database | Store,
  ticketKey: string,
  exceptId: string,
): Promise<boolean> {
  for (const row of await listAgents(db)) {
    if (row.id === exceptId) continue;
    if (ticketLeaseKey(row.ticket) === ticketKey) return true;
  }
  return false;
}
