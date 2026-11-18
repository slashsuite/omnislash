import type { Database } from "bun:sqlite";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Ctx, emitItem, requireItem } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { addLink, getRoadmapDetail, queryItems } from "../items.ts";
import { emitId, print } from "../output.ts";
import { asStore, type Store } from "../db/store.ts";
import { item, itemLink } from "../db/schema.ts";

/** Item statuses that count a member as "done" for roadmap progress. */
const DONE_STATUSES = new Set(["done", "archived", "merged"]);

export interface RoadmapMember {
  id: string;
  status: string;
  title: string;
  closed_at: string | null;
  position: number | null;
}

export interface Progress {
  done: number;
  total: number;
  fraction: number;
}

export type Verdict = "ahead" | "on_track" | "behind" | "no_target";

export interface OnTrack {
  verdict: Verdict;
  elapsedFraction: number | null;
}

/** Pure: count members that are done/closed over the total. */
export function computeProgress(members: { status: string; closed_at: string | null }[]): Progress {
  const total = members.length;
  const done = members.filter(
    (m) => DONE_STATUSES.has(m.status) || m.closed_at !== null,
  ).length;
  return { done, total, fraction: total > 0 ? done / total : 0 };
}

/**
 * Pure: compare how far the roadmap has progressed against how much of its
 * timeline has elapsed. Ahead/behind is judged with a small tolerance band so a
 * roadmap that is roughly on pace reads as `on_track` rather than flapping.
 */
export function onTrack(
  progressFraction: number,
  createdAt: string,
  targetDate: string | null,
  now: Date,
): OnTrack {
  if (!targetDate) return { verdict: "no_target", elapsedFraction: null };
  const created = new Date(createdAt).getTime();
  const target = new Date(targetDate).getTime();
  const nowMs = now.getTime();
  const span = target - created;
  let elapsed = span > 0 ? (nowMs - created) / span : nowMs >= target ? 1 : 0;
  if (elapsed < 0) elapsed = 0;
  const TOLERANCE = 0.05;
  let verdict: Verdict;
  if (progressFraction > elapsed + TOLERANCE) verdict = "ahead";
  else if (progressFraction >= elapsed - TOLERANCE) verdict = "on_track";
  else verdict = "behind";
  return { verdict, elapsedFraction: elapsed };
}

