import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { Ctx } from "../../../../apps/cli/src/ctx.ts";
import { UsageError, AppError } from "../../../../apps/cli/src/errors.ts";
import { print, warn } from "../../../../apps/cli/src/output.ts";
import { recordDecision, type DecisionOpts } from "../../../../apps/cli/src/decisions.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import type { Database } from "bun:sqlite";
import { ticketItemIdFor } from "../spinoff-item.ts";
import { agentNoteText } from "../spinoff-state-reason.ts";
import { withStatusWord } from "../spinoff-vocab.ts";
import {
  acquireLease,
  DEFAULT_LEASE_TTL_S,
  formatHold,
  formatNotHeld,
  heartbeatLease,
  LeaseExpiredError,
  formatReacquiredLeases,
  formatLostLease,
  lostLeasesOf,
  sweepExpiredLeases,
  heartbeatLeasesByHolder,
  leaseHolderId,
  leaseStatus,
  liveHold,
  normalizeLeaseResource,
  recordedHold,
  releaseLease,
  waitUntilAcquired,
  LeaseWaitSignalled,
} from "../lease.ts";
import { planLeaseRun, runUnderLease } from "../lease-run.ts";
import { leaseWaitTitle } from "../lease-wait-title.ts";
import {
  AGENT_STATUSES,
  DEFAULT_AGENT_STATUS,
  DEFAULT_AGENT_TTL_S,
  agentStateLabel,
  parseAgentStatus,
  registerAgent,
  heartbeatAgent,
  getAgent,
  listAgents,
  agentsActiveWithin,
  tabTitleEscape,
  effectiveLauncher,
  resetAgentsAndLeases,
  formatAgentsReset,
} from "../agent.ts";
import { isLauncherName, launcherRejection, agentLauncherMap, recordSpinoffSpawnFailure } from "./spinoff.ts";
import { titleSyncWarning } from "../../../../apps/cli/src/t3/dispatch.ts";
import { claimTicketLease, finishAgent, legTicketFor } from "../agent-register.ts";

function holderId(): string {
  return leaseHolderId();
}

/**
 * Put a lifecycle event that is not an ITEM status move onto the ticket's decision trail (1515), e.g. an
 * agent retiring or a lease being forced. The ticket ref resolves through the same identity the dispatch
 * used, so the trail lands on the item the ticket really is. Never throws: a missing item or a failed
 * write is a note beside the event, not a reason to fail it.
 */
async function recordTicketDecision(
  db: Database | Store,
  ticketRef: string | null | undefined,
  from: string,
  to: string,
  decision: DecisionOpts,
): Promise<void> {
  if (!ticketRef) return;
  try {
    const itemId = await ticketItemIdFor(db, ticketRef);
    if (!itemId) return;
    await recordDecision(db, itemId, from, to, decision);
  } catch (e) {
    // The event itself already happened and is reported on stdout; the trail is best effort. But a
    // trail that silently writes nothing looks the same as one that worked, so say so in one line.
    warn(`decision not recorded for ${ticketRef}: ${(e as Error).message}`);
  }
}

/** Human line for `ob agent done`: what went, what this agent released, what it must not drop (341). */
export function formatAgentDone(id: string, removed: boolean, released: string[], kept: string[]): string {
  const bits = [removed ? `done ${id}` : `no agent '${id}'`];
  if (released.length) bits.push(`released ${released.join(", ")}`);
  if (kept.length) bits.push(`kept ${kept.join(", ")}`);
  return bits.join(", ");
}

/** Best-effort branch + worktree root from the cwd git repo (undefined off-repo). */
function gitInfo(cwd: string): { branch?: string | undefined; worktree?: string | undefined } {
  const run = (args: string[]): string | undefined => {
    try {
      const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
      if (p.exitCode !== 0) return undefined;
      const out = new TextDecoder().decode(p.stdout).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };
  return { branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), worktree: run(["rev-parse", "--show-toplevel"]) };
}

// ---------------------------------------------------------------------------
// agent activity registry
// ---------------------------------------------------------------------------

