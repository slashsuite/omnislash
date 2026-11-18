import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Ctx } from "../ctx.ts";
import { requireItem } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import type { Store } from "../db/store.ts";
import { createItem, editItem, getItem, queryItems, referenceVersions, type ItemRow, type ReferenceVersion } from "../items.ts";
import { getProject } from "../project.ts";
import { print, printRaw } from "../output.ts";

// ob doc (OB-2004): living reference documents. A reference is an item of type `reference`: a titled body of
// text that is not work (no queue, no status to move, nothing to close), filed under a project, searchable
// with `ob search`, and versioned: every change to its title or body keeps the text it replaced (items.ts,
// `keepReferenceVersion`). The functions here are the whole behaviour; the local command, the API handlers
// and the API client all call or render the same ones.

/** One reference as `ob doc list` shows it. */
export interface DocRow {
  id: string;
  ref: string | null;
  title: string;
  project: string | null;
  updated_at: string;
}

/** One reference with its whole body and its earlier versions (oldest first, n = 1 is the original). */
export interface DocDetail extends DocRow {
  body: string;
  status: string;
  created_at: string;
  versions: ReferenceVersion[];
}

function docRow(row: ItemRow): DocRow {
  return { id: row.id, ref: row.ref, title: row.title, project: row.project_name, updated_at: row.updated_at };
}

/** `row` when it is a reference document; otherwise a UsageError naming `ob doc list`. */
export function requireDoc(row: ItemRow | null, id: string): ItemRow {
  if (!row || row.type !== "reference") throw new UsageError(`'${id}' is not a reference document (see 'ob doc list')`);
  return row;
}

/** Every reference, newest updated first; `project` (an id or a name) narrows it. */
export async function docList(db: Database | Store, project?: string): Promise<DocRow[]> {
  let projectId: string | undefined;
  if (project !== undefined) {
    const p = await getProject(db, project);
    if (!p) throw new UsageError(`project '${project}' does not exist`);
    projectId = p.id;
  }
  const rows = await queryItems(db, { type: "reference", projectId });
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return rows.map(docRow);
}

export async function docRead(db: Database | Store, row: ItemRow): Promise<DocDetail> {
  return {
    ...docRow(row),
    body: row.body ?? "",
    status: row.status,
    created_at: row.created_at,
    versions: await referenceVersions(db, row.id),
  };
}

export async function docCreate(
  db: Database | Store,
  input: { title: string; project: string; body: string },
): Promise<DocDetail> {
  const title = input.title.trim();
  if (title.length === 0) throw new UsageError("doc add requires a <title>");
  const p = await getProject(db, input.project);
  if (!p) throw new UsageError(`project '${input.project}' does not exist`);
  const id = await createItem(db, { type: "reference", title, body: input.body, projectId: p.id });
  return docRead(db, (await getItem(db, id))!);
}

/** Replace the title and/or body in place; `editItem` keeps the replaced text as a version. */
export async function docSet(
  db: Database | Store,
  row: ItemRow,
  fields: { title?: string; body?: string },
): Promise<DocDetail> {
  if (fields.title === undefined && fields.body === undefined) {
    throw new UsageError("doc set requires --body, --body-file or --title");
  }
  if (fields.title !== undefined && fields.title.trim().length === 0) throw new UsageError("--title cannot be empty");
  await editItem(db, row.id, { title: fields.title?.trim(), body: fields.body });
  return docRead(db, (await getItem(db, row.id))!);
}

