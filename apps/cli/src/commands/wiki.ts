// OB-2006: `ob wiki`, the project wiki. Markdown pages in the OmniSlash checkout's `wiki/`, one per project
// under `wiki/projects/<slug>.md` and anything else under `wiki/topics/<slug>.md`. OB-2007 adds the incident
// log: `wiki/incidents/<area>.md`, one file per area, newest entry first, written by `ob wiki log`. A project page carries a GENERATED facts block between two markers, then hand
// notes. The committed block holds only what is true on every machine and moves rarely (name, slug, kind,
// key, remote, whether repos/<slug>/AGENTS.md exists), so `ob wiki check` drifts only when the project
// itself changed. The machine-and-moment facts (local path, open counts, recent closes) are PRINTED by
// `ob wiki <slug>` and never written to a file.
//
// The pages are files on THIS machine (as `repos/` is for `project rules`), the facts come from the
// tracker through `ctx.store ?? ctx.db` as `cmdProject` does, so it works local and over the API.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { eq } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { listProjects, type Project } from "../project.ts";
import { asStore, type Store } from "../db/store.ts";
import { hasProjectRulesFile } from "../repo-private.ts";
import { displayRef } from "../refs.ts";
import { NON_QUEUE_TYPES } from "../status.ts";
import { priorityName, PRIORITY_NONE } from "../priority.ts";
import { print, type Mode } from "../output.ts";
import { parseJsonMap } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { settingFor } from "../settings.ts";

export const FACTS_START = "<!-- ob:facts:start -->";
export const FACTS_END = "<!-- ob:facts:end -->";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRIORITY_ORDER = ["critical", "urgent", "flake", "high", "medium", "low", "none"];

/** Whether `dir` is an OmniSlash checkout: it carries the wiki's README and this command's source. */
function isOmnislashCheckout(dir: string): boolean {
  return existsSync(join(dir, "wiki", "README.md")) && existsSync(join(dir, "apps", "cli", "src", "commands", "wiki.ts"));
}

/** The git checkout (a `.git` directory or worktree file) that contains `start`, or null. */
function gitCheckoutOf(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The wiki directory. `OB_WIKI_DIR` overrides it (tests). Otherwise the `wiki/` of the git checkout containing the
 * current directory when that checkout is omnislash, so a builder's `ob wiki log` lands in its own worktree and ships in
 * its PR (the on-PATH `ob` runs the MAIN checkout's source, so the source-relative path would write into the architect's
 * tree). Anywhere else, the wiki next to the running source.
 */
export function wikiDir(): string {
  const override = process.env.OB_WIKI_DIR;
  if (override) return resolve(override);
  const here = gitCheckoutOf(process.cwd());
  if (here && isOmnislashCheckout(here)) return join(here, "wiki");
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "wiki");
}

function pageFile(kind: "projects" | "topics", name: string): string {
  return join(wikiDir(), kind, `${name}.md`);
}

