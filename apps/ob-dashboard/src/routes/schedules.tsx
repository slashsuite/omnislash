import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, ButtonGroup, Callout, Card, Cluster, Disclosure, EmptyState, PageHeader, Pill, Stack, Text } from "@slashsuite/ui-react";
import {
  deleteSchedule,
  getSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  type ScheduledJobRun,
  type ScheduledJobWithRuns,
  type ScheduleWriteResult,
} from "../server/schedules.ts";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";

// OS-312: the scheduled jobs `ob schedule` stores (OS-310), one card each: what it is, where it goes, when it runs
// next, how it last went, and its newest runs. Pause, resume, run now and delete are the CLI's own writes behind the
// kit's guard. Run now only makes the job due: the next `ob role tick` on a machine fires it, never this page.
// Live: the snapshot carries a schedules stamp (a job written, deleted or given a run moves it), and a push means the
// snapshot changed, so the list is fetched again.

export const Route = createFileRoute("/schedules")({
  loader: () => getSchedules(),
  component: Schedules,
});

type Tone = "positive" | "danger" | "accent" | "neutral";

/** The last-status pill's tone. */
export function statusTone(status: string | null): Tone {
  if (status === "succeeded") return "positive";
  if (status === "failed") return "danger";
  if (status === "running") return "accent";
  return "neutral";
}

/** The most of a prompt a card shows before the full text is a click away. */
const PROMPT_PREVIEW = 120;

function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > PROMPT_PREVIEW ? `${one.slice(0, PROMPT_PREVIEW - 1)}…` : one;
}

/** How a schedule reads: "every 15m", "cron 0 9 * * 1-5", "once at …". */
function scheduleText(j: ScheduledJobWithRuns): string {
  if (j.schedule_kind === "interval") return `every ${j.schedule_expr}`;
  if (j.schedule_kind === "once") return `once at ${j.schedule_expr}`;
  return `cron ${j.schedule_expr}`;
}

function Target({ j }: { j: ScheduledJobWithRuns }) {
  if (j.target_kind === "role") {
    return (
      <Stack gap="xs">
        <Text>
          Sends to <Text as="span" mono>{`${j.team}:${j.role}`}</Text>
        </Text>
        {j.prompt && <Text tone="muted">{preview(j.prompt)}</Text>}
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Text>
        Runs <Text as="span" mono>{j.command}</Text>
      </Text>
      <Text tone="muted">
        {j.host ? `on ${j.host}` : "on any machine"}
        {j.cwd ? ` in ${j.cwd}` : ""}
      </Text>
    </Stack>
  );
}

function RunRow({ r }: { r: ScheduledJobRun }) {
  return (
    <Card tone="neutral" size="sm" aria-label={`Run ${r.id}`}>
      <Stack gap="xs">
        <Cluster gap="xs">
          <Pill size="lg" tone={statusTone(r.status)}>
            {r.status}
          </Pill>
          <Text as="span" mono>
            {r.started_at}
            {r.finished_at ? ` to ${r.finished_at}` : ""}
          </Text>
        </Cluster>
        <Text tone="muted">
          {[r.host ? `host ${r.host}` : null, r.exit_code !== null ? `exit ${r.exit_code}` : null, r.role_message_id !== null ? `inbox message ${r.role_message_id}` : null]
            .filter(Boolean)
            .join(" · ") || "no host, exit code or message"}
        </Text>
        {r.output_tail && (
          <Stack gap="xs">
            <Text tone="muted">Output (last lines)</Text>
            <Text mono preserveNewlines breakWords>
              {r.output_tail}
            </Text>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function JobCard({ j, onData }: { j: ScheduledJobWithRuns; onData: (d: ScheduledJobWithRuns[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const run = async (fn: () => Promise<ScheduleWriteResult>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fn();
      if (res.ok) onData(res.schedules);
      else setErr(res.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const data = { data: { name: j.name } };

  return (
    <Card
      title={j.name}
      titleStyle="name"
      status={
        <Pill size="lg" tone={j.enabled ? "positive" : "neutral"}>
          {j.enabled ? "enabled" : "paused"}
        </Pill>
      }
      actions={
        confirming ? (
          <ButtonGroup>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button tone="danger" disabled={busy} onClick={() => run(() => deleteSchedule(data))}>
              Delete {j.name}
            </Button>
          </ButtonGroup>
        ) : (
          <ButtonGroup>
            {j.enabled ? (
              <Button variant="outline" disabled={busy} onClick={() => run(() => pauseSchedule(data))}>
                Pause
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => run(() => resumeSchedule(data))}>
                Resume
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || !j.enabled}
              title={j.enabled ? "Make it due now: the next ob role tick fires it." : "Resume it first: a paused job does not run."}
              onClick={() => run(() => runScheduleNow(data))}
            >
              Run now
            </Button>
            <Button variant="outline" tone="danger" disabled={busy} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </ButtonGroup>
        )
      }
    >
      <Stack gap="sm">
        {confirming && <Text tone="danger">Delete {j.name} and its run history? This cannot be undone.</Text>}
        <Cluster gap="xs">
          <Pill size="lg" tone="neutral">
            {j.target_kind}
          </Pill>
          <Text as="span" mono>
            {scheduleText(j)}
          </Text>
          {!j.respect_good_night && (
            <Pill size="lg" tone="warn">
              runs through good night
            </Pill>
          )}
        </Cluster>
        <Target j={j} />
        <Cluster gap="xs">
          <Text as="span" tone="muted">
            Next {j.enabled ? (j.next_run_at ?? "never") : "paused"}
          </Text>
          <Text as="span" tone="muted">
            · Last {j.last_run_at ?? "never"}
          </Text>
          {j.last_status && (
            <Pill size="lg" tone={statusTone(j.last_status)}>
              {j.last_status}
            </Pill>
          )}
          {j.consecutive_failures >= 2 && (
            <Pill size="lg" tone="danger">
              {j.consecutive_failures} failures in a row
            </Pill>
          )}
        </Cluster>
        {j.last_error && <Text tone="danger">{j.last_error}</Text>}
        {err && <Callout tone="danger">{err}</Callout>}
        <Disclosure summary={j.runs.length === 0 ? "No runs yet" : `Recent runs (${j.runs.length})`}>
          {j.runs.length === 0 ? (
            <Text tone="muted">It has not run yet.</Text>
          ) : (
            <Stack gap="xs">
              {j.runs.map((r) => (
                <RunRow key={r.id} r={r} />
              ))}
            </Stack>
          )}
        </Disclosure>
      </Stack>
    </Card>
  );
}

function Schedules() {
  const initial = Route.useLoaderData();
  const [jobs, setJobs] = useState<ScheduledJobWithRuns[]>(initial);
  const { snap } = useRealtime();

  useEffect(() => {
    if (!snap) return;
    let live = true;
    getSchedules()
      .then((d) => live && setJobs(d))
      .catch(() => {}); // a refresh failure never blanks the view
    return () => {
      live = false;
    };
  }, [snap]);

  return (
    <>
      <PageHeader
        title="Schedules"
        description="The jobs ob schedule runs: a prompt to a team role, or a command on a machine. Run now makes a job due; the next ob role tick fires it."
      />
      {jobs.length === 0 ? (
        <EmptyState title="No scheduled jobs">
          <Text tone="muted">
            Add one with <Text as="span" mono>ob schedule add</Text>, for example a daily prompt to a team's architect.
          </Text>
        </EmptyState>
      ) : (
        <Stack>
          {jobs.map((j) => (
            <JobCard key={j.id} j={j} onData={setJobs} />
          ))}
        </Stack>
      )}
    </>
  );
}
