import { readFileSync } from "node:fs";
import type { Ctx, Flags } from "../ctx.ts";
import { listAgents } from "../../../../platform/cli-coord/src/agent.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import { listProjects } from "../project.ts";
import { storeAgentRegistry, worktreeRepoOf } from "../t3/dispatch.ts";
import { resolveRepoFor } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { doneAgent } from "../../../../platform/cli-coord/src/agent.ts";
import { addTeam, editTeam, getTeam, joinTeam, leaveTeam, listTeamViews, removeTeam, teamInUseRefusal, teamView } from "../team.ts";
import { refuseUnreadFlags } from "./capture.ts";
import { storeConfigIo } from "../model-routes-io.ts";
import { consumeTeamHandoff, latestTeamHandoff, recordTeamHandoff } from "../team-handoff.ts";
import { checkoutOf, runRole, runTeam, t3SubcommandReads, type TeamBackend } from "./t3-team.ts";
import { BROADCAST_AUDIENCES, broadcast, renderBroadcast, type BroadcastAudience, type BroadcastReport } from "../t3/broadcast.ts";
import {
  T3_PINNED_BUILD,
  T3_PINNED_CHANNEL,
  T3Client,
  channelForVersion,
  credentialPath,
  credentialStatus,
  formatDuration,
  mintCredential,
  readCredential,
  t3BaseUrl,
  T3Error,
  type FetchLike,
  type T3Credential,
  type T3ProviderInstance,
} from "../t3/client.ts";
import {
  buildT3Tree,
  looksLikeThreadId,
  readT3Projects,
  readT3Seam,
  readT3Thread,
  readT3View,
  renderT3Projects,
  renderT3ThreadsBlock,
  renderT3Tree,
  threadIdForTicket,
  threadLink,
  t3RowSource,
  unreadT3View,
  type T3ReadView,
} from "../t3/read.ts";

// -----------------------------------------------------------------------------
// `ob t3` (wayfinder 1102, read half 1124): the T3 Code seam's own commands.
//   t3 doctor   is the transport healthy, end to end, with NAMED failures.
//   t3 login    mint (or renew) the MCP credential. T3 advertises no refresh
//               grant, so renewal is re-minting — this is that path.
//   t3 team     teams (OB-2255): add|edit|join|leave|list|show|rm.
//   t3 architect|sentinel|muse
//               open or adopt a team's role thread, idempotently, tracked by
//               thread id, pinned (OB-2255, 1120).
//   t3 status   what T3 is doing: the health stages doctor computes, then every
//               project's threads newest first, joined to the ob ticket each one
//               belongs to (1124).
//   t3 projects T3's registered projects, read LIVE — no mirror table (1124).
//   t3 tree     the team thread → builder graph: T3's own parent links over ob's
//               rows (1124).
//   t3 open     resolve a ticket's stamped thread and print its T3 link (1124).
// The launcher's other half lives in the spinoff drain (`--launcher t3`), which
// is where a builder thread is opened; NOTHING here dispatches work, and the
// read subcommands write no T3 state at all.
// -----------------------------------------------------------------------------

export interface T3DoctorStage {
  readonly stage: string;
  readonly ok: boolean;
  readonly detail: string;
  /** One-line remedy; present on a failed stage. */
  readonly remedy?: string;
}

export interface T3DoctorReport {
  readonly baseUrl: string;
  readonly credentialPath: string;
  readonly stages: T3DoctorStage[];
  version: string | null;
  channel: string | null;
  readonly pinnedBuild: string;
  readonly pinnedChannel: string;
  versionDrift: boolean;
  projects: Array<{ id: string; title: string; workspaceRoot: string }>;
  providers: Array<{ id: string; displayName: string; models: number; healthy: boolean; note: string | null }>;
  tools: number;
  readonly expiresAt: string | null;
  ok: boolean;
}

function providerNote(p: T3ProviderInstance): string | null {
  const constraints = p.constraints ?? [];
  return constraints.length > 0 ? constraints[0]! : null;
}

