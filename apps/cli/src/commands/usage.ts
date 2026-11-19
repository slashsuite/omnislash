import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { defineSeam } from "../test-seams.ts";
import { resolveApiBase, resolveApiToken } from "../api/config.ts";
import { ApiClient } from "../api/client.ts";

// -----------------------------------------------------------------------------
// `ob usage day` (OB-2278): where the Claude tokens went over a window, read from the transcripts Claude
// Code and T3's claudeAgent write on THIS machine (`~/.claude/projects/<cwd slug>/<session>.jsonl`, and
// `<session>/subagents/*.jsonl`). Read-only and local: no database. The only tracker read is the thread
// names (spinoff rows and the agent registry), and when that read fails the slugs are printed instead.
// -----------------------------------------------------------------------------

/**
 * ESTIMATED list prices per model family, dollars per million input-equivalent tokens. Fitted on 2026-11-17 from the
 * `cost-state` records of 638 sessions (their recorded `costUSD`); they land within about 20% of it.
 * A change here is a reviewed diff: `usage-day-2278.test.ts` pins one record's cost by hand.
 */
export const PRICE_PER_MTOK: Record<string, number> = {
  opus: 3.36,
  sonnet: 1.77,
  haiku: 0.34,
  fable: 7.0,
};

/** Weights on the input price for each token class. */
export const CLASS_WEIGHT = { input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 } as const;

/** The price of the model's family (the id names it: `claude-<family>-5-5`); Opus when no family matches. */
export function pricePerMTok(model: string): number {
  const family = Object.keys(PRICE_PER_MTOK).find((f) => model.includes(f));
  return PRICE_PER_MTOK[family ?? "opus"]!;
}

export interface ClassCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One API call's estimated dollars, split by token class. Pure. */
export function callCost(model: string, usage: Record<string, unknown>): ClassCost & { total: number; context: number } {
  const p = pricePerMTok(model) / 1e6;
  const cc = (usage.cache_creation ?? null) as Record<string, unknown> | null;
  let w5 = num(cc?.ephemeral_5m_input_tokens);
  const w1 = num(cc?.ephemeral_1h_input_tokens);
  if (!cc) w5 = num(usage.cache_creation_input_tokens);
  const input = p * CLASS_WEIGHT.input * num(usage.input_tokens);
  const output = p * CLASS_WEIGHT.output * num(usage.output_tokens);
  const cacheRead = p * CLASS_WEIGHT.cacheRead * num(usage.cache_read_input_tokens);
  const cacheWrite = p * (CLASS_WEIGHT.write5m * w5 + CLASS_WEIGHT.write1h * w1);
  const written = cc ? w5 + w1 : num(usage.cache_creation_input_tokens);
  const context = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + written;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, context };
}

// --- the scan ------------------------------------------------------------------

export interface Window {
  since: Date;
  until: Date;
}

interface Bucket {
  cost: number;
  calls: number;
}

export interface UsageReport {
  since: string;
  until: string;
  total: Bucket;
  byModel: Array<{ model: string } & Bucket>;
  byClass: ClassCost;
  main: Bucket;
  subagent: Bucket;
  /** One line per ob project, plus one NOT_OB_PROJECT line for every cwd outside their checkouts. */
  projects: Array<{ name: string; cost: number; calls: number; avgContext: number }>;
  sessions: Array<{ slug: string; session: string; name: string; cost: number; calls: number; peakContext: number }>;
}

interface Acc {
  total: Bucket;
  models: Map<string, Bucket>;
  classes: ClassCost;
  main: Bucket;
  subagent: Bucket;
  projects: Map<string, { cost: number; calls: number; context: number }>;
  sessions: Map<string, { slug: string; session: string; cost: number; calls: number; peakContext: number }>;
}

function newAcc(): Acc {
  return {
    total: { cost: 0, calls: 0 },
    models: new Map(),
    classes: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    main: { cost: 0, calls: 0 },
    subagent: { cost: 0, calls: 0 },
    projects: new Map(),
    sessions: new Map(),
  };
}

/** The one line every session outside an ob project's checkout is summed into (#610). */
export const NOT_OB_PROJECT = "not an ob project";

export interface ScanOptions {
  /** slug -> thread name for the sessions list. */
  name?: (slug: string) => string;
  /** a record's cwd -> the ob project whose checkout holds it, else null. */
  project?: (cwd: string | null) => string | null;
}

