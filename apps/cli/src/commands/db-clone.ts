// OS-222: `ob db clone`, one command that refreshes a personal test copy of the live Postgres database.
//
// The work is done by a clone script that runs INSIDE the database container as its OS superuser (restore aside,
// row-count checks, canary, swap; it only ever reads live). This command does three things around it, all from
// THIS machine and none of them through the tracker or the API:
//
//   1. refuse a target that is live, protected, a template or a reserved name, before anything runs;
//   2. install the script in the container when it is missing or differs from the copy named in the profile;
//   3. run it with the target and the role to grant, stream its output, and end with the connection hint.
//
// Where the container is and how to reach it is a machine-local profile (JSON), never a hard-coded host:
// `OB_DB_CLONE_FILE`, else `$XDG_CONFIG_HOME/ob/db-clone.json` (`~/.config/ob/db-clone.json`). `pct` on PATH means
// this machine is the Proxmox host; otherwise the profile's ssh words reach it. A machine that can reach neither
// is refused by name: the API host cannot run this for it, because the container is not the API host's.
//
// The script contract: it reads OBPG_DB (live), OBPG_DEV_DB (the target) and OBPG_GRANT_ROLE (optional), and
// exits non-zero on any failed check, leaving the previous copy in place.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppError, UsageError } from "../errors.ts";
import { expandHome } from "../net.ts";
import { print } from "../output.ts";
import { shellWords } from "../remote.ts";
import type { Flags } from "../ctx.ts";
import type { Mode } from "../output.ts";

const DB_CLONE_FILE_ENV = "OB_DB_CLONE_FILE";

export interface CloneProfile {
  /** The profile file this was read from, for messages. */
  file: string;
  /** The clone script on this machine, absolute (relative paths resolve against the profile's real directory). */
  script: string;
  /** Where the script lives inside the container. */
  installPath: string;
  /** The Proxmox container id. */
  container: string;
  /** ssh words that reach the Proxmox host when `pct` is not on this machine's PATH (`["root@10.0.0.2"]`). */
  ssh: string[];
  /** The OS user the script runs as inside the container. */
  runAs: string;
  /** The live database. Never a target. */
  liveDb: string;
  /** Other databases that are never a target (a shared dev copy). */
  protect: string[];
  /** The default target. */
  target: string;
  /** The default role to grant on the copy, or null for none. */
  grantRole: string | null;
  /** The secret that holds the copy's connection URL, named in the closing hint (its value is never read). */
  urlSecret: string | null;
}

const IDENT = /^[a-z][a-z0-9_]*$/;

/** `OB_DB_CLONE_FILE`, else `~/.config/ob/db-clone.json` (XDG_CONFIG_HOME honoured). Pure. */
export function cloneProfilePath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env[DB_CLONE_FILE_ENV]?.trim();
  if (explicit) return resolve(expandHome(explicit));
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "ob", "db-clone.json");
}

function str(raw: Record<string, unknown>, key: string, file: string, fallback?: string): string {
  const v = raw[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || v.trim() === "") throw new UsageError(`${file}: "${key}" must be a non-empty string`);
  return v.trim();
}

function optStr(raw: Record<string, unknown>, key: string, file: string): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new UsageError(`${file}: "${key}" must be a string`);
  return v.trim() || null;
}

function strList(raw: Record<string, unknown>, key: string, file: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new UsageError(`${file}: "${key}" must be a list of strings`);
  return v as string[];
}

/**
 * Parse a profile. `dir` is the directory a relative `script` resolves against: the profile's REAL directory,
 * so a profile symlinked from a repo can name the script beside it. Pure apart from nothing: no file is read here.
 */
export function parseCloneProfile(text: string, file: string, dir: string): CloneProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError(`${file} must hold a JSON object`);
  const r = raw as Record<string, unknown>;
  const container = r.container;
  if (!(typeof container === "string" || typeof container === "number") || !/^\d+$/.test(String(container))) {
    throw new UsageError(`${file}: "container" must be a Proxmox container id`);
  }
  const installPath = str(r, "installPath", file);
  if (!installPath.startsWith("/")) throw new UsageError(`${file}: "installPath" must be an absolute path in the container`);
  const runAs = str(r, "runAs", file, "postgres");
  const liveDb = str(r, "liveDb", file);
  if (!IDENT.test(liveDb)) throw new UsageError(`${file}: "liveDb" is not a postgres identifier: ${liveDb}`);
  if (!IDENT.test(runAs)) throw new UsageError(`${file}: "runAs" is not a user name: ${runAs}`);
  return {
    file,
    script: resolve(dir, expandHome(str(r, "script", file))),
    installPath,
    container: String(container),
    ssh: strList(r, "ssh", file).map(expandHome),
    runAs,
    liveDb,
    protect: strList(r, "protect", file),
    target: str(r, "target", file),
    grantRole: optStr(r, "grantRole", file),
    urlSecret: optStr(r, "urlSecret", file),
  };
}

