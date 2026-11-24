import { type Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { deleteConfig, getFocusProject, setConfig } from "../config.ts";
import { getProject } from "../project.ts";
import { emitId, print } from "../output.ts";
import { parsePriority, priorityName, PRIORITY_OPTIONS } from "../priority.ts";
import { requireItem } from "../ctx.ts";
import { decisionOptsOf } from "../decisions.ts";
import { clearTodayRank, setQueueOrder, setTodayRank, type QueueMove } from "../workflow.ts";

export async function cmdToday(ctx: Ctx): Promise<void> {
  const id = ctx.args[0];
  if (ctx.flags.clear && !id) {
    await clearTodayRank(ctx.store ?? ctx.db);
    print("cleared today");
    return;
  }
  if (!id) throw new UsageError("today requires an <id> (or --clear)");
  if (ctx.flags.clear) {
    await clearTodayRank(ctx.store ?? ctx.db, id);
    emitId(ctx, id);
    return;
  }
  let rank: number | undefined;
  if (ctx.flags.rank !== undefined) {
    const n = Number(ctx.flags.rank);
    if (!Number.isInteger(n)) throw new UsageError(`invalid --rank '${ctx.flags.rank}'`);
    rank = n;
  }
  await setTodayRank(ctx.store ?? ctx.db, id, rank);
  emitId(ctx, id);
}

export async function cmdFocus(ctx: Ctx): Promise<void> {
  if (ctx.flags.clear) {
    await deleteConfig(ctx.store ?? ctx.db, "focus_project");
    if (ctx.mode === "json") print(JSON.stringify({ focus_project: null, cleared: true }));
    else print("cleared focus");
    return;
  }
  const name = ctx.args[0];
  if (!name) {
    const current = await getFocusProject(ctx.store ?? ctx.db);
    // "no focus set" is an EMPTY RESULT, not an absence of output: `ob focus --json` used to print
    // nothing at all and exit 0, so a scripted reader got a JSON parse error blamed on itself (149).
    if (ctx.mode === "json") print(JSON.stringify({ focus_project: current ?? null }));
    else print(current ?? "");
    return;
  }
  const project = await getProject(ctx.store ?? ctx.db, name);
  if (!project) throw new AppError(`no project '${name}' (create it with: ob project add ${name} --kind <k>)`);
  await setConfig(ctx.store ?? ctx.db, "focus_project", project.id);
  if (ctx.mode === "json") print(JSON.stringify({ focus_project: project.id }));
  else print(project.id);
}

/**
 * The move `ob order` was asked for: exactly one of --top, --before <ref>, --after <ref>, and --priority only
 * with --top. Shared by the local command and the API client so both refuse the same shapes the same way.
 */
export function orderMoveFromFlags(flags: { top?: boolean; before?: string; after?: string; priority?: string }): QueueMove {
  const given = [flags.top === true, flags.before !== undefined, flags.after !== undefined].filter(Boolean).length;
  if (given !== 1) throw new UsageError("order needs exactly one of --top, --before <ref>, --after <ref>");
  if (flags.priority !== undefined && flags.top !== true) {
    throw new UsageError("--priority goes with --top; --before / --after take the priority from the item they sit next to");
  }
  if (flags.top === true) {
    if (flags.priority === undefined) return { top: true };
    // parsePriority("") is 0 (Number("") is 0), so an empty --priority= would silently write "none".
    const p = flags.priority.trim() === "" ? null : parsePriority(flags.priority);
    if (p === null) throw new UsageError(`invalid --priority '${flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
    return { top: true, priority: p };
  }
  return flags.before !== undefined ? { before: flags.before } : { after: flags.after! };
}

/** `ob order <ref> --top | --before <ref> | --after <ref>` (OB-2083): place an item in its project's queue. */
export async function cmdOrder(ctx: Ctx): Promise<void> {
  const id = ctx.args[0];
  if (!id) throw new UsageError("order requires an <id> and one of --top, --before <ref>, --after <ref>");
  const move = orderMoveFromFlags(ctx.flags);
  const store = ctx.store ?? ctx.db;
  // Guard the typed refs BEFORE the write: a bare number that names two different items is refused here with
  // "nothing was changed", and the core is handed the resolved ids.
  const subject = await requireItem(ctx, id);
  let resolved = move;
  if ("before" in move) resolved = { before: (await requireItem(ctx, move.before)).id };
  else if ("after" in move) resolved = { after: (await requireItem(ctx, move.after)).id };
  const res = await setQueueOrder(store, subject.id, resolved, decisionOptsOf(ctx));
  const row = await requireItem(ctx, res.id, { trusted: true });
  const name = priorityName(res.priority);
  if (ctx.mode === "json") {
    print(JSON.stringify({ id: row.id, ...(row.ref ? { ref: row.ref } : {}), priority: name, priority_changed: res.priorityChanged, rank: res.rank }));
  } else if (ctx.mode === "quiet") {
    print(row.ref ?? row.id);
  } else {
    print(`${row.ref ?? row.id}  queue rank ${res.rank} in ${name}${res.priorityChanged ? " (priority changed)" : ""}`);
  }
}
