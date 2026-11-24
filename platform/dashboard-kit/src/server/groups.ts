// OS-185: the dashboard's project groups. Jacobus reads most of the dashboard by group, not by project, and drills
// into one project only when he wants to. A group is a team (`ob t3 team`): every project carries its team_name.
// Projects in no team sit under one "Other" group. A team with no projects has nothing to show and is left out.
// Read-only.

import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { getFocusProject } from "../../../../apps/cli/src/config.ts";
import { listProjects } from "../../../../apps/cli/src/project.ts";
import { listTeams } from "../../../../apps/cli/src/team.ts";

/** The group of the projects in no team. Not a team name `ob t3 team add` could also take: it is listed last, and a real team called `other` wins. */
export const OTHER_GROUP = "other";
/** The group a page opens on when the URL names none and the focus project is in no group. */
export const DEFAULT_GROUP = "slash";

export interface GroupProject {
  id: string;
  label: string;
}

export interface ProjectGroup {
  /** The team name, or OTHER_GROUP. What `?team=` carries. */
  id: string;
  /** `<icon> <display name or name>`, as the team's thread titles read. */
  label: string;
  projects: GroupProject[];
}

export interface GroupScope {
  groups: ProjectGroup[];
  group: ProjectGroup;
  /** The project drilled into, or null for the whole group. */
  project: GroupProject | null;
  /** The projects the page reads: the one drilled into, else every project in the group. */
  projectIds: string[];
}

/** Every group with at least one project, the teams by name and Other last. */
export async function projectGroups(store: Store): Promise<ProjectGroup[]> {
  const [teams, projects] = await Promise.all([listTeams(store), listProjects(store)]);
  const label = (p: { name: string; display_name: string | null }) => p.display_name ?? p.name;
  const groups: ProjectGroup[] = teams.map((t) => ({
    id: t.name,
    label: `${t.icon?.trim() ? `${t.icon.trim()} ` : ""}${t.display_name?.trim() || t.name}`,
    projects: [],
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const other: ProjectGroup = { id: OTHER_GROUP, label: "Other", projects: [] };
  for (const p of projects) (byId.get(p.team_name ?? "") ?? other).projects.push({ id: p.id, label: label(p) });
  for (const g of groups) g.projects.sort((a, b) => a.label.localeCompare(b.label));
  other.projects.sort((a, b) => a.label.localeCompare(b.label));
  return [...groups, ...(byId.has(OTHER_GROUP) ? [] : [other])].filter((g) => g.projects.length > 0);
}

/**
 * What a page shows for `?team=` and `?project=`. A project names its own group, so an old `?project=` link still
 * opens (on that project, inside its group), and a team that does not hold the named project gives way to it. No
 * project: the named team, else the focus project's group, else Slash, else the first. An unknown project is
 * refused, since an empty page for a typo reads as "nothing here"; an unknown team falls back to the default.
 */
export async function resolveScope(store: Store, ask: { team?: string; project?: string }): Promise<GroupScope> {
  const groups = await projectGroups(store);
  if (groups.length === 0) throw new AppError("no projects yet (ob project add)");
  const groupOf = (projectId: string) => groups.find((g) => g.projects.some((p) => p.id === projectId));

  if (ask.project !== undefined) {
    // By id, or by its name or label as `ob next --project` takes either.
    for (const g of groups) {
      const p = g.projects.find((x) => x.id === ask.project || x.label === ask.project);
      if (p) return { groups, group: g, project: p, projectIds: [p.id] };
    }
    throw new AppError(`no project '${ask.project}'`);
  }

  const focus = await getFocusProject(store);
  const group =
    (ask.team !== undefined ? groups.find((g) => g.id === ask.team) : undefined) ??
    (focus ? groupOf(focus) : undefined) ??
    groups.find((g) => g.id === DEFAULT_GROUP) ??
    groups[0]!;
  return { groups, group, project: null, projectIds: group.projects.map((p) => p.id) };
}
