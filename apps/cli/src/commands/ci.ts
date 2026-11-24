// OB-2276: `ob ci main` and `ob github hooks`. The subcommands, the flags and every printed line live HERE, once;
// the local command and the API client differ only in the backend they pass (this host's store, or HTTP). The
// rules are in ../ci-main.ts.
import type { Ctx, Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import {
  ciMainList,
  ciMainNotify,
  githubRestFor,
  hooksApply,
  hooksPlan,
  httpGithubRest,
  renderCiMain,
  renderCiOutcomes,
  renderHooks,
  requireWebhookSecret,
  type CiMainReport,
  type CiOutcome,
  type GithubRest,
  type HookPlanRow,
} from "../ci-main.ts";
import { readGithubToken } from "../net.ts";
import { defaultMasterKey } from "../secrets.ts";
import { storeAgentRegistry, t3Seam } from "../t3/dispatch.ts";
import type { Store } from "../db/store.ts";
import { refuseUnreadFlags } from "./capture.ts";

export interface CiBackend {
  list(project?: string): Promise<CiMainReport[]>;
  notify(project?: string): Promise<{ reports: CiMainReport[]; outcomes: CiOutcome[] }>;
  hooks(apply: boolean): Promise<HookPlanRow[]>;
}

export interface CiCtx {
  args: string[];
  flags: Record<string, unknown>;
  mode: Mode;
  /** Set to 1 when a read or a send failed, so the `ci-main` job's failure is a JOB FAILING alert. */
  exit?: number;
}

/** `ob ci main [--project <p>] [--notify] [--json]`. */
export async function runCi(ctx: CiCtx, be: CiBackend): Promise<void> {
  const sub = ctx.args[0];
  if (sub !== "main") throw new UsageError(`unknown ci subcommand '${sub ?? ""}' (main)`);
  refuseUnreadFlags("ci main", ctx.flags as unknown as Flags, ["project", "notify"]);
  const project = typeof ctx.flags.project === "string" ? ctx.flags.project : undefined;
  if (ctx.flags.notify === true) {
    const res = await be.notify(project);
    if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
    else print(`${renderCiMain(res.reports)}\n${renderCiOutcomes(res.outcomes)}`);
    if (res.reports.some((r) => r.error) || res.outcomes.some((o) => o.action === "failed")) ctx.exit = 1;
    return;
  }
  const reports = await be.list(project);
  if (ctx.mode === "json") print(JSON.stringify(reports, null, 2));
  else print(renderCiMain(reports));
  if (reports.some((r) => r.error)) ctx.exit = 1;
}

/** `ob github hooks [--yes] [--json]`: without --yes a dry run that changes nothing. */
export async function runGithub(ctx: CiCtx, be: CiBackend): Promise<void> {
  const sub = ctx.args[0];
  if (sub !== "hooks") throw new UsageError(`unknown github subcommand '${sub ?? ""}' (hooks)`);
  refuseUnreadFlags("github hooks", ctx.flags as unknown as Flags, ["yes"]);
  const apply = ctx.flags.yes === true;
  const rows = await be.hooks(apply);
  if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
  else print(renderHooks(rows, !apply));
  if (rows.some((r) => r.action === "error" || r.action === "failed")) ctx.exit = 1;
}

/** The backend over a store this process opened: the REST client from this host's `github` secret, T3 here. */
export function storeCiBackend(store: Store): CiBackend {
  const rest = (): Promise<GithubRest> => githubRestFor(async () => httpGithubRest(await readGithubToken(store)));
  return {
    list: async (project) => ciMainList(store, await rest(), project ? { project } : {}),
    notify: async (project) =>
      ciMainNotify(store, { rest: await rest(), registry: storeAgentRegistry(store), start: startSentinelIn(store) }, project ? { project } : {}),
    hooks: async (apply) =>
      apply ? hooksApply(store, await rest(), await requireWebhookSecret(store, defaultMasterKey())) : hooksPlan(store, await rest()),
  };
}

/**
 * OS-181: the catch-up starts a team's sentinel (`ob role start <team> sentinel`) on this machine's T3 when it has no
 * thread, so a red `main` is never told to the architect. The run opens in the team's checkout, as `ob role tick`'s
 * does, not the job's cwd (a timer runs from $HOME). Imported here: role.ts reaches back into dispatch.
 */
function startSentinelIn(store: Store): (team: string) => Promise<string> {
  return async (team) => {
    const { startRoleRun, storeTickBackend } = await import("./role.ts");
    const { teamCheckout } = await import("./role-tick.ts");
    const tick = storeTickBackend(store);
    const view = (await tick.teams()).find((v) => v.name === team);
    const checkout = view ? teamCheckout(view, await tick.checkouts()) : null;
    if (!checkout) throw new Error(`no checkout of team ${team} on this machine`);
    const role = { ...tick.role, team: { ...tick.role.team, cwdRepo: async () => checkout } };
    return (await startRoleRun(role, team, "sentinel", await t3Seam())).thread_id;
  };
}

function ciCtx(ctx: Ctx): CiCtx {
  return { args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode };
}

export async function cmdCi(ctx: Ctx): Promise<void> {
  const c = ciCtx(ctx);
  await runCi(c, storeCiBackend(ctx.store));
  if (c.exit) ctx.exit = c.exit;
}

export async function cmdGithub(ctx: Ctx): Promise<void> {
  const c = ciCtx(ctx);
  await runGithub(c, storeCiBackend(ctx.store));
  if (c.exit) ctx.exit = c.exit;
}