/** Every transcript under root: `<slug>/<session>.jsonl` and `<slug>/<session>/subagents/*.jsonl`. */
function transcriptFiles(root: string, notBefore: number): string[] {
  const out: string[] = [];
  const fresh = (f: string) => {
    try {
      return statSync(f).mtimeMs >= notBefore;
    } catch {
      return false;
    }
  };
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (e.endsWith(".jsonl")) {
        if (fresh(p)) out.push(p);
        continue;
      }
      const sub = join(p, "subagents");
      if (!existsSync(sub)) continue;
      try {
        for (const s of readdirSync(sub)) if (s.endsWith(".jsonl") && fresh(join(sub, s))) out.push(join(sub, s));
      } catch {
        // not a directory
      }
    }
  }
  return out;
}

/**
 * Sum the transcripts under `root` into one report per window. One pass over the files, whatever the
 * number of windows. A message split over several records counts once (deduped by `message.id` across
 * every file); `<synthetic>` records and records outside every window count zero; a sidechain record or
 * one in a `subagents/` file counts as subagent, and is folded into its parent session. Sessions are named
 * by `name(slug)`; the project lines are the ob projects `project(cwd)` places each record's cwd in, and
 * one NOT_OB_PROJECT line for the rest.
 */
export function scanUsage(root: string, windows: Window[], opts: ScanOptions = {}): UsageReport[] {
  const name = opts.name ?? ((s: string) => s);
  const projectOf = opts.project ?? (() => null);
  if (!existsSync(root)) throw new UsageError(`no Claude transcripts at ${root} (nothing to read on this machine)`);
  const notBefore = Math.min(...windows.map((w) => w.since.getTime()));
  const accs = windows.map(() => newAcc());
  const seen = new Set<string>();
  for (const file of transcriptFiles(root, notBefore)) {
    const rel = relative(root, file).split("/");
    const slug = rel[0]!;
    const inSubagents = rel.length > 2;
    const session = inSubagents ? rel[1]! : basename(file, ".jsonl");
    let cwd: string | null = null;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.type !== "assistant") continue;
      if (typeof r.cwd === "string") cwd = r.cwd;
      const msg = (r.message ?? {}) as Record<string, unknown>;
      const model = typeof msg.model === "string" ? msg.model : "?";
      if (model === "<synthetic>") continue;
      const ts = Date.parse(String(r.timestamp ?? ""));
      if (!Number.isFinite(ts)) continue;
      const wi = windows.findIndex((w) => ts >= w.since.getTime() && ts < w.until.getTime());
      if (wi < 0) continue;
      const id = typeof msg.id === "string" ? msg.id : null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const c = callCost(model, (msg.usage ?? {}) as Record<string, unknown>);
      const a = accs[wi]!;
      a.total.cost += c.total;
      a.total.calls += 1;
      const m = a.models.get(model) ?? { cost: 0, calls: 0 };
      m.cost += c.total;
      m.calls += 1;
      a.models.set(model, m);
      a.classes.input += c.input;
      a.classes.output += c.output;
      a.classes.cacheRead += c.cacheRead;
      a.classes.cacheWrite += c.cacheWrite;
      const side = r.isSidechain === true || inSubagents ? a.subagent : a.main;
      side.cost += c.total;
      side.calls += 1;
      const proj = projectOf(cwd) ?? NOT_OB_PROJECT;
      const p = a.projects.get(proj) ?? { cost: 0, calls: 0, context: 0 };
      p.cost += c.total;
      p.calls += 1;
      p.context += c.context;
      a.projects.set(proj, p);
      const key = `${slug}/${session}`;
      const s = a.sessions.get(key) ?? { slug, session, cost: 0, calls: 0, peakContext: 0 };
      s.cost += c.total;
      s.calls += 1;
      if (!(r.isSidechain === true || inSubagents)) s.peakContext = Math.max(s.peakContext, c.context);
      a.sessions.set(key, s);
    }
  }
  return accs.map((a, i) => ({
    since: windows[i]!.since.toISOString(),
    until: windows[i]!.until.toISOString(),
    total: a.total,
    byModel: [...a.models].map(([model, b]) => ({ model, ...b })).sort((x, y) => y.cost - x.cost),
    byClass: a.classes,
    main: a.main,
    subagent: a.subagent,
    projects: [...a.projects]
      .map(([proj, p]) => ({ name: proj, cost: p.cost, calls: p.calls, avgContext: p.calls ? p.context / p.calls : 0 }))
      .sort((x, y) => y.cost - x.cost),
    sessions: [...a.sessions.values()].map((s) => ({ ...s, name: name(s.slug) })).sort((x, y) => y.cost - x.cost),
  }));
}

