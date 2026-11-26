// OB-2097: the overnight decision log lives in ob. A night is one reference document per project per night (`ob doc`,
// so every edit is versioned) titled `Overnight review: <project>, <YYYY-MM-DD>` and tagged `overnight`, holding the
// morning summary in a fixed template. Each decision is an ob `decision` item in the project, its what in `choice`,
// its why in `rationale`, and `doubt` and `undo` in their own columns; a decision made in a night carries the tag
// `overnight:<YYYY-MM-DD>`, and a daytime architect decision is the same item without it. Only `ob overnight` writes the
// format, so it cannot drift; a run doc hand-edited with `ob doc set` is reported, never repaired.
//
// Everything here goes through the store seam, so the local command and the API handlers call the same functions.
import type { Database } from "bun:sqlite";
import { AppError, UsageError } from "./errors.ts";
import type { Store } from "./db/store.ts";
import { createItem, getDecisionDetail, getItem, queryItems, type ItemRow } from "./items.ts";
import { getProject } from "./project.ts";
import { docSet } from "./commands/doc.ts";

export const OVERNIGHT_TAG = "overnight";
export const SECTIONS = {
  shipped: "Shipped",
  review: "Review these",
  skipped: "Skipped / needs you",
  next: "Next actions",
} as const;
export type Section = keyof typeof SECTIONS;
const SECTION_KEYS = Object.keys(SECTIONS) as Section[];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TITLE = /^Overnight review: (\S+), (\d{4}-\d{2}-\d{2})$/;

type Db = Database | Store;

/** The tag that joins a decision to its night. */
export function nightTag(date: string): string {
  return `${OVERNIGHT_TAG}:${date}`;
}

export function runTitle(project: string, date: string): string {
  return `Overnight review: ${project}, ${date}`;
}

/** A new night's summary: the four sections, each `- none`. */
export function emptySummary(): string {
  return SECTION_KEYS.map((k) => `## ${SECTIONS[k]}\n\n- none\n`).join("\n");
}

/** `YYYY-MM-DD` that is a real date, else a UsageError naming the flag. */
export function parseDate(raw: string, flag: string): string {
  const d = new Date(`${raw}T00:00:00Z`);
  if (!DATE.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new UsageError(`${flag} must be a date YYYY-MM-DD (got '${raw}')`);
  }
  return raw;
}

/** Today on this machine's clock, local time: the night a run started. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function parseSection(raw: string | undefined): Section {
  if (raw !== undefined && (SECTION_KEYS as string[]).includes(raw)) return raw as Section;
  throw new UsageError(`unknown summary section '${raw ?? ""}' (${SECTION_KEYS.join(", ")})`);
}

interface Parsed {
  /** The `##` headings in order. */
  headings: string[];
  /** Each known section's bullets, `- none` dropped. */
  bullets: Record<Section, string[]>;
}

function parseBody(body: string): Parsed {
  const bullets: Record<Section, string[]> = { shipped: [], review: [], skipped: [], next: [] };
  const headings: string[] = [];
  let cur: Section | null = null;
  for (const line of body.split("\n")) {
    const h = /^## (.*)$/.exec(line);
    if (h) {
      const title = h[1]!.trim();
      headings.push(title);
      cur = SECTION_KEYS.find((k) => SECTIONS[k] === title) ?? null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("- ")) {
      if (line.trim() !== "- none") bullets[cur].push(line.slice(2));
    } else if (/^\s+\S/.test(line) && bullets[cur].length) {
      bullets[cur][bullets[cur].length - 1] += `\n${line}`;
    }
  }
  return { headings, bullets };
}

/** What is wrong with a summary's headings: each missing, extra, repeated or out-of-order one. */
export function summaryProblems(body: string): string[] {
  const { headings } = parseBody(body);
  const want = SECTION_KEYS.map((k) => SECTIONS[k] as string);
  const problems: string[] = [];
  for (const w of want) {
    const n = headings.filter((h) => h === w).length;
    if (n === 0) problems.push(`summary is missing '## ${w}'`);
    if (n > 1) problems.push(`summary has '## ${w}' ${n} times`);
  }
  for (const h of headings) if (!want.includes(h)) problems.push(`summary has an extra heading '## ${h}'`);
  const known = headings.filter((h) => want.includes(h));
  if (problems.length === 0 && known.some((h, i) => h !== want[i])) problems.push(`summary headings are out of order (${want.join(", ")})`);
  return problems;
}