/**
 * The `stage  ok  detail` lines every T3 health view prints, with a failed stage's one-line remedy under
 * it. Shared by `ob t3 doctor` and `ob t3 status` so the two cannot describe one server two ways. Pure.
 */
export function renderT3StageLines(report: T3DoctorReport): string[] {
  const lines: string[] = [];
  for (const s of report.stages) {
    const mark = s.ok ? "ok" : "FAILED";
    lines.push(`  ${s.stage.padEnd(13)} ${mark.padEnd(6)} ${s.detail}`);
    if (!s.ok && s.remedy) lines.push(`  ${" ".repeat(13)} → ${s.remedy}`);
  }
  return lines;
}

/** The health stages `ob t3 status` shows: server, credential, version. The rest is `ob t3 doctor`'s. */
export const T3_STATUS_STAGES = ["server", "credential", "version"] as const;

export function renderT3Doctor(report: T3DoctorReport, mode: Mode): string {
  if (mode === "json") return JSON.stringify(report, null, 2);
  if (mode === "quiet") return report.stages.map((s) => `${s.stage}\t${s.ok ? "ok" : "failed"}`).join("\n");

  const lines: string[] = ["T3 Code doctor", `  server        ${report.baseUrl}`, ...renderT3StageLines(report)];
  if (report.version) {
    const pin = report.versionDrift
      ? `MISMATCH — map pins ${report.pinnedBuild} (${report.pinnedChannel})`
      : "matches the map pin";
    lines.push(`  build         ${report.version} · channel ${report.channel ?? "unknown"} · ${pin}`);
  }
  lines.push(`  credential    ${report.credentialPath}`);
  if (report.expiresAt) lines.push(`  expires       ${report.expiresAt}`);
  if (report.projects.length > 0) {
    lines.push("  projects");
    for (const p of report.projects) lines.push(`    ${p.title.padEnd(12)} ${p.id}  ${p.workspaceRoot}`);
  }
  if (report.providers.length > 0) {
    lines.push("  providers");
    for (const p of report.providers) {
      const state = p.healthy ? `${p.models} models` : `UNAVAILABLE${p.note ? ` — ${p.note}` : ""}`;
      lines.push(`    ${p.id.padEnd(12)} ${state}`);
    }
  }
  if (report.ok) lines.push("\nTransport ok: MCP over OAuth on " + report.baseUrl + ".");
  return lines.join("\n");
}

/**
 * The doctor report — the stages, the version, the projects and the providers — assembled ONCE and
 * reused by `ob t3 doctor` and `ob t3 status` (1124's "never re-implemented" rule): the two views cannot
 * disagree about whether the transport is healthy because there is one measurement behind both.
 *
 * `deps` is the test seam for the transport (`fetchImpl`); production omits it.
 */