/** Members of a roadmap, ordered by link position (NULLs last) then numeric id. */
export async function getRoadmapMembers(db: Database | Store, roadmapId: string): Promise<RoadmapMember[]> {
  const s = asStore(db);
  // The `position is null` leading key is what makes NULLS-last explicit, and it is why this ordering
  // survives the engine change (337): a bare `ORDER BY position` puts NULLs LAST on SQLite and FIRST on
  // Postgres, so an unpositioned member would jump to the top of the roadmap. Ordering by the boolean
  // first pins it either way, since false sorts before true on both.
  return (await s.q
    .select({
      id: s.t.item.id,
      status: s.t.item.status,
      title: s.t.item.title,
      closed_at: s.t.item.closed_at,
      position: s.t.itemLink.position,
    })
    .from(s.t.itemLink)
    .innerJoin(s.t.item, eq(s.t.item.id, s.t.itemLink.fromItem))
    .where(and(eq(s.t.itemLink.relType, "roadmap_member"), eq(s.t.itemLink.toItem, roadmapId)))
    .orderBy(sql`${s.t.itemLink.position} is null`, asc(s.t.itemLink.position), sql`CAST(${s.t.item.id} AS INTEGER)`)) as RoadmapMember[];
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

async function listRoadmaps(ctx: Ctx): Promise<void> {
  const { mode } = ctx;
  const db = ctx.store ?? ctx.db;
  const roadmaps = await queryItems(db, { type: "roadmap" });
  const rows = await Promise.all(roadmaps.map(async (r) => {
    const progress = computeProgress(await getRoadmapMembers(db, r.id));
    return { id: r.id, status: r.status, title: r.title, progress };
  }));

  if (mode === "json") {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (mode === "quiet") {
    print(rows.map((r) => r.id).join("\n"));
    return;
  }
  print(renderRoadmapList(rows));
}

async function showRoadmap(ctx: Ctx, id: string): Promise<void> {
  const { mode } = ctx;
  const db = ctx.store ?? ctx.db;
  const item = await requireItem(ctx, id);
  id = item.id;
  if (item.type !== "roadmap") throw new UsageError(`item '${id}' is not a roadmap`);
  const detail = await getRoadmapDetail(db, id);
  const targetDate = (detail?.target_date as string | null | undefined) ?? null;
  const members = await getRoadmapMembers(db, id);
  const progress = computeProgress(members);
  const track = onTrack(progress.fraction, item.created_at, targetDate, new Date());

  if (mode === "json") {
    print(
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
          status: item.status,
          created_at: item.created_at,
          target_date: targetDate,
          source_ref: (detail?.source_ref as string | null | undefined) ?? null,
          owner: (detail?.owner as string | null | undefined) ?? null,
          body: item.body,
          members,
          progress,
          on_track: track,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "quiet") {
    print(members.map((m) => m.id).join("\n"));
    return;
  }

  const lines: string[] = [];
  lines.push(`${item.id}  ${item.title}`);
  lines.push(`  status:      ${item.status}`);
  if (targetDate) lines.push(`  target:      ${targetDate}`);
  if (detail?.source_ref) lines.push(`  source-ref:  ${String(detail.source_ref)}`);
  if (detail?.owner) lines.push(`  owner:       ${String(detail.owner)}`);
  lines.push(
    `  progress:    ${progress.done}/${progress.total} (${pct(progress.fraction)})`,
  );
  const trackLine =
    track.verdict === "no_target"
      ? "no target date"
      : `${track.verdict} (elapsed ${pct(track.elapsedFraction ?? 0)})`;
  lines.push(`  on-track:    ${trackLine}`);
  if (members.length > 0) {
    lines.push("  members:");
    for (const m of members) {
      const marker = DONE_STATUSES.has(m.status) || m.closed_at !== null ? "x" : " ";
      lines.push(`    [${marker}] ${m.id}\t${m.status.padEnd(9)}\t${m.title}`);
    }
  }
  print(lines.join("\n"));
}

async function addMember(ctx: Ctx): Promise<void> {
  let [, roadmapId, itemId, positionArg] = ctx.args;
  if (!roadmapId || !itemId) {
    throw new UsageError("roadmap add requires <roadmapId> <itemId> [position]");
  }
  const s = asStore(ctx.store ?? ctx.db);
  const roadmap = await requireItem(ctx, roadmapId);
  roadmapId = roadmap.id;
  if (roadmap.type !== "roadmap") throw new UsageError(`item '${roadmapId}' is not a roadmap`);
  itemId = (await requireItem(ctx, itemId)).id;
  await addLink(s, itemId, "roadmap_member", roadmapId);
  if (positionArg !== undefined) {
    const position = Number(positionArg);
    if (!Number.isInteger(position)) throw new UsageError(`invalid position '${positionArg}'`);
    await s.q
      .update(s.t.itemLink)
      .set({ position })
      .where(
        and(
          eq(s.t.itemLink.fromItem, itemId),
          eq(s.t.itemLink.toItem, roadmapId),
          eq(s.t.itemLink.relType, "roadmap_member"),
        ),
      );
  }
  await emitItem(ctx, itemId);
}

export function renderRoadmapList(rows: Array<{ id: string; status: string; title: string; progress: Progress }>): string {
  return rows
    .map((r) => `${r.id}\t${r.status.padEnd(9)}\t${r.title}\t(${r.progress.done}/${r.progress.total})`)
    .join("\n");
}

export async function cmdRoadmap(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === undefined || sub === "list") {
    await listRoadmaps(ctx);
    return;
  }
  if (sub === "add") {
    await addMember(ctx);
    return;
  }
  await showRoadmap(ctx, sub);
}
