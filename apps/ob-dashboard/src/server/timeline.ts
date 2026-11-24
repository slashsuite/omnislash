import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte, inArray, lte } from "../../../cli/src/db/orm.ts";
import { DECISION_SOURCE, DECISION_TYPE, PRIORITY_CHANGE_TYPE } from "../../../cli/src/decisions.ts";
import { listProjects } from "../../../cli/src/project.ts";
import { providedStore } from "../../provided-store.ts";

// OS-28 SPIKE (throwaway, never merged): one project's timeline over a date range, read-only. Items come from
// one read of the project's items; the trail from one ranged read of `event` (source ob, type transition or
// priority_change) joined to the project's items, both through the store's orm builder. Merges come from the
// project's checkout's git log, matched by the ticket ref in the subject.

/** OS-26 started writing priority_change events on this day; before it the trail has none. */
export const PRIORITY_TRACKING_SINCE = "2026-11-24";

/** Item types that are tickets. Learnings, references and hunt rows are left out. */
const TICKET_TYPES = ["task", "decision", "roadmap"];

/** The `from` a spinoff row's first transition carries (U+2014). */
const NO_STATE = String.fromCharCode(0x2014);

export type FeedKind = "opened" | "closed" | "status" | "blocked" | "unblocked" | "priority" | "build" | "merge" | "marker";

export interface FeedEntry {
  ts: string;
  kind: FeedKind;
  ref: string | null;
  title: string;
  /** The line under the title: from and to, a block reason, a commit subject. */
  detail: string | null;
  who: string | null;
}

export interface WeekRow {
  /** Monday, YYYY-MM-DD. */
  week: string;
  opened: number;
  closed: number;
  blocked: number;
  medianCycleDays: number | null;
}

export interface TimelineView {
  project: { id: string; label: string };
  projects: { id: string; label: string }[];
  from: string;
  to: string;
  tiles: { opened: number; closed: number; openNow: number; medianCycleDays: number | null };
  weeks: WeekRow[];
  feed: FeedEntry[];
  /** How many entries there were before the feed was cut to its newest FEED_LIMIT. */
  feedTotal: number;
}

const FEED_LIMIT = 600;
const DAY = 86_400_000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mondayOf(ts: string): string {
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return isoDay(new Date(d.getTime() - back * DAY));
}

const daysBetween = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY;

/** Commits on the project's checkout's origin/main with `(REF)` in the subject. No checkout or no git: none. */
function gitMerges(projectName: string, since: string, until: string): { at: string; sha: string; subject: string; ref: string }[] {
  const dir = `${process.env.HOME}/dev/${projectName}`;
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "log", "origin/main", `--since=${since}`, `--until=${until}`, "--format=%h%x09%cI%x09%s"], { stderr: "ignore" });
    if (p.exitCode !== 0) return [];
    return p.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [sha, at, subject] = line.split("\t") as [string, string, string];
        const ref = /\(([A-Z]{2,4}-\d+)\)/.exec(subject)?.[1];
        return ref ? [{ at: new Date(at).toISOString(), sha, subject, ref }] : [];
      });
  } catch {
    return [];
  }
}

