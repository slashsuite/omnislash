// Route component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-312: the Schedules page. No job is an empty state; each job is a card with its state, schedule, target, next
// and last run, a last-status pill and its last error; its runs open under a disclosure; Pause / Resume, Run now and
// Delete (behind an inline confirm) call the guarded writes, and a refusal shows on the card.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({ pauseSchedule: vi.fn(), resumeSchedule: vi.fn(), runScheduleNow: vi.fn(), deleteSchedule: vi.fn() }));
vi.mock("../server/schedules.ts", () => ({ getSchedules: vi.fn(async () => []), ...writes }));
vi.mock("../../../../platform/dashboard-kit/src/lib/useRealtime.ts", () => ({ useRealtime: () => ({ snap: null, connected: false }) }));

import { Route, statusTone } from "../routes/schedules.tsx";
import type { ScheduledJobRun, ScheduledJobWithRuns } from "../server/schedules.ts";

const Schedules = Route.options.component as (() => React.ReactElement) & { preload?: () => Promise<void> };
await Schedules.preload?.();

const base = {
  enabled: true,
  team: null,
  role: null,
  prompt: null,
  command: null,
  cwd: null,
  host: null,
  respect_good_night: true,
  next_run_at: "2026-11-28T11:00:00.000Z",
  last_run_at: null,
  last_status: null,
  last_error: null,
  created_at: "2026-11-27T10:00:00.000Z",
  updated_at: "2026-11-27T10:00:00.000Z",
  runs: [] as ScheduledJobRun[],
  consecutive_failures: 0,
  latest_failed_run_id: null,
} as const;

const run = (id: number, over: Partial<ScheduledJobRun> = {}): ScheduledJobRun => ({
  id,
  job_id: 2,
  started_at: `2026-11-28T0${id}:00:00.000Z`,
  finished_at: `2026-11-28T0${id}:00:05.000Z`,
  status: "failed",
  host: "desk",
  exit_code: 1,
  output_tail: null,
  role_message_id: null,
  ...over,
});

function jobs(): ScheduledJobWithRuns[] {
  return [
    {
      ...base,
      id: 1,
      name: "morning-brief",
      schedule_kind: "cron",
      schedule_expr: "0 9 * * 1-5",
      target_kind: "role",
      team: "slash",
      role: "architect",
      prompt: "Read the queue and plan the day.",
      last_run_at: "2026-11-28T09:00:00.000Z",
      last_status: "succeeded",
      runs: [run(9, { job_id: 1, status: "succeeded", host: null, exit_code: null, role_message_id: 42 })],
    },
    {
      ...base,
      id: 2,
      name: "db-copy",
      schedule_kind: "interval",
      schedule_expr: "1h",
      target_kind: "command",
      command: "ob backup run",
      cwd: "~/dev",
      host: "desk",
      respect_good_night: false,
      last_run_at: "2026-11-28T08:00:00.000Z",
      last_status: "failed",
      last_error: "exit 1: disk full",
      runs: [run(8, { output_tail: "copying...\ndisk full" }), run(7)],
      consecutive_failures: 2,
      latest_failed_run_id: 8,
    },
    { ...base, id: 3, name: "paused-job", enabled: false, schedule_kind: "once", schedule_expr: "2026-12-01T09:00:00.000Z", target_kind: "command", command: "true" },
  ];
}

function show(list: ScheduledJobWithRuns[]) {
  vi.spyOn(Route, "useLoaderData").mockReturnValue(list as never);
  return render(<Schedules />);
}

const card = (name: string) => within(screen.getByRole("article", { name }));

