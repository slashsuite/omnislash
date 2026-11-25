import type { ChangeEvent } from "react";
import { Select } from "@slashsuite/ui-react";
import type { GroupProject, ProjectGroup } from "../../../../platform/dashboard-kit/src/server/groups.ts";

// OS-185: the Queue and Timeline pages open on a group (a team, or Other) and drill into one of its projects only
// when asked. Two Selects: the group, and "All projects" or one project in it. Both live in the URL
// (`?team=slash&project=omnislash`); a new group drops the project, since it is not in that group.

const ALL_PROJECTS = "";

export type GroupSearch = { team?: string; project?: string };

export function GroupPicker({
  group,
  groups,
  project,
  onChange,
}: {
  group: ProjectGroup;
  groups: ProjectGroup[];
  project: GroupProject | null;
  onChange: (next: GroupSearch) => void;
}) {
  return (
    <>
      <Select
        aria-label="Group"
        size="sm"
        value={group.id}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange({ team: e.target.value, project: undefined })}
        items={groups.map((g) => ({ value: g.id, label: g.label }))}
      />
      <Select
        aria-label="Project"
        size="sm"
        value={project?.id ?? ALL_PROJECTS}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange({ team: group.id, project: e.target.value || undefined })}
        items={[{ value: ALL_PROJECTS, label: "All projects" }, ...group.projects.map((p) => ({ value: p.id, label: p.label }))]}
      />
    </>
  );
}

/** The two search params, kept only when they are non-empty strings. */
export function groupSearch(s: Record<string, unknown>): GroupSearch {
  return {
    ...(typeof s.team === "string" && s.team ? { team: s.team } : {}),
    ...(typeof s.project === "string" && s.project ? { project: s.project } : {}),
  };
}