// --- names ---------------------------------------------------------------------

/** Claude Code's project directory name for a cwd: every character that is not a letter or digit becomes `-`. */
export function cwdSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

export interface NameRow {
  ticket_ref: string | null;
  repo: string | null;
  worktree: string | null;
  brief: string | null;
}
export interface NameAgent {
  id: string;
  worktree: string | null;
}

const ROLE = /^(architect|sentinel|muse)-/;

/**
 * slug -> a readable name. A spinoff row's worktree names its ticket (`OB-2276 · <title>`); a team role in
 * the agent registry names its own checkout (`architect-acme`); a row's main checkout (the worktree's
 * `<repo>.<branch>` with the branch dropped) names `<repo> · architect` when no role row claims it. Anything
 * else prints as the slug. Rows are newest first, and the first claim on a slug wins. Pure.
 */
export function buildNamer(rows: NameRow[], agents: NameAgent[]): (slug: string) => string {
  const names = new Map<string, string>();
  for (const a of agents) {
    if (a.worktree && ROLE.test(a.id) && !names.has(cwdSlug(a.worktree))) names.set(cwdSlug(a.worktree), a.id);
  }
  for (const r of rows) {
    if (!r.worktree || !r.ticket_ref) continue;
    const slug = cwdSlug(r.worktree);
    if (!names.has(slug)) {
      const first = (r.brief ?? "").split("\n")[0]!.trim();
      const title = first.startsWith(`${r.ticket_ref} · `) ? first.slice(r.ticket_ref.length + 3) : "";
      names.set(slug, title ? `${r.ticket_ref} · ${title}` : r.ticket_ref);
    }
    const leaf = basename(r.worktree);
    const dot = leaf.indexOf(".");
    if (dot > 0) {
      const main = cwdSlug(join(dirname(r.worktree), leaf.slice(0, dot)));
      if (!names.has(main)) names.set(main, `${r.repo ?? leaf.slice(0, dot)} · architect`);
    }
  }
  return (slug) => names.get(slug) ?? slug;
}

/**
 * cwd -> the ob project whose checkout holds it (#610: "every project" is `ob project list`, nothing else).
 * A project's checkouts are `<home>/dev/<name>`, any `<home>/dev/<name>.<branch>` worktree,
 * `<home>/.t3/worktrees/<name>/...`, and the worktree of a spinoff row whose repo is the project; a cwd
 * anywhere inside one of them belongs to it. Names compare case-insensitively. Anything else is null. Pure.
 */
export function buildProjectOf(projects: string[], rows: NameRow[], home: string): (cwd: string | null) => string | null {
  const byLower = new Map(projects.map((p) => [p.toLowerCase(), p]));
  const rowRoots: Array<[string, string]> = [];
  for (const r of rows) {
    const proj = r.repo ? byLower.get(basename(r.repo).toLowerCase()) : undefined;
    if (proj && r.worktree) rowRoots.push([r.worktree, proj]);
  }
  const inside = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(`${dir}/`);
  /** The first path segment under `base`, lowercased; null when cwd is not below it. */
  const leafUnder = (cwd: string, base: string) => (cwd.startsWith(`${base}/`) ? cwd.slice(base.length + 1).split("/")[0]!.toLowerCase() : null);
  const dev = join(home, "dev");
  const t3 = join(home, ".t3", "worktrees");
  return (cwd) => {
    if (!cwd) return null;
    for (const [dir, proj] of rowRoots) if (inside(cwd, dir)) return proj;
    const d = leafUnder(cwd, dev);
    if (d) return byLower.get(d) ?? byLower.get(d.split(".")[0]!) ?? null; // `<name>` or `<name>.<branch>`
    const t = leafUnder(cwd, t3);
    return t ? (byLower.get(t) ?? null) : null;
  };
}

export interface NameSources {
  rows(): Promise<NameRow[]>;
  agents(): Promise<NameAgent[]>;
  /** The names in `ob project list`. */
  projects(): Promise<string[]>;
  /** Test only: the home the checkouts are under (default: this user's). */
  home?: string;
}