export async function buildT3DoctorReport(
  baseUrl: string,
  credential: T3Credential | null,
  env: NodeJS.ProcessEnv,
  readError: T3Error | null = null,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<T3DoctorReport> {
  return buildReport(baseUrl, credential, env, readError, deps);
}

async function buildReport(
  baseUrl: string,
  credential: T3Credential | null,
  env: NodeJS.ProcessEnv,
  readError: T3Error | null = null,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<T3DoctorReport> {
  const stages: T3DoctorStage[] = [];
  const path = credentialPath(env);
  const probe = new T3Client({ baseUrl, env, credential: null, ...deps });

  const reach = await probe.reachable();
  stages.push({
    stage: "server",
    ok: reach.ok,
    detail: reach.ok ? `${reach.detail} responding` : reach.detail,
    ...(reach.ok ? {} : { remedy: "start T3 (`t3 serve`), or set T3_BASE_URL" }),
  });

  if (readError) {
    stages.push({
      stage: "credential",
      ok: false,
      detail: readError.message,
      remedy: readError.remedy ?? "run `ob t3 login`",
    });
    return {
      baseUrl,
      credentialPath: path,
      stages,
      version: null,
      channel: null,
      pinnedBuild: T3_PINNED_BUILD,
      pinnedChannel: T3_PINNED_CHANNEL,
      versionDrift: false,
      projects: [],
      providers: [],
      tools: 0,
      expiresAt: null,
      ok: false,
    };
  }

  const status = credentialStatus(credential, Date.now(), env);
  if (!status.present) {
    stages.push({
      stage: "credential",
      ok: false,
      detail: `missing at ${path}`,
      remedy: "run `ob t3 login`",
    });
    return {
      baseUrl,
      credentialPath: path,
      stages,
      version: null,
      channel: null,
      pinnedBuild: T3_PINNED_BUILD,
      pinnedChannel: T3_PINNED_CHANNEL,
      versionDrift: false,
      projects: [],
      providers: [],
      tools: 0,
      expiresAt: null,
      ok: false,
    };
  }

  stages.push({
    stage: "credential",
    ok: !status.expired,
    detail: status.expired
      ? `EXPIRED ${status.expiresAt ?? ""}`
      : `present at ${path}, ${status.msRemaining !== null ? formatDuration(status.msRemaining) : "unknown ttl"} left`,
    ...(status.expired ? { remedy: "run `ob t3 login` to renew (no refresh grant)" } : {}),
  });

  const report: T3DoctorReport = {
    baseUrl,
    credentialPath: path,
    stages,
    version: null,
    channel: null,
    pinnedBuild: T3_PINNED_BUILD,
    pinnedChannel: T3_PINNED_CHANNEL,
    versionDrift: false,
    projects: [],
    providers: [],
    tools: 0,
    expiresAt: status.expiresAt,
    ok: false,
  };

  if (status.expired) return report;
  if (!reach.ok) return report;

  const client = new T3Client({ baseUrl, env, credential, ...deps });
  try {
    const init = await client.initialize();
    report.version = init.serverVersion;
    report.channel = channelForVersion(init.serverVersion);
    report.versionDrift = init.serverVersion !== T3_PINNED_BUILD;
    stages.push({
      stage: "version",
      ok: true,
      detail: `T3 Code ${init.serverVersion} (channel ${report.channel})${report.versionDrift ? ` — map pins ${T3_PINNED_BUILD}` : ""}`,
    });
  } catch (err) {
    const e = err as T3Error;
    stages.push({
      stage: "version",
      ok: false,
      detail: e.message,
      remedy: e.remedy ?? "run `ob t3 login`",
    });
    return report;
  }

  try {
    const env_ = await client.environment();
    stages.push({ stage: "environment", ok: true, detail: `${env_.label} (${env_.environmentId}, ${env_.platform.os}/${env_.platform.arch})` });
  } catch (err) {
    stages.push({ stage: "environment", ok: false, detail: (err as Error).message, remedy: "re-run `ob t3 login`" });
  }

  try {
    report.projects = (await client.projects()).filter((p) => !p.deletedAt);
    stages.push({
      stage: "projects",
      ok: report.projects.length > 0,
      detail: report.projects.map((p) => p.title).join(", ") || "none mapped",
      ...(report.projects.length === 0 ? { remedy: "register the repo as a T3 project (`t3 project add`)" } : {}),
    });
  } catch (err) {
    stages.push({ stage: "projects", ok: false, detail: (err as Error).message, remedy: "`ob t3 doctor` again after restarting T3" });
  }

  try {
    const caps = await client.capabilities();
    report.providers = caps.providers.map((p) => ({
      id: p.providerInstanceId,
      displayName: p.displayName,
      models: p.models.length,
      healthy: (p.constraints ?? []).length === 0 && p.models.length > 0,
      note: providerNote(p),
    }));
    const healthy = report.providers.filter((p) => p.healthy).length;
    stages.push({
      stage: "providers",
      ok: healthy > 0,
      detail: `${healthy}/${report.providers.length} instances usable`,
      ...(healthy === 0 ? { remedy: "authenticate a provider in T3 (e.g. `codex login`)" } : {}),
    });
  } catch (err) {
    stages.push({ stage: "providers", ok: false, detail: (err as Error).message, remedy: "`ob t3 doctor` again after restarting T3" });
  }

  try {
    report.tools = (await client.tools()).length;
    stages.push({ stage: "tools", ok: report.tools > 0, detail: `${report.tools} MCP tools advertised` });
  } catch (err) {
    stages.push({ stage: "tools", ok: false, detail: (err as Error).message, remedy: "the MCP endpoint is not answering tools/list" });
  }

  report.ok = stages.every((s) => s.ok) && report.version !== null;
  return report;
}

/**
 * The audience and the text of `ob t3 broadcast <architects|threads> <message…>` (OB-2187, OB-2255): the message is the
 * rest of the arguments, or `--message-file <path>`; an empty one refuses before T3 is touched.
 */
export function broadcastInput(args: string[], flags: Pick<Flags, "message-file">): { audience: BroadcastAudience; text: string } {
  const audience = args[1] as BroadcastAudience | undefined;
  if (!audience || !BROADCAST_AUDIENCES.includes(audience)) {
    throw new UsageError("t3 broadcast requires an audience: `ob t3 broadcast architects <message>` or `ob t3 broadcast threads <message>`");
  }
  const file = flags["message-file"] ?? null;
  const inline = args.slice(2).join(" ");
  if (file && inline.trim()) throw new UsageError("t3 broadcast takes the message as arguments or --message-file, not both");
  let text = inline;
  if (file) {
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new UsageError(`cannot read --message-file ${file}: ${(err as Error).message}`);
    }
  }
  if (!text.trim()) throw new UsageError("t3 broadcast refuses an empty message");
  return { audience, text };
}

/** Print a broadcast report in the run's mode; exit 1 if any send failed. Shared by the local and API paths. */
export function emitBroadcast(ctx: { mode: Ctx["mode"]; exit?: number }, report: BroadcastReport): void {
  print(
    ctx.mode === "json"
      ? JSON.stringify(report, null, 2)
      : ctx.mode === "quiet"
        ? report.rows.filter((r) => r.action === "sent" || r.action === "would-send").map((r) => r.threadId).join("\n")
        : renderBroadcast(report),
  );
  if (report.failed > 0) ctx.exit = 1;
}

// -----------------------------------------------------------------------------
// `ob t3 status` (1124) — the health stages doctor computes, then the threads.
// -----------------------------------------------------------------------------

/**
 * The read surface's status report: `doctor` is `buildT3DoctorReport`'s own object (not a re-derivation of
 * it), and `view` is the read — the threads, the ones needing the human, and which side failed if either.
 */
export interface T3StatusReport {
  doctor: T3DoctorReport;
  view: T3ReadView;
}

/** Are the three HEALTH stages (server, credential, version) all ok? The inventory stages are not the
 *  question `ob t3 status` asks, and a project/provider gap must not fail a readable thread list. Pure. */
export function t3HealthOk(report: T3DoctorReport): boolean {
  const health = report.stages.filter((s) => (T3_STATUS_STAGES as readonly string[]).includes(s.stage));
  return health.length > 0 && health.every((s) => s.ok);
}

/**
 * The one-line reason the threads were NOT read, taken from the first failed HEALTH stage: its own detail
 * and remedy, because in `-q` nothing else is printed. Falls back to naming `ob t3 doctor`. Pure.
 */
export function healthNotReadReason(report: T3DoctorReport): string {
  const failed = report.stages.find((s) => (T3_STATUS_STAGES as readonly string[]).includes(s.stage) && !s.ok);
  if (!failed) return "T3 is not healthy — run `ob t3 doctor`";
  return failed.remedy ? `${failed.detail} — ${failed.remedy}` : `${failed.stage} failed: ${failed.detail}`;
}

/** `ob t3 status` in the caller's mode. Pure. */
export function renderT3Status(report: T3StatusReport, mode: Mode): string {
  const healthOk = t3HealthOk(report.doctor);
  const { view } = report;
  // The read's own failure, whichever way it arrives: a failed health stage (the read was never attempted)
  // or a read that failed after the stages passed. It is a REASON, not a pointer — `-q` prints it alone.
  const notRead = view.error ?? (healthOk ? null : healthNotReadReason(report.doctor));

  if (mode === "json") {
    return JSON.stringify(
      {
        doctor: report.doctor,
        projects: view.projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot })),
        threads: view.threads,
        needs_you: view.needsYou.map((t) => t.threadId),
        unreadable: view.unreadable,
        truncated: view.truncated,
        error: notRead,
        rows_error: view.rowsError,
      },
      null,
      2,
    );
  }
  if (mode === "quiet") {
    // -q prints the ids when the threads were read, and the REASON when they were not: an empty line plus
    // exit 1 would be the same silent failure the ticket forbids, in one word instead of a list.
    if (notRead) return notRead;
    return view.threads.map((t) => t.threadId).join("\n");
  }

  const health: T3DoctorReport = { ...report.doctor, stages: report.doctor.stages.filter((s) => (T3_STATUS_STAGES as readonly string[]).includes(s.stage)) };
  const lines: string[] = ["T3 Code status", `  server        ${report.doctor.baseUrl}`, ...renderT3StageLines(health)];
  if (report.doctor.version) {
    lines.push(`  build         ${report.doctor.version} · channel ${report.doctor.channel ?? "unknown"}`);
  }
  // A failed health stage means the threads were NOT read: saying so beats printing "(none)", which reads
  // as "nothing is running" — the exact confusion the read surface exists to remove. When the STAGES are
  // printed above (human mode) the line points at them; `-q`/`--json` carry the full reason instead, since
  // nothing else is printed there.
  if (notRead) {
    const line = healthOk ? notRead : "T3 is not healthy; fix the failed stage above (`ob t3 doctor`)";
    lines.push(`  threads       not read — ${line}`);
    return lines.join("\n");
  }
  lines.push(`  threads       ${view.threads.length}`);
  lines.push(...renderT3ThreadsBlock(view, "  "));
  return lines.join("\n");
}