/** Why `target` may not be cloned into, or null when it may. Pure. The script refuses the same names again. */
export function cloneTargetRefusal(target: string, profile: Pick<CloneProfile, "liveDb" | "protect">): string | null {
  if (!IDENT.test(target)) return `target ${target} is not a postgres identifier`;
  if (target === profile.liveDb) return `target ${target} is the live database`;
  if (profile.protect.includes(target)) return `target ${target} is protected in the clone profile`;
  if (target === "postgres" || target.startsWith("template")) return `target ${target} is a reserved name`;
  if (/_(incoming|old|restore_check)$/.test(target)) return `target ${target} is a scratch name the clone itself uses`;
  if (target.length > 63 - "_incoming".length) return `target ${target} is too long: its scratch names would pass 63 characters`;
  return null;
}

/** Why `role` may not be granted on the copy, or null when it may. Pure. */
export function grantRoleRefusal(role: string): string | null {
  if (!IDENT.test(role)) return `grant role ${role} is not a postgres identifier`;
  if (role === "postgres" || role === "public" || role.startsWith("pg_")) return `grant role ${role} is a reserved role`;
  return null;
}

/** One command inside the container, from this machine: `pct exec` here, or over ssh to the Proxmox host. Pure. */
export function containerArgv(profile: CloneProfile, inner: string[], havePct: boolean): string[] {
  const pct = ["pct", "exec", profile.container, "--", ...inner];
  if (havePct) return pct;
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...profile.ssh, shellWords(pct)];
}

/** The argv that runs the script as `runAs` with the target (and grant role) in its environment. Pure. */
export function cloneRunInner(profile: CloneProfile, target: string, grantRole: string | null): string[] {
  const env = [`OBPG_DB=${profile.liveDb}`, `OBPG_DEV_DB=${target}`];
  if (grantRole) env.push(`OBPG_GRANT_ROLE=${grantRole}`);
  return ["su", "-", profile.runAs, "-c", shellWords(["env", ...env, profile.installPath])];
}

function checksumInner(profile: CloneProfile): string[] {
  return ["sh", "-c", `sha256sum ${shellWords([profile.installPath])} 2>/dev/null || true`];
}

function installInner(profile: CloneProfile): string[] {
  const p = shellWords([profile.installPath]);
  const tmp = shellWords([`${profile.installPath}.new`]);
  const dir = shellWords([dirname(profile.installPath)]);
  return ["sh", "-c", `set -e; mkdir -p ${dir}; cat > ${tmp}; chmod 0755 ${tmp}; mv ${tmp} ${p}`];
}

interface CloneRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable so no test runs pct, ssh or the script. */
export interface CloneDeps {
  env: Record<string, string | undefined>;
  readFile(path: string): string | null;
  realDir(path: string): string;
  hasPct(): boolean;
  /** Captured. `stdin` is piped in when given. */
  capture(argv: string[], stdin?: Uint8Array): CloneRunResult;
  /** Streamed to this terminal (stdout to stderr when `toStderr`, so `--json` keeps stdout clean). */
  stream(argv: string[], toStderr: boolean): number;
  /** Progress lines, on stderr. */
  log(line: string): void;
}

function cloneDeps(): CloneDeps {
  const dec = new TextDecoder();
  return {
    env: process.env,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    realDir: (p) => dirname(realpathSync(p)),
    hasPct: () => Bun.which("pct") !== null,
    capture(argv, stdin) {
      const p = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? 1, stdout: dec.decode(p.stdout), stderr: dec.decode(p.stderr) };
    },
    stream(argv, toStderr) {
      const p = Bun.spawnSync(argv, { stdin: "ignore", stdout: toStderr ? 2 : "inherit", stderr: "inherit" });
      return p.exitCode ?? 1;
    },
    log: (line) => process.stderr.write(`db clone: ${line}\n`),
  };
}

const SSH_UNREACHABLE = 255;

function loadCloneProfile(deps: CloneDeps): CloneProfile {
  const file = cloneProfilePath(deps.env);
  const text = deps.readFile(file);
  if (text === null) {
    throw new UsageError(
      `no clone profile at ${file}: write one (or point ${DB_CLONE_FILE_ENV} at one) naming the container, the script and the target; see 'ob help db clone'`,
    );
  }
  return parseCloneProfile(text, file, deps.realDir(file));
}

interface CloneCtx {
  mode: Mode;
  flags: Flags;
  args: string[];
}