export async function cmdAgent(ctx: Ctx): Promise<void> {
  // 337: ported handlers read and write through ctx.store when there is one (postgres mode, and sqlite
  // mode's wrapper around this same handle) and fall back to the raw handle otherwise.
  const store = ctx.store ?? ctx.db;
  const sub = ctx.args[0];
  const flag = (k: string): string | undefined => {
    const v = (ctx.flags as Record<string, unknown>)[k];
    return typeof v === "string" ? v : undefined;
  };

  if (sub === "active") {
    // "should the Mac stay awake?" — any agent heartbeated within the window (098, StayAwake integration)
    const min = ctx.flags.within ? Number(ctx.flags.within) : 20;
    if (!Number.isFinite(min) || min <= 0) throw new UsageError("agent active --within must be a positive number of minutes");
    const n = await agentsActiveWithin(store, min * 60 * 1000);
    const active = n > 0;
    if (ctx.mode === "json") print(JSON.stringify({ active, count: n, within_min: min }));
    else print(active ? `active (${n} within ${min}m)` : `dormant (none within ${min}m)`);
    return;
  }

  if (sub === "register") {
    // 417: register is a registry write. It must NEVER launch anything or open a
    // tab (opencode cannot pre-mint a session id — 384). Only `ob spinoff` starts an
    // agent. Do not import the launcher here.
    const rawStatus = flag("status");
    const status = rawStatus ? parseAgentStatus(rawStatus) : null;
    if (rawStatus && !status) {
      throw new UsageError(`--status must be one of ${AGENT_STATUSES.join("|")}`);
    }
    // --spawn-failed (#151): this report is the app saying the launch produced NO session, which is a
    // different fact from "the run failed", and only the first invalidates the spinoff row. Carried on
    // #146's existing report rather than a second command, because the agent row and the spinoff row
    // drifted apart exactly by being written from two places. Validated before anything is written, so a
    // malformed report registers nothing.
    //
    // 1189: it no longer also demands `--status failed`. `failed` is a LAUNCHER word and left
    // `agent.status` when the vocabulary split; the spinoff row is where a launch's failure is recorded
    // (`status: pending|failed` + `error`), and this flag is the app's report that moves it there. The
    // status this register writes, if any, is an ordinary one of the five (or the stored one).
    const spawnFailed = ctx.flags["spawn-failed"] === true;
    const ttlS = ctx.flags.ttl ? Number(ctx.flags.ttl) : DEFAULT_AGENT_TTL_S;
    if (!Number.isFinite(ttlS) || ttlS <= 0) {
      throw new UsageError("agent register --ttl must be a positive number of seconds");
    }
    // Where this agent lives (#125). A spinoff launch stamps it from the RESOLVED launcher; a
    // hand-registered agent says so itself, so it can claim its home instead of reading "unknown".
    const launcher = flag("launcher");
    if (launcher && !isLauncherName(launcher)) {
      throw new UsageError(launcherRejection("--launcher", launcher));
    }
    const id = flag("id") ?? holderId();
    const git = gitInfo(process.cwd());
    const existingAgent = await getAgent(store, id);
    // The recorded ticket beats nothing being passed: the heartbeat form (`agent register --id x
    // --status readying`) must refresh the SAME ticket lease it already holds, not drop it.
    // OB-1991: a trial's leg b builder names the plain ticket; it registers on `<ref>-b`.
    const ticket = await legTicketFor(store, id, flag("ticket") ?? existingAgent?.ticket ?? null);
    // Registering with a ticket IS claiming that ticket (#97): this command already knows it, so it is
    // the natural acquisition hook, and a re-register (the heartbeat form) refreshes the same key. A live
    // FOREIGN holder means another session is building/gating it, so refuse loudly instead of letting two
    // sessions work one ticket. --no-lease opts out for a deliberate second registrant. A ready-for-gate
    // spinoff for this builder does not re-claim (577): register still writes note/status.
    //
    // Only `ticket:` is claimed here, NOT the cwd's `worktree:`, because the agent registry is a COEXISTING
    // liveness registry (several rows legitimately share one checkout: an architect plus an ad-hoc agent).
    // The worktree key is claimed where a checkout really is exclusive: a `spinoff` launch, or an architect
    // taking it explicitly (`ob lease acquire worktree:<path> --holder <id>`) for the duration of a gate.
    //
    // --holder names a lease the CALLER already holds, and a hold of the caller's own is compatible, not
    // a collision (#75). The documented gate flow is exactly this: the architect takes `ticket:<n>` for the
    // review, then dispatches a builder for that same ticket, so refusing the dispatch made the flow
    // impossible to perform (and the refusal pointed at --force, i.e. at breaking the architect's own live
    // lease). A hold named this way is LEFT EXACTLY AS IT IS, not re-taken by the agent: rewriting it
    // would shorten the architect's TTL to the agent's, and only its holder should heartbeat it.
    // 352: the claim itself lives in agent-register.ts, so `POST /api/ob/agents` performs the SAME
    // refusal rather than writing the row and leaving the lease to the client's good intentions.
    await claimTicketLease(store, {
      id,
      ticket,
      ttlS,
      holder: typeof ctx.flags.holder === "string" ? ctx.flags.holder : null,
      noLease: ctx.flags["no-lease"] === true,
    });
    const row = await registerAgent(store, {
      id,
      ticket,
      worktree: flag("worktree") ?? git.worktree ?? null,
      branch: flag("branch") ?? git.branch ?? null,
      // No --status: a NEW row gets the agent's own default word, and an EXISTING one is left as it is
      // (the bare re-register is a heartbeat). 1189: the default lives HERE, not in the store, so a
      // launcher creating a row for a tree/lease claims no workflow word at all.
      status: status ?? (existingAgent ? null : DEFAULT_AGENT_STATUS),
      note: flag("note") ?? null,
      launcher: launcher ?? null,
      // --session (#126, reached by 189): the Claude Code session id this row was launched with, so the
      // tab can be resumed. It has to be settable from the CLI because a split command's database half
      // is an `ob agent register` on the server, and a row registered without it is a row nobody can
      // resume. Omitted on a re-register, the stored id is preserved (registerAgent treats it as absent).
      sessionId: flag("session") ?? null,
      ttlS,
    });
    const spinoffRow = spawnFailed
      ? await recordSpinoffSpawnFailure(store, id, flag("note") ?? "spawn produced no session")
      : null;
    // 1579: a t3 builder's thread wears `🙋` while it is parked on the owner and loses it on the next status
    // that is not `needs-human`. Only a register that NAMES a status moves it (the bare form is a heartbeat),
    // and a title that cannot be set is a warning, never a failed register.
    const titleWarning = await titleSyncWarning(row, status);
    if (titleWarning) warn(titleWarning);
    if (ctx.mode === "json") print(JSON.stringify(spawnFailed ? { ...row, spinoff: spinoffRow && withStatusWord(spinoffRow) } : row, null, 2));
    else if (ctx.mode === "quiet") print(row.id);
    else {
      print(`registered ${row.id} — ${row.status}${row.ticket ? ` on ${row.ticket}` : ""}`);
      if (spinoffRow) {
        print(
          spinoffRow.retrying
            ? `  spinoff ${spinoffRow.ticket} re-queued after ${spinoffRow.attempts} failed launch${spinoffRow.attempts === 1 ? "" : "es"}; the next drain launches it again`
            : `  spinoff ${spinoffRow.ticket} marked failed after ${spinoffRow.attempts} failed launches; re-enqueue it by hand once you know why`,
        );
      } else if (spawnFailed) {
        print(`  no launched spinoff under '${id}': nothing to re-queue`);
      }
      // reflect the agent's state in its own tab title (062) — only when attached to a terminal
      if (process.stdout.isTTY) {
        const title = tabTitleEscape(row.status, row.ticket);
        if (title) process.stdout.write(title);
      }
    }
    return;
  }

  if (sub === "heartbeat") {
    const id = ctx.args[1] ?? flag("id") ?? holderId();
    if (!(await heartbeatAgent(store, id))) throw new AppError(`no agent '${id}'`);
    // a long build must not expire its own ticket/worktree lease (#97); an already-expired one is never
    // revived but acquired afresh, and the builder is told (OB-1922)
    const { reacquired } = await heartbeatLeasesByHolder(store, id);
    if (reacquired.length > 0) warn(`note: ${formatReacquiredLeases(id, reacquired)}`);
    // OS-110: a key the row records that another session took is never in that list, so say so and fail
    const lost = await lostLeasesOf(store, (await getAgent(store, id))!);
    for (const hold of lost) warn(formatLostLease(hold));
    if (ctx.mode !== "quiet") print(`beat ${id}`);
    if (lost.length > 0) ctx.exit = 1;
    return;
  }

  if (sub === "done") {
    const id = ctx.args[1] ?? flag("id") ?? holderId();
    // --no-lease clears the ROW ALONE (225), the same opt-out `agent register` takes. A caller that
    // judges every lease its holder holds on its own signal (a lease whose own TTL is current) releases
    // only the ones the evidence proved orphaned, so the row expiry it dispatches must not release the
    // rest.
    // 341: finishAgent releases only leases THIS agent acquired. An architect hold the builder registered
    // under is kept, never dropped — `--holder` here is not a release target.
    const agent = await getAgent(store, id);
    const { done: removed, released, kept } = await finishAgent(store, id, {
      noLease: ctx.flags["no-lease"] === true,
    });
    // 1515: the agent's retirement is a lifecycle event on its TICKET's decision trail. Best effort: a
    // trail write must never turn a successful retire into a failure.
    await recordTicketDecision(store, agent?.ticket, `agent ${id}`, "done", {
      note: ctx.flags.note,
      actor: ctx.flags.holder ?? id,
    });
    if (ctx.mode === "json") {
      print(JSON.stringify({ id, done: removed, released, kept }, null, 2));
    } else if (ctx.mode !== "quiet") {
      print(formatAgentDone(id, removed, released, kept));
    }
    return;
  }

  throw new UsageError(`unknown agent subcommand '${sub ?? ""}' (register|heartbeat|done)`);
}