async function realNameSources(ctx: Ctx): Promise<NameSources> {
  const base = resolveApiBase();
  if (base) {
    const api = new ApiClient({ base, token: resolveApiToken() });
    return {
      rows: async () => (await api.spinoffs({})).spinoffs,
      agents: async () => (await api.agents(true)).agents,
      projects: async () => (await api.projects()).projects.map((p) => p.name),
    };
  }
  const { listSpinoffs } = await import("../../../../platform/cli-coord/src/commands/spinoff.ts");
  const { listAgents } = await import("../../../../platform/cli-coord/src/agent.ts");
  const { listProjects } = await import("../project.ts");
  return {
    rows: () => listSpinoffs(ctx.store ?? ctx.db),
    agents: () => listAgents(ctx.store ?? ctx.db, { includeExpired: true }),
    projects: async () => (await listProjects(ctx.store ?? ctx.db)).map((p) => p.name),
  };
}

const nameSourcesSeam = defineSeam<NameSources | null>("commands/usage.nameSources", null);
/** Test seam: fake the row and agent reads; `null` puts the real ones back. */
export function __setUsageNameSources(s: NameSources | null): void {
  nameSourcesSeam.set(s);
}

/**
 * The session namer and the project classifier. When the tracker read fails: slugs for names and every
 * session on the NOT_OB_PROJECT line, with a note. Totals never depend on it.
 */
async function lookups(ctx: Ctx): Promise<ScanOptions & { note: string | null }> {
  try {
    const src = nameSourcesSeam.get() ?? (await realNameSources(ctx));
    const [rows, agents, projects] = await Promise.all([src.rows(), src.agents(), src.projects()]);
    return { name: buildNamer(rows, agents), project: buildProjectOf(projects, rows, src.home ?? homedir()), note: null };
  } catch (e) {
    return { note: `thread names and ob projects unavailable (${(e as Error).message}); slugs shown, every session under '${NOT_OB_PROJECT}'` };
  }
}

// --- the weekly window ---------------------------------------------------------

export interface WeeklyWindow {
  usedPercent: number;
  resetsAt: string;
  /** Share of the week already gone, 0 to 100. */
  elapsedPercent: number;
}

export function readWeekly(file: string, now: Date): WeeklyWindow | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    const w = (d?.usageLimits?.windows ?? []).find((x: { id?: string }) => x.id === "seven_day");
    if (!w || typeof w.usedPercent !== "number" || typeof w.resetsAt !== "string") return null;
    const mins = typeof w.windowDurationMins === "number" ? w.windowDurationMins : 10080;
    const left = (Date.parse(w.resetsAt) - now.getTime()) / 60000;
    const elapsedPercent = Math.max(0, Math.min(100, (100 * (mins - left)) / mins));
    return { usedPercent: w.usedPercent, resetsAt: w.resetsAt, elapsedPercent };
  } catch {
    return null;
  }
}

// --- the command ---------------------------------------------------------------

function transcriptRoot(): string {
  if (process.env.OB_USAGE_TRANSCRIPTS?.trim()) return process.env.OB_USAGE_TRANSCRIPTS.trim();
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), ".claude");
  return join(cfg, "projects");
}

export function t3Cache(): string {
  return process.env.OB_USAGE_T3_CACHE?.trim() || join(process.env.HOME?.trim() || homedir(), ".t3", "caches", "claudeAgent.json");
}

