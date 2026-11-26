// OS-212: `ob t3 team forward`. A message for a team role goes to the seat's CURRENT thread, found by team and role,
// never to a thread id someone remembered. A restart retires the old thread and settles it, and T3 unsettles a
// thread on any send, so a send to a remembered id would wake a retired thread in a seat it no longer holds.
//
// A remembered id is still accepted: one the seat retired is redirected to the current thread, and one that is no
// seat's (current or retired) is refused by name, with nothing sent.
import { AppError, UsageError } from "./errors.ts";
import type { T3Seam } from "./t3/dispatch.ts";
import { TEAM_ROLES, type TeamRole, type TeamView } from "./team.ts";
import type { RestartBackend } from "./team-restart.ts";

/** Where a forward goes: the seat's current thread, and the retired thread it was aimed at, if any. */
export type ForwardTarget = { team: string; role: TeamRole; threadId: string; redirectedFrom: string | null };

type ForwardBackend = Pick<RestartBackend, "list" | "show" | "handoffLatest">;

/** A thread a seat retired: it wrote a handoff for that seat and is no longer its bound thread. */
async function retiredBy(backend: ForwardBackend, team: TeamView, role: TeamRole, threadId: string): Promise<boolean> {
  return (await backend.handoffLatest(team.name, role, { from: threadId }))?.old_thread_id === threadId;
}

function boundOf(team: TeamView, role: TeamRole): string | null {
  return team.threads.find((t) => t.role === role)?.thread_id ?? null;
}

/**
 * Resolve a forward to the seat's current thread. `team` and `role` name the seat; `thread` is an id the sender had,
 * accepted when it is the seat's current thread or one it retired. With only `thread`, the seat is the one that
 * holds or retired it. Throws an AppError naming why nothing can be sent.
 */
export async function resolveForward(backend: ForwardBackend, input: { team?: string; role?: TeamRole; thread?: string }): Promise<ForwardTarget> {
  const { role, thread } = input;
  if (!input.team && !thread) throw new UsageError("t3 team forward needs a <team> and --role, or --thread <id>");
  if (input.team && !role && !thread) throw new UsageError(`t3 team forward ${input.team} needs --role <${TEAM_ROLES.join("|")}>`);
  let teams: TeamView[];
  if (input.team) {
    const t = await backend.show(input.team);
    if (!t) throw new AppError(`no team '${input.team}' (see \`ob t3 team list\`); nothing sent`);
    teams = [t];
  } else {
    teams = await backend.list();
  }
  const roles = role ? [role] : TEAM_ROLES;

  for (const team of teams) {
    for (const r of roles) {
      const bound = boundOf(team, r);
      if (!thread || thread === bound) {
        if (!bound) throw new AppError(`${team.name} has no ${r} thread (add one with \`ob t3 ${r} ${team.name}\`); nothing sent`);
        return { team: team.name, role: r, threadId: bound, redirectedFrom: null };
      }
    }
  }
  // `thread` is no seat's current thread: it may be one a seat retired.
  for (const team of teams) {
    for (const r of roles) {
      if (!(await retiredBy(backend, team, r, thread!))) continue;
      const bound = boundOf(team, r);
      if (!bound) throw new AppError(`thread ${thread} is a retired ${team.name} ${r} thread, and the seat has no current thread (add one with \`ob t3 ${r} ${team.name}\`); nothing sent`);
      return { team: team.name, role: r, threadId: bound, redirectedFrom: thread! };
    }
  }
  const seat = input.team ? `the ${input.team}${role ? ` ${role}` : ""} seat${role ? "" : "s"}` : "any team seat";
  throw new AppError(`thread ${thread} is not ${seat}'s current thread and was not retired by it; nothing sent (see \`ob t3 team show <team>\`)`);
}

/** The text a forward arrives as. A send aimed at a retired thread says so on its first line. Pure. */
function forwardMessage(target: ForwardTarget, body: string): string {
  if (!target.redirectedFrom) return body;
  return `Sent to the retired ${target.team} ${target.role} thread ${target.redirectedFrom}, forwarded to this one:\n\n${body}`;
}

/** Queue the message into the seat's current thread (it lands after anything in flight). */
export async function forwardToSeat(seam: T3Seam, target: ForwardTarget, body: string): Promise<void> {
  await seam.send({ threadId: target.threadId, message: forwardMessage(target, body), mode: "queue" });
}
