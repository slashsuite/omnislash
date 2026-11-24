import { type Ctx, type Flags, emitItem, requireItem } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { parsePriority, PRIORITY_OPTIONS } from "../priority.ts";
import {
  getProject,
  inferProject,
  inferProjectSpec,
  originRepo,
  registerProject,
  type Project,
} from "../project.ts";
import { VALID_TYPES, type Kind } from "../status.ts";
import type { DispatchRewrite } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import {
  addLink,
  addTags,
  appendNote,
  createItem,
  deleteItem,
  editItem,
  removeTags,
} from "../items.ts";
import { emitId, print } from "../output.ts";
import { decisionOptsOf } from "../decisions.ts";
import { bodyFromFlags } from "./doc.ts";
import { remoteCommand } from "../remote.ts";
import { refsFor } from "../refs.ts";
import { linkUrlClashMessage } from "../tracker-link.ts";
import { setting } from "../settings.ts";
import { createIssue, issueLabels, type CreatedIssue } from "../github-issues.ts";

const PROJECT_REQUIRED_TYPES = ["task", "linear_ref"];
/** The largest quoted remote command sent over ssh: one argv string may not exceed 128 KiB on Linux. */
const REMOTE_COMMAND_MAX_BYTES = 100_000;
const VALID_KINDS: Kind[] = ["side", "home", "admin", "learning"];

/** Flags every command reads (the entry point reads them for each one), so `add`/`edit` never refuse them. */
const GLOBAL_FLAGS = ["json", "quiet", "table", "db", "local", "no-daemon", "help"];

/** The detail-row flags each detail type writes (the store writes them; the API refuses the whole type). */
export const ADD_DETAIL_FLAGS: Record<string, string[]> = {
  roadmap: ["target-date", "source-ref", "owner"],
  decision: ["context", "choice", "rationale", "alternatives", "decided-at"],
  learning: ["learn-kind", "progress", "source", "why"],
};
/** The flags `ob add` reads on either path, whatever the type and the other flags. */
const ADD_CORE_READS = ["type", "body", "body-file", "project", "repo", "priority", "issue", "triage", "tag"];

/**
 * The flags `ob add` reads on a path, for THESE flags. A modifier is read only when its parent is present:
 * `--from` needs `--triage`, `--map` and `--exec` need `--issue`, `--link` is read only without `--issue` (the
 * issue's URL is the link then), `--kind` needs a project to resolve (a task-type add always resolves one),
 * and each detail flag needs its own type. Anything else is refused by name.
 */
export function addReads(flags: Flags, type: string, path: "store" | "api"): string[] {
  const reads = [...ADD_CORE_READS];
  if (flags.issue) reads.push("map", "exec");
  else reads.push("link");
  if (flags.triage) reads.push("from");
  if (path === "store" && (PROJECT_REQUIRED_TYPES.includes(type) || flags.project !== undefined || flags.repo !== undefined)) {
    reads.push("kind");
  }
  reads.push(...(ADD_DETAIL_FLAGS[type] ?? []));
  return reads;
}

/**
 * The flags `ob edit` reads on a path. `--kind` is read only where a project is resolved (the store path,
 * with --project or --repo); the API client never carries it.
 */
export function editReads(flags: Flags, path: "store" | "api"): string[] {
  const reads = ["title", "body", "body-file", "priority", "project", "repo", "note", "holder"];
  if (path === "store" && (flags.project !== undefined || flags.repo !== undefined)) reads.push("kind");
  return reads;
}

/**
 * OB-2181: refuse, by name, a flag the command does not read. The global parser accepts every command's
 * flags (one table), so a flag this handler ignores used to be dropped without a word. Runs before any
 * write or request, so a refused call changes nothing.
 */
export function refuseUnreadFlags(command: string, flags: Flags, reads: readonly string[]): void {
  const allowed = new Set([...GLOBAL_FLAGS, ...reads]);
  const parsed = flags as unknown as Record<string, unknown>;
  const unread = Object.keys(parsed).filter((name) => parsed[name] !== undefined && !allowed.has(name));
  if (unread.length > 0) {
    throw new UsageError(`${command} does not take ${unread.map((name) => `--${name}`).join(", ")}`);
  }
}
export const VALID_RELS = ["roadmap_member", "spun_off_from", "references", "blocks", "supersedes"];

