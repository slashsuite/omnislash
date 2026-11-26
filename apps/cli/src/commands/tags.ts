// OS-216: `ob tags [--project <name>]`, every tag in use with its count, most used first. The tags are read from
// the items themselves, never a fixed list. The printing lives here once; the local command and the API client
// differ only in where the counts come from.
import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { tagCounts, type TagCount } from "../items.ts";
import { print, type Mode } from "../output.ts";
import { getProject } from "../project.ts";

export function renderTagCounts(rows: readonly TagCount[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(rows, null, 2);
  if (mode === "quiet") return rows.map((r) => r.tag).join("\n");
  if (rows.length === 0) return "no tags in use";
  const width = String(rows[0]!.count).length;
  return rows.map((r) => `${String(r.count).padStart(width)}  ${r.tag}`).join("\n");
}

export async function runTags(
  ctx: { flags: Record<string, unknown>; mode: Mode },
  load: (project: string | undefined) => Promise<TagCount[]>,
): Promise<void> {
  const flag = ctx.flags.repo ?? ctx.flags.project;
  print(renderTagCounts(await load(typeof flag === "string" ? flag : undefined), ctx.mode));
}

export async function cmdTags(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  await runTags({ flags: ctx.flags as Record<string, unknown>, mode: ctx.mode }, async (project) => {
    if (project === undefined) return await tagCounts(store);
    const p = await getProject(store, project);
    // An unknown project is an error, not an empty list that reads as "no tags".
    if (!p) throw new AppError(`no project '${project}'`);
    return await tagCounts(store, { projectIds: [p.id] });
  });
}
