import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { allConfig, getConfig, setConfig } from "../config.ts";
import {
  addConflict,
  getProject,
  listProjects,
  openItemsRefusal,
  type ProjectPatch,
  registerProject,
  removeProject,
  renameProject,
  renameRefusal,
  slugify,
  updateProject,
  type Project,
} from "../project.ts";
import { asStore, getStore, resetStore, type Store } from "../db/store.ts";
import { resolveStoreKind } from "../db/store-kind.ts";
import { configuredRemoteHost } from "../remote.ts";
import { installOpencodeWiring, opencodeSourceDir, readProjectRules } from "../repo-private.ts";
import { keyProblem } from "../refs.ts";
import { parseStage, StageError, stageLine } from "../stage.ts";
import { parseProjectStatus, PROJECT_STATUS_ALIASES, projectStatusOf, ProjectStatusError } from "../project-status.ts";

/**
 * One tab-separated line per project: id, kind, name, remote, then the ref key (1949), the architect title's
 * icon and display name (OB-2116) and the release stage (OB-2103), each APPENDED so earlier columns keep their
 * place. Every column is written on every row, so the stage is always the eighth; it is `-` when unset. The ninth
 * is the lifecycle status (OS-134), `active`, `paused` or `archived`.
 */
export function renderProjectList(projects: Project[]): string {
  return projects
    .map((p) =>
      [p.id, p.kind, p.name, p.git_remote ?? "", p.key ?? "", p.icon ?? "", p.display_name ?? "", p.stage || "-", projectStatusOf(p)].join("\t"),
    )
    .join("\n");
}

/** OS-134: `project list` leaves archived projects out unless `--all`. Pure. */
export function visibleProjects<P extends { status?: string | null }>(projects: P[], all: boolean): P[] {
  return all ? projects : projects.filter((p) => projectStatusOf(p) !== "archived");
}
import type { Kind } from "../status.ts";
import { emitId, print } from "../output.ts";
import { nowIso, openDb } from "../db.ts";
import { isLauncherName, launcherRejection } from "../../../../platform/cli-coord/src/commands/spinoff.ts";

export const VALID_PROJECT_KINDS: Kind[] = ["side", "home", "admin", "learning"];
const VALID_KINDS = VALID_PROJECT_KINDS;

/** OB-2116: an emoji is a few code points (a ZWJ flag is several), so the cap is generous but finite. */
export const PROJECT_ICON_MAX = 16;
export const PROJECT_DISPLAY_NAME_MAX = 40;

/**
 * `--icon` / `--display-name` (OB-2116), trimmed; the empty string is kept and means "clear". The icon is at
 * most 16 UTF-16 code units, the name at most 40 characters; nothing else is checked.
 */
export function parseProjectLabel(flag: "icon" | "display-name", value: string): string {
  const v = value.trim();
  const max = flag === "icon" ? PROJECT_ICON_MAX : PROJECT_DISPLAY_NAME_MAX;
  const len = flag === "icon" ? v.length : Array.from(v).length;
  if (len > max) throw new UsageError(`--${flag} must be at most ${max} ${flag === "icon" ? "UTF-16 code units" : "characters"} (got ${len})`);
  return v;
}