function parseWhen(raw: string | undefined, flag: string): Date | null {
  if (raw === undefined) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--${flag} '${raw}' is not a date (ISO 8601, e.g. 2026-11-16T17:00Z)`);
  return d;
}

/** A name cut to fit one line of the report. */
const fit = (s: string, n = 72) => (s.length <= n ? s : `${s.slice(0, n - 3).trimEnd()}...`);
const usd = (v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`;
const k = (v: number) => `${Math.round(v / 1000)}k`;
function delta(now: number, prev: number | undefined): string {
  if (prev === undefined) return "";
  const d = now - prev;
  const pct = prev > 0 ? ` (${d >= 0 ? "+" : ""}${Math.round((100 * d) / prev)}%)` : "";
  return `  was ${usd(prev)}, ${d >= 0 ? "+" : "-"}${usd(Math.abs(d))}${pct}`;
}

/** The text report. `prev` adds the previous window beside each figure. Pure. */
export function renderReport(r: UsageReport, prev: UsageReport | null, opts: { limit: number; weekly: WeeklyWindow | null; note: string | null }): string {
  const L: string[] = [];
  const pc = (v: number) => (r.total.cost > 0 ? `${Math.round((100 * v) / r.total.cost)}%` : "0%");
  L.push(`window ${r.since} to ${r.until} (estimated list price)`);
  L.push(`total: ${usd(r.total.cost)} over ${r.total.calls} calls${delta(r.total.cost, prev?.total.cost)}`);
  if (opts.weekly) {
    const w = opts.weekly;
    const ahead = Math.round(w.usedPercent - w.elapsedPercent);
    L.push(`weekly window: ${w.usedPercent}% used, ${Math.round(w.elapsedPercent)}% of the week gone (${ahead >= 0 ? `${ahead} points ahead` : `${-ahead} points behind`}); resets ${w.resetsAt}`);
  }
  L.push("", "by model:");
  for (const m of r.byModel) L.push(`  ${usd(m.cost).padStart(8)} ${pc(m.cost).padStart(4)}  ${m.model} (${m.calls} calls)${delta(m.cost, prev?.byModel.find((x) => x.model === m.model)?.cost ?? (prev ? 0 : undefined))}`);
  L.push("", "by token class:");
  const classes: Array<[string, keyof ClassCost]> = [["cache read", "cacheRead"], ["cache write", "cacheWrite"], ["output", "output"], ["input", "input"]];
  for (const [label, key] of classes) L.push(`  ${usd(r.byClass[key]).padStart(8)} ${pc(r.byClass[key]).padStart(4)}  ${label}${delta(r.byClass[key], prev?.byClass[key])}`);
  L.push("", "main vs subagent:");
  L.push(`  ${usd(r.main.cost).padStart(8)} ${pc(r.main.cost).padStart(4)}  main (${r.main.calls} calls)${delta(r.main.cost, prev?.main.cost)}`);
  L.push(`  ${usd(r.subagent.cost).padStart(8)} ${pc(r.subagent.cost).padStart(4)}  subagent (${r.subagent.calls} calls)${delta(r.subagent.cost, prev?.subagent.cost)}`);
  L.push("", "ob projects (cost, calls, average context):");
  const ob = r.projects.filter((p) => p.name !== NOT_OB_PROJECT);
  const rest = r.projects.filter((p) => p.name === NOT_OB_PROJECT);
  for (const p of [...ob.slice(0, opts.limit), ...rest]) {
    const was = prev ? (prev.projects.find((x) => x.name === p.name)?.cost ?? 0) : undefined;
    L.push(`  ${usd(p.cost).padStart(8)} ${String(p.calls).padStart(5)} ${k(p.avgContext).padStart(5)}  ${fit(p.name)}${delta(p.cost, was)}`);
  }
  L.push("", "top sessions (cost, calls, peak context):");
  for (const s of r.sessions.slice(0, opts.limit)) L.push(`  ${usd(s.cost).padStart(8)} ${String(s.calls).padStart(5)} ${k(s.peakContext).padStart(5)}  ${fit(s.name, 62)} ${s.session.slice(0, 8)}`);
  if (opts.note) L.push("", `note: ${opts.note}`);
  return L.join("\n");
}

export async function cmdUsage(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "day";
  if (sub !== "day") throw new UsageError(`unknown usage subcommand '${sub}' (day)`);
  const flags = ctx.flags as Record<string, unknown>;
  const until = parseWhen(flags.until as string | undefined, "until") ?? new Date();
  const since = parseWhen(flags.since as string | undefined, "since") ?? new Date(until.getTime() - 86_400_000);
  if (since.getTime() >= until.getTime()) throw new UsageError(`--since must be before --until`);
  const limit = flags.limit !== undefined ? Number(flags.limit) : 10;
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive whole number`);
  const span = until.getTime() - since.getTime();
  const windows: Window[] = [{ since, until }];
  if (flags.compare) windows.push({ since: new Date(since.getTime() - span), until: since });
  const { note, ...opts } = await lookups(ctx);
  const [cur, prev] = scanUsage(transcriptRoot(), windows, opts);
  const weekly = readWeekly(t3Cache(), new Date());
  if (ctx.flags.json) {
    if (note) process.stderr.write(`note: ${note}\n`);
    print(JSON.stringify({ ...cur, previous: prev ?? null, weekly, estimated: true }, null, 2));
    return;
  }
  print(renderReport(cur!, prev ?? null, { limit, weekly, note }));
}
