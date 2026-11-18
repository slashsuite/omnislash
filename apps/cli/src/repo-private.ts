import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageLine } from "./stage.ts";

// A repo's PRIVATE agent half (ob 1803). A repo that goes public cannot carry the ob-specific rules (the
// tracker, the PixelSlash upload, the builder-merges-its-own-PR land, dispatch) or the opencode architect wiring, whose plugins import
// from this machine's absolute paths. OmniSlash owns both, versioned here, under `repos/<project>/`:
//
//   repos/<project>/AGENTS.md    the private rules, served by `ob project rules <project>` and appended to
//                                every spinoff launch prompt for that repo
//   repos/<project>/opencode/    the architect wiring (SOUL.md, agents/, commands/, plugins/), installed into
//                                a checkout's `.opencode/` by `ob project wire` and by every spinoff launch
//
// A project with neither directory behaves exactly as before: no rules, nothing installed.

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The `repos/` directory holding every project's private half. `OB_REPOS_DIR` overrides it (tests). */
function reposDir(): string {
  const override = process.env.OB_REPOS_DIR;
  if (override) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "repos");
}

/** The project's directory under `repos/`, or null when the name is not a plain slug (no path escape). */
function projectDir(project: string): string | null {
  if (!SLUG.test(project)) return null;
  return join(reposDir(), project);
}

/** Whether `repos/<project>/AGENTS.md` exists, even if it is empty (`readProjectRules` is null for an empty one). */
export function hasProjectRulesFile(project: string): boolean {
  const dir = projectDir(project);
  return dir !== null && existsSync(join(dir, "AGENTS.md"));
}

/** The project's private rules text, or null when it has none (no file, an empty one, or a bad name). */
export function readProjectRules(project: string): string | null {
  const dir = projectDir(project);
  if (!dir) return null;
  const file = join(dir, "AGENTS.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return text.trim() ? text : null;
}

/**
 * The block appended to a spinoff launch prompt: the project's stage line (OB-2103) and its private rules
 * under their own heading. `stage` is the project's stored stage (null = not set, which reads as beta); it is
 * undefined only when the caller could not read it, and then the block is the rules alone, or "" when the
 * project has none. With a stage the block is emitted for every repo, AGENTS.md or not. Pure given the files.
 */
export function rulesBlock(project: string, stage?: string | null): string {
  const rules = readProjectRules(project);
  const lines = [stage !== undefined ? stageLine(stage) : null, rules ? rules.trim() : null].filter((l): l is string => l !== null);
  if (lines.length === 0) return "";
  return `\n\n---\n\n# Repo-private rules for ${project} (ob project rules ${project})\n\n${lines.join("\n\n")}\n`;
}

/** Every file under repos/<project>/opencode, as paths relative to it. Empty when there is none. */
export function opencodeWiringFiles(project: string): string[] {
  const dir = projectDir(project);
  if (!dir) return [];
  const root = join(dir, "opencode");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const next = rel ? join(rel, name) : name;
      if (statSync(join(root, next)).isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk("");
  return out;
}

export interface WiringResult {
  /** Files copied into (or refreshed in) `<dir>/.opencode/`. */
  installed: string[];
  /** Files left alone because the checkout TRACKS its own copy (a repo that still commits its wiring). */
  kept: string[];
  /** True when files were installed but the checkout's `info/exclude` could not be written, so git will see them. */
  excludeFailed: boolean;
}

/** The checkout `dir` sits in (git resolves exclude and `ls-files` paths against it), or null when it is none. */
function checkoutRoot(dir: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Where `dir`'s `.opencode/` sits relative to the checkout root: "" at the root, `apps/x/` below it. `--dir` may
 * name a subdirectory, and an exclude line or pathspec is read from the ROOT, so the prefix cannot be assumed
 * away — `/.opencode/x` written for `<checkout>/apps/x/.opencode/x` would leave the file visible to git.
 */
function opencodePrefix(root: string, dir: string): string {
  const rel = relative(root, canonicalDir(dir));
  return rel && rel !== "." ? `${rel.replace(/\/+$/, "")}/` : "";
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The `.opencode/` files git TRACKS under `dir`, relative to `.opencode/`: the ones a repo still commits, which
 * are never overwritten. An empty set for a non-git directory, which installs everything.
 */
function trackedOpencodeFiles(dir: string, prefix: string): Set<string> {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "ls-files", "-z", "--full-name", "--", `${prefix}.opencode`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return new Set();
    const lead = `${prefix}.opencode/`;
    return new Set(
      r.stdout
        .toString()
        .split("\0")
        .filter((p) => p.startsWith(lead))
        .map((p) => p.slice(lead.length)),
    );
  } catch {
    return new Set();
  }
}

/** The git exclude file a checkout (or `wt` worktree, which shares its common dir's) reads, or null. */
function excludeFile(dir: string): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Install the project's opencode wiring into `<dir>/.opencode/`, copying only the files the checkout does not
 * TRACK as its own, so a repo that still commits its wiring keeps every file it commits. ob's own untracked
 * copies are refreshed, so a long-lived checkout picks up a change to `repos/<project>/opencode` instead of
 * pinning the first version it ever installed. Installed files are listed in the checkout's `info/exclude`,
 * which keeps the worktree clean (`ob spinoff handoff` refuses a dirty tree). A project with no wiring is a
 * no-op that touches nothing, not even git.
 */
export function installOpencodeWiring(project: string, dir: string): WiringResult {
  const files = opencodeWiringFiles(project);
  const result: WiringResult = { installed: [], kept: [], excludeFailed: false };
  if (files.length === 0) return result;
  const src = join(projectDir(project) as string, "opencode");
  const dest = join(resolve(dir), ".opencode");
  const root = checkoutRoot(dir);
  const prefix = root ? opencodePrefix(root, dir) : "";
  const tracked = root ? trackedOpencodeFiles(dir, prefix) : new Set<string>();
  for (const rel of files) {
    const target = join(dest, rel);
    if (tracked.has(rel)) {
      result.kept.push(rel);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(src, rel), target);
    result.installed.push(rel);
  }
  if (result.installed.length > 0) {
    const exclude = root ? excludeFile(dir) : null;
    if (!exclude) result.excludeFailed = true;
    else {
      const have = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      const lines = new Set(have.split("\n"));
      const add = result.installed.map((rel) => `/${prefix}.opencode/${rel}`).filter((l) => !lines.has(l));
      if (add.length > 0) {
        mkdirSync(dirname(exclude), { recursive: true });
        appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
      }
    }
  }
  return result;
}

