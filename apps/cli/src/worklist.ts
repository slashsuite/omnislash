// ob 352 -- the worklist and the item query, as ONE core that both the CLI and the API call.
//
// `ob next` and `ob list` are the two reads the whole tracker is judged on, and until now their ordering
// and filtering lived inside the command handlers, next to the printing. An API that re-implemented
// either would have produced a worklist that was ALMOST the same as the terminal's -- the same items in a
// slightly different order, which is precisely the kind of difference nobody notices and everybody acts
// on. So the ordering moved here, the handlers call it, and there is one answer to "what is next".
//
// Pure over a Store: no printing, no flags, no argv. The CLI converts flags into `ItemQuery`; the API
// validates JSON into the same shape.
import type { Database } from "bun:sqlite";
import type { Store } from "./db/store.ts";
import { AppError } from "./errors.ts";
import { getFocusProject } from "./config.ts";
import { queryItems, triageCount, triageCountIn, type ItemRow } from "./items.ts";
import { getProject, listProjects } from "./project.ts";
import { teamMembersIn, listTeams } from "./team.ts";
import { effectivePriority, kindRank, prioritySortRank } from "./priority.ts";

export type ItemSort = "priority" | "created" | "updated";

/** The `ob list` query, as values. `project` is an id OR a name; the name map is resolved here. */
export interface ItemQuery {
  open?: boolean;
  status?: string;
  type?: string;
  project?: string;
  /** OB-2255: only items in the team's member projects; an unknown team throws `UnknownTeamError`. */
  team?: string;
  tag?: string;
  kind?: string;
  /** An already-parsed priority integer (0-6, where 5 is `flake` and 6 is `critical`). Parsing the NAME belongs to the caller's validator. */
  priority?: number;
  since?: string;
  updatedAfter?: string;
  by?: ItemSort;
  limit?: number;
}

export interface WorklistResult {
  items: ItemRow[];
  /** The focus project the effective priorities were computed against -- returned so a caller renders
   *  the same numbers this sort used, instead of reading the config a second time and possibly later. */
  focusProject: string | null;
}

export interface NextResult extends WorklistResult {
  triageCount: number;
}

function effOf(item: ItemRow, focusProject: string | null): number {
  return effectivePriority({ priority: item.priority, projectId: item.project_id, focusProject });
}

/** OB-2083: ranked items first, ascending; unranked ones after, so a rank pins an item above "recently touched". */
function compareQueueRank(a: ItemRow, b: ItemRow): number {
  const ar = a.queue_rank ?? Number.POSITIVE_INFINITY;
  const br = b.queue_rank ?? Number.POSITIVE_INFINITY;
  if (ar === br) return 0;
  return ar < br ? -1 : 1;
}

/**
 * The order inside ONE priority band of one project: kind, queue rank (ranked first), recency, id. It is
 * `sortWorklist` minus Today and the band itself, which is what `setQueueOrder` numbers from: the queue
 * is independent of today's focus.
 */
export function compareWithinBand(a: ItemRow, b: ItemRow): number {
  const kr = kindRank(a.project_kind) - kindRank(b.project_kind);
  if (kr !== 0) return kr;
  const qr = compareQueueRank(a, b);
  if (qr !== 0) return qr;
  const ur = b.updated_at.localeCompare(a.updated_at);
  if (ur !== 0) return ur;
  return a.id.localeCompare(b.id);
}

/**
 * The worklist order (`ob next`): a ranked Today item first, then effective priority, then kind, then the
 * queue rank (OB-2083, ranked before unranked), then recency. Every comparison is total and every tie is broken, so two calls a millisecond apart return the
 * same order -- an unstable worklist is a worklist nobody can act down.
 */