/** The `ob t3 open` outcome: the thread, its live state, and T3's own link for it. */
export interface T3OpenOutcome {
  ticket: string | null;
  threadId: string;
  title: string;
  status: string;
  settled: boolean;
  link: string;
}

/** `ob t3 open` in the caller's mode. The link is printed VERBATIM — never markdown-wrapped — so it can
 *  be pasted straight into T3 Code. Pure. */
export function renderT3Open(o: T3OpenOutcome, mode: Mode): string {
  if (mode === "json") return JSON.stringify(o, null, 2);
  if (mode === "quiet") return o.link;
  return [`${o.title}  ${o.status}${o.settled ? " (settled)" : ""}`, o.link].join("\n");
}

/** Read the stored credential without throwing: a read failure is a doctor STAGE, not a crash. */
function credentialOrError(env: NodeJS.ProcessEnv): { credential: T3Credential | null; readError: T3Error | null } {
  try {
    return { credential: readCredential(env), readError: null };
  } catch (err) {
    return { credential: null, readError: err as T3Error };
  }
}

/**
 * In `-q` the diagnostics are NOT on stdout (which is thread ids, or the one reason there are none), so
 * they go to stderr. A non-zero exit with nothing explaining it is the silent failure this ticket forbids,
 * in the one mode where a human is least likely to look at stdout.
 */
