import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { machineConfigIo } from "../model-routes-io.ts";

// -----------------------------------------------------------------------------
// `ob skills doctor [--fix]` (OS-182): the links in ~/.claude/skills drift. Every `ob-*` link pointed at the
// omnibus checkout while the skill moved on in omnislash, so a review leg ran an old review-leg.ts that read
// `antigravity:gemini-4-neon` as a Claude model and failed on every run. This lists each link into an
// omnibus or omnislash checkout and whether omnislash's copy is the same. `--fix` repoints a link that
// differs at the omnislash copy, only when omnislash's last commit on that skill is the newer one.
// It never deletes or writes anything but those links.
// -----------------------------------------------------------------------------

type SkillState = "same" | "differs" | "omnibus-only";

interface SkillLink {
  name: string;
  /** The link's target as it resolves. */
  target: string;
  state: SkillState;
  /** The omnislash copy the link is compared against (null when omnibus-only). */
  omnislash: string | null;
  /** For `differs`: which checkout's last commit on the skill is newer, or `unknown` when git cannot say. */
  newer?: "omnislash" | "omnibus" | "unknown";
  /** Set by `--fix`: the link now points at the omnislash copy. */
  fixed?: boolean;
}

interface Checkouts {
  omnibus: string;
  omnislash: string;
}

/**
 * The two checkouts: the `repo_checkouts` setting (what `ob spinoff` resolves a repo with), else
 * `$HOME/dev/<name>`. On an API client the setting is read over the API. A read that fails says so on stderr
 * and falls back.
 */
async function skillCheckouts(ctx: Ctx, home: string): Promise<Checkouts> {
  let map: Record<string, string> = {};
  try {
    const raw = await (await machineConfigIo(ctx.store ?? ctx.db)).get("repo_checkouts");
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object") map = parsed as Record<string, string>;
  } catch (e) {
    console.error(`skills: could not read repo_checkouts (${(e as Error).message}); using ~/dev`);
  }
  const pick = (name: string): string => {
    const mapped = map[name];
    return mapped && existsSync(mapped) ? mapped : join(home, "dev", name);
  };
  return { omnibus: pick("omnibus"), omnislash: pick("omnislash") };
}

/** The real path; for a path that does not exist (a dangling link's target), its deepest existing ancestor's real path plus the rest. */
function canonical(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonical(parent), basename(abs));
  }
}

/** `path` relative to `root` when it sits inside it, else null. */
function inside(root: string, path: string): string | null {
  const rel = relative(root, path);
  return rel === "" || rel.startsWith("..") || rel.startsWith(sep) ? null : rel;
}

/** Every entry under `path` (or `path` itself), as relative path -> bytes; a symlink is its link text, never followed. */
function contents(path: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (abs: string, rel: string) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.set(rel, Buffer.from(`symlink:${readlinkSync(abs)}`));
    } else if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) walk(join(abs, entry), rel ? `${rel}/${entry}` : entry);
    } else if (st.isFile()) {
      out.set(rel, readFileSync(abs));
    }
  };
  walk(path, "");
  return out;
}

function sameContents(a: string, b: string): boolean {
  const ca = contents(a);
  const cb = contents(b);
  if (ca.size !== cb.size) return false;
  for (const [rel, bytes] of ca) {
    const other = cb.get(rel);
    if (!other || !bytes.equals(other)) return false;
  }
  return true;
}