/** `project edit`'s flags -> a patch; no flag at all is a usage error, and so is an unknown kind. */
export function parseProjectPatch(flags: {
  remote?: string | undefined;
  kind?: string | undefined;
  key?: string | undefined;
  icon?: string | undefined;
  displayName?: string | undefined;
  stage?: string | undefined;
  status?: string | undefined;
}): ProjectPatch {
  const { remote, kind, key, icon, displayName, stage, status } = flags;
  if (
    remote === undefined &&
    kind === undefined &&
    key === undefined &&
    icon === undefined &&
    displayName === undefined &&
    stage === undefined &&
    status === undefined
  ) {
    throw new UsageError(
      "project edit needs at least one of --remote <url>, --kind <k>, --key <KEY>, --icon <emoji>, --display-name <text>, --stage <s> or --status <s>",
    );
  }
  let parsedStatus: string | undefined;
  if (status !== undefined) {
    try {
      parsedStatus = parseProjectStatus(status);
    } catch (e) {
      if (e instanceof ProjectStatusError) throw new UsageError(e.message);
      throw e;
    }
  }
  let parsedStage: string | undefined;
  if (stage !== undefined) {
    try {
      parsedStage = parseStage(stage);
    } catch (e) {
      if (e instanceof StageError) throw new UsageError(e.message);
      throw e;
    }
  }
  if (key !== undefined) {
    const problem = keyProblem(key.trim().toUpperCase());
    if (problem) throw new UsageError(problem);
  }
  if (kind !== undefined && !VALID_KINDS.includes(kind as Kind)) {
    throw new UsageError(`--kind must be one of ${VALID_KINDS.join(", ")}`);
  }
  if (remote !== undefined && remote.trim() === "") throw new UsageError("--remote must not be empty");
  return {
    ...(remote !== undefined ? { remote: remote.trim() } : {}),
    ...(kind !== undefined ? { kind: kind as Kind } : {}),
    ...(key !== undefined ? { key: key.trim().toUpperCase() } : {}),
    ...(icon !== undefined ? { icon: parseProjectLabel("icon", icon) } : {}),
    ...(displayName !== undefined ? { display_name: parseProjectLabel("display-name", displayName) } : {}),
    ...(parsedStage !== undefined ? { stage: parsedStage } : {}),
    ...(parsedStatus !== undefined ? { status: parsedStatus } : {}),
  };
}

/**
 * `project rules|wire` (1803): the repo-private half omnislash serves for a project. Both read files on THIS
 * machine (`repos/` in the OmniSlash checkout); `apiProject` calls this too, which keeps them local on an API
 * client. `rules` also opens with the project's stage line (OB-2103), so the caller passes `readStage`: the
 * stored stage (null = not set, treated as beta) read from the store or over the API. A read that fails is
 * said on stderr and the rules still print.
 */
export async function projectRepoPrivate(
  sub: "rules" | "wire",
  name: string | undefined,
  dirFlag: string | boolean | undefined,
  mode: Ctx["mode"],
  readStage?: (name: string) => Promise<string | null>,
): Promise<void> {
  if (!name) throw new UsageError(`project ${sub} requires a <project>`);
  if (sub === "rules") {
    const rules = readProjectRules(name);
    let stage: string | null | undefined;
    if (readStage) {
      try {
        stage = await readStage(name);
      } catch (e) {
        process.stderr.write(`ob: could not read ${name}'s stage (${(e as Error).message}); printing the rules without it\n`);
      }
    }
    if (mode === "json") {
      print(JSON.stringify({ project: name, ...(stage !== undefined ? { stage, stage_line: stageLine(stage) } : {}), rules }, null, 2));
      return;
    }
    const out = [stage !== undefined ? stageLine(stage) : null, rules ? rules.replace(/\n+$/, "") : null].filter((l): l is string => l !== null);
    if (out.length > 0) print(out.join("\n\n"));
    return;
  }
  const dir = typeof dirFlag === "string" ? dirFlag : process.cwd();
  const res = installOpencodeWiring(name, dir, { built: true });
  if (mode === "json") print(JSON.stringify({ project: name, dir, ...res }, null, 2));
  else if (mode !== "quiet") {
    print(
      res.installed.length === 0 && res.kept.length === 0
        ? `no opencode wiring for '${name}' (not a plain project name)`
        : `${name}: installed ${res.installed.length}, kept ${res.kept.length} (already in ${dir}/.opencode)`,
    );
    if (res.excludeFailed) print(`warning: could not write ${dir}'s git info/exclude; the installed files will show in git status`);
  }
  // The plugin shims import from this checkout. A linked worktree (`.git` is a file) is removed when its branch
  // lands, and the plugins then stop loading with no message, so say so while it can still be fixed.
  const gitPath = join(opencodeSourceDir(), "..", "..", "..", ".git");
  if (res.installed.length > 0 && existsSync(gitPath) && statSync(gitPath).isFile()) {
    process.stderr.write(
      `warning: the plugins point into ${resolve(opencodeSourceDir(), "..", "..", "..")}, a linked worktree; re-run 'ob project wire' from the main checkout before it is removed\n`,
    );
  }
}

