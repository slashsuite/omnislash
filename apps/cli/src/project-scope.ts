// OS-178: the projects a scoped API token reaches, resolved once per request.
//
// A scope is the set of project IDS its names resolve to (a name that matches no project is simply not in
// it). The item reads take it as `allowedProjects`: an item outside it is filtered from lists and is a 404
// on its own, so a scoped user cannot tell a disallowed item from one that does not exist.
import type { Database } from "bun:sqlite";
import type { Store } from "./db/store.ts";
import { listProjects } from "./project.ts";

export interface ProjectScope {
  /** Project ids the principal may read. */
  ids: ReadonlySet<string>;
}

export async function projectScopeFor(db: Database | Store, names: readonly string[]): Promise<ProjectScope> {
  const wanted = new Set(names);
  const ids = new Set<string>();
  for (const p of await listProjects(db)) if (wanted.has(p.name) || wanted.has(p.id)) ids.add(p.id);
  return { ids };
}

/** Whether an item's project is inside the scope. No scope is everything; a project-less item is outside any scope. */
export function inScope(scope: ProjectScope | undefined, projectId: string | null): boolean {
  if (!scope) return true;
  return projectId !== null && scope.ids.has(projectId);
}