function pageNames(kind: "projects" | "topics"): string[] {
  const dir = join(wikiDir(), kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** The committed facts block for a project: deterministic, machine-independent, no counts or dates. */
export function renderFacts(p: Project): string {
  const rules = hasProjectRulesFile(p.id) ? `yes (repos/${p.id}/AGENTS.md)` : "none";
  return [
    FACTS_START,
    `- name: ${p.name}`,
    `- slug: ${p.id}`,
    `- kind: ${p.kind}`,
    `- key: ${p.key ?? "none"}`,
    `- stage: ${p.stage || "not set"}`,
    `- remote: ${p.git_remote ?? "none"}`,
    `- private agent rules: ${rules}`,
    FACTS_END,
  ].join("\n");
}

/** A fresh page: heading, the facts block, an empty Notes section. */
export function newPage(p: Project): string {
  return `# ${p.name}\n\n${renderFacts(p)}\n\n## Notes\n\n`;
}

/** The marker span of a page (start index through end of the end marker), or null when it has none. */
function factsSpan(text: string): { from: number; to: number } | null {
  const from = text.indexOf(FACTS_START);
  if (from === -1) return null;
  const end = text.indexOf(FACTS_END, from);
  if (end === -1) return null;
  return { from, to: end + FACTS_END.length };
}

/** Whether the page has any marker beyond its one block (a second pair, or a stray start or end), which refresh and check would never see. */
function hasExtraMarkers(text: string): boolean {
  const count = (m: string) => text.split(m).length - 1;
  return count(FACTS_START) > 1 || count(FACTS_END) > 1;
}

/** `text` with its facts block replaced by `block`; everything outside the markers is untouched. */
export function replaceFacts(text: string, block: string): string | null {
  const span = factsSpan(text);
  if (!span) return null;
  return text.slice(0, span.from) + block + text.slice(span.to);
}

/** One item of a project, as the wiki reads it: the same shape from the store and from the API. */
export interface WikiTask {
  id: string;
  /** The item type (`task`, `learning`, ...): a reference never counts. */
  type: string;
  ref: string | null;
  title: string;
  status: string;
  /** A priority NAME (`urgent`..`none`). */
  priority: string;
  closed_at: string | null;
}

/** Where the wiki gets the tracker's facts: the local store, or the API on a client with no database. */
export interface WikiSource {
  projects(): Promise<Project[]>;
  /** Every item of the project, any type and status. */
  tasks(projectId: string): Promise<WikiTask[]>;
  /** The `repo_checkouts` setting, parsed. */
  checkouts(): Promise<Record<string, string>>;
}

export function storeSource(db: Store | Ctx["db"]): WikiSource {
  const s = asStore(db);
  return {
    projects: () => listProjects(s),
    checkouts: async () => parseJsonMap(await settingFor(s, "repo_checkouts")),
    async tasks(projectId) {
      const rows = (await s.q
        .select({
          id: s.t.item.id,
          type: s.t.item.type,
          ref: s.t.item.ref,
          title: s.t.item.title,
          status: s.t.item.status,
          priority: s.t.item.priority,
          closed_at: s.t.item.closed_at,
        })
        .from(s.t.item)
        .where(eq(s.t.item.project_id, projectId))) as Array<
        Omit<WikiTask, "priority"> & { priority: number | null }
      >;
      return rows.map((r) => ({ ...r, priority: priorityName(r.priority ?? PRIORITY_NONE) }));
    },
  };
}

interface Live {
  /** This machine's checkout, or null. */
  local_path: string | null;
  /** True when `repo_checkouts` could not be read, so a null path means "unknown", not "absent". */
  local_path_unknown: boolean;
  open: number;
  open_by_priority: Record<string, number>;
  last_closed: Array<{ ref: string; title: string; closed_at: string | null }>;
  /** OB-2007: the incident log of the area named like this project, when it has entries. */
  incidents?: { entries: number; latest: { date: string; title: string } | null } | null;
}

/**
 * The project's checkout on THIS machine: its `repo_checkouts` entry, else `~/dev/<slug>`, each only when it is a
 * git repo. Not `resolveRepoWith`, whose first step takes the slug as a path relative to the cwd and so would
 * answer `omnislash` (or another repo of that name) when `ob wiki` runs from a directory that holds one.
 */
export function localCheckout(checkouts: Record<string, string>, slug: string, home: string = homedir()): string | null {
  for (const dir of [checkouts[slug], join(home, "dev", slug)]) {
    if (dir && isAbsolute(dir) && existsSync(join(dir, ".git"))) return dir;
  }
  return null;
}

async function liveFacts(src: WikiSource, p: Project): Promise<Live> {
  // The same rule as `ob list --open` (items.ts queryItems), so the counts can be compared with it: a reference
  // is a document and never counts; an item is closed at `done`.
  const rows = (await src.tasks(p.id)).filter((r) => !NON_QUEUE_TYPES.includes(r.type));
  const isClosed = (r: WikiTask) => r.status === "done";
  const byPriority: Record<string, number> = {};
  let open = 0;
  for (const r of rows) {
    if (isClosed(r)) continue;
    open++;
    byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
  }
  const closed = rows
    .filter(isClosed)
    .sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? "") || b.id.localeCompare(a.id, undefined, { numeric: true }))
    .slice(0, 5);
  let localPath: string | null = null;
  let unknown = false;
  try {
    localPath = localCheckout(await src.checkouts(), p.id);
  } catch {
    unknown = true; // a failed repo_checkouts read must not lose the page, nor claim the repo is absent
  }
  return {
    local_path: localPath,
    local_path_unknown: unknown,
    open,
    open_by_priority: byPriority,
    last_closed: closed.map((c) => ({ ref: displayRef(c), title: c.title, closed_at: c.closed_at })),
  };
}

