import { isClosedStatus } from "../../../cli/src/status.ts";

// OS-27: the Timeline page's pure part, shared by the page and its server read (server/timeline.ts). It imports
// nothing that touches the store, so the page's client bundle stays free of it. buildTimeline turns a project's
// items and its ranged trail into the tiles, the weekly table and a page of the feed; the feed is paged by
// FEED_PAGE entries, keyset on (at, key), newest first. The tiles and the weekly table always cover the whole
// range, whatever page the feed is on.

/** decisions.ts PRIORITY_CHANGE_TYPE (OS-26), not imported: that module reaches the store. */
export const PRIORITY_CHANGE_TYPE = "priority_change";

/** `1.5 d`, or whole hours under a day. */
export function fmtSpan(days: number): string {
  return days < 1 ? `${Math.round(days * 24)} h` : `${days.toFixed(1)} d`;
}

/** SPINOFF_STATUS_WORDS (platform/cli-coord/src/spinoff-vocab.ts, not imported: it sits beside the whole spinoff
 *  command). Only a move into one of these is a row step; the row's other events (usage, flake slot, route) are not. */
const ROW_WORDS = new Set(["queued", "launching", "building", "handed-off", "landed", "failed"]);
const LANDED = "landed";

const FEED_PAGE = 200;

export type FeedKind = "opened" | "closed" | "status" | "blocked" | "unblocked" | "priority" | "build" | "merge";

export interface FeedEntry {
  /** ISO time. With `key`, the feed's order and its paging cursor. */
  at: string;
  /** Unique in the feed: `e:<event id>`, `o:`/`c:<item id>`, `r:`/`m:<spinoff row>`. */
  key: string;
  kind: FeedKind;
  ref: string | null;
  title: string;
  /** The muted line under the title: from and to, a block reason, a spell, a build's length. */
  detail: string | null;
  who: string | null;
  /** A merge line's pull request. */
  href?: string;
}

export interface WeekRow {
  /** Monday, YYYY-MM-DD. */
  week: string;
  opened: number;
  closed: number;
  net: number;
  /** Block spells that started this week. */
  blocks: number;
  /** Task items closed this week, created_at to closed_at, in days. */
  medianCycleDays: number | null;
}

export interface Tiles {
  opened: number;
  closed: number;
  net: number;
  /** Task items closed in the range only: quick notes filed as decisions or roadmaps do not skew it. */
  medianCycleDays: number | null;
}

export interface Cursor {
  at: string;
  key: string;
}

export interface TimelineView {
  project: { id: string; label: string };
  projects: { id: string; label: string }[];
  from: string;
  to: string;
  builds: boolean;
  tiles: Tiles;
  weeks: WeekRow[];
  /** One page of the feed, newest first. */
  feed: FeedEntry[];
  /** Where the next older page starts; null when this page is the oldest. */
  next: Cursor | null;
}

export interface TimelineItem {
  id: string;
  ref: string | null;
  title: string;
  type: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  block_reason: string | null;
}

export interface TimelineEvent {
  id: number;
  ts: string;
  type: string | null;
  item_id: string | null;
  actor: string | null;
  payload: string | null;
}