/**
 * OB-2103: the stage for `project rules` run locally. The command runs with no database (1803: the rules are
 * files), so the store is opened here, inside the caller's try: a machine that cannot open it still prints
 * the rules, with one line on stderr saying why the stage is missing.
 */
async function localProjectStage(dbPath: string, name: string): Promise<string | null> {
  if (resolveStoreKind() === "sqlite") {
    const db = openDb(dbPath, { what: "'ob project rules'" });
    try {
      return (await getProject(db, name))?.stage ?? null;
    } finally {
      db.close();
    }
  }
  try {
    return (await getProject(await getStore(), name))?.stage ?? null;
  } finally {
    await resetStore();
  }
}

export async function cmdProject(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "add") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("project add requires a <name>");
    const kind = ctx.flags.kind;
    if (!kind || !VALID_KINDS.includes(kind as Kind)) {
      throw new UsageError(`project add requires --kind (${VALID_KINDS.join(", ")})`);
    }
    if (ctx.flags.key !== undefined) {
      const problem = keyProblem(ctx.flags.key.trim().toUpperCase());
      if (problem) throw new UsageError(problem);
    }
    const icon = ctx.flags.icon !== undefined ? parseProjectLabel("icon", ctx.flags.icon) : null;
    const displayName = ctx.flags["display-name"] !== undefined ? parseProjectLabel("display-name", ctx.flags["display-name"]) : null;
    const existing = await getProject(ctx.store ?? ctx.db, slugify(name));
    if (existing) {
      const conflict = addConflict(existing, { kind, remote: ctx.flags.remote, icon, displayName });
      if (conflict) throw new AppError(conflict);
      emitId(ctx, existing.id);
      return;
    }
    const project = await registerProject(ctx.store ?? ctx.db, {
      name,
      kind: kind as Kind,
      remote: ctx.flags.remote ?? null,
      key: ctx.flags.key ?? null,
      icon,
      displayName,
    });
    emitId(ctx, project.id);
    return;
  }
  if (sub === "edit") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("project edit requires a <name>");
    const patch = parseProjectPatch({
      remote: ctx.flags.remote,
      kind: ctx.flags.kind,
      key: ctx.flags.key,
      icon: ctx.flags.icon,
      displayName: ctx.flags["display-name"],
      stage: ctx.flags.stage,
      status: ctx.flags.status,
    });
    const project = await updateProject(ctx.store ?? ctx.db, name, patch);
    if (!project) throw new AppError(`no project '${name}'`);
    emitId(ctx, project.id);
    return;
  }
  // OS-134: `project pause|resume|archive <name>` are `project edit <name> --status paused|active|archived`.
  const aliased = sub !== undefined ? PROJECT_STATUS_ALIASES[sub] : undefined;
  if (aliased) {
    const name = ctx.args[1];
    if (!name) throw new UsageError(`project ${sub} requires a <name>`);
    const project = await updateProject(ctx.store ?? ctx.db, name, { status: aliased });
    if (!project) throw new AppError(`no project '${name}'`);
    emitId(ctx, project.id);
    return;
  }
  if (sub === "rename") {
    const [, oldName, newName] = ctx.args;
    if (!oldName || !newName) throw new UsageError("project rename requires <old> <new>");
    const res = await renameProject(ctx.store ?? ctx.db, oldName, newName);
    if (!res.renamed) throw new AppError(renameRefusal(oldName, newName, res));
    emitId(ctx, res.project.id);
    return;
  }
  if (sub === "rm") {
    const name = ctx.args[1];
    if (!name) throw new UsageError("project rm requires a <name>");
    const res = await removeProject(ctx.store ?? ctx.db, name, { force: ctx.flags.force === true });
    if (!res.removed && res.reason === "unknown") throw new AppError(`no project '${name}'`);
    if (!res.removed) throw new AppError(openItemsRefusal(res.project, res.open));
    emitId(ctx, res.project.id);
    return;
  }
  if (sub === "rules" || sub === "wire") {
    // OB-2103: over an ssh remote_host this machine's store is not the tracker, so the stage is not read here.
    const host = configuredRemoteHost(ctx.dbPath);
    await projectRepoPrivate(sub, ctx.args[1], ctx.flags.dir, ctx.mode, host ? undefined : (n) => localProjectStage(ctx.dbPath, n));
    return;
  }
  if (sub === "list" || sub === undefined) {
    const projects = visibleProjects(await listProjects(ctx.store ?? ctx.db), ctx.flags.all === true);
    if (ctx.mode === "json") {
      print(JSON.stringify(projects, null, 2));
      return;
    }
    if (ctx.mode === "quiet") {
      print(projects.map((p) => p.id).join("\n"));
      return;
    }
    print(renderProjectList(projects));
    return;
  }
  throw new UsageError(`unknown project subcommand '${sub}' (add|edit|pause|resume|archive|rename|rm|list|rules|wire)`);
}

