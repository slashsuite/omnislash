// ob 337: the project table through ob 324's store seam.
//
// Same two conventions as items.ts and config.ts: every DB-touching function takes `Database | Store`
// and normalises with asStore so its signature WIDENS rather than changes, and every function is async
// with every builder AWAITED (`.all()` / `.get()` / `.run()` are the sqlite dialect's synchronous
// terminators and do not exist on pg-core; `.get()` becomes `limit(1)` plus `[0]`).
//
// The pure helpers -- slugify, parseRemote, readGitRemote, originRepo, inferProjectSpec --
// touch no database and stay synchronous. Only the four that query are async.
import type { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { deleteConfig, getConfig, setConfig } from "./config.ts";
import { asStore, type Store } from "./db/store.ts";
import { closedStatuses, type Kind } from "./status.ts";
import { AGREED_KEYS, ProjectKeyError, rerefAfterMove, setProjectKey } from "./refs.ts";
import { AppError } from "./errors.ts";

/** OB-2255: the refusal for an unknown team name (`ob t3 team join`, every `--team` filter). */
export class UnknownTeamError extends AppError {
  constructor(readonly team: string) {
    super(`no team '${team}' (see \`ob t3 team list\`, or add it with \`ob t3 team add ${team}\`)`);
    this.name = "UnknownTeamError";
  }
}

export interface Project {
  id: string;
  name: string;
  kind: Kind;
  git_remote: string | null;
  created_at: string;
  /** The ref key (`PS`, 1949); null until `ob project edit <id> --key` sets one. */
  key: string | null;
  /** OB-2116: one emoji for the architect thread title (`🖼️`); null when unset. */
  icon: string | null;
  /** OB-2116: the name the architect thread title wears (`PixelSlash`); null falls back to the slug. */
  display_name: string | null;
  /** OB-2103: the release stage (`alpha|beta|rc|stable|legacy`, see stage.ts); null = not set, treated as beta. */
  stage: string | null;
  /** OB-2255: the team this project is in (`ob t3 team`); null = in no team, so its handoffs send no note. */
  team_name: string | null;
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function getProject(db: Database | Store, idOrName: string): Promise<Project | null> {
  const store = asStore(db);
  const rows = await store.q
    .select()
    .from(store.t.project)
    .where(or(eq(store.t.project.id, idOrName), eq(store.t.project.name, idOrName)))
    .limit(1);
  return (rows[0] as Project | undefined) ?? null;
}

export async function listProjects(db: Database | Store): Promise<Project[]> {
  const store = asStore(db);
  return (await store.q
    .select()
    .from(store.t.project)
    .orderBy(asc(store.t.project.kind), asc(store.t.project.name))) as Project[];
}

export async function registerProject(
  db: Database | Store,
  opts: { name: string; kind: Kind; remote?: string | null; key?: string | null; icon?: string | null; displayName?: string | null },
): Promise<Project> {
  const id = slugify(opts.name);
  // One transaction, so a refused --key leaves no keyless project behind.
  return asStore(db).txn("register the project", async (store) => {
    const existing = await getProject(store, id);
    if (existing) return existing;
    await store.q.insert(store.t.project).values({
      id,
      name: opts.name,
      kind: opts.kind,
      git_remote: opts.remote ?? null,
      created_at: nowIso(),
      icon: opts.icon || null,
      display_name: opts.displayName || null,
    });
    if (opts.key) await setProjectKey(store, id, opts.key);
    else if (AGREED_KEYS[id]) {
      // The agreed key (1949) is a default for a project registered after the migration (a fresh
      // machine). Another project already holding it keeps it, and this one is left keyless, said aloud.
      await setProjectKey(store, id, AGREED_KEYS[id]).catch((e) => {
        if (!(e instanceof ProjectKeyError)) throw e;
        console.error(`ob: ${e.message}; '${id}' has no key, so its items keep their legacy numbers until \`ob project edit ${id} --key\``);
      });
    }
    return (await getProject(store, id))!;
  });
}

/**
 * Why `project add` must not go ahead on a name that already exists (1621), or null when the add
 * agrees with the row and can answer with its id. A re-add that asks for a DIFFERENT kind or remote
 * used to return the old row unchanged and say nothing; it now refuses and names `project edit`.
 */
export function addConflict(
  existing: Project,
  want: { kind: string; remote?: string | null; icon?: string | null; displayName?: string | null },
): string | null {
  const diffs: string[] = [];
  if (want.kind !== existing.kind) diffs.push(`kind is ${existing.kind}, not ${want.kind}`);
  if (want.remote && want.remote !== existing.git_remote) diffs.push(`remote is ${existing.git_remote ?? "unset"}, not ${want.remote}`);
  // OB-2116: a re-add that names an icon or display name the row does not have would otherwise exit 0 unchanged.
  if (want.icon && want.icon !== existing.icon) diffs.push(`icon is ${existing.icon ?? "unset"}, not ${want.icon}`);
  if (want.displayName && want.displayName !== existing.display_name) {
    diffs.push(`display name is ${existing.display_name ?? "unset"}, not ${want.displayName}`);
  }
  if (diffs.length === 0) return null;
  return `project '${existing.id}' already exists (${diffs.join("; ")}); change it with: ob project edit ${existing.id} [--remote <url>] [--kind <k>] [--icon <emoji>] [--display-name <text>]`;
}

/** The refusal `project rm` gives while open items still reference the project. */
export function openItemsRefusal(project: Project, open: number): string {
  return `project '${project.id}' still has ${open} open item${open === 1 ? "" : "s"}; close or move them, or re-run with --force`;
}

/** What `project edit` may change; a key left undefined is left alone. */
export interface ProjectPatch {
  remote?: string;
  kind?: Kind;
  /** 1949: numbers the project's items under it; a change keeps their old refs as aliases. */
  key?: string;
  /** OB-2116: the architect title's emoji; the empty string clears it. */
  icon?: string;
  /** OB-2116: the architect title's name; the empty string clears it. */
  display_name?: string;
  /** OB-2103: the release stage (already parsed by `parseStage`); the empty string clears it. */
  stage?: string;
}

/** The project after the edit, or null when no project is named `idOrName` (1621). */
export async function updateProject(
  db: Database | Store,
  idOrName: string,
  patch: ProjectPatch,
): Promise<Project | null> {
  // One transaction, so a refused --key leaves --remote/--kind unapplied too.
  return asStore(db).txn("edit the project", async (store) => {
    const existing = await getProject(store, idOrName);
    if (!existing) return null;
    const set: { git_remote?: string; kind?: Kind; icon?: string | null; display_name?: string | null; stage?: string | null } = {};
    if (patch.remote !== undefined) set.git_remote = patch.remote;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.icon !== undefined) set.icon = patch.icon || null;
    if (patch.display_name !== undefined) set.display_name = patch.display_name || null;
    if (patch.stage !== undefined) set.stage = patch.stage || null;
    if (Object.keys(set).length > 0) await store.q.update(store.t.project).set(set).where(eq(store.t.project.id, existing.id));
    if (patch.key !== undefined) await setProjectKey(store, existing.id, patch.key);
    return (await getProject(store, existing.id))!;
  });
}

export type RenameProjectResult =
  | { renamed: false; reason: "unknown" }
  | { renamed: false; reason: "taken"; taken: Project }
  | { renamed: true; project: Project };

/**
 * Rename a project in place (OB-1846). The id is the name's slug, so a new name is a new id: the row
 * moves to it in one transaction, with its kind, remote, created_at and KEY, and every item pointing at
 * it follows. Refs are stored on the item and numbered by the key, which does not change, so every
 * `FS-n` still resolves. Refuses an unknown old name and a new name (or its slug) another project
 * already holds, changing nothing.
 */
export async function renameProject(
  db: Database | Store,
  oldIdOrName: string,
  newName: string,
): Promise<RenameProjectResult> {
  return asStore(db).txn("rename the project", async (s) => {
    const project = await getProject(s, oldIdOrName);
    if (!project) return { renamed: false, reason: "unknown" } as const;
    const newId = slugify(newName);
    const clashes = (await s.q
      .select()
      .from(s.t.project)
      .where(and(or(eq(s.t.project.id, newId), eq(s.t.project.name, newName)), ne(s.t.project.id, project.id)))
      .limit(1)) as Project[];
    if (clashes[0]) return { renamed: false, reason: "taken", taken: clashes[0] } as const;
    if (newId === project.id) {
      await s.q.update(s.t.project).set({ name: newName }).where(eq(s.t.project.id, project.id));
      return { renamed: true, project: (await getProject(s, project.id))! } as const;
    }
    // The key is unique: free it on the old row before the new row takes it.
    await s.q.update(s.t.project).set({ key: null }).where(eq(s.t.project.id, project.id));
    await s.q.insert(s.t.project).values({
      id: newId,
      name: newName,
      kind: project.kind,
      git_remote: project.git_remote,
      created_at: project.created_at,
      key: project.key,
      icon: project.icon,
      display_name: project.display_name,
      stage: project.stage,
      team_name: project.team_name,
    });
    await s.q.update(s.t.item).set({ project_id: newId }).where(eq(s.t.item.project_id, project.id));
    // `ob focus` keeps the project's id as text, not a foreign key, so it would go stale.
    if ((await getConfig(s, "focus_project")) === project.id) await setConfig(s, "focus_project", newId);
    await s.q.delete(s.t.project).where(eq(s.t.project.id, project.id));
    return { renamed: true, project: (await getProject(s, newId))! } as const;
  });
}

/** The refusal `project rename` gives, naming which name was wrong. */
export function renameRefusal(oldName: string, newName: string, res: Exclude<RenameProjectResult, { renamed: true }>): string {
  if (res.reason === "unknown") return `no project '${oldName}'; nothing renamed`;
  return `project '${newName}' already exists (as '${res.taken.id}'); nothing renamed`;
}

/**
 * Items still pointing at the project that are not closed for their own type (OB-1929): what `project rm`
 * refuses over. An archived roadmap and an accepted decision are closed.
 */
async function countOpenItems(db: Database | Store, projectId: string): Promise<number> {
  const store = asStore(db);
  const rows = (await store.q
    .select({ type: store.t.item.type, status: store.t.item.status })
    .from(store.t.item)
    .where(eq(store.t.item.project_id, projectId))) as Array<{ type: string; status: string }>;
  return rows.filter((r) => !closedStatuses(r.type).includes(r.status)).length;
}

export type RemoveProjectResult =
  | { removed: false; reason: "unknown" }
  | { removed: false; reason: "open_items"; project: Project; open: number }
  | { removed: true; project: Project };

/**
 * Remove a project row (1621). Refuses while open items reference it unless `force`. Every item that
 * still points at the row (done ones, and open ones under force) is detached first (project_id -> NULL):
 * item.project_id is a foreign key in both engines, so the row cannot go while anything references it.
 */
export async function removeProject(
  db: Database | Store,
  idOrName: string,
  opts: { force?: boolean } = {},
): Promise<RemoveProjectResult> {
  return asStore(db).txn("remove the project", async (s) => {
    const project = await getProject(s, idOrName);
    if (!project) return { removed: false, reason: "unknown" } as const;
    const open = await countOpenItems(s, project.id);
    if (open > 0 && !opts.force) return { removed: false, reason: "open_items", project, open } as const;
    const detached = (await s.q.select({ id: s.t.item.id }).from(s.t.item).where(eq(s.t.item.project_id, project.id))) as Array<{ id: string }>;
    await s.q.update(s.t.item).set({ project_id: null }).where(eq(s.t.item.project_id, project.id));
    // A projectless item is OB's (1949): each takes an OB ref, and its old one stays as an alias.
    for (const it of detached) await rerefAfterMove(s, it.id, null);
    // `ob focus` keeps the project's id as text, not a foreign key, so it would point at nothing (OB-1929).
    if ((await getConfig(s, "focus_project")) === project.id) await deleteConfig(s, "focus_project");
    await s.q.delete(s.t.project).where(eq(s.t.project.id, project.id));
    return { removed: true, project } as const;
  });
}

interface RemoteInfo {
  org: string;
  repo: string;
  url: string;
}

export function parseRemote(url: string): RemoteInfo | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  let m = trimmed.match(/github\.com[:/]([^/]+)\/(.+)$/);
  if (!m) return null;
  return { org: m[1]!, repo: m[2]!.split("/").pop()!, url: url.trim() };
}

