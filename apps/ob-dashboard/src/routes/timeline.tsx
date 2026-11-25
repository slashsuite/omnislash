import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Button,
  Callout,
  Caption,
  CardGrid,
  Cluster,
  DateField,
  fromISODate,
  PageHeader,
  Pill,
  Section,
  SegmentedControl,
  Stack,
  StatTile,
  SubsectionHeading,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
  Timeline,
  TimelineItem,
} from "@slashsuite/ui-react";
import { fmtSpan, type Cursor, type FeedEntry, type FeedKind, type TimelineView } from "../lib/timeline.ts";
import { getTimeline } from "../server/timeline.ts";
import { GroupPicker, groupSearch, type GroupSearch } from "../components/GroupPicker.tsx";

// OS-27: the timeline. OS-185: a group's projects together (`?team=`, each line naming its project), or one
// project's (`?project=`). The group and project Selects, 7 (default), 30 and 90 day presets or a custom from and to,
// all in the URL; four tiles (Opened, Closed, Net, task-only Median cycle) and a weekly table over the whole
// range; the feed grouped by day, newest first, paged by "Load older". Build steps are folded per spinoff row
// and shown only with the Builds switch (`builds=true`). Read-only: nothing on this page writes.

type Search = GroupSearch & { from?: string; to?: string; builds?: boolean };

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
/** The first day of an `n` day range that ends today. */
const daysAgo = (n: number) => new Date(Date.now() - (n - 1) * DAY).toISOString().slice(0, 10);
const PRESETS = [7, 30, 90] as const;
const DEFAULT_DAYS = 7;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const Route = createFileRoute("/timeline")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...groupSearch(s),
    ...(isDate(s.from) ? { from: s.from } : {}),
    ...(isDate(s.to) ? { to: s.to } : {}),
    ...(s.builds === true || s.builds === 1 || s.builds === "1" ? { builds: true } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    await getTimeline({ data: { team: deps.team, project: deps.project, from: deps.from ?? daysAgo(DEFAULT_DAYS), to: deps.to ?? today(), builds: deps.builds === true } }),
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
};

const fmtDays = (d: number | null) => (d === null ? "none" : fmtSpan(d));
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const dayHeading = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const clock = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function Entry({ e, projectLabel }: { e: FeedEntry; projectLabel: string | null }) {
  const k = KIND[e.kind];
  const who = e.who && e.who !== "human" ? `by ${e.who}` : null;
  return (
    <TimelineItem
      tone={k.tone}
      time={clock(e.at)}
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
          {projectLabel && <Pill size="sm">{projectLabel}</Pill>}
          <Text as="span">{e.title}</Text>
        </Cluster>
      }
    >
      {(e.detail || who) && (
        <Caption as="span" tone="muted">
          {e.href ? (
            <TextLink href={e.href} external>
              {e.detail}
            </TextLink>
          ) : (
            e.detail
          )}
          {who && `${e.detail ? " · " : ""}${who}`}
        </Caption>
      )}
    </TimelineItem>
  );
}

/** The feed, from the loader's first page; "Load older" appends the next. Keyed by the range, so a new range starts over. */
function Feed({ v }: { v: TimelineView }) {
  const [feed, setFeed] = useState(v.feed);
  const [next, setNext] = useState<Cursor | null>(v.next);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOlder = async () => {
    if (!next) return;
    setLoading(true);
    setError(null);
    try {
      const older = await getTimeline({ data: { team: v.group.id, project: v.project?.id, from: v.from, to: v.to, builds: v.builds, before: next } });
      setFeed((f) => [...f, ...older.feed]);
      setNext(older.next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const labelOf = new Map(v.group.projects.map((p) => [p.id, p.label]));
  const days: { day: string; entries: FeedEntry[] }[] = [];
  for (const e of feed) {
    const day = e.at.slice(0, 10);
    if (days.at(-1)?.day !== day) days.push({ day, entries: [] });
    days.at(-1)!.entries.push(e);
  }

  return (
    <Stack gap="sm">
      {days.length === 0 && <Caption tone="muted">Nothing happened in this range.</Caption>}
      {days.map((d) => (
        <Stack key={d.day} gap="xs">
          <SubsectionHeading size="sm">{dayHeading(d.day)}</SubsectionHeading>
          <Timeline label={`Events on ${d.day}`}>
            {d.entries.map((e) => (
              <Entry key={e.key} e={e} projectLabel={v.project === null && e.project ? (labelOf.get(e.project) ?? e.project) : null} />
            ))}
          </Timeline>
        </Stack>
      ))}
      {error && <Callout tone="danger">Could not load older entries: {error}</Callout>}
      {next && (
        <div>
          <Button size="sm" variant="outline" busy={loading} onClick={() => void loadOlder()}>
            Load older
          </Button>
        </div>
      )}
    </Stack>
  );
}

function TimelinePage() {
  const v = Route.useLoaderData();
  const navigate = useNavigate({ from: "/timeline" });
  const go = (patch: Search) => navigate({ search: (s) => ({ ...s, ...patch }) });

  const span = Math.round((Date.parse(v.to) - Date.parse(v.from)) / DAY) + 1;
  const preset = v.to === today() ? PRESETS.find((n) => n === span) : undefined;
  const rangeHint = `${span} ${span === 1 ? "day" : "days"}`;

  return (
    <>
      <PageHeader
        title="Timeline"
        description="What happened to a group's tickets over a range: opened, closed, status moves, blocks, priority changes and merges. Pick a project to see only its tickets."
      />
      <Stack>
        <Cluster gap="sm" align="end">
          <GroupPicker group={v.group} groups={v.groups} project={v.project} onChange={go} />
          <SegmentedControl
            size="sm"
            label="Range"
            value={preset ? String(preset) : "custom"}
            onChange={(n) => n !== "custom" && go({ from: daysAgo(Number(n)), to: today() })}
            items={[...PRESETS.map((n) => ({ value: String(n), label: `${n} days` })), { value: "custom", label: "Custom" }]}
          />
          <DateField size="sm" label="From" calendar value={fromISODate(v.from)} onChange={(d) => d && go({ from: d.toString() })} />
          <DateField size="sm" label="To" calendar value={fromISODate(v.to)} onChange={(d) => d && go({ to: d.toString() })} />
        </Cluster>

        <CardGrid columns={4}>
          <StatTile data-tile="opened" label="Opened" value={v.tiles.opened} hint={rangeHint} />
          <StatTile data-tile="closed" label="Closed" value={v.tiles.closed} tone="positive" hint={rangeHint} />
          <StatTile data-tile="net" label="Net" value={signed(v.tiles.net)} hint="opened minus closed" />
          <StatTile data-tile="median cycle" label="Median cycle" value={fmtDays(v.tiles.medianCycleDays)} hint="tasks closed in range, opened to closed" />
        </CardGrid>

        <Section title="Feed" size="sm">
          <Stack gap="sm">
            <Switch size="sm" label="Builds" hint="one line per spinoff row" checked={v.builds} onChange={(on) => go({ builds: on ? true : undefined })} />
            <Feed key={`${v.group.id}|${v.project?.id ?? ""}|${v.from}|${v.to}|${v.builds}`} v={v} />
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
                  <TableCell>{dayHeading(w.week)}</TableCell>
                  <TableCell>{w.opened}</TableCell>
                  <TableCell>{w.closed}</TableCell>
                  <TableCell>{signed(w.net)}</TableCell>
                  <TableCell>{w.blocks}</TableCell>
                  <TableCell>{fmtDays(w.medianCycleDays)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
        <Caption tone="muted">Times are UTC. Read-only.</Caption>
      </Stack>
    </>
  );
}
