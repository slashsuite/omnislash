// OS-56: a handoff delivers into the target role's run, starting one when none is open. The tests written for the
// seat send keep their meaning by giving each bound seat an open run on its thread: the note then queues into the
// same thread it always went to.
import type { Database } from "bun:sqlite";
import { listAgents } from "../../../platform/cli-coord/src/agent.ts";
import type { Store } from "../src/db/store.ts";
import { markRoleRun, updateRoleRun } from "../src/role-run.ts";
import { t3BaseUrl, type T3Thread } from "../src/t3/client.ts";
import type { T3Seam } from "../src/t3/dispatch.ts";
import { teamRoleOf } from "../src/team.ts";
import { UnknownTeamError } from "../src/project.ts";

/** Open a run for (team, role) on this machine's T3, already on `threadId`. Returns its id. */
export async function openLiveRoleRun(db: Database | Store, team: string, role: "architect" | "sentinel" | "muse", threadId: string): Promise<number> {
  const { run } = await markRoleRun(db, { team, role, t3Host: t3BaseUrl() });
  await updateRoleRun(db, team, run.id, { thread_id: threadId });
  return run.id;
}

/** Give every team seat with a thread (`architect-<team>`, `sentinel-<team>`, `muse-<team>`) an open run on it. */
export async function openRunsOnSeats(db: Database | Store): Promise<void> {
  for (const a of await listAgents(db)) {
    const role = teamRoleOf(a.id);
    if (!role || !a.session_id) continue;
    // A seat whose team is not in the store (a test that binds rows only) gets no run.
    await openLiveRoleRun(db, a.id.slice(role.length + 1), role, a.session_id).catch((err: unknown) => {
      if (!(err instanceof UnknownTeamError)) throw err;
    });
  }
}

/** A fake `read` that answers every thread as live and idle, which is all the delivery reads. */
export const liveRead: T3Seam["read"] = async (threadId) => ({
  thread: {
    threadId,
    projectId: "proj-0",
    title: threadId,
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
  } as T3Thread,
  recentRuns: [],
  items: [],
  nextPosition: 0,
  hasMore: false,
});