export async function cmdAgents(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const sub = ctx.args[0];
  if (sub === "reset") {
    if (ctx.args[1] !== undefined) {
      throw new UsageError(`unexpected argument '${ctx.args[1]}' (agents reset [--dry-run])`);
    }
    const dryRun = ctx.flags["dry-run"] === true;
    const report = await resetAgentsAndLeases(store, { dryRun });
    if (ctx.mode === "json") {
      print(JSON.stringify({ dry_run: dryRun, agents: report.agents, leases: report.leases }, null, 2));
      return;
    }
    if (ctx.mode === "quiet") {
      print([...report.agents, ...report.leases].join("\n"));
      return;
    }
    print(formatAgentsReset(report, dryRun));
    return;
  }
  if (sub !== undefined) {
    throw new UsageError(`unknown agents subcommand '${sub}' (reset)`);
  }
  const all = await listAgents(store, { includeExpired: ctx.flags.all === true });
  // "Where does this agent live?" is what you ask when something dies (#125), so `ob agents`, the
  // CROSS-launcher view, answers it on every row: the agent's own launcher, else its launching
  // spinoff's, else "-" (unknown: a pre-0020 row, or one nothing recorded a home for).
  const fromSpinoff = await agentLauncherMap(store);
  const rows = all.map((r) => ({ ...r, launcher: effectiveLauncher(r, fromSpinoff.get(r.id)) }));
  if (ctx.mode === "json") {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(rows.map((r) => r.id).join("\n"));
    return;
  }
  if (rows.length === 0) {
    print("no active agents");
    return;
  }
  print(
    rows
      .map((r) => {
        const state = r.expired ? "expired" : agentStateLabel(r.status, r.run);
        const note = r.note ? `\t— ${agentNoteText(r.status ?? "", r.note)}` : "";
        return `${r.id}\t${state}\t${r.launcher ?? "-"}\t${r.ticket ?? "-"}\t${r.branch ?? "-"}\tbeat ${r.heartbeat_at}${note}`;
      })
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------
// lease
// ---------------------------------------------------------------------------

export async function cmdLease(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const sub = ctx.args[0];
  // --holder names the lease's owner explicitly (#97). The default `<pid>@<host>` belongs to the `ob`
  // process, which exits immediately, so it is useless for anything a LATER command must release/heartbeat (a
  // ticket, a worktree, an app). An architect/agent passes its stable id (`architect-acme`, the branch).
  const holderOf = (): string => {
    const v = ctx.flags.holder;
    return typeof v === "string" && v.trim() ? v.trim() : holderId();
  };
  if (sub === "acquire") {
    // Canonicalise what the caller typed so it is the SAME key the guards derive (#97); otherwise
    // `ticket:CUE-1234` or a `/var` symlink alias would hold a key that protects nothing.
    const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
    if (!resource) throw new UsageError("lease acquire requires a <resource>");
    const ttlS = ctx.flags.ttl ? Number(ctx.flags.ttl) : DEFAULT_LEASE_TTL_S;
    if (!Number.isFinite(ttlS) || ttlS <= 0) {
      throw new UsageError(`lease acquire --ttl must be a positive number of seconds`);
    }
    const holder = holderOf();
    const wait = ctx.flags.wait === true;
    const attempt = () => acquireLease(store, resource, holder, ttlS);
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = wait ? await waitUntilAcquired(attempt, { resource, log: warn, title: leaseWaitTitle(resource, warn) }) : await attempt();
    } catch (err) {
      // A titled wait stopped by Ctrl-C or SIGTERM: the title is back, so exit as the signal would have (OB-2153).
      if (!(err instanceof LeaseWaitSignalled)) throw err;
      ctx.exit = err.exitCode;
      return;
    }
    const hold = result.ok ? null : await liveHold(store, resource);
    if (ctx.mode === "json") {
      print(JSON.stringify({ resource, ...result, hold }, null, 2));
    } else if (ctx.mode === "quiet") {
      if (result.ok) print(holder);
    } else if (result.ok) {
      print(`acquired ${resource} (holder ${result.holder}, ttl ${ttlS}s)`);
    } else {
      print(`denied: ${hold ? formatHold(hold) : `${resource} held by ${result.holder}`}`);
    }
    if (!result.ok) ctx.exit = 1;
    return;
  }
  if (sub === "run") {
    const { resource, holder, command, ttlS, heartbeatMs, capS } = planLeaseRun(ctx.args, ctx.flags);
    ctx.exit = await runUnderLease({
      resource,
      holder,
      command,
      heartbeatMs,
      capS,
      io: {
        acquire: () => acquireLease(store, resource, holder, ttlS),
        release: () => releaseLease(store, resource, holder),
      },
      log: warn,
    });
    return;
  }
  if (sub === "release") {
    const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
    if (!resource) throw new UsageError("lease release requires a <resource>");
    const holder = holderOf();
    // --force is the ONE documented way past a LIVE holder (#97): every guard refuses to stomp one, so
    // breaking a lease whose session is gone is a deliberate, explicit human act, never a side effect.
    const force = ctx.flags.force === true;
    // Read the row BEFORE the delete: on a mismatch the message has to name the holder it found (#75).
    const recorded = await recordedHold(store, resource);
    const released = await releaseLease(store, resource, holder, force);
    // 1515: a FORCED release (or one a caller explained with --note) is a decision, recorded on the
    // ticket item the resource names. A routine release on a land stays quiet: it is the gate flow
    // working, not a call someone made.
    if (released && (force || ctx.flags.note)) {
      const ticketRef = resource.startsWith("ticket:") ? resource.slice("ticket:".length) : null;
      await recordTicketDecision(store, ticketRef, `lease ${resource}`, force ? "released (forced)" : "released", {
        note: ctx.flags.note,
        actor: holder,
      });
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ resource, released, holder, force, recorded }, null, 2));
    } else if (ctx.mode !== "quiet") {
      if (released) print(force ? `released ${resource} (forced)` : `released ${resource}`);
      else print(formatNotHeld("release", resource, holder, recorded));
    }
    // A release that released nothing is a FAILURE the caller must see: the gate flow's "release on
    // land" step looked like it worked while the lease stayed held for its whole TTL (#75).
    if (!released) ctx.exit = 1;
    return;
  }
  if (sub === "heartbeat") {
    const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
    if (!resource) throw new UsageError("lease heartbeat requires a <resource>");
    const holder = holderOf();
    const recorded = await recordedHold(store, resource);
    // OB-1922: an expired lease is not revived. The holder acquires it again, which decides afresh.
    let beat = false;
    let expired: LeaseExpiredError | null = null;
    try {
      beat = await heartbeatLease(store, resource, holder);
    } catch (err) {
      if (!(err instanceof LeaseExpiredError)) throw err;
      expired = err;
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ resource, beat, holder, recorded, ...(expired ? { error: expired.name } : {}) }, null, 2));
    } else if (ctx.mode !== "quiet") {
      if (beat) print(`beat ${resource} (holder ${holder})`);
      else if (expired) print(expired.message);
      else print(formatNotHeld("heartbeat", resource, holder, recorded));
    }
    if (!beat) ctx.exit = 1;
    return;
  }
  if (sub === "status" || sub === undefined) {
    // OB-1922: status is where expired rows get tidied, once they have been expired for over a day.
    const swept = await sweepExpiredLeases(store);
    if (swept.length > 0 && ctx.mode !== "quiet" && ctx.mode !== "json") {
      warn(`swept ${swept.length} lease(s) expired for over a day: ${swept.join(", ")}`);
    }
    const rows = await leaseStatus(store);
    if (ctx.mode === "json") {
      print(JSON.stringify(rows, null, 2));
      return;
    }
    if (ctx.mode === "quiet") {
      print(rows.map((r) => r.resource).join("\n"));
      return;
    }
    if (rows.length === 0) {
      print("no active leases");
      return;
    }
    print(
      rows
        .map((r) => {
          const state = r.expired ? "expired" : "held";
          return `${r.resource}\t${state}\t${r.holder ?? "-"}\tttl=${r.ttl_s ?? "-"}s\tsince ${r.acquired_at ?? "-"}\tbeat ${r.heartbeat_at ?? "-"}`;
        })
        .join("\n"),
    );
    return;
  }
  throw new UsageError(`unknown lease subcommand '${sub}' (acquire|run|release|heartbeat|status)`);
}

