// OS-179: the refusals a scoped token's writes meet before the handler runs. Each guard reads what the
// request names (an item, a spinoff row, a ticket, an agent, a lease, a team) and answers 404 for anything
// outside the token's projects, worded exactly as the handler's own miss so a hidden row and a missing one
// look the same. Lists are filtered after the handler, in server.ts, with the predicates in scope-filter.ts.
import { getAgent } from "../../../../platform/cli-coord/src/agent.ts";
import { getSpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { normalizeLeaseResource } from "../../../../platform/cli-coord/src/lease.ts";
import { getItem } from "../items.ts";
import { inScope } from "../project-scope.ts";
import type { Store } from "../db/store.ts";
import type { ProjectScope } from "../project-scope.ts";
import { ApiFault } from "./fault.ts";
import { requireItem, requireScopedProject } from "./handlers.ts";
import { agentInScope, itemIdInScope, leaseInScope, refInScope, spinoffRowInScope, teamInScope } from "./scope-filter.ts";

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * An item write: the target item in scope, and for `order` and `links` the other item too. A create, and an
 * edit that moves the item, must name a project in scope; an item with no project is outside every scope,
 * so a scoped token may not make one or clear one's project.
 */
export async function guardItemWrite(store: Store, scope: ProjectScope, id: string | undefined, action: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (id === undefined) {
    const project = str(body, "project");
    if (!project) throw new ApiFault("invalid_request", 400, "'project' is required: an item with no project is outside this token's projects");
    await requireScopedProject(store, scope, project);
    return;
  }
  await requireItem(store, id, { scope });
  const others = action === "order" ? ["before", "after"] : action === "links" ? ["to"] : [];
  for (const k of others) {
    const other = str(body, k);
    if (other) await requireItem(store, other, { scope });
  }
  if (action === "edit" && typeof body.project === "string") {
    if (!body.project.trim()) throw new ApiFault("invalid_request", 400, "'project' cannot be cleared: an item with no project is outside this token's projects");
    await requireScopedProject(store, scope, body.project.trim());
  }
}

async function requireRow(store: Store, scope: ProjectScope, id: number): Promise<void> {
  const row = await getSpinoffRow(store, id);
  if (!row || !(await spinoffRowInScope(store, scope, row))) throw new ApiFault("not_found", 404, `no spinoff #${id}`);
}

async function requireRef(store: Store, scope: ProjectScope, ref: string): Promise<void> {
  if (!(await refInScope(store, scope, ref))) throw new ApiFault("not_found", 404, `no item '${ref}'`);
}

/** A spinoff write: every row id, ticket ref and item it names must be in scope. */
export async function guardSpinoffWrite(store: Store, scope: ProjectScope, op: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (typeof body.id === "number" && Number.isInteger(body.id)) await requireRow(store, scope, body.id);
  const ref = str(body, "ticket_ref");
  if (ref) await requireRef(store, scope, ref);
  const itemId = str(body, "item_id");
  if (op === "serving" && itemId) await requireItem(store, itemId, { scope });
  if (op === "overlap" && Array.isArray(body.refs)) {
    for (const r of body.refs as Array<{ ticket_ref?: unknown; item_id?: unknown }>) {
      if (typeof r?.item_id === "string" && r.item_id) {
        if (!(await itemIdInScope(store, scope, r.item_id))) throw new ApiFault("not_found", 404, `no item '${r.item_id}'`);
      } else if (typeof r?.ticket_ref === "string") await requireRef(store, scope, r.ticket_ref);
    }
  }
  if (op === "overlap" && Array.isArray(body.rows)) {
    for (const r of body.rows as Array<{ row?: unknown }>) if (typeof r?.row === "number") await requireRow(store, scope, r.row);
  }
  if (op === "planned-files" && Array.isArray(body.rows)) {
    for (const r of body.rows as Array<{ id?: unknown }>) if (typeof r?.id === "number") await requireRow(store, scope, r.id);
  }
  if (op === "cleanup-guard") {
    const branch = str(body, "branch");
    const agent = branch ? await getAgent(store, branch) : null;
    if (agent && !(await agentInScope(store, scope, agent))) throw new ApiFault("not_found", 404, `no agent '${branch}'`);
  }
}

/** POST /agents: an existing row must be in scope, and a registration must name a ticket (or team) in scope. */
export async function guardAgentWrite(store: Store, scope: ProjectScope, body: Record<string, unknown>): Promise<void> {
  const id = str(body, "id");
  if (!id) return; // the route's own 400
  const existing = await getAgent(store, id);
  if (existing && !(await agentInScope(store, scope, existing))) throw new ApiFault("not_found", 404, `no agent '${id}'`);
  if (body.action !== "register") return;
  const ticket = str(body, "ticket") ?? existing?.ticket ?? null;
  if (!(await agentInScope(store, scope, { id, ticket }))) throw new ApiFault("not_found", 404, ticket ? `no item '${ticket}'` : `no agent '${id}'`);
}

/** A lease write names its resource; one outside the scope is the same 404 as an unknown one. */
export async function guardLease(store: Store, scope: ProjectScope, resource: string): Promise<void> {
  if (!(await leaseInScope(store, scope, resource))) throw new ApiFault("not_found", 404, `no lease resource '${resource}'`);
}

/** Every /teams/:name route: a team outside the scope is the unknown-team 404. */
export async function guardTeam(store: Store, scope: ProjectScope, name: string): Promise<void> {
  if (!(await teamInScope(store, scope, name))) throw new ApiFault("not_found", 404, `no team '${name}'`);
}

/** GET /decisions/:id: a decision outside the scope is the handler's own miss. */
export async function guardDecision(store: Store, scope: ProjectScope, id: string): Promise<void> {
  const item = await getItem(store, id);
  if (item && !inScope(scope, item.project_id)) throw new ApiFault("not_found", 404, `decision '${id}' does not exist`);
}

/**
 * The one entry point server.ts calls for a scoped request, before routing. The gate has already admitted
 * only marked routes, so this only has to refuse what names something outside the scope. `peek` reads the
 * body without consuming it, so the route still reads it (stamped with the token's user) afterwards.
 */
export async function guardScopedRequest(
  store: Store,
  scope: ProjectScope,
  method: string,
  segments: readonly string[],
  peek: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const [head, second, third] = segments;
  if (head === "items" && method === "POST") return guardItemWrite(store, scope, second, third, await peek());
  if (head === "agents" && method === "POST" && segments.length === 1) return guardAgentWrite(store, scope, await peek());
  if (head === "leases" && method === "POST" && segments.length === 1) {
    const resource = str(await peek(), "resource");
    if (resource) await guardLease(store, scope, normalizeLeaseResource(resource));
    return;
  }
  if (head === "leases" && method === "DELETE" && second !== undefined) return guardLease(store, scope, normalizeLeaseResource(second));
  if (head === "spinoffs" && method === "POST") return guardSpinoffWrite(store, scope, second, await peek());
  if (head === "teams" && second !== undefined) return guardTeam(store, scope, second);
  if (head === "decisions" && second !== undefined && method === "GET") return guardDecision(store, scope, second);
}