/** `ob db clone [--target <db>] [--grant-role <role> | --no-grant] [--dry-run]`. */
export async function dbClone(ctx: CloneCtx, deps: CloneDeps = cloneDeps()): Promise<void> {
  if (ctx.args.length > 1) throw new UsageError(`db clone takes no arguments (got '${ctx.args.slice(1).join(" ")}'); use --target`);
  const profile = loadCloneProfile(deps);
  const target = typeof ctx.flags.target === "string" ? ctx.flags.target.trim() : profile.target;
  const roleFlag = ctx.flags["grant-role"];
  if (ctx.flags["no-grant"] === true && roleFlag !== undefined) throw new UsageError("db clone takes --grant-role or --no-grant, not both");
  const grantRole = ctx.flags["no-grant"] === true ? null : typeof roleFlag === "string" ? roleFlag.trim() : profile.grantRole;

  const refusal = cloneTargetRefusal(target, profile);
  if (refusal) throw new UsageError(`${refusal}; refusing`);
  if (grantRole !== null) {
    const why = grantRoleRefusal(grantRole);
    if (why) throw new UsageError(`${why}; refusing`);
  }

  const script = deps.readFile(profile.script);
  if (script === null) throw new UsageError(`${profile.file}: the clone script ${profile.script} does not exist on this machine`);
  const localSum = createHash("sha256").update(script).digest("hex");

  const havePct = deps.hasPct();
  if (!havePct && profile.ssh.length === 0) {
    throw new UsageError(`${profile.file}: this machine has no pct and the profile has no "ssh" words to reach the Proxmox host`);
  }
  const where = havePct ? `container ${profile.container}` : `container ${profile.container} via ssh ${profile.ssh.join(" ")}`;
  const checkArgv = containerArgv(profile, checksumInner(profile), havePct);
  const installArgv = containerArgv(profile, installInner(profile), havePct);
  const runArgv = containerArgv(profile, cloneRunInner(profile, target, grantRole), havePct);
  const hint = profile.urlSecret ? `ob secret get ${profile.urlSecret}` : null;

  if (ctx.flags["dry-run"] === true) {
    const plan = { target, grantRole, liveDb: profile.liveDb, where, check: checkArgv, install: installArgv, run: runArgv, hint };
    if (ctx.mode === "json") {
      print(JSON.stringify(plan, null, 2));
      return;
    }
    print(
      [
        `dry run: would refresh ${target} from ${profile.liveDb} on ${where}${grantRole ? `, granting ${grantRole}` : ""}`,
        `  check:   ${shellWords(checkArgv)}`,
        `  install: ${shellWords(installArgv)}  (only when missing or stale)`,
        `  run:     ${shellWords(runArgv)}`,
      ].join("\n"),
    );
    return;
  }

  const sum = deps.capture(checkArgv);
  if (!havePct && sum.code === SSH_UNREACHABLE) {
    throw new AppError(
      `db clone runs on a machine that reaches the Proxmox host, and this one cannot (${sum.stderr.trim() || "ssh failed"}). ` +
        `It is not run through the ob API: the container is not the API host's. Run it on the LAN or on the Proxmox host.`,
    );
  }
  if (sum.code !== 0) throw new AppError(`could not read ${profile.installPath} in ${where}: ${sum.stderr.trim() || `exit ${sum.code}`}`);
  const remoteSum = sum.stdout.trim().split(/\s+/)[0] ?? "";
  let installed = false;
  if (remoteSum === localSum) {
    deps.log(`${profile.installPath} is up to date in ${where}`);
  } else {
    deps.log(`${remoteSum ? "updating" : "installing"} ${profile.installPath} in ${where}`);
    const put = deps.capture(installArgv, new TextEncoder().encode(script));
    if (put.code !== 0) throw new AppError(`could not install ${profile.installPath}: ${put.stderr.trim() || `exit ${put.code}`}`);
    installed = true;
  }

  deps.log(`refreshing ${target} from ${profile.liveDb}${grantRole ? ` and granting ${grantRole}` : ""}`);
  const code = deps.stream(runArgv, ctx.mode === "json");
  if (code !== 0) {
    throw new AppError(`the clone script failed (exit ${code}); it swaps only after every check passes, so ${target} is as it was unless the output above says otherwise`);
  }

  if (ctx.mode === "json") {
    print(JSON.stringify({ target, grantRole, liveDb: profile.liveDb, installed, hint }, null, 2));
    return;
  }
  const lines = [`done: ${target} refreshed from ${profile.liveDb}${grantRole ? `; ${grantRole} can read and write it` : ""}`];
  if (hint) lines.push(`connect: ${hint}`);
  print(lines.join("\n"));
}
