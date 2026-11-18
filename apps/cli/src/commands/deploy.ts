// ob 582: what is deployed, per target -- the ob answer to "is that SHA actually serving?".
//
// Today the only record of a deploy is journalctl on the API host (`ob-deploy: deployed <sha>`). This module
// keeps ONE row per deploy target (live omnislash-web on the API host, the ob 581 test/dev instance, ...) with
// the LATEST outcome, so `ob deploy status` answers the question without grepping a log. The writer is
// the server's deploy script (and the 581 web-dev push): a successful deploy, a no-op ("already at
// SHA" -- still refreshed so what's live cannot go stale), a rollback (result=rolled-back, sha = the
// SHA restored), and a refusal (result=refused, sha = the SHA still serving).
import type { Database } from "bun:sqlite";
import { asc, sql } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { asStore, type Store } from "../db/store.ts";
import { nowIso } from "../db.ts";
import { AppError, UsageError } from "../errors.ts";
import { print } from "../output.ts";

export const DEPLOY_RESULTS = ["ok", "rolled-back", "refused"] as const;
export type DeployResult = (typeof DEPLOY_RESULTS)[number];

export interface DeployRow {
  target: string;
  host: string;
  unit: string;
  sha: string;
  at: string;
  result: DeployResult;
}

export async function listDeploys(db: Database | Store): Promise<DeployRow[]> {
  const store = asStore(db);
  const rows = await store.q.select().from(store.t.deploy).orderBy(asc(store.t.deploy.target));
  return rows as DeployRow[];
}

export interface RecordDeployInput {
  target: string;
  host: string;
  unit: string;
  sha: string;
  at?: string;
  result: DeployResult;
}

/**
 * OB-1926: `at` is the ordering key for recordDeploy, compared as text, so it must be one canonical ISO form.
 * Returns the instant as toISOString() prints it, or null when it is not a date at all.
 */
export function canonicalDeployAt(at: string): string | null {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * OB-1926: an older write never overwrites a newer row. ob-deploy.sh passes `--at` with the moment it DECIDED
 * (before the restart and the record retries), so an `ok` decided before an API kick's `refused` cannot land on
 * top of it. A write whose `at` is older than the stored one is a silent no-op; equal or newer applies.
 */
export async function recordDeploy(db: Database | Store, input: RecordDeployInput): Promise<void> {
  const store = asStore(db);
  const at = input.at === undefined ? nowIso() : canonicalDeployAt(input.at);
  if (at === null) throw new Error(`deploy record: --at '${input.at}' is not a date`);
  await store.q
    .insert(store.t.deploy)
    .values({ ...input, at })
    .onConflictDoUpdate({
      target: store.t.deploy.target,
      set: {
        host: sql`excluded.host`,
        unit: sql`excluded.unit`,
        sha: sql`excluded.sha`,
        at: sql`excluded.at`,
        result: sql`excluded.result`,
      },
      setWhere: sql`excluded.at >= ${store.t.deploy.at}`,
    });
}

export function renderDeploys(rows: DeployRow[]): string {
  if (rows.length === 0) return "no deploys recorded yet — ob-deploy.sh writes the first row on its next run";
  return rows
    .map(
      (r) =>
        `${r.target.padEnd(10)} ${r.host.padEnd(8)} ${r.unit.padEnd(22)} ${r.sha}  ${r.at}  ${r.result}`,
    )
    .join("\n");
}

export const LIVE_DEPLOY_TARGET = "live";

/**
 * 1534: a deploy names its SHA. `ob deploy run --sha <sha>` (ob-land calls it with the squash it just
 * pushed) pins the deploy to that commit; the pin travels in the kick's environment so it is enforced
 * where the deploy happens, not where it is requested. ob-deploy.sh refuses rather than deploy
 * something else.
 */
const LIVE_DEPLOY_SHA_ENV = "OMNISLASH_DEPLOY_SHA";

/**
 * The pin reaches a remote shell (the `--ssh` last resort) and the server's request file (the API kick),
 * so it must be a commit id and nothing else. Client and server both check it (OB-1809).
 */
export const DEPLOY_SHA_RE = /^[0-9a-f]{7,40}$/;

export function liveDeploySshArgv(sha?: string): readonly string[] {
  const env = sha === undefined ? "OMNISLASH_REPO=/opt/omnislash" : `OMNISLASH_REPO=/opt/omnislash ${LIVE_DEPLOY_SHA_ENV}=${sha}`;
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "ob-host",
    `nohup env ${env} /opt/omnislash/bin/ob-deploy.sh >/tmp/ob-deploy.log 2>&1 &`,
  ];
}

export const LIVE_DEPLOY_UNKNOWN = {
  host: "api-host",
  unit: "omnislash-web.service",
  sha: "unknown",
} as const;

export type LiveDeploySsh = (argv: readonly string[]) => { code: number };

export function defaultLiveDeploySsh(argv: readonly string[]): { code: number } {
  const p = Bun.spawnSync({ cmd: [...argv], stdout: "ignore", stderr: "pipe" });
  return { code: p.exitCode ?? 1 };
}

export function notOkLiveDeploy(rows: DeployRow[]): DeployRow | null {
  const live = rows.find((r) => r.target === LIVE_DEPLOY_TARGET);
  if (!live || live.result === "ok") return null;
  return live;
}