export async function timelineView(input: { project?: string; from: string; to: string }): Promise<TimelineView> {
  const store = await providedStore();
  const all = await listProjects(store);
  const projects = all.map((p) => ({ id: p.id, label: p.display_name ?? p.name }));
  const p = all.find((x) => x.id === (input.project ?? "omnislash")) ?? all[0];
  if (!p) throw new Error("no projects");
  // The range is whole UTC days, both ends included.
  const since = `${input.from}T00:00:00.000Z`;
  const until = `${input.to}T23:59:59.999Z`;

  const t = store.t;
  const items = await store.q
    .select({
      id: t.item.id,
      ref: t.item.ref,
      title: t.item.title,
      status: t.item.status,
      created_at: t.item.created_at,
      closed_at: t.item.closed_at,
      block_reason: t.item.block_reason,
    })
    .from(t.item)
    .where(and(eq(t.item.project_id, p.id), inArray(t.item.type, TICKET_TYPES)));
  const byId = new Map(items.map((i) => [i.id, i]));

  const events = await store.q
    .select({ ts: t.event.ts, type: t.event.type, item_id: t.event.item_id, actor: t.event.actor, payload: t.event.payload })
    .from(t.event)
    .innerJoin(t.item, eq(t.item.id, t.event.item_id))
    .where(
      and(
        eq(t.event.source, DECISION_SOURCE),
        inArray(t.event.type, [DECISION_TYPE, PRIORITY_CHANGE_TYPE]),
        gte(t.event.ts, since),
        lte(t.event.ts, until),
        eq(t.item.project_id, p.id),
      ),
    );

  const inRange = (ts: string | null): ts is string => ts !== null && ts >= since && ts <= until;
  const feed: FeedEntry[] = [];
  for (const i of items) {
    if (inRange(i.created_at)) feed.push({ ts: i.created_at, kind: "opened", ref: i.ref, title: i.title, detail: null, who: null });
    if (inRange(i.closed_at)) {
      const d = `${i.status} after ${daysBetween(i.created_at, i.closed_at).toFixed(1)} days`;
      feed.push({ ts: i.closed_at, kind: "closed", ref: i.ref, title: i.title, detail: d, who: null });
    }
  }

  // Block spells: a move to blocked opens one, the item's next move off blocked closes it.
  const blockedAt = new Map<string, string>();
  const blockedByWeek = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const item = e.item_id ? byId.get(e.item_id) : undefined;
    if (!item) continue;
    let pl: { from?: string; to?: string; note?: string; spinoff_row?: number } = {};
    try {
      pl = e.payload ? JSON.parse(e.payload) : {};
    } catch {}
    const move = `${pl.from ?? "?"} → ${pl.to ?? "?"}`;
    const note = pl.note ? ` · ${pl.note}` : "";
    const base = { ts: e.ts, ref: item.ref, title: item.title, who: e.actor };
    if (e.type === PRIORITY_CHANGE_TYPE) {
      feed.push({ ...base, kind: "priority", detail: `priority ${move}${note}` });
    } else if (pl.spinoff_row != null) {
      feed.push({ ...base, kind: "build", detail: `build row ${pl.spinoff_row}: ${move}` });
    } else if (pl.to === "blocked") {
      blockedAt.set(item.id, e.ts);
      blockedByWeek.set(mondayOf(e.ts), (blockedByWeek.get(mondayOf(e.ts)) ?? 0) + 1);
      feed.push({ ...base, kind: "blocked", detail: pl.note ?? (item.status === "blocked" ? item.block_reason : null) ?? "no reason given" });
    } else if (pl.from === "blocked") {
      const start = blockedAt.get(item.id);
      blockedAt.delete(item.id);
      const spell = start ? ` after ${daysBetween(start, e.ts).toFixed(1)} days blocked` : "";
      feed.push({ ...base, kind: "unblocked", detail: `${move}${spell}${note}` });
    } else if (pl.to !== "done" && pl.from !== NO_STATE) {
      // A move to done is already the "closed" line, from the item's own closed_at.
      feed.push({ ...base, kind: "status", detail: `${move}${note}` });
    }
  }

  const refs = new Map(items.filter((i) => i.ref).map((i) => [i.ref!, i]));
  for (const m of gitMerges(p.name, since, until)) {
    feed.push({ ts: m.at, kind: "merge", ref: m.ref, title: refs.get(m.ref)?.title ?? m.subject, detail: `${m.sha} ${m.subject}`, who: null });
  }

  if (input.from < PRIORITY_TRACKING_SINCE) {
    const markerTs = `${PRIORITY_TRACKING_SINCE}T00:00:00.000Z`;
    feed.push({
      ts: markerTs <= until ? markerTs : until,
      kind: "marker",
      ref: null,
      title: `Priority changes are on the trail from ${PRIORITY_TRACKING_SINCE}; earlier ones were not recorded.`,
      detail: null,
      who: null,
    });
  }
  feed.sort((a, b) => b.ts.localeCompare(a.ts));

  const opened = items.filter((i) => inRange(i.created_at));
  const closed = items.filter((i) => inRange(i.closed_at));

  // Every Monday from the range's first week to its last, newest first.
  const weeks: WeekRow[] = [];
  for (let w = Date.parse(`${mondayOf(since)}T00:00:00Z`); w <= Date.parse(until); w += 7 * DAY) {
    const week = isoDay(new Date(w));
    const c = closed.filter((i) => mondayOf(i.closed_at!) === week);
    weeks.push({
      week,
      opened: opened.filter((i) => mondayOf(i.created_at) === week).length,
      closed: c.length,
      blocked: blockedByWeek.get(week) ?? 0,
      medianCycleDays: median(c.map((i) => daysBetween(i.created_at, i.closed_at!))),
    });
  }
  weeks.reverse();

  return {
    project: { id: p.id, label: p.display_name ?? p.name },
    projects,
    from: input.from,
    to: input.to,
    tiles: {
      opened: opened.length,
      closed: closed.length,
      openNow: items.filter((i) => i.closed_at === null).length,
      medianCycleDays: median(closed.map((i) => daysBetween(i.created_at, i.closed_at!))),
    },
    weeks,
    feed: feed.slice(0, FEED_LIMIT),
    feedTotal: feed.length,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const getTimeline = createServerFn({ method: "GET" })
  .validator((d: { project?: string; from: string; to: string }) => {
    if (!DATE.test(d.from) || !DATE.test(d.to)) throw new Error("from and to must be YYYY-MM-DD");
    return { project: typeof d.project === "string" && d.project ? d.project : undefined, from: d.from, to: d.to };
  })
  .handler(async ({ data }): Promise<TimelineView> => await timelineView(data));