export async function getSkillCursorFor(
  db: Database | Store,
  skill: string,
  key: string,
): Promise<string | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ value: s.t.skillCursor.value })
    .from(s.t.skillCursor)
    .where(and(eq(s.t.skillCursor.skill, skill), eq(s.t.skillCursor.key, key)))
    .limit(1)) as Array<{ value: string | null }>;
  return rows[0]?.value ?? null;
}

export async function setSkillCursorFor(
  db: Database | Store,
  skill: string,
  key: string,
  value: string,
): Promise<void> {
  const s = asStore(db);
  await s.q
    .insert(s.t.skillCursor)
    .values({ skill, key, value, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: [s.t.skillCursor.skill, s.t.skillCursor.key],
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
}

export async function cmdCursor(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "get") {
    const [, skill, key] = ctx.args;
    if (!skill || !key) throw new UsageError("cursor get requires <skill> <key>");
    print((await getSkillCursorFor(ctx.store, skill, key)) ?? "");
    return;
  }
  if (sub === "set") {
    const [, skill, key, ...rest] = ctx.args;
    const value = rest.join(" ");
    if (!skill || !key) throw new UsageError("cursor set requires <skill> <key> <value>");
    await setSkillCursorFor(ctx.store, skill, key, value);
    print(value);
    return;
  }
  throw new UsageError("cursor requires get|set");
}

export async function cmdConfig(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === undefined) {
    const rows = await allConfig(ctx.store ?? ctx.db);
    if (ctx.mode === "json") {
      print(JSON.stringify(rows, null, 2));
      return;
    }
    print(rows.map((r) => `${r.key}=${r.value ?? ""}`).join("\n"));
    return;
  }
  if (sub === "get") {
    const key = ctx.args[1];
    if (!key) throw new UsageError("config get requires <key>");
    print((await getConfig(ctx.store ?? ctx.db, key)) ?? "");
    return;
  }
  if (sub === "set") {
    const key = ctx.args[1];
    const value = ctx.args.slice(2).join(" ");
    if (!key) throw new UsageError("config set requires <key> <value>");
    refuseUnroutableLauncher(key, value);
    await setConfig(ctx.store ?? ctx.db, key, value);
    print(value);
    return;
  }
  throw new UsageError(`unknown config subcommand '${sub}' (get|set)`);
}

/**
 * `config set spinoff_launcher <v>` (and each `spinoff_launcher_by_repo` value) must name a launcher a row
 * can be routed to (1589): since headless retired that is only `t3`, and a stored `headless` would only
 * fall back silently at launch time. Refusing at the write names t3 where the mistake is made.
 */
function refuseUnroutableLauncher(key: string, value: string): void {
  if (key === "spinoff_launcher") {
    if (!isLauncherName(value)) throw new UsageError(launcherRejection("config set spinoff_launcher", value));
    return;
  }
  if (key !== "spinoff_launcher_by_repo") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError("config set spinoff_launcher_by_repo requires a JSON object of repo → launcher");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("config set spinoff_launcher_by_repo requires a JSON object of repo → launcher");
  }
  for (const [repo, launcher] of Object.entries(parsed)) {
    if (typeof launcher !== "string" || !isLauncherName(launcher)) {
      throw new UsageError(launcherRejection(`config set spinoff_launcher_by_repo[${repo}]`, String(launcher)));
    }
  }
}

export function cmdInit(ctx: Ctx): void {
  if (ctx.mode === "json") print(JSON.stringify({ db: ctx.dbPath }));
  else print(`initialized ${ctx.dbPath}`);
}