export const INFER_PROJECT_ERROR =
  "could not infer project from git remote; pass --project <name> --kind <kind>";

/**
 * The argv actually sent to the server for `ob add` (243): `--project`/`--kind` are resolved HERE
 * from this machine's cwd git remote, before dispatch. The server's cwd is `/opt/omnislash` or the
 * ob user's home, so inference there always fails (or guesses the wrong project). An explicit
 * `--project`/`--repo` is already machine-independent and passes through untouched. A cwd that
 * cannot be inferred still produces the existing error, here, rather than a wrong guess.
 */
export function rewriteAddProjectArgv(input: {
  argv: string[];
  command: string;
  flags: Record<string, unknown>;
  cwd?: string;
}): DispatchRewrite {
  const { command, flags } = input;
  let argv = input.argv;
  // A flag the command does not read is refused HERE, before anything is sent: the host would refuse it too,
  // but only after the ssh hop, and the refusal belongs on the caller's own terminal.
  if (command === "add" || command === "edit") {
    const type = typeof flags.type === "string" ? flags.type : "task";
    const reads = command === "add" ? addReads(flags as unknown as Flags, type, "store") : editReads(flags as unknown as Flags, "store");
    try {
      refuseUnreadFlags(`ob ${command}`, flags as unknown as Flags, reads);
    } catch (e) {
      return { argv, error: (e as Error).message };
    }
  }
  // OB-2181: a --body-file names a file on THIS machine. Over ssh the server would read its own copy of
  // that path, so the text is read here and sent inline as --body=<text> (one argv token, so it cannot be
  // read as a flag). The check is on the quoted command the ssh hop carries, not the raw text.
  if ((command === "add" || command === "edit") && flags["body-file"] !== undefined) {
    let text: string | undefined;
    try {
      text = bodyFromFlags(flags as unknown as Flags);
    } catch (e) {
      return { argv, error: (e as Error).message };
    }
    if (text !== undefined) {
      const i = argv.findIndex((a) => a === "--body-file" || a.startsWith("--body-file="));
      if (i < 0) return { argv, error: "--body-file could not be carried to the host; refusing rather than letting the host read its own copy of the path" };
      const inlined = [...argv.slice(0, i), `--body=${text}`, ...argv.slice(argv[i] === "--body-file" ? i + 2 : i + 1)];
      if (Buffer.byteLength(remoteCommand(inlined)) > REMOTE_COMMAND_MAX_BYTES) {
        return { argv, error: `--body-file ${String(flags["body-file"])} is too large to send over ssh (the quoted command would pass ${REMOTE_COMMAND_MAX_BYTES} bytes); run the command on the host` };
      }
      argv = inlined;
    }
  }
  if (command !== "add") return { argv, error: null };

  const explicit = flags.repo ?? flags.project;
  if (typeof explicit === "string") return { argv, error: null };

  const type = typeof flags.type === "string" ? flags.type : "task";
  if (!PROJECT_REQUIRED_TYPES.includes(type)) return { argv, error: null };

  const spec = inferProjectSpec(input.cwd ?? process.cwd());
  if (!spec) return { argv, error: INFER_PROJECT_ERROR };

  const out = [...argv, "--project", spec.name];
  if (typeof flags.kind !== "string") out.push("--kind", spec.kind);
  return { argv: out, error: null };
}

function resolveKind(input: string | undefined): Kind {
  if (!input) throw new UsageError("--kind is required");
  if (!VALID_KINDS.includes(input as Kind)) {
    throw new UsageError(`invalid --kind '${input}' (expected: ${VALID_KINDS.join(", ")})`);
  }
  return input as Kind;
}

// The repo/project name for this invocation. `--repo` is an alias for `--project`;
// if both are given and differ, --repo wins (documented). Undefined ⇒ fall back to
// git-remote inference.
function repoOrProject(ctx: Ctx): string | undefined {
  return ctx.flags.repo ?? ctx.flags.project;
}