function renderLive(l: Live, slugOfLive: string): string {
  const buckets = PRIORITY_ORDER.filter((n) => l.open_by_priority[n]).map((n) => `${n} ${l.open_by_priority[n]}`);
  const lines = [
    "## Live (this machine, now)",
    `- local path: ${l.local_path_unknown ? "unknown (repo_checkouts could not be read)" : (l.local_path ?? "not found on this machine")}`,
    `- open: ${l.open}${buckets.length ? ` (${buckets.join(", ")})` : ""}`,
    l.last_closed.length ? "- last closed:" : "- last closed: none",
    ...l.last_closed.map((c) => `  - ${c.ref} ${c.title}`),
  ];
  if (l.incidents) {
    const latest = l.incidents.latest ? `, latest ${l.incidents.latest.date}: ${l.incidents.latest.title}` : "";
    lines.push(`- incidents: ${l.incidents.entries}${latest} (ob wiki incidents ${slugOfLive})`);
  }
  return lines.join("\n");
}

/** Pages whose name contains the input, else those sharing its first 3 characters, else every page. */
export function nearestNames(input: string, names: string[]): string[] {
  const q = input.toLowerCase();
  const sub = names.filter((n) => n.toLowerCase().includes(q));
  if (sub.length) return sub;
  const pre = names.filter((n) => n.toLowerCase().slice(0, 3) === q.slice(0, 3));
  return pre.length ? pre : names;
}

function requireSlug(name: string): void {
  if (!SLUG.test(name)) throw new UsageError(`'${name}' is not a plain page name (letters, digits, '.', '_' and '-' only)`);
}

async function projectsById(src: WikiSource): Promise<Map<string, Project>> {
  return new Map((await src.projects()).map((p) => [p.id, p]));
}

async function showPage(ctx: WikiCtx, name: string): Promise<void> {
  requireSlug(name);
  const projects = await projectsById(ctx.src);
  const project = projects.get(name);
  const projFile = pageFile("projects", name);
  const topicFile = pageFile("topics", name);

  if (project) {
    const block = renderFacts(project);
    const hasPage = existsSync(projFile);
    const text = hasPage ? readFileSync(projFile, "utf8") : null;
    // A page whose markers are missing or broken still prints the fresh block, ahead of the file as it is.
    // A page with extra markers is printed as it is under the fresh block: `check` and `refresh` refuse that shape.
    const page =
      text === null
        ? `# ${project.name}\n\n${block}\n`
        : (hasExtraMarkers(text) ? null : replaceFacts(text, block)) ?? `${block}\n\n${text}`;
    const live = await liveFacts(ctx.src, project);
    live.incidents = incidentSummary(name);
    if (ctx.mode === "json") {
      print(JSON.stringify({ name, type: "project", has_page: hasPage, page, live }, null, 2));
      return;
    }
    const note = hasPage ? "" : `\nno page yet: run ob wiki refresh ${name}\n`;
    print(`${page.replace(/\n+$/, "")}\n${note}\n${renderLive(live, name)}`);
    return;
  }
  // A project page for a project the tracker no longer has: still readable, which is how `check` reports it.
  if (existsSync(projFile)) {
    const page = readFileSync(projFile, "utf8");
    if (ctx.mode === "json") print(JSON.stringify({ name, type: "project", has_page: true, orphan: true, page }, null, 2));
    else print(`${page.replace(/\n+$/, "")}\n\nno such project in the tracker: ob wiki check`);
    return;
  }
  if (existsSync(topicFile)) {
    const page = readFileSync(topicFile, "utf8");
    if (ctx.mode === "json") print(JSON.stringify({ name, type: "topic", page }, null, 2));
    else print(page.replace(/\n+$/, ""));
    return;
  }
  const all = [...pageNames("projects"), ...pageNames("topics"), ...[...projects.keys()]];
  const unique = [...new Set(all)].sort();
  throw new AppError(`no wiki page '${name}'. Nearest: ${nearestNames(name, unique).join(", ")}`);
}