function warnQuietDiagnostics(view: T3ReadView, mode: Mode): void {
  if (mode !== "quiet") return;
  if (view.rowsError) warn(`t3: the ob rows could not be read — ${view.rowsError} (threads shown unattributed)`);
  for (const u of view.unreadable) warn(`t3: could not read thread ${u.threadId} — ${u.reason}`);
  if (view.truncated > 0) warn(`t3: ${view.truncated} project(s) hold more threads than one page`);
}

/** The store-backed `TeamBackend` (OB-2255): the teams, the role rows and the cwd's checkout, on this machine. */
export function storeTeamBackend(store: Ctx["db"] | NonNullable<Ctx["store"]>): TeamBackend {
  const view = async (name: string) => {
    const t = await getTeam(store, name);
    return t ? teamView(store, t) : null;
  };
  return {
    list: () => listTeamViews(store),
    show: view,
    add: async (input) => teamView(store, await addTeam(store, input)),
    edit: async (name, patch) => {
      const t = await editTeam(store, name, patch);
      return t ? teamView(store, t) : null;
    },
    join: async (name, projects) => {
      const res = await joinTeam(store, name, projects);
      return { team: await teamView(store, res.team), joined: res.joined };
    },
    leave: (projects) => leaveTeam(store, projects),
    remove: async (name, force) => {
      const res = await removeTeam(store, name, { force });
      if (!res.removed && res.reason === "unknown") throw new AppError(`no team '${name}'`);
      if (!res.removed) throw new AppError(teamInUseRefusal(name, res.members, res.threads));
      return res;
    },
    dropRow: (id) => doneAgent(store, id),
    registry: storeAgentRegistry(store),
    cwdRepo: async () => {
      const resolved = await resolveRepoFor(store, checkoutOf(process.cwd()));
      return worktreeRepoOf(resolved) ?? resolved;
    },
    projects: () => listProjects(store),
    handoffRecord: (team, role, body, from) => recordTeamHandoff(store, { team, role, body, fromThreadId: from ?? null }),
    handoffLatest: (team, role, filter) => latestTeamHandoff(store, team, role, filter),
    handoffConsume: async (team, id, newThreadId) => {
      await consumeTeamHandoff(store, team, id, newThreadId);
    },
    configIo: storeConfigIo(store),
  };
}

