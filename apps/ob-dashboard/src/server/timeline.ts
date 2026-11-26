import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte, inArray, lte } from "../../../cli/src/db/orm.ts";
import { DECISION_SOURCE, DECISION_TYPE, PRIORITY_CHANGE_TYPE } from "../../../cli/src/decisions.ts";
import { resolveScope } from "../../../../platform/dashboard-kit/src/server/groups.ts";
import { providedStore } from "../../provided-store.ts";
import { buildTimeline, placeDecisions, rangeBounds, type Cursor, type TimelineEvent, type TimelineRow, type TimelineView } from "../lib/timeline.ts";

// OS-27: one project's timeline (OS-185: a group's projects together, or one project's) over a range of whole UTC days, read-only. Two reads through the store's orm
// builder: the project's ticket items, and one ranged read of the trail (`event`,
// source ob, type transition or priority_change) for that project's items. lib/timeline.ts buildTimeline does
// the rest. Only getTimeline is exported, so the client build keeps none of the store imports above.

/** Item types that are tickets, as `ob list` counts them. Learnings, references and hunt rows are left out. */
const TICKET_TYPES = ["task", "decision", "roadmap"];

interface TimelineInput {
  team?: string | undefined;
  project?: string | undefined;
  from: string;
  to: string;
  builds?: boolean;
  before?: Cursor | null;
}

async function timelineView(input: TimelineInput): Promise<TimelineView> {
  const store = await providedStore();
  const scope = await resolveScope(store, { team: input.team, project: input.project });
  const [from, to] = input.from <= input.to ? [input.from, input.to] : [input.to, input.from];
  const { since, until } = rangeBounds(from, to);

  const t = store.t;
  const rows = (await store.q
    .select({
      id: t.item.id,
      ref: t.item.ref,
      title: t.item.title,
      type: t.item.type,
      status: t.item.status,
      created_at: t.item.created_at,
      closed_at: t.item.closed_at,
      block_reason: t.item.block_reason,
      project_id: t.item.project_id,
      decided_at: t.decisionDetail.decided_at,
    })
    .from(t.item)
    .leftJoin(t.decisionDetail, eq(t.decisionDetail.item_id, t.item.id))
    .where(and(inArray(t.item.project_id, scope.projectIds), inArray(t.item.type, TICKET_TYPES)))) as TimelineRow[];
  // OS-216: a decision is placed at its decided_at (an imported overnight night), not at its filing.
  const items = placeDecisions(rows);

  const events = (await store.q
    .select({ id: t.event.id, ts: t.event.ts, type: t.event.type, item_id: t.event.item_id, actor: t.event.actor, payload: t.event.payload })
    .from(t.event)
    .innerJoin(t.item, eq(t.item.id, t.event.item_id))
    .where(
      and(
        eq(t.event.source, DECISION_SOURCE),
        inArray(t.event.type, [DECISION_TYPE, PRIORITY_CHANGE_TYPE]),
        gte(t.event.ts, since),
        lte(t.event.ts, until),
        inArray(t.item.project_id, scope.projectIds),
      ),
    )) as TimelineEvent[];

  const builds = input.builds === true;
  return {
    group: scope.group,
    groups: scope.groups,
    project: scope.project,
    from,
    to,
    builds,
    ...buildTimeline(items, events, { from, to, builds, before: input.before ?? null }),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The page's one read: tiles, weekly table and a page of the feed. `before` asks for the page older than it. */
export const getTimeline = createServerFn({ method: "GET" })
  .validator((d: TimelineInput): TimelineInput => {
    if (!d || !DATE.test(d.from) || !DATE.test(d.to)) throw new Error("from and to must be YYYY-MM-DD");
    const b = d.before;
    const before = b && typeof b.at === "string" && typeof b.key === "string" ? { at: b.at, key: b.key } : null;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { team: str(d.team), project: str(d.project), from: d.from, to: d.to, builds: d.builds === true, before };
  })
  .handler(async ({ data }): Promise<TimelineView> => await timelineView(data));
