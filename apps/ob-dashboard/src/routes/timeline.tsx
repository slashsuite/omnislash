import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type ChangeEvent } from "react";
import {
  Caption,
  CardGrid,
  Cluster,
  DateField,
  fromISODate,
  PageHeader,
  Pill,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatTile,
  SubsectionHeading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  Timeline,
  TimelineItem,
} from "@hackcove/ui-react";
import { getTimeline, type FeedEntry, type FeedKind } from "../server/timeline.ts";

// OS-28 SPIKE (throwaway, never merged): one project's timeline. A project Select, 7/30/90 day presets or a
// from and to date, four tiles, the feed grouped by day (newest first) and a weekly table. Read-only: nothing
// on this page writes.

type Search = { project?: string; from?: string; to?: string };

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - (n - 1) * DAY).toISOString().slice(0, 10);
const PRESETS = [7, 30, 90] as const;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const Route = createFileRoute("/timeline")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.project === "string" && s.project ? { project: s.project } : {}),
    ...(isDate(s.from) ? { from: s.from } : {}),
    ...(isDate(s.to) ? { to: s.to } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    await getTimeline({ data: { project: deps.project, from: deps.from ?? daysAgo(30), to: deps.to ?? today() } }),
  component: TimelinePage,
});

const KIND: Record<FeedKind, { label: string; tone: "neutral" | "info" | "positive" | "warn" | "danger" }> = {
  opened: { label: "Opened", tone: "info" },
  closed: { label: "Closed", tone: "positive" },
  status: { label: "Status", tone: "neutral" },
  blocked: { label: "Blocked", tone: "danger" },
  unblocked: { label: "Unblocked", tone: "warn" },
  priority: { label: "Priority", tone: "warn" },
  build: { label: "Build", tone: "neutral" },
  merge: { label: "Merged", tone: "positive" },
  marker: { label: "", tone: "neutral" },
};

const FILTERS: { value: string; label: string; kinds: FeedKind[] | null }[] = [
  { value: "core", label: "Core", kinds: ["opened", "closed", "status", "blocked", "unblocked", "priority"] },
  { value: "all", label: "All", kinds: null },
  { value: "flow", label: "Opened & closed", kinds: ["opened", "closed"] },
  { value: "blocks", label: "Blocks", kinds: ["blocked", "unblocked"] },
  { value: "builds", label: "Builds & merges", kinds: ["build", "merge"] },
];