beforeEach(() => {
  for (const fn of Object.values(writes)) {
    fn.mockReset();
    fn.mockImplementation(async () => ({ ok: true, schedules: jobs() }));
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Schedules page (OS-312)", () => {
  it("says how to add a job when there are none", () => {
    show([]);
    expect(screen.getByRole("heading", { name: "No scheduled jobs" })).toBeTruthy();
    expect(screen.getByText("ob schedule add")).toBeTruthy();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("shows each job's state, schedule, target, next and last run, and its last error", () => {
    show(jobs());
    const brief = card("morning-brief");
    expect(brief.getByText("enabled")).toBeTruthy();
    expect(brief.getByText("cron 0 9 * * 1-5")).toBeTruthy();
    expect(brief.getByText("slash:architect")).toBeTruthy();
    expect(brief.getByText("Read the queue and plan the day.")).toBeTruthy();
    expect(brief.getByText("Next 2026-11-28T11:00:00.000Z")).toBeTruthy();
    expect(brief.getAllByText("succeeded").length).toBeGreaterThan(0);
    expect(brief.queryByText("runs through good night")).toBeNull();

    const copy = card("db-copy");
    expect(copy.getByText("every 1h")).toBeTruthy();
    expect(copy.getByText("ob backup run")).toBeTruthy();
    expect(copy.getByText("on desk in ~/dev")).toBeTruthy();
    expect(copy.getByText("runs through good night")).toBeTruthy();
    expect(copy.getByText("exit 1: disk full")).toBeTruthy();
    expect(copy.getByText("2 failures in a row")).toBeTruthy();

    const paused = card("paused-job");
    expect(paused.getByText("paused")).toBeTruthy();
    expect(paused.getByText("Next paused")).toBeTruthy();
    expect((paused.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(paused.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("opens a job's recent runs with host, exit code, message and output", () => {
    show(jobs());
    const copy = card("db-copy");
    expect(copy.queryByRole("article", { name: "Run 8" })).toBeNull();
    fireEvent.click(copy.getByRole("button", { name: "Recent runs (2)" }));
    const run8 = copy.getByRole("article", { name: "Run 8" });
    expect(within(run8).getByText("host desk · exit 1")).toBeTruthy();
    expect(within(run8).getByText("Output (last lines)")).toBeTruthy();
    expect(run8.textContent).toContain("disk full");
    fireEvent.click(card("morning-brief").getByRole("button", { name: "Recent runs (1)" }));
    expect(within(card("morning-brief").getByRole("article", { name: "Run 9" })).getByText("inbox message 42")).toBeTruthy();
    expect(card("paused-job").getByRole("button", { name: "No runs yet" })).toBeTruthy();
  });

  it("pauses, resumes and runs a job now through the guarded writes", async () => {
    show(jobs());
    await act(async () => {
      fireEvent.click(card("morning-brief").getByRole("button", { name: "Pause" }));
    });
    expect(writes.pauseSchedule).toHaveBeenCalledWith({ data: { name: "morning-brief" } });
    await act(async () => {
      fireEvent.click(card("paused-job").getByRole("button", { name: "Resume" }));
    });
    expect(writes.resumeSchedule).toHaveBeenCalledWith({ data: { name: "paused-job" } });
    await act(async () => {
      fireEvent.click(card("db-copy").getByRole("button", { name: "Run now" }));
    });
    expect(writes.runScheduleNow).toHaveBeenCalledWith({ data: { name: "db-copy" } });
  });

  it("deletes only after the inline confirm, and Keep backs out", async () => {
    show(jobs());
    const copy = () => card("db-copy");
    fireEvent.click(copy().getByRole("button", { name: "Delete" }));
    expect(copy().getByText("Delete db-copy and its run history? This cannot be undone.")).toBeTruthy();
    fireEvent.click(copy().getByRole("button", { name: "Keep" }));
    expect(copy().queryByText(/cannot be undone/)).toBeNull();
    expect(writes.deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(copy().getByRole("button", { name: "Delete" }));
    writes.deleteSchedule.mockImplementation(async () => ({ ok: true, schedules: jobs().filter((j) => j.name !== "db-copy") }));
    await act(async () => {
      fireEvent.click(copy().getByRole("button", { name: "Delete db-copy" }));
    });
    expect(writes.deleteSchedule).toHaveBeenCalledWith({ data: { name: "db-copy" } });
    expect(screen.queryByRole("article", { name: "db-copy" })).toBeNull();
  });

  it("shows a refused write on the card and keeps the job as it was", async () => {
    show(jobs());
    writes.pauseSchedule.mockImplementation(async () => ({ ok: false, error: "refusing to change a scheduled job over http://192.168.0.20" }));
    await act(async () => {
      fireEvent.click(card("morning-brief").getByRole("button", { name: "Pause" }));
    });
    expect(card("morning-brief").getByText(/refusing to change a scheduled job/)).toBeTruthy();
    expect(card("morning-brief").getByText("enabled")).toBeTruthy();
  });

  it("colours the last status: succeeded positive, failed danger, running accent, skipped neutral", () => {
    expect([statusTone("succeeded"), statusTone("failed"), statusTone("running"), statusTone("skipped"), statusTone(null)]).toEqual(["positive", "danger", "accent", "neutral", "neutral"]);
  });
});
