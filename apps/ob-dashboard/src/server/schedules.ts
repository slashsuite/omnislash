import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { listSchedulesWithRuns, type ScheduledJobRun, type ScheduledJobWithRuns } from "../../../cli/src/scheduled-jobs.ts";
import { providedStore } from "../../provided-store.ts";
import {
  deleteSchedule as deleteScheduleWrite,
  pauseSchedule as pauseScheduleWrite,
  resumeSchedule as resumeScheduleWrite,
  runScheduleNow as runScheduleNowWrite,
  type ScheduleWriteResult,
  type WriteContext,
} from "../../../../platform/dashboard-kit/src/server/writes.ts";

// OS-312: the Schedules page's server functions over OS-310's `ob schedule` jobs. The store comes from serve.ts
// (providedStore), never opened here. The list is every job, enabled and paused, with its newest runs. Pause,
// resume, run now and delete go through the kit's guarded writes: a cross-site POST is refused, and so is plain
// HTTP to a host that is not this machine. "Run now" only makes the job due; the next `ob role tick` on a machine
// fires it. Nothing here runs a command.

export type { ScheduledJobRun, ScheduledJobWithRuns, ScheduleWriteResult };

const writeCtx = (): WriteContext => ({ request: getRequest(), store: providedStore });

const nameOnly = (d: { name: string }) => {
  if (!d || typeof d.name !== "string" || !d.name) throw new Error("name required");
  return { name: d.name };
};

/** Every scheduled job with its newest runs: the SSR loader for /schedules. Read-only. */
export const getSchedules = createServerFn({ method: "GET" }).handler(async (): Promise<ScheduledJobWithRuns[]> => await listSchedulesWithRuns(await providedStore()));

/** Pause a job (`ob schedule pause`). Returns the fresh list, or why it was refused. */
export const pauseSchedule = createServerFn({ method: "POST" })
  .validator(nameOnly)
  .handler(async ({ data }): Promise<ScheduleWriteResult> => await pauseScheduleWrite(writeCtx(), data.name));

/** Resume a paused job (`ob schedule resume`). */
export const resumeSchedule = createServerFn({ method: "POST" })
  .validator(nameOnly)
  .handler(async ({ data }): Promise<ScheduleWriteResult> => await resumeScheduleWrite(writeCtx(), data.name));

/** Make a job due now (`ob schedule run`): only its next time changes. */
export const runScheduleNow = createServerFn({ method: "POST" })
  .validator(nameOnly)
  .handler(async ({ data }): Promise<ScheduleWriteResult> => await runScheduleNowWrite(writeCtx(), data.name));

/** Delete a job and its runs (`ob schedule delete`). */
export const deleteSchedule = createServerFn({ method: "POST" })
  .validator(nameOnly)
  .handler(async ({ data }): Promise<ScheduleWriteResult> => await deleteScheduleWrite(writeCtx(), data.name));