async function resolveProject(ctx: Ctx): Promise<Project | null> {
  const { flags, db } = ctx;
  const name = repoOrProject(ctx);
  if (name) {
    const existing = await getProject(ctx.store ?? db, name);
    if (existing) {
      if (flags.kind && flags.kind !== existing.kind) {
        return registerProject(ctx.store ?? db, { name, kind: resolveKind(flags.kind) });
      }
      return existing;
    }
    // A new repo/project needs a kind, but a bare `--repo <name>` can't carry one —
    // default to `side` (the ob-native kind) so the headline `ob tag ... --repo`
    // command works; pass --kind, or fix later via `ob project`, to correct it.
    const kind = flags.kind ? resolveKind(flags.kind) : "side";
    return registerProject(ctx.store ?? db, { name, kind });
  }
  const inferred = await inferProject(ctx.store ?? db, process.cwd());
  if (inferred) {
    if (flags.kind && flags.kind !== inferred.kind) {
      return registerProject(ctx.store ?? db, { name: inferred.name, kind: resolveKind(flags.kind) });
    }
    return inferred;
  }
  throw new UsageError(INFER_PROJECT_ERROR);
}

export async function cmdAdd(ctx: Ctx): Promise<void> {
  const type = ctx.flags.type ?? "task";
  refuseUnreadFlags("ob add", ctx.flags, addReads(ctx.flags, type, "store"));
  const title = ctx.args[0];
  if (!title) throw new UsageError("add requires a <title>");
  // Read before anything is created: an unreadable --body-file must not leave a GitHub issue or an item behind.
  const body = bodyFromFlags(ctx.flags);
  if (!VALID_TYPES.includes(type)) {
    throw new UsageError(`invalid --type '${type}' (supported: ${VALID_TYPES.join(", ")})`);
  }
  // Opt-in (221 phase 3): --issue creates a GitHub issue on wayfinder_repo as the source of truth,
  // then a local ob mirror linked to it (so ob next/status/agents still surface it). Without --issue,
  // add is byte-for-byte unchanged. --map/--exec become labels on the issue; they're issue-only.
  // One issue, one item (OB-1929): an explicit --link to an issue another item holds is refused before
  // anything is created, with the message `ob issue link` gives. --issue makes a NEW issue, so it cannot clash.
  if (!ctx.flags.issue && ctx.flags.link) {
    const clash = await linkUrlClashMessage(ctx.store ?? ctx.db, ctx.flags.link);
    if (clash) throw new AppError(clash);
  }
  let issue: CreatedIssue | null = null;
  if (ctx.flags.issue) {
    const repo = setting(ctx.db, "wayfinder_repo");
    issue = await createIssue(ctx.db, {
      repo,
      title,
      body: body ?? null,
      labels: issueLabels({ map: ctx.flags.map, exec: ctx.flags.exec }),
    });
  }
  // Tasks/linear_refs belong to a project (inferred or explicit); roadmap/decision/
  // learning are cross-cutting — project is optional, only resolved if --project given.
  let project: Project | null = null;
  if (PROJECT_REQUIRED_TYPES.includes(type)) {
    project = await resolveProject(ctx);
  } else if (ctx.flags.project || ctx.flags.repo) {
    project = await resolveProject(ctx);
  }
  let priority: number | null = null;
  if (ctx.flags.priority) {
    priority = parsePriority(ctx.flags.priority);
    if (priority === null) throw new UsageError(`invalid --priority '${ctx.flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
  }
  // --triage flags a handed-over item for the OmniSlash architect's triage inbox (issue #56). --from names
  // the origin repo; without it, auto-capture the current git repo's root basename ("" when not in a
  // git repo). A triage item defaults to open, priority none (the natural add defaults).
  const triage = !!ctx.flags.triage;
  const originRepoName = triage ? ctx.flags.from ?? originRepo(process.cwd()) : null;
  const id = await createItem(ctx.store ?? ctx.db, {
    type,
    title,
    body: body ?? null,
    projectId: project ? project.id : null,
    priority,
    triage,
    originRepo: originRepoName,
    tags: ctx.flags.tag,
    // The mirror links to the issue (the source of truth) via the existing item-link mechanism;
    // an explicit --link is honoured only when there's no issue.
    linkUrl: issue ? issue.url : ctx.flags.link ?? null,
    roadmap:
      type === "roadmap"
        ? {
            targetDate: ctx.flags["target-date"] ?? null,
            sourceRef: ctx.flags["source-ref"] ?? null,
            owner: ctx.flags.owner ?? null,
          }
        : undefined,
    decision:
      type === "decision"
        ? {
            context: ctx.flags.context ?? null,
            choice: ctx.flags.choice ?? null,
            rationale: ctx.flags.rationale ?? null,
            alternatives: ctx.flags.alternatives ?? null,
            decidedAt: ctx.flags["decided-at"] ?? null,
          }
        : undefined,
    learning:
      type === "learning"
        ? {
            kind: ctx.flags["learn-kind"] ?? null,
            progress: ctx.flags.progress ?? null,
            source: ctx.flags.source ?? null,
            why: ctx.flags.why ?? null,
          }
        : undefined,
  });
  if (issue) {
    const ref = (await refsFor(ctx.store ?? ctx.db, [id])).get(id);
    if (ctx.mode === "json") print(JSON.stringify({ id, ...(ref ? { ref } : {}), issue: issue.number, url: issue.url }));
    else if (ctx.mode === "quiet") print(ref ?? id);
    else print(`${ref ?? id}  → issue #${issue.number} ${issue.url}`);
    return;
  }
  await emitItem(ctx, id);
}

export async function cmdEdit(ctx: Ctx): Promise<void> {
  refuseUnreadFlags("ob edit", ctx.flags, editReads(ctx.flags, "store"));
  let id = ctx.args[0];
  if (!id) throw new UsageError("edit requires an <id>");
  const body = bodyFromFlags(ctx.flags);
  id = (await requireItem(ctx, id)).id;
  const fields: Parameters<typeof editItem>[2] = {};
  if (ctx.flags.title !== undefined) fields.title = ctx.flags.title;
  if (body !== undefined) fields.body = body;
  if (ctx.flags.priority !== undefined) {
    const p = parsePriority(ctx.flags.priority);
    if (p === null) throw new UsageError(`invalid --priority '${ctx.flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
    fields.priority = p;
  }
  if (ctx.flags.project !== undefined || ctx.flags.repo !== undefined) {
    const project = await resolveProject(ctx);
    fields.projectId = project ? project.id : null;
  }
  // OS-26: a priority change is recorded on the trail with `--note` and `--holder`.
  await editItem(ctx.store ?? ctx.db, id, fields, decisionOptsOf(ctx));
  await emitItem(ctx, id);
}

export async function cmdNote(ctx: Ctx): Promise<void> {
  let id = ctx.args[0];
  const text = ctx.args.slice(1).join(" ");
  if (!id || text.length === 0) throw new UsageError("note requires <id> <text>");
  id = (await requireItem(ctx, id)).id;
  await appendNote(ctx.store ?? ctx.db, id, text);
  await emitItem(ctx, id);
}

export async function cmdTag(ctx: Ctx): Promise<void> {
  let id = ctx.args[0];
  const tags = ctx.args.slice(1);
  if (!id || tags.length === 0) throw new UsageError("tag requires <id> <tag>...");
  id = (await requireItem(ctx, id)).id;
  await addTags(ctx.store ?? ctx.db, id, tags);
  // `--repo`/`--project` records the repo alongside the classification, in one command.
  if (ctx.flags.repo !== undefined || ctx.flags.project !== undefined) {
    const project = await resolveProject(ctx);
    await editItem(ctx.store ?? ctx.db, id, { projectId: project ? project.id : null });
  }
  await emitItem(ctx, id);
}

export async function cmdUntag(ctx: Ctx): Promise<void> {
  let id = ctx.args[0];
  const tags = ctx.args.slice(1);
  if (!id || tags.length === 0) throw new UsageError("untag requires <id> <tag>...");
  id = (await requireItem(ctx, id)).id;
  await removeTags(ctx.store ?? ctx.db, id, tags);
  await emitItem(ctx, id);
}

export async function cmdLink(ctx: Ctx): Promise<void> {
  let [from, rel, to] = ctx.args;
  if (!from || !rel || !to) throw new UsageError("link requires <id> <rel> <other-id>");
  if (!VALID_RELS.includes(rel)) {
    throw new UsageError(`invalid rel '${rel}' (expected: ${VALID_RELS.join(", ")})`);
  }
  from = (await requireItem(ctx, from)).id;
  to = (await requireItem(ctx, to)).id;
  await addLink(ctx.store ?? ctx.db, from, rel, to);
  await emitItem(ctx, from);
}

export async function cmdRm(ctx: Ctx): Promise<void> {
  let id = ctx.args[0];
  if (!id) throw new UsageError("rm requires an <id>");
  const row = await requireItem(ctx, id);
  await deleteItem(ctx.store ?? ctx.db, row.id);
  emitId(ctx, row.id, row.ref);
}