async function listPages(ctx: WikiCtx): Promise<void> {
  const projects = pageNames("projects");
  const topics = pageNames("topics");
  if (ctx.mode === "json") {
    print(JSON.stringify({ projects, topics }, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print([...projects, ...topics].join("\n"));
    return;
  }
  const lines = ["projects:", ...projects.map((n) => `  ${n}`), "topics:", ...topics.map((n) => `  ${n}`)];
  print(lines.join("\n"));
}

async function refresh(ctx: WikiCtx, only: string | undefined): Promise<void> {
  const projects = await projectsById(ctx.src);
  let targets = [...projects.values()];
  if (only !== undefined) {
    requireSlug(only);
    const p = projects.get(only);
    if (!p) throw new AppError(`no project '${only}'. Projects: ${[...projects.keys()].join(", ")}`);
    targets = [p];
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  const bad: string[] = [];
  for (const p of targets) {
    const file = pageFile("projects", p.id);
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, newPage(p));
      written.push(p.id);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const next = replaceFacts(text, renderFacts(p));
    if (next === null) {
      bad.push(`wiki/projects/${p.id}.md has no ${FACTS_START} ... ${FACTS_END} block; add the markers where the facts belong, then refresh again`);
    } else if (hasExtraMarkers(text)) {
      bad.push(`wiki/projects/${p.id}.md has more than one ${FACTS_START} or ${FACTS_END} marker; keep one pair, then refresh again`);
    } else if (next === text) {
      unchanged.push(p.id);
    } else {
      writeFileSync(file, next);
      written.push(p.id);
    }
  }
  if (ctx.mode === "json") print(JSON.stringify({ written, unchanged, refused: bad }, null, 2));
  else print(`refreshed ${written.length}${written.length ? ` (${written.join(", ")})` : ""}, unchanged ${unchanged.length}`);
  // Every page that could be refreshed was; the ones that could not are named together, exit 1.
  if (bad.length) throw new AppError(bad.join("\n"));
}

async function check(ctx: WikiCtx): Promise<void> {
  const projects = await projectsById(ctx.src);
  const problems: Array<{ page: string; problem: string }> = [];
  const pages = new Set(pageNames("projects"));
  for (const p of projects.values()) {
    const rel = `wiki/projects/${p.id}.md`;
    if (!pages.has(p.id)) {
      problems.push({ page: rel, problem: "missing: project has no page (ob wiki refresh)" });
      continue;
    }
    const text = readFileSync(pageFile("projects", p.id), "utf8");
    const span = factsSpan(text);
    if (!span) problems.push({ page: rel, problem: "no facts block markers" });
    else if (hasExtraMarkers(text)) problems.push({ page: rel, problem: "more than one facts block or stray marker" });
    else if (text.slice(span.from, span.to) !== renderFacts(p)) problems.push({ page: rel, problem: "facts block is stale (ob wiki refresh)" });
  }
  for (const name of pages) {
    if (!projects.has(name)) problems.push({ page: `wiki/projects/${name}.md`, problem: "no such project in the tracker" });
  }
  const logs = incidentAreas().filter((a) => existsSync(incidentFile(a)));
  for (const area of logs) {
    for (const problem of incidentProblems(readFileSync(incidentFile(area), "utf8"))) {
      problems.push({ page: `wiki/incidents/${area}.md`, problem });
    }
  }
  problems.sort((a, b) => a.page.localeCompare(b.page));
  if (ctx.mode === "json") print(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  else if (problems.length === 0) print(`wiki ok: ${projects.size} project pages current${logs.length ? `, ${logs.length} incident logs` : ""}`);
  else print(problems.map((x) => `${x.page}: ${x.problem}`).join("\n"));
  if (problems.length) ctx.exit = 1;
}

/** What the wiki needs of a command context: the args, the output mode, the data source and the exit code. */
export interface WikiCtx {
  args: string[];
  mode: Mode;
  src: WikiSource;
  /** The flags `ob wiki log` reads (OB-2007); absent for the read-only subcommands. */
  flags?: LogFlags;
  exit?: number;
}

export async function cmdWiki(ctx: Ctx): Promise<void> {
  const w: WikiCtx = { args: ctx.args, mode: ctx.mode, src: storeSource(ctx.store ?? ctx.db), flags: ctx.flags };
  await runWiki(w);
  if (w.exit !== undefined) ctx.exit = w.exit;
}

export async function runWiki(ctx: WikiCtx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === undefined || sub === "list") return listPages(ctx);
  if (sub === "refresh") return refresh(ctx, ctx.args[1]);
  if (sub === "check") return check(ctx);
  if (sub === "incidents") return incidents(ctx, ctx.args[1]);
  if (sub === "log") return logIncident(ctx);
  return showPage(ctx, sub);
}

// ---------------------------------------------------------------------------------------------------------------
// OB-2007: the incident log. `wiki/incidents/<area>.md`, one file per area, newest entry first:
//
//   # Incidents: network
//
//   ## 2026-11-02: DHCP pool overlapped fixed addresses, then a router factory reset
//   - what: ...
//   - cause: ...
//   - fix: ...
//   - tickets: OB-123, OB-456
//
// A field may run over several lines (an indented line continues the field above it).
// ---------------------------------------------------------------------------------------------------------------

/** The areas that may start a log without `--new-area`. */
export const STARTER_AREAS = ["home-assistant", "network", "deploy", "daemon", "sources", "ops"];
const AREA = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_HEADING = /^## (\d{4}-\d{2}-\d{2}): (\S.*)$/;
const TICKET = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The flags `ob wiki log` reads. */
export interface LogFlags {
  what?: string;
  cause?: string;
  fix?: string;
  ticket?: string;
  date?: string;
  "new-area"?: boolean;
}

function incidentFile(area: string): string {
  return join(wikiDir(), "incidents", `${area}.md`);
}

/** Every area with a log file, plus the starter areas, sorted. */
function incidentAreas(): string[] {
  const dir = join(wikiDir(), "incidents");
  const have = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];
  return [...new Set([...STARTER_AREAS, ...have])].sort();
}

export interface IncidentEntry {
  /** Null when the `## ` heading carries no `YYYY-MM-DD: ` date. */
  date: string | null;
  title: string;
  heading: string;
  hasWhat: boolean;
}

/** The entries of an incident file: every `## ` heading, with whether its body has a `- what:` line. */
export function parseIncidents(text: string): IncidentEntry[] {
  const out: IncidentEntry[] = [];
  let cur: IncidentEntry | null = null;
  let inWhat = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      const m = ENTRY_HEADING.exec(line);
      const date = m && validDate(m[1]!) ? m[1]! : null;
      cur = { date, title: m ? m[2]!.trim() : line.slice(3).trim(), heading: line, hasWhat: false };
      out.push(cur);
      inWhat = false;
    } else if (cur) {
      const key = /^- (\w+):(.*)$/.exec(line);
      if (key) {
        inWhat = key[1] === "what";
        if (inWhat && key[2]!.trim()) cur.hasWhat = true;
      } else if (inWhat && /^\s+\S/.test(line)) {
        cur.hasWhat = true; // the text of a `- what:` field that runs onto the next line
      }
    }
  }
  return out;
}

