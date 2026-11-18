import { decisionsForItem, renderDecision } from "../decisions.ts";
import { type Ctx, requireItem } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { getFocusProject } from "../config.ts";
import {
  getDetail,
  getItem,
  getLinearRef,
  getLinks,
  getTags,
  getTaskDetail,
  type ItemRow,
} from "../items.ts";
import { triageBanner } from "./triage.ts";
import { parseGithubIssueUrl } from "../tracker-link.ts";
import { parsePriority, PRIORITY_OPTIONS } from "../priority.ts";
import { itemView, print, renderItems } from "../output.ts";
import { searchItemIds } from "../search.ts";
import { aliasesOf } from "../refs.ts";
import { listWorklist, nextWorklist, type ItemSort } from "../worklist.ts";

async function focus(ctx: Ctx): Promise<string | null> {
  return getFocusProject(ctx.store ?? ctx.db);
}

export async function cmdList(ctx: Ctx): Promise<void> {
  const { flags, db } = ctx;
  let priority: number | undefined;
  if (flags.priority) {
    const want = parsePriority(flags.priority);
    if (want === null) throw new UsageError(`invalid --priority '${flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
    priority = want;
  }
  let limit: number | undefined;
  if (flags.limit) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`invalid --limit '${flags.limit}'`);
    limit = n;
  }
  // 352: the filtering, the project-name resolution, the ordering and the cap all live in worklist.ts
  // now, so `ob list` and `GET /api/ob/items` cannot answer the same question two ways.
  const { items, focusProject } = await listWorklist(ctx.store ?? db, {
    open: flags.open,
    status: flags.status,
    type: flags.type,
    // `--repo` is an alias for `--project`; if both differ, --repo wins.
    project: flags.repo ?? flags.project,
    team: flags.team,
    tag: flags.tag ? flags.tag[flags.tag.length - 1] : undefined,
    kind: flags.kind,
    priority,
    since: flags.since,
    updatedAfter: flags["updated-after"],
    by: flags.by as ItemSort | undefined,
    limit,
  });
  print(renderItems(items.map((i) => itemView(i, focusProject)), ctx.mode));
}

export async function cmdNext(ctx: Ctx): Promise<void> {
  // OB-2083: `--project` (or its alias `--repo`) shows one project's queue, the dispatch order for that repo.
  const { items, focusProject, triageCount: triage } = await nextWorklist(ctx.store ?? ctx.db, {
    project: ctx.flags.repo ?? ctx.flags.project,
  });
  // Triage-inbox banner near the top (human/table only; json/quiet stay machine-clean).
  if (ctx.mode === "human" || ctx.mode === "table") {
    const banner = triageBanner(triage);
    if (banner) print(banner);
  }
  print(renderItems(items.map((i) => itemView(i, focusProject)), ctx.mode));
}

export async function cmdShow(ctx: Ctx): Promise<void> {
  let id = ctx.args[0];
  if (!id) throw new UsageError("show requires an <id>");
  const item = await requireItem(ctx, id);
  id = item.id;
  const focusProject = await focus(ctx);
  const view = itemView(item, focusProject);
  const store = ctx.store ?? ctx.db;
  const tags = await getTags(store, id);
  const links = await getLinks(store, id);
  const linear = await getLinearRef(store, id);
  const taskDetail = item.type === "task" ? await getTaskDetail(store, id) : null;
  const detail = await getDetail(store, item.type, id);
  const decisions = await decisionsForItem(store, id);
  const aliases = await aliasesOf(store, id);

  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        {
          ...view,
          aliases,
          body: item.body,
          tags,
          links,
          linear,
          task_detail: taskDetail,
          detail,
          events: [],
          decisions,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(item.ref ?? id);
    return;
  }

  const lines: string[] = [];
  lines.push(`${item.ref ?? item.id}  ${item.title}`);
  // 1949: the legacy number stays the item's id, and a move leaves its old refs behind as aliases.
  if (item.ref) lines.push(`  id:        ${item.id}`);
  if (aliases.length > 0) lines.push(`  was:       ${aliases.join(", ")}`);
  lines.push(`  type:      ${item.type}`);
  lines.push(`  status:    ${item.status}`);
  lines.push(`  priority:  ${view.effective_priority}${view.priority ? " (explicit)" : " (derived)"}`);
  lines.push(`  project:   ${item.project_id ?? "-"}${item.project_kind ? ` (${item.project_kind})` : ""}`);
  if (item.today_rank !== null) lines.push(`  today:     rank ${item.today_rank}`);
  if (item.queue_rank !== null) lines.push(`  queue:     rank ${item.queue_rank}`);
  if (item.status === "blocked") {
    lines.push(`  blocked:   ${item.block_reason ?? "-"}${item.block_owner ? ` (owner: ${item.block_owner})` : ""}`);
  }
  lines.push(`  created:   ${item.created_at}`);
  lines.push(`  updated:   ${item.updated_at}`);
  if (item.closed_at) lines.push(`  closed:    ${item.closed_at}`);
  if (tags.length > 0) lines.push(`  tags:      ${tags.join(", ")}`);
  // A GitHub issue link lives in the same ref row (77); label it for what it is so the two trackers
  // are legible here, instead of a GitHub URL reading as a `linear:` ref.
  const issueRef = linear ? parseGithubIssueUrl(linear.url) : null;
  if (issueRef) lines.push(`  issue:     #${issueRef.number}  ${linear!.url}`);
  else if (linear && linear.url) lines.push(`  linear:    ${linear.linear_id ?? "?"}  ${linear.url}`);
  if (detail) {
    for (const [k, v] of Object.entries(detail)) {
      if (k === "item_id" || v === null || v === undefined || v === "") continue;
      lines.push(`  ${k.padEnd(9)}: ${String(v)}`);
    }
  }
  for (const l of links) {
    const arrow = l.direction === "out" ? "->" : "<-";
    lines.push(`  link:      ${arrow} ${l.rel_type} ${l.other}`);
  }
  if (item.body) {
    lines.push("  body:");
    for (const bl of item.body.split("\n")) lines.push(`    ${bl}`);
  }
  if (decisions.length > 0) {
    lines.push("  Decisions:");
    for (const d of decisions) lines.push(`    ${renderDecision(d)}`);
  }
  print(lines.join("\n"));
}

export async function cmdSearch(ctx: Ctx): Promise<void> {
  const q = ctx.args.join(" ").trim();
  if (q.length === 0) throw new UsageError("search requires a <query>");
  let ids: string[];
  try {
    // 337: the fts5 MATCH is unchanged for SQLite; in postgres mode this runs ob 322's tsquery
    // translator against the generated search_vec column instead. See src/search.ts for why the two
    // engines do not, and should not, match identically.
    ids = await searchItemIds(ctx.store ?? ctx.db, q);
  } catch {
    throw new AppError(`invalid search query: ${q}`);
  }
  const focusProject = await focus(ctx);
  const items: ItemRow[] = [];
  for (const id of ids) {
    const it = await getItem(ctx.store ?? ctx.db, id);
    if (it) items.push(it);
  }
  print(renderItems(items.map((i) => itemView(i, focusProject)), ctx.mode));
}