export function readGitRemote(cwd: string): string | null {
  try {
    const out = execSync("git config --get remote.origin.url", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const s = out.toString().trim();
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

// The repo an ob invocation originates from: the basename of the enclosing git repo root, or "" when
// cwd is not inside a git repo. Used by `ob add --triage` to auto-capture where a handed-over item came
// from (issue #56). A worktree reports its own directory name (its checkout root), which is intended.
export function originRepo(cwd: string): string {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const top = out.toString().trim();
    if (top.length === 0) return "";
    return top.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

export interface InferredProject {
  name: string;
  kind: Kind;
  remote: string;
}

/**
 * The project a cwd's git remote would resolve to, with no database write. Used by the client
 * (243) so an API `ob add` and an ssh dispatch both send a resolved `--project`/`--kind`; the
 * server's cwd is never the checkout meant. `inferProject` still registers the same spec locally.
 */
export function inferProjectSpec(cwd: string): InferredProject | null {
  const remote = readGitRemote(cwd);
  if (!remote) return null;
  const info = parseRemote(remote);
  if (!info) return null;
  // Only the owner's own GitHub org infers a project (OB_GITHUB_OWNER). Unset, nothing is inferred and
  // `ob add` asks for --project.
  const owner = process.env.OB_GITHUB_OWNER ?? "";
  if (!owner || info.org !== owner) return null;
  return { name: info.repo, kind: "side", remote: info.url };
}

export async function inferProject(db: Database | Store, cwd: string): Promise<Project | null> {
  const spec = inferProjectSpec(cwd);
  if (!spec) return null;
  return registerProject(db, { name: spec.name, kind: spec.kind, remote: spec.remote });
}