/** What is wrong with an incident file, one string per problem. */
export function incidentProblems(text: string): string[] {
  const problems: string[] = [];
  for (const e of parseIncidents(text)) {
    if (e.date === null) problems.push(`entry '${e.heading}' has no valid 'YYYY-MM-DD: ' date`);
    else if (!e.hasWhat) problems.push(`entry '${e.heading}' has no '- what:' line`);
  }
  return problems;
}

function latestOf(entries: IncidentEntry[]): { date: string; title: string } | null {
  let best: { date: string; title: string } | null = null;
  for (const e of entries) {
    if (e.date !== null && (best === null || e.date > best.date)) best = { date: e.date, title: e.title };
  }
  return best;
}

/** The entry count and latest entry of an area's log, or null when it has no file. */
function incidentSummary(area: string): Live["incidents"] {
  const file = incidentFile(area);
  if (!existsSync(file)) return null;
  const entries = parseIncidents(readFileSync(file, "utf8"));
  return { entries: entries.length, latest: latestOf(entries) };
}

async function incidents(ctx: WikiCtx, area: string | undefined): Promise<void> {
  if (area === undefined) {
    const rows = incidentAreas().map((a) => ({ area: a, ...(incidentSummary(a) ?? { entries: 0, latest: null }) }));
    if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
    else if (ctx.mode === "quiet") print(rows.map((r) => r.area).join("\n"));
    else {
      const width = Math.max(...rows.map((r) => r.area.length));
      print(
        rows
          .map((r) => {
            const n = `${r.entries} ${r.entries === 1 ? "entry" : "entries"}`;
            return `${r.area.padEnd(width)}  ${n.padEnd(10)}${r.latest ? `  latest ${r.latest.date}: ${r.latest.title}` : ""}`.trimEnd();
          })
          .join("\n"),
      );
    }
    return;
  }
  requireArea(area);
  const file = incidentFile(area);
  if (!existsSync(file)) {
    if (!STARTER_AREAS.includes(area)) throw new AppError(unknownAreaMessage(area));
    if (ctx.mode === "json") print(JSON.stringify({ area, entries: 0, page: null }, null, 2));
    else print(`no incidents logged for ${area} yet`);
    return;
  }
  const page = readFileSync(file, "utf8");
  if (ctx.mode === "json") print(JSON.stringify({ area, entries: parseIncidents(page).length, page }, null, 2));
  else print(page.replace(/\n+$/, ""));
}