/** Unix seconds of the last commit touching `rel` in `repo`, or null when git has none. */
function lastCommitTime(repo: string, rel: string): number | null {
  const r = Bun.spawnSync(["git", "-C", repo, "log", "-1", "--format=%ct", "--", rel], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  const n = Number(r.stdout.toString().trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read every link in `<home>/.claude/skills` into an omnibus or omnislash checkout. Reads only. */
function inspectSkillLinks(home: string, checkouts: Checkouts): SkillLink[] {
  const dir = join(home, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const omnibus = canonical(checkouts.omnibus);
  const omnislash = canonical(checkouts.omnislash);
  const out: SkillLink[] = [];
  for (const name of readdirSync(dir).sort()) {
    const linkPath = join(dir, name);
    if (!lstatSync(linkPath).isSymbolicLink()) continue;
    const target = canonical(resolve(dir, readlinkSync(linkPath)));
    const inSlash = inside(omnislash, target);
    if (inSlash !== null) {
      // Already the omnislash copy.
      out.push({ name, target, state: "same", omnislash: target });
      continue;
    }
    const inBus = inside(omnibus, target);
    if (inBus === null) continue;
    const copy = join(omnislash, inBus);
    if (!existsSync(copy)) {
      out.push({ name, target, state: "omnibus-only", omnislash: null });
      continue;
    }
    // A dangling link (the skill left omnibus) has no omnibus copy to be newer, so the omnislash one is.
    if (!existsSync(target)) {
      out.push({ name, target, state: "differs", omnislash: copy, newer: "omnislash" });
      continue;
    }
    if (sameContents(target, copy)) {
      out.push({ name, target, state: "same", omnislash: copy });
      continue;
    }
    const slashAt = lastCommitTime(omnislash, inBus);
    const busAt = lastCommitTime(omnibus, inBus);
    const newer = slashAt === null || busAt === null || slashAt === busAt ? "unknown" : slashAt > busAt ? "omnislash" : "omnibus";
    out.push({ name, target, state: "differs", omnislash: copy, newer });
  }
  return out;
}

/** Repoint each `differs` link whose omnislash copy is newer. Touches nothing else. */
function fixSkillLinks(home: string, links: SkillLink[]): SkillLink[] {
  const dir = join(home, ".claude", "skills");
  return links.map((l) => {
    if (l.state !== "differs" || l.newer !== "omnislash" || !l.omnislash) return l;
    const linkPath = join(dir, l.name);
    unlinkSync(linkPath);
    symlinkSync(l.omnislash, linkPath);
    return { ...l, fixed: true };
  });
}

function renderSkillLinks(links: SkillLink[], fix: boolean): string {
  if (links.length === 0) return "no skill links into omnibus or omnislash";
  return links
    .map((l) => {
      const base = `${l.name} ${l.target} ${l.state}`;
      if (l.state !== "differs") return base;
      if (l.fixed) return `${base} (omnislash newer; repointed to ${l.omnislash})`;
      const why = l.newer === "unknown" ? "newer side unknown" : `${l.newer} newer`;
      return fix ? `${base} (${why}; left as is)` : `${base} (${why})`;
    })
    .join("\n");
}

export async function cmdSkills(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "doctor" && ctx.args.length > 1) throw new UsageError(`skills doctor takes no arguments (got '${ctx.args[1]}')`);
  if (sub !== "doctor") throw new UsageError(sub ? `unknown skills subcommand '${sub}' (doctor)` : "usage: ob skills doctor [--fix]");
  const home = process.env.HOME || homedir();
  if (ctx.flags.fix !== undefined && ctx.flags.fix !== "") throw new UsageError("skills doctor --fix takes no value");
  const fix = ctx.flags.fix !== undefined;
  let links = inspectSkillLinks(home, await skillCheckouts(ctx, home));
  if (fix) links = fixSkillLinks(home, links);
  if (ctx.mode === "json") print(JSON.stringify(links, null, 2));
  else print(renderSkillLinks(links, fix));
}

/**
 * `--fix` is a string flag (`ob wiki log --fix <text>`), so a bare `ob skills doctor --fix` would be refused by
 * parseArgs for a missing value. Only when `skills` is the command (the first positional, past any flags and the values
 * of string flags in `flags`) does a bare `--fix` before any `--` become `--fix=`.
 */
export function expandSkillsFixFlag(argv: string[], flags: Record<string, { type: string; short?: string }>): string[] {
  const takesValue = (tok: string): boolean => {
    if (tok.includes("=")) return false;
    if (tok.startsWith("--")) return flags[tok.slice(2)]?.type === "string";
    return Object.values(flags).some((f) => f.type === "string" && f.short === tok.slice(1));
  };
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "--") i += takesValue(argv[i]!) ? 2 : 1;
  if (argv[i] !== "skills") return argv;
  const end = argv.indexOf("--", i);
  return argv.map((a, j) => (j > i && (end < 0 || j < end) && a === "--fix" ? "--fix=" : a));
}