export async function cmdT3(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "doctor";
  // OB-2255: a flag this subcommand does not read is refused by name, before anything is read or changed
  // (an ignored `--dry-run` once opened a real thread).
  refuseUnreadFlags(`ob t3 ${sub}`, ctx.flags, t3SubcommandReads(ctx.args));
  const env = process.env;
  const baseUrl = ctx.flags["base-url"] ?? t3BaseUrl(env);
  const store = ctx.store ?? ctx.db;

  if (sub === "login") {
    const access = ctx.flags.access ?? undefined;
    const pairingTtl = ctx.flags.ttl ?? undefined;
    const { credential, path, steps } = await mintCredential({
      baseUrl,
      env,
      ...(access === undefined ? {} : { access }),
      ...(pairingTtl === undefined ? {} : { pairingTtl }),
    });
    if (ctx.mode === "json") {
      print(JSON.stringify({ credentialPath: path, expiresAt: credential.expiresAt, scopes: credential.scopes, access: credential.access, steps }, null, 2));
      return;
    }
    for (const step of steps) warn(step);
    print(`T3 MCP credential stored at ${path}\n  access   ${credential.access}\n  scopes   ${credential.scopes.join(" ")}\n  expires  ${credential.expiresAt}\nNothing was committed; the file is mode 600 outside the repo.`);
    return;
  }

  if (sub === "doctor") {
    const { credential, readError } = credentialOrError(env);
    const report = await buildT3DoctorReport(baseUrl, credential, env, readError);
    print(renderT3Doctor(report, ctx.mode));
    if (!report.ok) ctx.exit = 1;
    return;
  }

  if (sub === "status") {
    const { credential, readError } = credentialOrError(env);
    const doctor = await buildT3DoctorReport(baseUrl, credential, env, readError);
    // The health stages come FIRST and on their own: an unreachable server or a rejected credential is
    // answered by printing them and exiting non-zero, never by an empty thread list that reads as
    // "nothing is running" (the ticket's rule). `ob t3 doctor` is the remedy the failed stage names.
    if (!t3HealthOk(doctor)) {
      print(renderT3Status({ doctor, view: unreadT3View(healthNotReadReason(doctor)) }, ctx.mode));
      ctx.exit = 1;
      return;
    }
    const view = await readT3View(t3RowSource(store), {}, await readT3Seam());
    print(renderT3Status({ doctor, view }, ctx.mode));
    // A read that failed after the stages passed, or an unreadable ob join, is still not a complete
    // answer: it is printed (the threads that WERE read stay visible) and the exit code says so.
    warnQuietDiagnostics(view, ctx.mode);
    if (view.error || view.rowsError) ctx.exit = 1;
    return;
  }

  if (sub === "projects") {
    const rows = await readT3Projects(await readT3Seam());
    print(
      ctx.mode === "json"
        ? JSON.stringify(rows, null, 2)
        : ctx.mode === "quiet"
          ? rows.map((r) => r.id).join("\n")
          : renderT3Projects(rows),
    );
    return;
  }

  if (sub === "tree") {
    const includeSubagents = !!ctx.flags.subagents;
    const view = await readT3View(t3RowSource(store), { includeSubagents }, await readT3Seam());
    if (view.error) {
      // No tree at all: the failure is printed (with its remedy, from the decoration) and the exit code
      // is non-zero — never an empty tree that reads as "nothing is running". `-q` prints the reason
      // ALONE, like `t3 status -q` does, so quiet output stays one machine-readable line.
      print(
        ctx.mode === "json"
          ? JSON.stringify({ projects: [], error: view.error, rows_error: null }, null, 2)
          : ctx.mode === "quiet"
            ? view.error
            : `T3 Code tree (not read)\n  could not read T3 — ${view.error}`,
      );
      ctx.exit = 1;
      return;
    }
    const tree = buildT3Tree(view.projects, view.threads);
    print(
      ctx.mode === "json"
        ? JSON.stringify({ projects: tree, unreadable: view.unreadable, truncated: view.truncated, error: null, rows_error: view.rowsError }, null, 2)
        : ctx.mode === "quiet"
          ? view.threads.map((t) => t.threadId).join("\n")
          : renderT3Tree(tree, { unreadable: view.unreadable, truncated: view.truncated, rowsError: view.rowsError }),
    );
    // The human and the JSON views carry the SAME diagnostics; the exit code carries them too.
    warnQuietDiagnostics(view, ctx.mode);
    if (view.rowsError) ctx.exit = 1;
    return;
  }

  if (sub === "open") {
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("t3 open requires a <ticket|thread-id>");
    let threadId: string;
    let ticket: string | null = null;
    if (looksLikeThreadId(ref)) {
      threadId = ref;
    } else {
      const hit = threadIdForTicket(await t3RowSource(store).spinoffs(), ref);
      if (!hit) {
        throw new AppError(
          `no T3 thread is stamped for '${ref}' — a spinoff row only carries one once a --launcher t3 drain has launched (or adopted) it; \`ob spinoff list\` shows the rows`,
        );
      }
      threadId = hit.threadId;
      ticket = hit.row.ticket_ref;
    }
    // The thread is READ, not assumed: a stale id would otherwise print a link to nothing, and an
    // unreachable T3 must fail here like every other read command rather than hand out a dead link.
    const thread = await readT3Thread(await readT3Seam(), threadId);
    print(
      renderT3Open(
        { ticket, threadId, title: thread.title, status: thread.status, settled: thread.settled, link: threadLink(threadId) },
        ctx.mode,
      ),
    );
    return;
  }

  if (sub === "broadcast") {
    const { audience, text } = broadcastInput(ctx.args, ctx.flags);
    const report = await broadcast({ audience, text, rows: audience === "architects" ? await listAgents(store, { includeExpired: true }) : [], dryRun: ctx.flags["dry-run"] === true });
    emitBroadcast(ctx, report);
    return;
  }

  if (sub === "team") {
    await runTeam(ctx, storeTeamBackend(store));
    return;
  }

  if (sub === "architect" || sub === "sentinel" || sub === "muse") {
    await runRole(ctx, storeTeamBackend(store), sub);
    return;
  }

  throw new UsageError(`unknown t3 subcommand '${sub}' (doctor, login, team, architect, sentinel, muse, broadcast, status, projects, tree, open)`);
}