function requireArea(area: string): void {
  if (!AREA.test(area)) throw new UsageError(`'${area}' is not an incident area (lowercase letters, digits and '-' only)`);
}

function unknownAreaMessage(area: string): string {
  return `no incident log '${area}'. Nearest: ${nearestNames(area, incidentAreas()).join(", ")}. A genuinely new area needs --new-area`;
}

/** Today as a local YYYY-MM-DD. */
function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** `ob wiki log <area> "<title>" --what ...`: put a new entry at the top of the area's log. */
async function logIncident(ctx: WikiCtx): Promise<void> {
  const area = ctx.args[1];
  const title = oneLine(ctx.args.slice(2).join(" "));
  const f = ctx.flags ?? {};
  if (!area || !title) throw new UsageError('usage: ob wiki log <area> "<title>" --what <what happened> [--cause <c>] [--fix <f>] [--ticket OB-N[,OB-M]] [--date YYYY-MM-DD] [--new-area]');
  requireArea(area);
  const what = f.what === undefined ? "" : oneLine(f.what);
  if (!what) throw new UsageError("ob wiki log needs --what: what happened");
  const date = f.date ?? today();
  if (!validDate(date)) throw new UsageError(`--date '${date}' is not a YYYY-MM-DD date`);
  const tickets = (f.ticket ?? "").split(/[\s,]+/).filter(Boolean);
  for (const t of tickets) if (!TICKET.test(t)) throw new UsageError(`--ticket '${t}' is not a ticket ref like OB-123`);

  const file = incidentFile(area);
  const exists = existsSync(file);
  if (!exists && !STARTER_AREAS.includes(area) && !f["new-area"]) throw new AppError(unknownAreaMessage(area));

  const entry = [
    `## ${date}: ${title}`,
    `- what: ${what}`,
    `- cause: ${oneLine(f.cause ?? "") || "unknown"}`,
    `- fix: ${oneLine(f.fix ?? "") || "open"}`,
    `- tickets: ${tickets.length ? tickets.join(", ") : "none"}`,
  ].join("\n");

  let next: string;
  const text = exists ? readFileSync(file, "utf8") : "";
  if (!text.trim()) {
    next = `# Incidents: ${area}\n\n${entry}\n`;
  } else {
    // Newest first: go above the first entry that is older than this one (a same-day entry goes above too);
    // an entry whose heading has no valid date is skipped, so a malformed one never pulls the new entry down.
    let at = -1;
    let pos = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) {
        const m = ENTRY_HEADING.exec(line);
        if (m && validDate(m[1]!) && m[1]! <= date) {
          at = pos;
          break;
        }
      }
      pos += line.length + 1;
    }
    next = at === -1 ? `${text.replace(/\n*$/, "\n")}\n${entry}\n` : `${text.slice(0, at)}${entry}\n\n${text.slice(at)}`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  if (ctx.mode === "json") print(JSON.stringify({ area, date, title, file: `wiki/incidents/${area}.md` }, null, 2));
  else print(`logged in wiki/incidents/${area}.md: ${date}: ${title}`);
}
