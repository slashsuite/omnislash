import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn } from "../output.ts";
import { configuredRemoteHost, RemoteConfigUnreadable, sshExec, type RemoteExec } from "../remote.ts";
import {
  dumpReplica,
  expectedFingerprint,
  formatAge,
  readMeta,
  refreshReplica,
  replicaAgeSeconds,
  replicaPath,
  replicaToken,
  skewBackoffUntil,
  STALE_AFTER_S,
} from "../replica.ts";
import { existsSync } from "node:fs";

export interface ReplicaDeps {
  exec?: RemoteExec;
  write?: (bytes: Uint8Array) => Promise<unknown>;
}

export async function cmdReplica(ctx: Ctx, deps: ReplicaDeps = {}): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "dump") return await replicaDump(ctx, deps);
  if (sub === "token") return replicaTokenCmd(ctx);
  if (sub === "refresh") return replicaRefreshCmd(ctx, deps);
  if (sub === "status" || sub === undefined) return replicaStatusCmd(ctx);
  throw new UsageError(`unknown replica subcommand '${sub}' (status|refresh|token|dump)`);
}

/** SERVER side: stream a consistent gzipped copy of the authoritative DB on stdout. */
async function replicaDump(ctx: Ctx, deps: ReplicaDeps): Promise<void> {
  const write = deps.write ?? ((bytes: Uint8Array) => Bun.write(Bun.stdout, bytes));
  const bytes = await dumpReplica(ctx.db, write);
  if (ctx.mode !== "json") warn(`dumped ${bytes} gzipped bytes`);
}

/** SERVER side: the cheap change token the client compares before paying for a transfer. */
function replicaTokenCmd(ctx: Ctx): void {
  const token = replicaToken(ctx.dbPath);
  if (ctx.mode === "json") print(JSON.stringify({ token }));
  else print(token);
}

function replicaRefreshCmd(ctx: Ctx, deps: ReplicaDeps): void {
  const host = configuredRemoteHost(ctx.dbPath);
  if (!host) throw new AppError("no remote_host configured, so there is nothing to refresh from");
  const outcome = refreshReplica({
    dbPath: ctx.dbPath,
    host,
    exec: deps.exec ?? sshExec(),
    force: ctx.flags.force,
  });
  if (ctx.mode === "json") {
    print(JSON.stringify({ host, ...outcome }, null, 2));
  } else if (outcome.error) {
    print(`refresh failed: ${outcome.error}`);
  } else if (outcome.deferred) {
    // 308: not a failure. Replacing the file under an open reader poisons that reader's handle for
    // good, so a refresh that cannot get the replica to itself keeps the copy it has.
    print(`replica busy: another ob process has it open, so the existing copy was kept (it refreshes on the next command)`);
  } else if (outcome.skipped) {
    print(`replica unchanged on ${host} (token ${outcome.token})`);
  } else {
    print(`replica refreshed from ${host} (${outcome.bytes} gzipped bytes)`);
  }
  if (outcome.error) ctx.exit = 1;
}

function replicaStatusCmd(ctx: Ctx): void {
  // A diagnostic: an unreadable config is reported in its output (OB-1912), not thrown as a stack.
  let host: string | null;
  try {
    host = configuredRemoteHost(ctx.dbPath);
  } catch (err) {
    if (!(err instanceof RemoteConfigUnreadable)) throw err;
    if (ctx.mode === "json") print(JSON.stringify({ remote_host: null, mode: "unknown", error: err.message }, null, 2));
    else print(`remote host: UNREADABLE\nerror:       ${err.message}`);
    ctx.exit = 1;
    return;
  }
  const meta = readMeta(ctx.dbPath);
  const path = replicaPath(ctx.dbPath);
  const age = replicaAgeSeconds(meta);
  // OB-1931: the skew backoff is active only inside its window AND for this checkout's expected schema
  // (an updated checkout retries at once). The fingerprint is cached, and only looked up after a skew.
  const backoffUntil = meta.skew_at ? skewBackoffUntil(meta, expectedFingerprint(ctx.dbPath)) : null;
  const status = {
    remote_host: host,
    mode: host ? "remote" : "local",
    replica: path,
    exists: existsSync(path),
    age_s: age,
    age: formatAge(age),
    stale: age === null || age > STALE_AFTER_S,
    token: meta.token,
    dirty: meta.dirty,
    last_refresh_ok: meta.last_refresh_ok,
    last_error: meta.last_error,
    fingerprint: meta.fingerprint,
    last_deferred_at: meta.last_deferred_at,
    skew_at: meta.skew_at,
    skew_backoff_until: backoffUntil,
  };
  if (ctx.mode === "json") {
    print(JSON.stringify(status, null, 2));
    return;
  }
  print(
    [
      `remote host: ${host ?? "(none, ob is in local mode)"}`,
      `replica:     ${path}${status.exists ? "" : " (absent)"}`,
      `age:         ${status.age}${status.stale ? " (stale)" : ""}`,
      `token:       ${meta.token ?? "-"}`,
      `dirty:       ${meta.dirty ? "yes (next read refreshes first)" : "no"}`,
      `last refresh: ${
        backoffUntil && meta.last_error?.startsWith("schema skew")
          ? `failed: schema skew, backing off until ${backoffUntil}`
          : meta.last_refresh_ok
            ? "ok"
            : meta.last_error
              ? `failed: ${meta.last_error}`
              : "never"
      }`,
      `deferred:    ${meta.last_deferred_at ?? "-"}`,
      `fingerprint: ${meta.fingerprint ?? "-"}`,
    ].join("\n"),
  );
}
