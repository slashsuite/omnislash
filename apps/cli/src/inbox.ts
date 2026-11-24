// A team role's inbox: `ob send <team> <role>` stores a message, `ob inbox <team> <role>` lists the unread ones, and a
// run marks what it read. A builder's handoff writes its readying note here too (kind `handoff`), next to the T3 note.
//
// The store half, served locally and over the API, so a message reaches the role from any machine and a message to a
// replaced thread is still there for the next run. Delivery into a run is not here: this only stores and lists.
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";
import { UnknownTeamError } from "./project.ts";
import { getTeam, teamView, type TeamRole } from "./team.ts";

export const ROLE_MESSAGE_KINDS = ["message", "handoff"] as const;
export type RoleMessageKind = (typeof ROLE_MESSAGE_KINDS)[number];

export interface RoleMessage {
  id: number;
  team: string;
  role: TeamRole;
  /** Who sent it: an agent id, or `owner`. Free text. */
  from_actor: string;
  kind: RoleMessageKind;
  /** The ticket a handoff is for; null for a message. */
  ref: string | null;
  body: string;
  /** A handoff's retry key, so a second handoff of one commit stores nothing. */
  client_key: string | null;
  created_at: string;
  read_at: string | null;
  /** The run or agent id that read it. */
  read_by: string | null;
  withdrawn_at: string | null;
}

export interface RoleMessageInput {
  team: string;
  role: TeamRole;
  from: string;
  kind: RoleMessageKind;
  ref?: string | null;
  body: string;
  clientKey?: string | null;
}

/**
 * A role that may receive: the architect, the sentinel (OS-181: every team has one, started on delivery when it has
 * no thread), or a role with a thread bound on the team. Refused by name otherwise.
 */
async function requireRecipient(s: Store, team: string, role: TeamRole): Promise<void> {
  const t = await getTeam(s, team);
  if (!t) throw new UnknownTeamError(team);
  if (role === "architect" || role === "sentinel") return;
  const view = await teamView(s, t);
  if (!view.threads.some((th) => th.role === role)) {
    throw new AppError(`team '${team}' has no ${role} bound, so nothing was stored (bind one with \`ob t3 ${role} ${team}\`, see \`ob t3 team show ${team}\`)`);
  }
}

async function messageById(s: Store, id: number): Promise<RoleMessage | null> {
  const t = s.t.roleMessage;
  const rows = (await s.q.select().from(t).where(eq(t.id, id)).limit(1)) as RoleMessage[];
  return rows[0] ?? null;
}

/**
 * Store one message for a team role. A message with a `clientKey` already stored is answered as it is and nothing is
 * written (`created` false), which is how a repeated handoff of one commit stays one row.
 */
export async function sendRoleMessage(db: Database | Store, input: RoleMessageInput): Promise<{ message: RoleMessage; created: boolean }> {
  const s = asStore(db);
  if (!input.body.trim()) throw new UsageError("the message body is empty");
  if (!input.from.trim()) throw new UsageError("the sender is empty");
  await requireRecipient(s, input.team, input.role);
  const t = s.t.roleMessage;
  const inserted = (await s.q
    .insert(t)
    .values({
      team: input.team,
      role: input.role,
      from_actor: input.from,
      kind: input.kind,
      ref: input.ref ?? null,
      body: input.body,
      client_key: input.clientKey ?? null,
      created_at: nowIso(),
    })
    .onConflictDoNothing()
    .returning()) as RoleMessage[];
  if (inserted[0]) return { message: inserted[0], created: true };
  const rows = (await s.q.select().from(t).where(eq(t.client_key, input.clientKey ?? "")).limit(1)) as RoleMessage[];
  if (!rows[0]) throw new AppError(`could not store the message for ${input.team} ${input.role}, and no earlier one was found; re-run`);
  return { message: rows[0], created: false };
}

/** A role's messages, oldest first: the unread ones that are not withdrawn, or every one with `all`. */
export async function listRoleMessages(db: Database | Store, team: string, role: TeamRole, opts: { all?: boolean } = {}): Promise<RoleMessage[]> {
  const s = asStore(db);
  if (!(await getTeam(s, team))) throw new UnknownTeamError(team);
  const t = s.t.roleMessage;
  const where = and(eq(t.team, team), eq(t.role, role), ...(opts.all ? [] : [isNull(t.read_at), isNull(t.withdrawn_at)]));
  return (await s.q.select().from(t).where(where).orderBy(asc(t.id))) as RoleMessage[];
}

/**
 * Mark a role's messages read by a run or agent. An id that is not this role's refuses by name and marks nothing; a
 * message already read keeps its first reader.
 */
export async function markRoleMessagesRead(db: Database | Store, team: string, role: TeamRole, ids: number[], by: string): Promise<RoleMessage[]> {
  const s = asStore(db);
  if (ids.length === 0) throw new UsageError("--read needs at least one message id");
  if (!by.trim()) throw new UsageError("--by names the run or agent that read it");
  if (!(await getTeam(s, team))) throw new UnknownTeamError(team);
  const t = s.t.roleMessage;
  const found = (await s.q.select().from(t).where(and(eq(t.team, team), eq(t.role, role), inArray(t.id, ids)))) as RoleMessage[];
  const missing = ids.filter((id) => !found.some((m) => m.id === id));
  if (missing.length > 0) throw new AppError(`no message ${missing.join(", ")} in the ${team} ${role} inbox, so nothing was marked`);
  await s.q.update(t).set({ read_at: nowIso(), read_by: by }).where(and(inArray(t.id, ids), isNull(t.read_at)));
  const out: RoleMessage[] = [];
  for (const id of ids) out.push((await messageById(s, id))!);
  return out;
}

/** Hide the unread handoffs for these tickets (their ticket closed). Returns how many were withdrawn. */
export async function withdrawHandoffs(db: Database | Store, refs: string[]): Promise<number> {
  const wanted = [...new Set(refs.filter(Boolean))];
  if (wanted.length === 0) return 0;
  const s = asStore(db);
  const t = s.t.roleMessage;
  const rows = (await s.q
    .update(t)
    .set({ withdrawn_at: nowIso() })
    .where(and(eq(t.kind, "handoff"), inArray(t.ref, wanted), isNull(t.read_at), isNull(t.withdrawn_at)))
    .returning()) as RoleMessage[];
  return rows.length;
}

/** What a handoff stores in its role's inbox. */
export interface HandoffMessage {
  team: string;
  role: TeamRole;
  from: string;
  ref: string;
  body: string;
  clientKey: string;
}

/**
 * Store a handoff without ever failing it: the T3 note and the row stamp go ahead whatever happens here, and a failure
 * is one stderr line. A server with no inbox route (an older one) answers 404, which lands here too.
 */
export async function storeHandoffQuietly(write: () => Promise<unknown>, warnLine: (text: string) => void): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
    warnLine(`inbox: handoff not stored (${reason})`);
    return false;
  }
}

/** Parse `--read` ids: positive integers, each refused by name otherwise. Pure. */
export function parseMessageIds(raw: string[]): number[] {
  return raw.map((r) => {
    const n = Number(r);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`message id '${r}' is not a positive integer`);
    return n;
  });
}