interface Payload {
  from?: string;
  to?: string;
  note?: string;
  spinoff_row?: number;
  pr_url?: string;
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The Monday (UTC) of the week `ts` falls in. */
function mondayOf(ts: string): string {
  const d = Date.parse(`${ts.slice(0, 10)}T00:00:00Z`);
  return isoDay(d - ((new Date(d).getUTCDay() + 6) % 7) * DAY);
}

/** The PR number in a GitHub pull request URL. */
const prNumber = (url: string): string | null => /\/pull\/(\d+)/.exec(url)?.[1] ?? null;

function parse(e: TimelineEvent): Payload {
  try {
    const p = e.payload ? (JSON.parse(e.payload) as unknown) : {};
    return p && typeof p === "object" ? (p as Payload) : {};
  } catch {
    return {};
  }
}

/** The range as ISO bounds, both whole UTC days included. */
export function rangeBounds(from: string, to: string): { since: string; until: string } {
  return { since: `${from}T00:00:00.000Z`, until: `${to}T23:59:59.999Z` };
}

/** Newest first: by time, then key, both descending. */
const newestFirst = (a: Cursor, b: Cursor) => (a.at === b.at ? (a.key < b.key ? 1 : a.key > b.key ? -1 : 0) : a.at < b.at ? 1 : -1);

/**
 * The timeline from the project's ticket items and the trail's events in the range. Pure.
 * - A close from blocked is one Closed line that carries the spell, never an Unblocked line beside it.
 * - A spinoff row's steps fold into one Build line per row ("built, row N, X h" once landed, timed from the
 *   row's first step in range to its landing), shown only with `builds`. A landed row whose PR is known (the
 *   landed event's pr_url) also gets a Merged line.
 */
export function buildTimeline(
  items: TimelineItem[],
  events: TimelineEvent[],
  opts: { from: string; to: string; builds: boolean; before?: Cursor | null; limit?: number },
): Pick<TimelineView, "tiles" | "weeks" | "feed" | "next"> {
  const { since, until } = rangeBounds(opts.from, opts.to);
  const inRange = (ts: string | null): ts is string => ts !== null && ts >= since && ts <= until;
  const byId = new Map(items.map((i) => [i.id, i]));
  const feed: FeedEntry[] = [];

  const blockedAt = new Map<string, string>();
  const blockStarts: string[] = [];
  /** item id -> the spell the item's current close (its closed_at) ended, when it closed from blocked. */
  const closedFromBlocked = new Map<string, string>();
  /** item id -> its moves into a closed status in range, oldest first. */
  const closes = new Map<string, { base: Omit<FeedEntry, "kind" | "detail">; move: string; spell: string | null }[]>();
  const rows = new Map<number, { item: TimelineItem; first: string; last: string; lastTo: string; landed: TimelineEvent | null; pr: string | null }>();

  for (const e of [...events].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1))) {
    const item = e.item_id ? byId.get(e.item_id) : undefined;
    if (!item || !inRange(e.ts)) continue;
    const pl = parse(e);
    const move = `${pl.from ?? "?"} → ${pl.to ?? "?"}`;
    const note = pl.note ? ` · ${pl.note}` : "";
    const base = { at: e.ts, key: `e:${e.id}`, ref: item.ref, title: item.title, who: e.actor };
    if (e.type === PRIORITY_CHANGE_TYPE) {
      feed.push({ ...base, kind: "priority", detail: `priority ${move}${note}` });
    } else if (typeof pl.spinoff_row === "number") {
      if (!pl.to || !ROW_WORDS.has(pl.to)) continue;
      const r = rows.get(pl.spinoff_row) ?? { item, first: e.ts, last: e.ts, lastTo: "", landed: null, pr: null };
      r.last = e.ts;
      r.lastTo = pl.to ?? "?";
      if (pl.to === LANDED && !r.landed) {
        r.landed = e;
        r.pr = typeof pl.pr_url === "string" ? pl.pr_url : null;
      } else if (pl.from === LANDED && pl.to !== LANDED) {
        // `ob spinoff reopen`: the landing was a mistake, so the row is building again.
        r.landed = null;
        r.pr = null;
      }
      rows.set(pl.spinoff_row, r);
    } else if (pl.to === "blocked") {
      blockedAt.set(item.id, e.ts);
      blockStarts.push(e.ts);
      feed.push({ ...base, kind: "blocked", detail: `${pl.note ?? item.block_reason ?? "no reason given"}` });
    } else {
      let spell: string | null = null;
      if (pl.from === "blocked") {
        const start = blockedAt.get(item.id);
        blockedAt.delete(item.id);
        spell = start ? `after ${fmtSpan(daysBetween(start, e.ts))} blocked` : "blocked before the range";
      }
      const closing = !!pl.to && isClosedStatus(item.type, pl.to) && !(pl.from && isClosedStatus(item.type, pl.from));
      if (closing) closes.set(item.id, [...(closes.get(item.id) ?? []), { base, move: `${move}${note}`, spell }]);
      else if (spell) feed.push({ ...base, kind: "unblocked", detail: `${move} ${spell}${note}` });
      else feed.push({ ...base, kind: "status", detail: `${move}${note}` });
    }
  }

  // The item's latest close is its Closed line from closed_at below; an earlier close (later reopened) is its own line.
  for (const [id, cs] of closes) {
    const current = inRange(byId.get(id)!.closed_at) ? cs.pop() : undefined;
    if (current?.spell) closedFromBlocked.set(id, current.spell);
    for (const c of cs) feed.push({ ...c.base, kind: "closed", detail: c.spell ? `${c.move} · ${c.spell}` : c.move });
  }

  for (const i of items) {
    if (inRange(i.created_at)) feed.push({ at: i.created_at, key: `o:${i.id}`, kind: "opened", ref: i.ref, title: i.title, detail: null, who: null });
    if (inRange(i.closed_at)) {
      const spell = closedFromBlocked.get(i.id);
      const detail = `${i.status} after ${fmtSpan(daysBetween(i.created_at, i.closed_at))}${spell ? ` · ${spell}` : ""}`;
      feed.push({ at: i.closed_at, key: `c:${i.id}`, kind: "closed", ref: i.ref, title: i.title, detail, who: null });
    }
  }

  for (const [n, r] of rows) {
    const item = r.item;
    if (opts.builds) {
      const detail = r.landed ? `built, row ${n}, ${fmtSpan(daysBetween(r.first, r.landed.ts))}` : `row ${n}, ${r.lastTo}`;
      feed.push({ at: r.landed?.ts ?? r.last, key: `r:${n}`, kind: "build", ref: item.ref, title: item.title, detail, who: null });
    }
    const pr = r.pr;
    const num = pr ? prNumber(pr) : null;
    if (r.landed && pr && num) {
      feed.push({ at: r.landed.ts, key: `m:${n}`, kind: "merge", ref: item.ref, title: item.title, detail: `merged, PR #${num}`, who: null, href: pr });
    }
  }

  feed.sort(newestFirst);
  const before = opts.before;
  const older = before ? feed.filter((e) => newestFirst(e, before) > 0) : feed;
  const limit = opts.limit ?? FEED_PAGE;
  const page = older.slice(0, limit);
  const last = page.at(-1);
  const next = older.length > limit && last ? { at: last.at, key: last.key } : null;

  const opened = items.filter((i) => inRange(i.created_at));
  const closed = items.filter((i) => inRange(i.closed_at));
  const cycle = (xs: TimelineItem[]) => median(xs.filter((i) => i.type === "task").map((i) => daysBetween(i.created_at, i.closed_at!)));

  // Every Monday from the range's first week to its last, newest first.
  const weeks: WeekRow[] = [];
  for (let w = Date.parse(`${mondayOf(since)}T00:00:00Z`); w <= Date.parse(until); w += 7 * DAY) {
    const week = isoDay(w);
    const o = opened.filter((i) => mondayOf(i.created_at) === week).length;
    const c = closed.filter((i) => mondayOf(i.closed_at!) === week);
    weeks.push({
      week,
      opened: o,
      closed: c.length,
      net: o - c.length,
      blocks: blockStarts.filter((ts) => mondayOf(ts) === week).length,
      medianCycleDays: cycle(c),
    });
  }
  weeks.reverse();

  return {
    tiles: { opened: opened.length, closed: closed.length, net: opened.length - closed.length, medianCycleDays: cycle(closed) },
    weeks,
    feed: page,
    next,
  };
}