export async function runLiveDeploy(opts: {
  list: () => Promise<DeployRow[]>;
  record: (input: RecordDeployInput) => Promise<void>;
  ssh: LiveDeploySsh;
  /** 1534: deploy exactly this commit, or refuse on the server. Validated before it reaches argv. */
  sha?: string;
}): Promise<{ kicked: true } | { kicked: false; recorded: RecordDeployInput }> {
  const sshResult = opts.ssh(liveDeploySshArgv(opts.sha));
  if (sshResult.code === 0) return { kicked: true };
  return { kicked: false, recorded: await recordLiveRefused(opts) };
}

/** A kick that never started: live stays on what it was serving, so the refusal keeps that row's host/unit/sha. */
export async function recordLiveRefused(opts: {
  list: () => Promise<DeployRow[]>;
  record: (input: RecordDeployInput) => Promise<void>;
}): Promise<RecordDeployInput> {
  const last = (await opts.list()).find((r) => r.target === LIVE_DEPLOY_TARGET);
  const recorded: RecordDeployInput = {
    target: LIVE_DEPLOY_TARGET,
    host: last?.host ?? LIVE_DEPLOY_UNKNOWN.host,
    unit: last?.unit ?? LIVE_DEPLOY_UNKNOWN.unit,
    sha: last?.sha ?? LIVE_DEPLOY_UNKNOWN.sha,
    result: "refused",
  };
  await opts.record(recorded);
  return recorded;
}

async function cmdDeployRun(ctx: Ctx): Promise<void> {
  const db = ctx.store ?? ctx.db;
  const pin = ctx.flags.sha;
  if (pin !== undefined && (typeof pin !== "string" || !DEPLOY_SHA_RE.test(pin))) {
    throw new UsageError(`deploy run --sha must be a commit id (7-40 lowercase hex), not '${String(pin)}'`);
  }
  const outcome = await runLiveDeploy({
    list: () => listDeploys(db),
    record: (input) => recordDeploy(db, input),
    ssh: ctx.deploySsh ?? defaultLiveDeploySsh,
    sha: pin,
  });
  if (!outcome.kicked) {
    throw new AppError("ssh to ob-host failed; recorded refused for live");
  }
  if (ctx.mode === "json") {
    print(JSON.stringify({ kicked: true, target: LIVE_DEPLOY_TARGET, ...(pin === undefined ? {} : { sha: pin }) }));
  } else if (ctx.mode !== "quiet") {
    print(pin === undefined ? "live deploy kicked" : `live deploy kicked, pinned to ${pin}`);
  }
}

/**
 * `ob deploy status` / `ob deploy record --target <t> --host <h> --unit <u> --sha <s> --result
 * <ok|rolled-back|refused> [--at <iso>]` / `ob deploy run [--sha <sha>]`. The read is the one-liner
 * answer to "what is actually serving right now"; the write is what the deploy scripts call, never a
 * human guessing. `run` (636) kicks live ob-deploy.sh fire-and-forget and returns; `--sha` (1534) pins it
 * to one commit, which the server enforces by refusing anything else. An API client kicks through
 * POST /deploys/run (OB-1809, api/deploy-kick.ts); this store-backed path is the machine with no API, and
 * it still goes over ssh.
 */
export async function cmdDeploy(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "record") {
    await cmdDeployRecord(ctx);
    return;
  }
  if (sub === "run") {
    await cmdDeployRun(ctx);
    return;
  }
  if (sub !== undefined && sub !== "status") {
    throw new UsageError(`unknown deploy subcommand '${sub}' (status|record|run)`);
  }
  const rows = await listDeploys(ctx.store ?? ctx.db);
  if (ctx.mode === "json") {
    print(JSON.stringify(rows, null, 2));
  } else if (ctx.mode === "quiet") {
    print(rows.map((r) => r.target).join("\n"));
  } else {
    print(renderDeploys(rows));
  }
}

function required(ctx: Ctx, name: keyof typeof ctx.flags): string | null {
  const value = ctx.flags[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function cmdDeployRecord(ctx: Ctx): Promise<void> {
  const labels = ["target", "host", "unit", "sha", "result"] as const;
  const missing = labels.filter((l) => required(ctx, l) === null);
  if (missing.length > 0) {
    throw new UsageError(`deploy record requires ${missing.map((l) => `--${l}`).join(" ")}`);
  }
  const target = ctx.flags.target as string;
  const host = ctx.flags.host as string;
  const unit = ctx.flags.unit as string;
  const sha = ctx.flags.sha as string;
  const result = ctx.flags.result as string;
  if (!(DEPLOY_RESULTS as readonly string[]).includes(result)) {
    throw new UsageError(`--result must be one of ${DEPLOY_RESULTS.join("|")}, not '${result}'`);
  }
  const at = typeof ctx.flags.at === "string" && ctx.flags.at.length > 0 ? ctx.flags.at : undefined;
  if (at !== undefined && canonicalDeployAt(at) === null) throw new UsageError(`--at must be an ISO date, not '${at}'`);
  const db = ctx.store ?? ctx.db;
  await recordDeploy(db, { target, host, unit, sha, at, result: result as DeployResult });
  if (ctx.mode !== "quiet") {
    // OB-1926: print what is stored, so a write ignored as older than the row says so.
    const row = (await listDeploys(db)).find((r) => r.target === target);
    print(
      row && row.sha === sha && row.result === result
        ? `recorded ${result} for ${target} @ ${sha.slice(0, 8)}`
        : `ignored: the ${target} row is newer (${row?.result} @ ${row?.sha.slice(0, 8)}, ${row?.at})`,
    );
  }
}