/** The version `raw` names (1 = oldest), or a UsageError. */
export function pickVersion(doc: DocDetail, raw: string): ReferenceVersion {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--version must be a whole number from 1 (got '${raw}')`);
  const v = doc.versions.find((x) => x.n === n);
  if (!v) {
    const name = doc.ref ?? doc.id;
    throw new UsageError(
      doc.versions.length === 0 ? `'${name}' has no earlier versions` : `'${name}' has versions 1 to ${doc.versions.length}, not ${n}`,
    );
  }
  return v;
}

export function renderDocList(rows: DocRow[]): string {
  return rows.map((r) => `${r.ref ?? r.id}\t${r.project ?? "-"}\t${r.updated_at}\t${r.title}`).join("\n");
}

/** The document as a human reads it: a header line, a blank line, then the body exactly as stored. */
export function renderDocShow(doc: DocDetail): string {
  const name = doc.ref ?? doc.id;
  const head = `${name}  ${doc.title}  (${doc.project ?? "no project"}, updated ${doc.updated_at}, ${doc.versions.length} earlier version${doc.versions.length === 1 ? "" : "s"})`;
  return `${head}\n\n${doc.body}`;
}

/** Earlier versions, newest first. */
export function renderDocHistory(doc: DocDetail): string {
  if (doc.versions.length === 0) return `${doc.ref ?? doc.id}  ${doc.title}: no earlier versions`;
  return [...doc.versions]
    .reverse()
    .map((v) => `${v.n}\t${v.replaced_at}\t${v.title}`)
    .join("\n");
}

/** `--body`, or `--body-file` read on THIS machine; both is an error. */
export function bodyFromFlags(flags: { body?: string; "body-file"?: string }): string | undefined {
  if (flags.body !== undefined && flags["body-file"] !== undefined) {
    throw new UsageError("pass --body or --body-file, not both");
  }
  if (flags["body-file"] === undefined) return flags.body;
  try {
    return readFileSync(flags["body-file"], "utf8");
  } catch (e) {
    throw new UsageError(`cannot read --body-file ${flags["body-file"]}: ${(e as Error).message}`);
  }
}

export function emitDoc(ctx: { mode: string }, doc: DocDetail, version?: ReferenceVersion): void {
  if (ctx.mode === "json") {
    print(JSON.stringify(version ? { ...doc, title: version.title, body: version.body, version: version.n } : doc, null, 2));
  } else if (ctx.mode === "quiet") {
    print(doc.ref ?? doc.id);
  } else if (version) {
    // An earlier version is the text itself, byte for byte: no header, no newline added.
    printRaw(version.body);
  } else {
    print(renderDocShow(doc));
  }
}

export function emitDocHistory(ctx: { mode: string }, doc: DocDetail): void {
  const newestFirst = [...doc.versions].reverse();
  if (ctx.mode === "json") print(JSON.stringify(newestFirst, null, 2));
  else if (ctx.mode === "quiet") print(newestFirst.map((v) => String(v.n)).join("\n"));
  else print(renderDocHistory(doc));
}

export function emitDocList(ctx: { mode: string }, rows: DocRow[]): void {
  if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
  else if (ctx.mode === "quiet") print(rows.map((r) => r.ref ?? r.id).join("\n"));
  else print(renderDocList(rows));
}

/** What a write prints: the reference's ref (or id), or the whole document under --json. */
export function emitDocWritten(ctx: { mode: string }, doc: DocDetail): void {
  if (ctx.mode === "json") print(JSON.stringify(doc, null, 2));
  else print(doc.ref ?? doc.id);
}

export const DOC_USAGE =
  "doc [list [--project <p>] | add <title> --project <p> (--body <text>|--body-file <file>) | show <id|ref> [--version <n>] | history <id|ref> | set <id|ref> (--body <text>|--body-file <file>) [--title <t>]]";

export async function cmdDoc(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const sub = ctx.args[0];

  if (sub === undefined || sub === "list") {
    emitDocList(ctx, await docList(store, ctx.flags.project));
    return;
  }

  if (sub === "add") {
    const title = ctx.args.slice(1).join(" ");
    if (title.trim().length === 0) throw new UsageError("doc add requires a <title>");
    if (ctx.flags.project === undefined) throw new UsageError("doc add requires --project <project>");
    const body = bodyFromFlags(ctx.flags);
    if (body === undefined) throw new UsageError("doc add requires --body <text> or --body-file <file>");
    emitDocWritten(ctx, await docCreate(store, { title, project: ctx.flags.project, body }));
    return;
  }

  if (sub === "show" || sub === "history" || sub === "set") {
    const id = ctx.args[1];
    if (!id) throw new UsageError(`doc ${sub} requires an <id|ref>`);
    const row = requireDoc(await requireItem(ctx, id), id);
    if (sub === "set") {
      emitDocWritten(ctx, await docSet(store, row, { title: ctx.flags.title, body: bodyFromFlags(ctx.flags) }));
      return;
    }
    const doc = await docRead(store, row);
    if (sub === "history") emitDocHistory(ctx, doc);
    else emitDoc(ctx, doc, ctx.flags.version !== undefined ? pickVersion(doc, ctx.flags.version) : undefined);
    return;
  }

  throw new UsageError(`unknown doc subcommand '${sub}'. usage: ${DOC_USAGE}`);
}