// ---------------------------------------------------------------------------
// daemon (launchd)
// ---------------------------------------------------------------------------

export interface PlistOpts {
  logPath: string;
  /** StartInterval in seconds (mutually exclusive with calendar). */
  interval?: number;
  /** StartCalendarInterval time-of-day (mutually exclusive with interval). */
  calendar?: { hour: number; minute: number };
  /** StartCalendarInterval day-of-month (1-31) — combine with calendar for a monthly job. */
  dayOfMonth?: number;
  /** StartCalendarInterval weekday (0/7=Sun … 6=Sat) — combine with calendar for a weekly job. */
  weekday?: number;
  runAtLoad?: boolean;
  /** KeepAlive — relaunch if the process exits. For persistent jobs (a long-running server), not periodic ones. */
  keepAlive?: boolean;
  /** PATH for the job's EnvironmentVariables — launchd's default PATH lacks bun and the tools (wt/git) the jobs shell out to. */
  envPath?: string;
  /** HOME for the job's EnvironmentVariables. Required with envPath: without it the ob wrapper skips ~/.cloudflare_warp_ca.pem and bun fetch dies (601). */
  envHome?: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render a launchd LaunchAgent plist as a string. Pure — no filesystem access. */
export function renderPlist(label: string, args: string[], opts: PlistOpts): string {
  const progArgs = args.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
  let schedule: string;
  if (opts.interval !== undefined) {
    schedule = `    <key>StartInterval</key>\n    <integer>${opts.interval}</integer>`;
  } else if (opts.calendar) {
    const day =
      opts.dayOfMonth !== undefined
        ? `      <key>Day</key>\n      <integer>${opts.dayOfMonth}</integer>\n`
        : "";
    const weekday =
      opts.weekday !== undefined
        ? `      <key>Weekday</key>\n      <integer>${opts.weekday}</integer>\n`
        : "";
    schedule =
      `    <key>StartCalendarInterval</key>\n` +
      `    <dict>\n` +
      day +
      weekday +
      `      <key>Hour</key>\n      <integer>${opts.calendar.hour}</integer>\n` +
      `      <key>Minute</key>\n      <integer>${opts.calendar.minute}</integer>\n` +
      `    </dict>`;
  } else {
    schedule = "";
  }
  const env = opts.envPath
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n      <key>HOME</key>\n      <string>${xmlEscape(opts.envHome ?? homedir())}</string>\n      <key>PATH</key>\n      <string>${xmlEscape(opts.envPath)}</string>\n    </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${progArgs}
    </array>
${env}    <key>RunAtLoad</key>
    <${opts.runAtLoad ? "true" : "false"}/>
${opts.keepAlive ? "    <key>KeepAlive</key>\n    <true/>\n" : ""}${schedule}
    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

export interface DaemonJob {
  job: string;
  label: string;
  args: string[];
  opts: PlistOpts;
}

export function daemonJobs(home: string): DaemonJob[] {
  const ob = join(home, ".local", "bin", "ob");
  const logDir = join(home, ".local", "share", "omnislash", "logs");
  // launchd's default PATH (/usr/bin:/bin:…) lacks bun (the `ob` wrapper's `exec bun`) and the tools the
  // jobs shell out to (wt/git/gh/open). Bake the install-time PATH, with the running bun's dir guaranteed first.
  const envPath = [dirname(process.execPath), process.env.PATH]
    .filter((p): p is string => Boolean(p))
    .join(":");
  const mk = (job: string, args: string[], schedule: Partial<PlistOpts>): DaemonJob => ({
    job,
    label: `com.omnislash.${job}`,
    args: [ob, ...args],
    opts: { logPath: join(logDir, `${job}.log`), runAtLoad: false, envPath, envHome: home, ...schedule },
  });
  return [
    mk("sync", ["sync"], { interval: 3600 }),
    mk("gmail-sync", ["gmail", "sync"], { interval: 300 }), // poll Gmail every 5 min (126)
    mk("cal-sync", ["cal", "sync"], { interval: 900 }), // poll Google Calendar every 15 min (127)
    mk("alerts", ["alerts", "--digest", "--notify"], { calendar: { hour: 8, minute: 0 } }), // the one morning message: --notify sends the digest as ONE Home Assistant push, only when an alert exists (1655)
    mk("web", ["web", "--prebuilt"], { keepAlive: true, runAtLoad: true }), // persistent: the read-only dashboard on :5050. OB-2160: --prebuilt, as in jobs.json; the server-only job serves the dist the deploy built
    mk("whatsapp-bridge", ["whatsapp", "bridge", "run"], { keepAlive: true, runAtLoad: true }), // persistent: the Go bridge (161); `run` blocks (like `web`) so KeepAlive supervises the real process — crash → immediate restart
    mk("whatsapp-sync", ["whatsapp", "sync"], { interval: 60 }), // poll the bridge → ob every 60s so the dashboard feed live-updates (184)
    mk("backup", ["backup"], { calendar: { hour: 3, minute: 15 }, dayOfMonth: 1 }), // monthly: 1st at 03:15 — DB snapshot (StartCalendarInterval Day=1)
    mk("cert-renew", ["cert", "renew"], { calendar: { hour: 3, minute: 40 } }), // daily 03:40, renews inside the last 30 days of a 90-day certificate, so a broken renewal is a JOB FAILING alert (218) a month before it is an outage (220)
    mk("tunnel-check", ["cloudflare", "tunnels"], { calendar: { hour: 7, minute: 30 } }), // daily 07:30 — flag a stale cloudflared connector before Cloudflare emails the advisory (1643). Exit 1 on drift is the signal: a JOB FAILING alert (218) plus the unit's OnFailure ticket, both carrying the per-host fix the command prints. 07:30 so the 08:00 alerts digest has today's verdict.
    mk("creds-check", ["creds", "check", "--all"], { calendar: { hour: 7, minute: 45 } }), // daily 07:45 — asks every credential's provider whether it still works and records each verdict in credential_check (1655). `--all` is every spec in the inventory, so opencode-go/opencode-zen (1656) join with no change here. A failed verdict exits 1 and names which, so a revoked or expired token is a JOB FAILING alert (218) like gmail-sync, not a surprise when the monthly ob backup needs it (1575). 07:45 so the 08:00 alerts digest (rule 11) has today's verdicts; the job itself does not notify.
    mk("role-tick", ["role", "tick"], { interval: 900 }), // every 15 min (OS-67), a CLIENT job: writes what needs each team's architect into its inbox and delivers it into the architect's run on this machine's T3. Nothing new is one line and no T3 call.
    mk("ci-main", ["ci", "main", "--notify"], { interval: 3600 }), // hourly (OB-2276): the catch-up behind the GitHub webhook receiver. Tells a red run on main the receiver missed, once, and its recovery. Exit 1 when a repo could not be read or a note not sent, so a broken catch-up is a JOB FAILING alert. Server only, enabled by hand after one manual run.
  ];
}

/**
 * The jobs a GUI client runs. Since ob 1589 `ob spinoff <ref>` opens its T3 thread in the same invocation, so the 45s
 * `spinoff-drain` poll retired. `role-tick` (OS-67) runs here because a pass may open a role run, and runs open on the
 * caller's own T3, which the server does not have.
 */
const MAC_DAEMON_JOBS = new Set<string>(["role-tick"]);

/** Whether a declared job runs on a client, not the server, so the server's job_run table never sees its runs. */
export function isClientJob(job: string): boolean {
  return MAC_DAEMON_JOBS.has(job);
}

/**
 * Client jobs an older `ob daemon install` wrote and this one no longer does (ob 1589). Install and
 * uninstall both remove a leftover unit/plist, so a machine that re-runs either one stops polling.
 */
export const RETIRED_CLIENT_JOBS: readonly string[] = ["spinoff-drain"];

const NO_CLIENT_JOBS =
  "no client jobs remain: ob spinoff <ref> launches its T3 thread immediately (ob 1589), so nothing polls on this machine";

/** Jobs `ob daemon install` writes on a GUI client. Mac LaunchAgent / Linux systemd --user (448/457/664). */
export function macDaemonJobs(home: string): DaemonJob[] {
  return daemonJobs(home).filter((j) => MAC_DAEMON_JOBS.has(j.job));
}

export function systemdUserUnit(job: string): string {
  return `omnislash-${job}`;
}

export function systemdUserDir(home: string): string {
  return join(home, ".config", "systemd", "user");
}

function systemdQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function execStartLine(args: string[]): string {
  return args.map((a) => (/[\s"]/.test(a) ? `"${systemdQuote(a)}"` : a)).join(" ");
}

/** systemd --user oneshot for a GUI-local interval job. Pure — no filesystem access. */
export function renderSystemdUserService(job: DaemonJob): string {
  const unit = systemdUserUnit(job.job);
  const home = job.opts.envHome ?? "";
  const envPath = job.opts.envPath ?? "";
  return `[Unit]
Description=omnislash ${job.job}: ${job.args.slice(1).join(" ")}

[Service]
Type=oneshot
ExecStart=${execStartLine(job.args)}
Environment="HOME=${systemdQuote(home)}"
Environment="PATH=${systemdQuote(envPath)}"
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${unit}
`;
}

/** systemd --user timer matching launchd StartInterval. AccuracySec must beat the 1min default. */
export function renderSystemdUserTimer(job: DaemonJob): string {
  const unit = systemdUserUnit(job.job);
  const sec = job.opts.interval ?? 45;
  return `[Unit]
Description=omnislash ${job.job} every ${sec}s

[Timer]
Unit=${unit}.service
OnBootSec=${sec}s
OnUnitActiveSec=${sec}s
AccuracySec=5s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function plistPath(home: string, label: string): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export type DaemonSpawn = (cmd: readonly string[]) => { ok: boolean; stdout: string; stderr: string };

export interface DaemonIo {
  home?: string;
  platform?: NodeJS.Platform;
  spawn?: DaemonSpawn;
  mkdirSync?: typeof mkdirSync;
  writeFileSync?: typeof writeFileSync;
  existsSync?: typeof existsSync;
  rmSync?: typeof rmSync;
}

function defaultSpawn(cmd: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([...cmd]);
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function jobSchedule(j: DaemonJob): string {
  if (j.opts.interval !== undefined) return `every ${j.opts.interval}s`;
  if (j.opts.calendar) {
    const when = `${String(j.opts.calendar.hour).padStart(2, "0")}:${String(j.opts.calendar.minute).padStart(2, "0")}`;
    if (j.opts.dayOfMonth !== undefined) return `monthly day ${j.opts.dayOfMonth} ${when}`;
    if (j.opts.weekday !== undefined) return `weekly day ${j.opts.weekday} ${when}`;
    return `daily ${when}`;
  }
  return "on-demand";
}

type DaemonCtx = Pick<Ctx, "args" | "mode">;

function resolvedIo(io: DaemonIo) {
  return {
    home: io.home ?? homedir(),
    platform: io.platform ?? process.platform,
    spawn: io.spawn ?? defaultSpawn,
    mkdirSync: io.mkdirSync ?? mkdirSync,
    writeFileSync: io.writeFileSync ?? writeFileSync,
    existsSync: io.existsSync ?? existsSync,
    rmSync: io.rmSync ?? rmSync,
  };
}

function runLaunchd(ctx: DaemonCtx, io: ReturnType<typeof resolvedIo>): void {
  const { home, spawn } = io;
  const jobs = macDaemonJobs(home);
  const logDir = join(home, ".local", "share", "omnislash", "logs");
  const agentsDir = join(home, "Library", "LaunchAgents");
  const sub = ctx.args[0];
  const launchctl = (args: string[]) => spawn(["launchctl", ...args]);

  // ob 1589: a retired job's plist is removed by install AND uninstall, so either one stops it polling.
  const removeRetired = (): string[] => {
    const removed: string[] = [];
    for (const job of RETIRED_CLIENT_JOBS) {
      const path = plistPath(home, `com.omnislash.${job}`);
      if (!io.existsSync(path)) continue;
      launchctl(["unload", "-w", path]);
      io.rmSync(path, { force: true });
      removed.push(path);
    }
    return removed;
  };

  if (sub === "install") {
    const retired = removeRetired();
    if (jobs.length) {
      io.mkdirSync(logDir, { recursive: true });
      io.mkdirSync(agentsDir, { recursive: true });
    }
    const summary: Array<{ job: string; plist: string; loaded: boolean; note?: string | undefined }> = [];
    for (const j of jobs) {
      const path = plistPath(home, j.label);
      io.writeFileSync(path, renderPlist(j.label, j.args, j.opts));
      launchctl(["unload", path]);
      const load = launchctl(["load", "-w", path]);
      summary.push({ job: j.job, plist: path, loaded: load.ok, note: load.ok ? undefined : load.stderr });
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ action: "install", jobs: summary, retired_removed: retired }, null, 2));
    } else {
      for (const path of retired) print(`removed retired agent ${path}`);
      if (jobs.length === 0) {
        print(NO_CLIENT_JOBS);
        return;
      }
      print(`installed ${summary.length} launchd agents:`);
      for (const s of jobs) {
        print(`  ${s.label} → ${s.args.slice(1).join(" ")}`);
      }
      print(`logs: ${logDir}`);
    }
    return;
  }

  if (sub === "uninstall") {
    const retired = removeRetired();
    const summary: Array<{ job: string; plist: string; removed: boolean }> = [];
    for (const j of jobs) {
      const path = plistPath(home, j.label);
      const existed = io.existsSync(path);
      if (existed) {
        launchctl(["unload", "-w", path]);
        io.rmSync(path, { force: true });
      }
      summary.push({ job: j.job, plist: path, removed: existed });
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ action: "uninstall", jobs: summary, retired_removed: retired }, null, 2));
    } else {
      for (const path of retired) print(`removed retired agent ${path}`);
      const removed = summary.filter((s) => s.removed).length;
      print(`uninstalled ${removed} launchd agents`);
    }
    return;
  }

  const list = spawn(["launchctl", "list"]);
  const loadedLabels = new Set(
    list.ok
      ? list.stdout
          .split("\n")
          .map((l) => l.trim().split(/\s+/).pop() ?? "")
          .filter((l) => l.startsWith("com.omnislash."))
      : [],
  );
  const rows = jobs.map((j) => ({
    job: j.job,
    label: j.label,
    installed: io.existsSync(plistPath(home, j.label)),
    loaded: loadedLabels.has(j.label),
    schedule: jobSchedule(j),
    command: j.args.slice(1).join(" "),
  }));
  const leftover = RETIRED_CLIENT_JOBS.map((job) => plistPath(home, `com.omnislash.${job}`)).filter((p) => io.existsSync(p));
  if (ctx.mode === "json") {
    print(JSON.stringify({ action: "status", jobs: rows, retired_leftover: leftover }, null, 2));
  } else {
    if (rows.length === 0) print(NO_CLIENT_JOBS);
    for (const path of leftover) print(`retired agent still installed: ${path} (ob daemon uninstall removes it)`);
    if (rows.length) print(
      rows
        .map(
          (r) =>
            `${r.label}\t${r.installed ? "installed" : "absent"}\t${r.loaded ? "loaded" : "unloaded"}\t${r.schedule}\t${r.command}`,
        )
        .join("\n"),
    );
  }
}

function runSystemdUser(ctx: DaemonCtx, io: ReturnType<typeof resolvedIo>): void {
  const { home, spawn } = io;
  const jobs = macDaemonJobs(home);
  const unitDir = systemdUserDir(home);
  const sub = ctx.args[0];

  // ob 1589: a retired job's units are removed by install AND uninstall, so either one stops it polling.
  const removeRetired = (): string[] => {
    const removed: string[] = [];
    for (const job of RETIRED_CLIENT_JOBS) {
      const unit = systemdUserUnit(job);
      const servicePath = join(unitDir, `${unit}.service`);
      const timerPath = join(unitDir, `${unit}.timer`);
      if (!io.existsSync(servicePath) && !io.existsSync(timerPath)) continue;
      spawn(["systemctl", "--user", "disable", "--now", `${unit}.timer`]);
      io.rmSync(servicePath, { force: true });
      io.rmSync(timerPath, { force: true });
      removed.push(`${unit}.timer`);
    }
    if (removed.length) spawn(["systemctl", "--user", "daemon-reload"]);
    return removed;
  };

  if (sub === "install") {
    const retired = removeRetired();
    if (jobs.length) io.mkdirSync(unitDir, { recursive: true });
    const summary: Array<{
      job: string;
      unit: string;
      service: string;
      timer: string;
      loaded: boolean;
      note?: string | undefined;
    }> = [];
    for (const j of jobs) {
      const unit = systemdUserUnit(j.job);
      const servicePath = join(unitDir, `${unit}.service`);
      const timerPath = join(unitDir, `${unit}.timer`);
      io.writeFileSync(servicePath, renderSystemdUserService(j));
      io.writeFileSync(timerPath, renderSystemdUserTimer(j));
      spawn(["systemctl", "--user", "daemon-reload"]);
      const enable = spawn(["systemctl", "--user", "enable", "--now", `${unit}.timer`]);
      summary.push({
        job: j.job,
        unit: `${unit}.timer`,
        service: servicePath,
        timer: timerPath,
        loaded: enable.ok,
        note: enable.ok ? undefined : enable.stderr,
      });
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ action: "install", jobs: summary, retired_removed: retired }, null, 2));
    } else {
      for (const unit of retired) print(`removed retired unit ${unit}`);
      if (jobs.length === 0) {
        print(NO_CLIENT_JOBS);
        return;
      }
      print(`installed ${summary.length} systemd --user units:`);
      for (const s of jobs) {
        print(`  ${systemdUserUnit(s.job)}.timer → ${s.args.slice(1).join(" ")}`);
      }
    }
    return;
  }

  if (sub === "uninstall") {
    const retired = removeRetired();
    const summary: Array<{ job: string; unit: string; service: string; timer: string; removed: boolean }> = [];
    for (const j of jobs) {
      const unit = systemdUserUnit(j.job);
      const servicePath = join(unitDir, `${unit}.service`);
      const timerPath = join(unitDir, `${unit}.timer`);
      const existed = io.existsSync(servicePath) || io.existsSync(timerPath);
      spawn(["systemctl", "--user", "disable", "--now", `${unit}.timer`]);
      io.rmSync(servicePath, { force: true });
      io.rmSync(timerPath, { force: true });
      spawn(["systemctl", "--user", "daemon-reload"]);
      summary.push({ job: j.job, unit: `${unit}.timer`, service: servicePath, timer: timerPath, removed: existed });
    }
    if (ctx.mode === "json") {
      print(JSON.stringify({ action: "uninstall", jobs: summary, retired_removed: retired }, null, 2));
    } else {
      for (const unit of retired) print(`removed retired unit ${unit}`);
      const removed = summary.filter((s) => s.removed).length;
      print(`uninstalled ${removed} systemd --user units`);
    }
    return;
  }

  const rows = jobs.map((j) => {
    const unit = systemdUserUnit(j.job);
    const timerName = `${unit}.timer`;
    const installed =
      io.existsSync(join(unitDir, `${unit}.service`)) && io.existsSync(join(unitDir, timerName));
    const enabled = spawn(["systemctl", "--user", "is-enabled", timerName]);
    return {
      job: j.job,
      label: j.label,
      unit: timerName,
      installed,
      loaded: enabled.ok,
      schedule: jobSchedule(j),
      command: j.args.slice(1).join(" "),
    };
  });
  const leftover = RETIRED_CLIENT_JOBS.map((job) => `${systemdUserUnit(job)}.timer`).filter((t) => io.existsSync(join(unitDir, t)));
  if (ctx.mode === "json") {
    print(JSON.stringify({ action: "status", jobs: rows, retired_leftover: leftover }, null, 2));
  } else {
    if (rows.length === 0) print(NO_CLIENT_JOBS);
    for (const unit of leftover) print(`retired unit still installed: ${unit} (ob daemon uninstall removes it)`);
    if (rows.length) print(
      rows
        .map(
          (r) =>
            `${r.unit}\t${r.installed ? "installed" : "absent"}\t${r.loaded ? "loaded" : "unloaded"}\t${r.schedule}\t${r.command}`,
        )
        .join("\n"),
    );
  }
}

export function cmdDaemon(ctx: DaemonCtx, io: DaemonIo = {}): void {
  const sub = ctx.args[0];
  if (sub !== "install" && sub !== "uninstall" && sub !== "status" && sub !== undefined) {
    throw new UsageError(`unknown daemon subcommand '${sub}' (install|uninstall|status)`);
  }
  const resolved = resolvedIo(io);
  if (resolved.platform === "darwin") {
    runLaunchd(ctx, resolved);
    return;
  }
  if (resolved.platform === "linux") {
    runSystemdUser(ctx, resolved);
    return;
  }
  throw new UsageError(`ob daemon is launchd on macOS or systemd --user on Linux, not ${resolved.platform}`);
}