const fmtDays = (d: number | null) => (d === null ? "none" : d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1)} d`);
const dayHeading = (ts: string) =>
  new Date(ts).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function Entry({ e }: { e: FeedEntry }) {
  if (e.kind === "marker") {
    return (
      <TimelineItem title={<Caption as="span" tone="muted">{e.title}</Caption>} time={clock(e.ts)}>
        {null}
      </TimelineItem>
    );
  }
  const k = KIND[e.kind];
  return (
    <TimelineItem
      tone={k.tone}
      time={clock(e.ts)}
      title={
        <Cluster gap="xs">
          <Pill size="sm" tone={k.tone === "neutral" ? undefined : k.tone}>
            {k.label}
          </Pill>
          {e.ref && (
            <Pill size="sm" tone="accent">
              {e.ref}
            </Pill>
          )}
          <Text as="span">
            {e.title}
          </Text>
        </Cluster>
      }
    >
      {(e.detail || e.who) && (
        <Caption as="span" tone="muted">
          {[e.detail, e.who && e.who !== "human" ? `by ${e.who}` : null].filter(Boolean).join(" · ")}
        </Caption>
      )}
    </TimelineItem>
  );
}

function TimelinePage() {
  const v = Route.useLoaderData();
  const navigate = useNavigate({ from: "/timeline" });
  const [filter, setFilter] = useState("core");
  const go = (patch: Search) => navigate({ search: (s) => ({ ...s, ...patch }) });

  const span = Math.round((Date.parse(v.to) - Date.parse(v.from)) / DAY) + 1;
  const preset = v.to === today() ? PRESETS.find((n) => n === span) : undefined;
  const kinds = FILTERS.find((f) => f.value === filter)?.kinds ?? null;
  const shown = v.feed.filter((e) => e.kind === "marker" || kinds === null || kinds.includes(e.kind));

  const days: { day: string; entries: FeedEntry[] }[] = [];
  for (const e of shown) {
    const day = e.ts.slice(0, 10);
    if (days.at(-1)?.day !== day) days.push({ day, entries: [] });
    days.at(-1)!.entries.push(e);
  }

  return (
    <>
      <PageHeader title="Timeline" description="What happened to one project's tickets over a range: opened, closed, status moves, blocks and priority changes." />
      <Stack>
        <Cluster gap="sm" align="end">
          <Select
            aria-label="Project"
            size="sm"
            value={v.project.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => go({ project: e.target.value })}
            items={v.projects.map((p) => ({ value: p.id, label: p.label }))}
          />
          <SegmentedControl
            size="sm"
            label="Range"
            value={preset ? String(preset) : "custom"}
            onChange={(n) => n !== "custom" && go({ from: daysAgo(Number(n)), to: today() })}
            items={[...PRESETS.map((n) => ({ value: String(n), label: `${n} days` })), { value: "custom", label: "Custom" }]}
          />
          <DateField
            size="sm"
            label="From"
            calendar
            value={fromISODate(v.from)}
            onChange={(d) => d && go({ from: d.toString() })}
          />
          <DateField size="sm" label="To" calendar value={fromISODate(v.to)} onChange={(d) => d && go({ to: d.toString() })} />
        </Cluster>

        <CardGrid columns={4}>
          <StatTile label="Opened" value={v.tiles.opened} hint={`${span} days`} />
          <StatTile label="Closed" value={v.tiles.closed} tone="positive" hint={`${span} days`} />
          <StatTile label="Open now" value={v.tiles.openNow} hint="today, whatever the range" />
          <StatTile label="Median cycle" value={fmtDays(v.tiles.medianCycleDays)} hint="opened to closed, for those closed in range" />
        </CardGrid>

        <Section title="Feed" size="sm">
          <Stack gap="sm">
            <SegmentedControl size="sm" label="Show" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
            {v.feedTotal > v.feed.length && (
              <Caption tone="muted">
                Showing the newest {v.feed.length} of {v.feedTotal} entries; narrow the range for the rest.
              </Caption>
            )}
            {days.length === 0 && <Caption tone="muted">Nothing happened in this range.</Caption>}
            {days.map((d) => (
              <Stack key={d.day} gap="xs">
                <SubsectionHeading size="sm">{dayHeading(`${d.day}T12:00:00Z`)}</SubsectionHeading>
                <Timeline label={`Events on ${d.day}`}>
                  {d.entries.map((e, i) => (
                    <Entry key={`${e.ts}-${i}`} e={e} />
                  ))}
                </Timeline>
              </Stack>
            ))}
          </Stack>
        </Section>

        <Section title="By week" size="sm">
          <Table label="Weekly trend">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Week of</TableHeaderCell>
                <TableHeaderCell numeric>Opened</TableHeaderCell>
                <TableHeaderCell numeric>Closed</TableHeaderCell>
                <TableHeaderCell numeric>Net</TableHeaderCell>
                <TableHeaderCell numeric>Blocks</TableHeaderCell>
                <TableHeaderCell numeric>Median cycle</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {v.weeks.map((w) => (
                <TableRow key={w.week}>
                  <TableCell>{dayHeading(`${w.week}T12:00:00Z`)}</TableCell>
                  <TableCell>{w.opened}</TableCell>
                  <TableCell>{w.closed}</TableCell>
                  <TableCell>{w.opened - w.closed > 0 ? `+${w.opened - w.closed}` : w.opened - w.closed}</TableCell>
                  <TableCell>{w.blocked}</TableCell>
                  <TableCell>{fmtDays(w.medianCycleDays)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
        <Caption tone="muted">Times are UTC. Spike page (OS-28), read-only.</Caption>
      </Stack>
    </>
  );
}
