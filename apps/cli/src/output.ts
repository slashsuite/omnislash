import type { ItemRow } from "./items.ts";
import type { Ctx } from "./ctx.ts";
import { effectivePriority, priorityName } from "./priority.ts";

export type Mode = "human" | "json" | "table" | "quiet";

export function modeFromFlags(flags: { json?: boolean; table?: boolean; quiet?: boolean }): Mode {
  if (flags.quiet) return "quiet";
  if (flags.json) return "json";
  if (flags.table) return "table";
  return "human";
}

export interface ItemView {
  id: string;
  /** 1949: `PS-12`, what ob prints for the item; null for an item in a project with no key. */
  ref: string | null;
  type: string;
  title: string;
  status: string;
  priority: string | null;
  effective_priority: string;
  today_rank: number | null;
  queue_rank: number | null;
  project: string | null;
  kind: string | null;
  block_reason: string | null;
  block_owner: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export function itemView(item: ItemRow, focusProject: string | null): ItemView {
  const eff = effectivePriority({
    priority: item.priority,
    projectId: item.project_id,
    focusProject,
  });
  return {
    id: item.id,
    ref: item.ref ?? null,
    type: item.type,
    title: item.title,
    status: item.status,
    priority: item.priority !== null ? priorityName(item.priority) : null,
    effective_priority: priorityName(eff),
    today_rank: item.today_rank,
    queue_rank: item.queue_rank,
    project: item.project_id,
    kind: item.project_kind,
    block_reason: item.block_reason,
    block_owner: item.block_owner,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
  };
}

function line(v: ItemView): string {
  const prio = v.effective_priority.padEnd(6);
  const status = v.status.padEnd(11);
  const proj = v.project ? `  ·${v.project}` : "";
  return `${v.ref ?? v.id}\t${prio}\t${status}\t${v.title}${proj}`;
}

export function renderItems(views: ItemView[], mode: Mode): string {
  if (mode === "quiet") return views.map((v) => v.ref ?? v.id).join("\n");
  if (mode === "json") return JSON.stringify(views, null, 2);
  if (mode === "table") return renderTable(views);
  return views.map(line).join("\n");
}

function renderTable(views: ItemView[]): string {
  const headers = ["ID", "PRIO", "STATUS", "TITLE", "PROJECT"];
  const rows = views.map((v) => [
    v.ref ?? v.id,
    v.effective_priority,
    v.status,
    v.title,
    v.project ?? "",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length), 0),
  );
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

// Every byte of machine-readable stdout goes through print(), so counting here is what lets run() hold
// the "--json is never both silent and successful" guarantee in ONE place (149).
let stdoutBytes = 0;

export function print(text: string): void {
  if (text.length === 0) return;
  stdoutBytes += text.length;
  console.log(text);
}

/** stdout verbatim (no trailing newline added), for the few payloads a caller consumes raw. */
export function printRaw(text: string): void {
  if (text.length === 0) return;
  stdoutBytes += text.length;
  // Bun's process.stdout.write to a pipe is asynchronous (unlike console.log, which blocks), so the entry
  // point must wait for it before `process.exit`, or the tail of a large value is dropped (OB-1829).
  pendingWrites.push(new Promise<void>((resolve) => process.stdout.write(text, () => resolve())));
}

const pendingWrites: Promise<void>[] = [];

/** Resolves once every printRaw() write has been handed to the OS (or failed: a reader that closed early
 *  leaves nothing to wait for). The entry point awaits this before `process.exit`. */
export async function flushStdout(): Promise<void> {
  await Promise.all(pendingWrites.splice(0));
}

/** Bytes print()ed to stdout so far this process. */
export function printedBytes(): number {
  return stdoutBytes;
}

/** Test-only: reset the counter between in-process run() invocations. */
export function resetPrintedBytes(): void {
  stdoutBytes = 0;
}

/** Non-fatal notice to stderr (keeps stdout clean for machine-readable output). */
export function warn(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Echo the id a write touched. With an item's `ref` (1949) the human and quiet forms print the ref and
 *  `--json` carries both. */
export function emitId(ctx: { mode: Mode }, id: string, ref?: string | null): void {
  if (ctx.mode === "json") print(JSON.stringify(ref ? { id, ref } : { id }));
  else print(ref ?? id);
}