export function sortWorklist(items: ItemRow[], focusProject: string | null): ItemRow[] {
  return [...items].sort((a, b) => {
    const ar = a.today_rank ?? Number.POSITIVE_INFINITY;
    const br = b.today_rank ?? Number.POSITIVE_INFINITY;
    if (ar !== br) return ar - br;
    const pr = prioritySortRank(effOf(a, focusProject)) - prioritySortRank(effOf(b, focusProject));
    if (pr !== 0) return pr;
    return compareWithinBand(a, b);
  });
}

/** The `ob list` order. Same tie-breaking rule and the same reason. */
export function sortItems(items: ItemRow[], focusProject: string | null, by: ItemSort): ItemRow[] {
  return [...items].sort((a, b) => {
    if (by === "priority") {
      const r = prioritySortRank(effOf(a, focusProject)) - prioritySortRank(effOf(b, focusProject));
      if (r !== 0) return r;
      const ur = b.updated_at.localeCompare(a.updated_at);
      if (ur !== 0) return ur;
      return a.id.localeCompare(b.id);
    }
    if (by === "created") {
      const r = b.created_at.localeCompare(a.created_at);
      if (r !== 0) return r;
      return a.id.localeCompare(b.id);
    }
    const r = b.updated_at.localeCompare(a.updated_at);
    if (r !== 0) return r;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The worklist: open items in `ob next` order, plus the triage-inbox count the banner reports. `project`
 * (a name or id, OB-2083) narrows it to one project's queue; an unknown one is an error, since an
 * empty queue for a typo would read as "nothing to do".
 */
export async function nextWorklist(db: Database | Store, opts: { project?: string; allowedProjects?: ReadonlySet<string> } = {}): Promise<NextResult> {
  const focusProject = await getFocusProject(db);
  let projectId: string | undefined;
  // `!== undefined`, not truthiness: `--project "$SLUG"` with an empty variable must error, not print every project's queue.
  if (opts.project !== undefined) {
    const p = await getProject(db, opts.project);
    if (!p) throw new AppError(`no project '${opts.project}' (see: ob project list)`);
    projectId = p.id;
  }
  let items = await queryItems(db, { open: true, projectId });
  // OS-178: a scoped API token sees only its projects, its triage count included.
  const allowed = opts.allowedProjects;
  if (allowed) items = items.filter((i) => i.project_id !== null && allowed.has(i.project_id));
  return {
    items: sortWorklist(items, focusProject),
    focusProject,
    triageCount: allowed ? await triageCountIn(db, allowed) : await triageCount(db),
  };
}

/** The `ob list` read: filter, resolve the project name, sort, cap. */
export async function listWorklist(db: Database | Store, query: ItemQuery, opts: { allowedProjects?: ReadonlySet<string> } = {}): Promise<WorklistResult> {
  let projectId: string | undefined;
  if (query.project) {
    const p = await getProject(db, query.project);
    // An unknown name is passed THROUGH rather than rejected: `ob list --project foo` has always matched
    // a raw project_id, and a filter that silently matched everything would be worse than one that
    // matches nothing.
    projectId = p ? p.id : query.project;
  }
  let items = await queryItems(db, {
    open: query.open,
    status: query.status,
    type: query.type,
    projectId,
    tag: query.tag,
    since: query.since,
    updatedAfter: query.updatedAfter,
  });
  const allowed = opts.allowedProjects;
  if (allowed) items = items.filter((i) => i.project_id !== null && allowed.has(i.project_id));
  if (query.kind) items = items.filter((i) => i.project_kind === query.kind);
  if (query.team) {
    const members = new Set(teamMembersIn(query.team, (await listTeams(db)).map((t) => t.name), await listProjects(db)).map((p) => p.id));
    items = items.filter((i) => i.project_id !== null && members.has(i.project_id));
  }
  const focusProject = await getFocusProject(db);
  if (query.priority !== undefined) {
    items = items.filter((i) => effOf(i, focusProject) === query.priority);
  }
  items = sortItems(items, focusProject, query.by ?? "updated");
  if (query.limit !== undefined) items = items.slice(0, query.limit);
  return { items, focusProject };
}
