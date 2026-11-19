// Delivery into a role's run (OS-56): what `ob send` and a builder's handoff do once the message is stored.
//
// The role's unread messages go into its open run on this machine's T3 (queued, so a busy thread finishes its turn
// first). With no open run, `ob role start`'s path opens one whose start brief lists every unread message. A run open
// on another machine's T3 is left alone: the messages stay unread for that run, or the next one, to read.
//
// The store half (rows, runs) goes through the backends, so the same procedure serves the store and the API client;
// T3 is always the caller's own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxBackend } from "./commands/inbox.ts";
import type { RoleBackend } from "./commands/role.ts";
import type { RoleMessage } from "./inbox.ts";
import { roleRunHolder, type RoleRun } from "./role-run.ts";
import { t3BaseUrl } from "./t3/client.ts";
import type { T3Seam } from "./t3/dispatch.ts";
import type { TeamRole } from "./team.ts";

/** What a delivery did. `ids` are the messages marked read by the run. */
export type DeliverOutcome =
  | { kind: "idle" }
  | { kind: "other-host"; run: RoleRun; host: string }
  | { kind: "started"; run: RoleRun; thread_id: string; ids: number[]; auto_settle_warning: string | null }
  | { kind: "queued"; run: RoleRun; thread_id: string; ids: number[] };

/** The T3 request id a queued message carries, so a retry of one message is one delivery. Pure. */
export function roleMessageRequestId(id: number): string {
  return `ob-role-msg-${id}`;
}

/**
 * The text a queued message arrives as: its body, then one line naming it. The body comes first because `ob close`
 * finds a held readying note by its first line (`isReadyingNoteFor`) and withdraws it once the ticket has landed. Pure.
 */
export function queuedText(m: RoleMessage): string {
  const ref = m.ref ? ` ${m.ref}` : "";
  return [m.body, "", `(inbox #${m.id} from ${m.from_actor}, ${m.kind}${ref}; marked read by this run)`].join("\n");
}

/**
 * Deliver a role's unread messages into its run, starting one when none is open. Throws when T3 cannot be reached or
 * refuses; messages T3 took before that are marked read first, so a retry sends only the rest.
 */
export async function deliverToRole(
  backend: RoleBackend,
  inbox: Pick<InboxBackend, "list" | "read">,
  seam: () => Promise<T3Seam>,
  team: string,
  role: TeamRole,
): Promise<DeliverOutcome> {
  if ((await inbox.list(team, role, false)).length === 0) return { kind: "idle" };
  const local = t3BaseUrl();
  const [open] = await backend.open(team, role);
  if (open && open.t3_host !== local) return { kind: "other-host", run: open, host: open.t3_host };

  // Reuses the open run while its thread is live, else ends it as gone and opens one (whose brief marks its inbox read).
  // Imported here, not at the top: the handoff (t3/dispatch.ts) imports this module, and commands/role.ts imports dispatch.
  const { startRoleRun } = await import("./commands/role.ts");
  const s = await seam();
  const started = await startRoleRun(backend, team, role, s);
  const reader = roleRunHolder(started.run.id);
  const briefIds = started.inbox_ids;
  // Anything still unread and not in the brief: every message for a reused run, and only a late arrival for a new one.
  const pending = (await inbox.list(team, role, false)).filter((m) => !briefIds.includes(m.id));
  const queued: number[] = [];
  let sendError: unknown = null;
  for (const m of pending) {
    try {
      await s.send({ threadId: started.thread_id, message: queuedText(m), mode: "queue", clientRequestId: roleMessageRequestId(m.id) });
    } catch (err) {
      sendError = err;
      break;
    }
    queued.push(m.id);
  }
  // What T3 took is marked read before a send error is raised, so a retry sends only the rest.
  if (queued.length > 0) await inbox.read(team, role, queued, reader);
  if (sendError !== null) throw sendError;
  const ids = [...briefIds, ...queued];
  return started.created
    ? { kind: "started", run: started.run, thread_id: started.thread_id, ids, auto_settle_warning: started.auto_settle_warning }
    : { kind: "queued", run: started.run, thread_id: started.thread_id, ids };
}

/** One line for what a delivery did, after `<team> <role>: `. Pure. */
export function renderDelivery(d: DeliverOutcome): string {
  if (d.kind === "idle") return "nothing unread to deliver";
  if (d.kind === "other-host") return `run ${d.run.id} is open on ${d.host}; message stored`;
  const n = `${d.ids.length} message${d.ids.length === 1 ? "" : "s"}`;
  if (d.kind === "started") return `run ${d.run.id} opened, thread ${d.thread_id}, with ${n} in its start brief, marked read by ${roleRunHolder(d.run.id)}`;
  return `${n} queued into run ${d.run.id}, thread ${d.thread_id}, marked read by ${roleRunHolder(d.run.id)}`;
}

/** The good-night lock file under a home directory (skills/ob-good-night): one ISO timestamp, the lock's end. Pure. */
function nightLockPath(home: string): string {
  return join(home, ".cache", "ob-good-night");
}

/**
 * When the good-night lock ends, while it holds: read at call time from `$HOME/.cache/ob-good-night`. A missing,
 * empty or unparseable file, or a time not in the future, is unlocked (null). `ob role tick` writes findings under the
 * lock but starts and sends nothing; `ob send` does not read it.
 */
export function nightLockedUntil(now: Date = new Date(), home: string = process.env.HOME || homedir()): string | null {
  let raw: string;
  try {
    raw = readFileSync(nightLockPath(home), "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const until = Date.parse(raw);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return raw;
}