/** The body with `line` appended to `section` as a bullet, replacing its `- none`. */
export function appendToSection(body: string, section: Section, line: string): string {
  const lines = body.split("\n");
  const head = lines.findIndex((l) => l === `## ${SECTIONS[section]}`);
  if (head === -1) throw new AppError(`the run's summary has no '## ${SECTIONS[section]}' (see ob overnight show; fix it with ob doc set)`);
  let end = lines.findIndex((l, i) => i > head && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const part = lines.slice(head + 1, end);
  while (part.length && part[part.length - 1]!.trim() === "") part.pop();
  const kept = part.filter((l) => l.trim() !== "- none");
  const text = line.trim().split("\n").map((l, i) => (i === 0 ? `- ${l.trim()}` : `  ${l.trim()}`));
  const section_ = [...(kept.length ? kept : [""]), ...text, ""];
  if (section_[0] !== "") section_.unshift("");
  const rest = lines.slice(end);
  return [...lines.slice(0, head + 1), ...section_, ...rest].join("\n").replace(/\n+$/, "\n");
}

/** A run as every command reports it. */
export interface OvernightRun {
  id: string;
  ref: string | null;
  project: string;
  date: string;
  title: string;
  body: string;
}

export interface OvernightDecision {
  id: string;
  ref: string | null;
  project: string | null;
  title: string;
  status: string;
  night: string | null;
  what: string | null;
  why: string | null;
  doubt: string | null;
  undo: string | null;
  context: string | null;
  decided_at: string | null;
  /** The item's body: `ob note` lines, the decision's trail. */
  notes: string | null;
}

export interface OvernightNight {
  run: OvernightRun;
  summary: Record<Section, string[]>;
  problems: string[];
  decisions: OvernightDecision[];
}

export interface OvernightRunRow {
  date: string;
  project: string;
  ref: string | null;
  decisions: number;
  review: number;
  problems: string[];
}

async function requireProject(db: Db, name: string) {
  const p = await getProject(db, name);
  if (!p) throw new UsageError(`project '${name}' does not exist`);
  return p;
}

function asRun(row: ItemRow, project: string, date: string): OvernightRun {
  return { id: row.id, ref: row.ref, project, date, title: row.title, body: row.body ?? "" };
}

/** Every run doc, optionally of one project. */
async function runRows(db: Db, projectId?: string): Promise<Array<{ row: ItemRow; project: string; date: string }>> {
  const rows = await queryItems(db, { type: "reference", tag: OVERNIGHT_TAG, projectId });
  const out: Array<{ row: ItemRow; project: string; date: string }> = [];
  for (const row of rows) {
    const m = TITLE.exec(row.title);
    if (m && row.project_id) out.push({ row, project: m[1]!, date: m[2]! });
  }
  return out;
}

async function findRun(db: Db, projectId: string, project: string, date: string): Promise<OvernightRun | null> {
  const hit = (await runRows(db, projectId)).find((r) => r.date === date && r.project === project);
  return hit ? asRun(hit.row, project, date) : null;
}

/** The project's run for `date`, or, with no date, its latest run; refused naming `ob overnight start`. */
async function requireRun(db: Db, project: string, date?: string): Promise<OvernightRun> {
  const p = await requireProject(db, project);
  if (date !== undefined) {
    const run = await findRun(db, p.id, p.id, date);
    if (!run) throw new AppError(`no overnight run for ${p.id} on ${date} (start one with ob overnight start --project ${p.id} --date ${date})`);
    return run;
  }
  const all = (await runRows(db, p.id)).filter((r) => r.project === p.id).sort((a, b) => b.date.localeCompare(a.date));
  if (!all.length) throw new AppError(`no overnight run for ${p.id} (start one with ob overnight start --project ${p.id})`);
  return asRun(all[0]!.row, p.id, all[0]!.date);
}

/** The night's run doc, created from the template when it does not exist yet (idempotent). */
export async function startRun(db: Db, input: { project: string; date: string }): Promise<{ run: OvernightRun; created: boolean }> {
  const date = parseDate(input.date, "--date");
  const p = await requireProject(db, input.project);
  const existing = await findRun(db, p.id, p.id, date);
  if (existing) return { run: existing, created: false };
  // A reference document, as `ob doc add` makes one, tagged in the same transaction as the create.
  const id = await createItem(db, { type: "reference", title: runTitle(p.id, date), body: emptySummary(), projectId: p.id, tags: [OVERNIGHT_TAG] });
  return { run: asRun((await getItem(db, id))!, p.id, date), created: true };
}

export interface DecideInput {
  title: string;
  what: string;
  why: string;
  doubt?: string | null | undefined;
  undo?: string | null | undefined;
  context?: string | null | undefined;
  project: string;
  /** The night it belongs to; absent for a daytime decision. */
  night?: string | null | undefined;
}

function required(v: string | undefined | null, what: string): string {
  if (v === undefined || v === null || v.trim() === "") throw new UsageError(`overnight decide requires ${what}`);
  return v.trim();
}

function optional(v: string | undefined | null): string | null {
  return v === undefined || v === null || v.trim() === "" ? null : v.trim();
}

/** Record one decision: an accepted `decision` item, tagged with its night when it has one. */
export async function decide(db: Db, input: DecideInput): Promise<OvernightDecision> {
  const title = required(input.title, 'a "<title>"');
  const what = required(input.what, "--what");
  const why = required(input.why, "--why");
  const night = input.night === undefined || input.night === null ? null : parseDate(input.night, "--night");
  const p = await requireProject(db, input.project);
  if (night !== null) await requireRun(db, p.id, night);
  const id = await createItem(db, {
    type: "decision",
    title,
    status: "accepted",
    projectId: p.id,
    tags: night !== null ? [nightTag(night)] : [],
    decision: { choice: what, rationale: why, doubt: optional(input.doubt), undo: optional(input.undo), context: optional(input.context) },
  });
  return readDecision(db, (await getItem(db, id))!, night);
}

async function readDecision(db: Db, row: ItemRow, night: string | null): Promise<OvernightDecision> {
  const d = (await getDecisionDetail(db, row.id)) ?? {};
  const str = (k: string) => {
    const v = d[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  return {
    id: row.id,
    ref: row.ref,
    project: row.project_id,
    title: row.title,
    status: row.status,
    night,
    what: str("choice"),
    why: str("rationale"),
    doubt: str("doubt"),
    undo: str("undo"),
    context: str("context"),
    decided_at: str("decided_at"),
    notes: row.body && row.body.length ? row.body : null,
  };
}

/** Append a bullet to one section of the night's summary; the replaced text is kept as a doc version. */
export async function addSummaryLine(
  db: Db,
  input: { project: string; date?: string | undefined; section: string; line: string },
): Promise<OvernightRun> {
  const section = parseSection(input.section);
  const line = required(input.line, "--add '<line>'");
  const date = input.date === undefined ? undefined : parseDate(input.date, "--date");
  const run = await requireRun(db, input.project, date);
  const row = (await getItem(db, run.id))!;
  await docSet(db, row, { body: appendToSection(row.body ?? "", section, line) });
  return asRun((await getItem(db, run.id))!, run.project, run.date);
}

/** The night: its summary, any problem with the summary's headings, and its decisions in the order they were made. */
export async function showNight(db: Db, input: { project: string; date?: string | undefined }): Promise<OvernightNight> {
  const date = input.date === undefined ? undefined : parseDate(input.date, "--date");
  const run = await requireRun(db, input.project, date);
  const rows = await queryItems(db, { type: "decision", tag: nightTag(run.date), projectId: run.project });
  const decisions = await Promise.all(rows.map((r) => readDecision(db, r, run.date)));
  decisions.sort((a, b) => (a.decided_at ?? "").localeCompare(b.decided_at ?? "") || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { run, summary: parseBody(run.body).bullets, problems: summaryProblems(run.body), decisions };
}

/** One row per run, oldest night first: its decision count, its Review these count and any summary problem. */
export async function listRuns(db: Db, input: { project?: string | undefined; since?: string | undefined } = {}): Promise<OvernightRunRow[]> {
  const since = input.since === undefined ? undefined : parseDate(input.since, "--since");
  const projectId = input.project === undefined ? undefined : (await requireProject(db, input.project)).id;
  const out: OvernightRunRow[] = [];
  for (const { row, project, date } of await runRows(db, projectId)) {
    if (since !== undefined && date < since) continue;
    const decisions = await queryItems(db, { type: "decision", tag: nightTag(date), projectId: row.project_id! });
    out.push({
      date,
      project,
      ref: row.ref,
      decisions: decisions.length,
      review: parseBody(row.body ?? "").bullets.review.length,
      problems: summaryProblems(row.body ?? ""),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project));
}

// --- rendering, shared by the local command and the API client ---------------------------------------------------

const NOT_RECORDED = "not recorded";

export function renderNight(n: OvernightNight): string {
  const lines = [`${n.run.title}  (${n.run.ref ?? n.run.id})`];
  for (const k of SECTION_KEYS) {
    lines.push("", `## ${SECTIONS[k]}`);
    const b = n.summary[k];
    lines.push(...(b.length ? b.map((x) => `- ${x}`) : ["- none"]));
  }
  lines.push("", "## Decisions");
  if (!n.decisions.length) lines.push("- none");
  n.decisions.forEach((d, i) => {
    lines.push("", `${i + 1}. ${d.title}  (${d.ref ?? d.id}, ${d.decided_at ?? "no date"})`);
    const field = (label: string, v: string | null) => lines.push(`   ${label.padEnd(9)}${(v ?? NOT_RECORDED).split("\n").join(`\n${" ".repeat(12)}`)}`);
    field("what:", d.what);
    field("why:", d.why);
    field("doubt:", d.doubt);
    field("undo:", d.undo);
    if (d.context) field("context:", d.context);
    if (d.notes) {
      lines.push("   notes:");
      for (const l of d.notes.split("\n")) lines.push(`     ${l}`);
    }
  });
  for (const p of n.problems) lines.push(`problem: ${p}`);
  return lines.join("\n");
}

export function renderDecision(d: OvernightDecision): string {
  return `${d.ref ?? d.id}  ${d.title}${d.night ? `  (night ${d.night})` : "  (daytime)"}`;
}

export function renderRunList(rows: OvernightRunRow[]): string {
  if (!rows.length) return "no overnight runs";
  const w = Math.max(...rows.map((r) => r.project.length));
  return rows
    .map((r) => {
      const base = `${r.date}  ${r.project.padEnd(w)}  ${r.decisions} decisions  ${r.review} to review`;
      return r.problems.length ? `${base}  PROBLEM: ${r.problems.join("; ")}` : base;
    })
    .join("\n");
}
