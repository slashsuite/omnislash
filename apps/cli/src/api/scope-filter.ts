// OS-179: which rows a scoped API token reaches beyond items: spinoff rows, agents, leases and teams.
//
// Every rule ends at an item's project. A spinoff row is in scope when its ticket's item is; a builder agent
// when its ticket is; a team role agent when its team is; a lease when the ticket, worktree or row it names
// is. A team is in scope when it has projects and every one of them is in scope. Anything that names no
// item (a machine slot such as `cpu:browser`, an agent with no ticket) is outside every scope, so a scoped
// token cannot see it or write to it. Out of scope reads exactly like missing: the callers answer 404.
import { ticketItemIdFor } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import { leaseKeyClass, worktreeLeaseKey } from "../../../../platform/cli-coord/src/lease.ts";
import { listAgents, type AgentRow } from "../../../../platform/cli-coord/src/agent.ts";
import { getSpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import type { Store } from "../db/store.ts";
import { getItem } from "../items.ts";
import { listProjects } from "../project.ts";
import { inScope, type ProjectScope } from "../project-scope.ts";
import { isTeamRoleAgent } from "../team.ts";

export async function itemIdInScope(store: Store, scope: ProjectScope, itemId: string | null | undefined): Promise<boolean> {
  if (!itemId) return false;
  const item = await getItem(store, itemId);
  return item !== null && inScope(scope, item.project_id);
}

/** A ticket ref (`OS-12`, an item id, an issue number) is in scope when the item it resolves to is. */
export async function refInScope(store: Store, scope: ProjectScope, ref: string | null | undefined): Promise<boolean> {
  const r = ref?.trim();
  if (!r) return false;
  return itemIdInScope(store, scope, await ticketItemIdFor(store, r));
}

/** The recorded item wins; a row queued before it was recorded falls back to its ticket ref. */
export async function spinoffRowInScope(store: Store, scope: ProjectScope, row: { ticket_ref: string; item_id?: string | null }): Promise<boolean> {
  if (row.item_id) return itemIdInScope(store, scope, row.item_id);
  return refInScope(store, scope, row.ticket_ref);
}

/** A team with no projects belongs to nobody's scope; otherwise every one of its projects must be in it. */
export async function teamInScope(store: Store, scope: ProjectScope, name: string): Promise<boolean> {
  const members = (await listProjects(store)).filter((p) => p.team_name === name);
  return members.length > 0 && members.every((p) => scope.ids.has(p.id));
}

/** The team of a team role agent id (`sentinel-slash` is `slash`). */
function roleAgentTeam(id: string): string {
  return id.slice(id.indexOf("-") + 1);
}

export async function agentInScope(store: Store, scope: ProjectScope, row: Pick<AgentRow, "id" | "ticket">): Promise<boolean> {
  if (isTeamRoleAgent(row.id)) return teamInScope(store, scope, roleAgentTeam(row.id));
  return refInScope(store, scope, row.ticket);
}

/**
 * A lease is in scope when what it names is: a `ticket:` key its ticket, a `spinoff:<id>` key its row, a
 * `worktree:` key the agent registered on that worktree. A key naming none of those is a machine slot and in
 * no scope.
 */
export async function leaseInScope(store: Store, scope: ProjectScope, resource: string): Promise<boolean> {
  const cls = leaseKeyClass(resource);
  const value = resource.slice(resource.indexOf(":") + 1);
  if (cls === "ticket") return refInScope(store, scope, value);
  if (cls === "spinoff") {
    const id = Number(/^\d+/.exec(value)?.[0]);
    const row = Number.isInteger(id) ? await getSpinoffRow(store, id) : null;
    return row !== null && spinoffRowInScope(store, scope, row);
  }
  if (cls === "worktree") {
    for (const agent of await listAgents(store, { includeExpired: true })) {
      if (agent.worktree && worktreeLeaseKey(agent.worktree) === resource) return agentInScope(store, scope, agent);
    }
    return false;
  }
  return false;
}

/** Keep the rows `keep` admits, in order. */
export async function filterAsync<T>(rows: readonly T[], keep: (row: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) if (await keep(row)) out.push(row);
  return out;
}

/** A repo-keyed config map, kept to the repos of the scope's projects (keyed by a project's id or name). */
export async function reposInScope(store: Store, scope: ProjectScope, map: Record<string, string>): Promise<Record<string, string>> {
  const keys = new Set<string>();
  for (const p of await listProjects(store)) if (scope.ids.has(p.id)) keys.add(p.id).add(p.name);
  return Object.fromEntries(Object.entries(map).filter(([repo]) => keys.has(repo)));
}
