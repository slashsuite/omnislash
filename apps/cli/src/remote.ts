import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openReadOnly } from "./db.ts";
import { orm } from "./db/orm.ts";
import { config } from "./db/schema.ts";
import { AppError } from "./errors.ts";

// -----------------------------------------------------------------------------
// Remote client (ticket 183). The Proxmox box is the single WRITER of the
// authoritative DB; this laptop is a client that answers an explicit allowlist of
// READ commands from a local read-only replica and ships everything else to the
// server over ssh.
//
// With `remote_host` unset the whole file is inert and `ob` behaves exactly as it
// always has. That matters twice over: it is the pre-cutover behaviour, and the
// same code runs ON the server, where nothing must ever be dispatched anywhere.
// -----------------------------------------------------------------------------

/** Set in the child environment by the ssh exec, so a server that has `remote_host` set fails fast. */
export const HOP_ENV = "OB_REMOTE_HOP";
/** `OB_REMOTE=0` makes the feature inert for ONE invocation (the debugging escape hatch). */
export const REMOTE_ENV = "OB_REMOTE";
export const REMOTE_HOST_KEY = "remote_host";

/**
 * How a single invocation is served.
 *  - `local`:   open the real local DB read/write, exactly as `ob` has always done.
 *  - `replica`: answer from the local read-only replica (an allowlisted READ, or `--local`).
 *  - `remote`:  run it on the server over ssh and stream the result back.
 *  - `split`:   run the handler HERE (its side effect belongs to this machine) against the read-only
 *               replica, and dispatch its DB half to the server as explicit `ob` sub-invocations (189).
 *  - `refused`: a command whose side effect belongs to this machine but whose DB half is not separable
 *               yet, so it refuses out loud rather than acting on the wrong machine (189).
 */
export type ExecutionMode = "local" | "replica" | "remote" | "nodb" | "split" | "refused";

/**
 * `replica token` and `replica status` answer from the FILESYSTEM and must not open the real database
 * read/write. On the server that is not a nicety: a read-write open grows the `-wal` file, which would
 * move the very change token `replica token` exists to report, and every refresh would then transfer the
 * whole 59MB database because nothing ever looked unchanged.
 */
const REPLICA_NO_DB_SUBS = new Set<string>(["token", "status"]);

/**
 * A read rule for ONE command. Classification is on the FULL invocation, never the first word alone:
 * several read-looking commands carry a mutating subcommand (`config set`, `triage clear`,
 * `lease acquire`, `agent register`, `issue link`, `person add`), and getting that wrong is the one
 * mistake that would send a write into a file the next refresh overwrites.
 */
export interface InvocationRule {
  /** matches when invoked with no positional args at all (`ob next`, `ob lease`). */
  bare?: boolean;
  /** matches when the leading positional args match one of these prefixes (`ob person show <id>`). */
  subs?: string[];
  /** matches whatever the positionals are, because they are query terms and not subcommands. */
  anyArgs?: boolean;
  /** prefixes that do NOT match even though a shorter entry in `subs` does (`config set` over a `config` read). */
  deny?: string[];
  /** matches when the first positional is NOT one of these words (`ob spinoff <ref>`, 1589): an open set. */
  notSubs?: ReadonlySet<string>;
}

export interface ReadRule extends InvocationRule {
  /** flags that make an otherwise-read invocation mutating (`ob focus --clear` writes config). */
  mutatingFlags?: string[];
}

/**
 * THE ALLOWLIST. Everything absent from it is REMOTE, deliberately: a command added next year is then
 * run on the server (correct, it might write) instead of silently answering from a stale replica. Each
 * entry below was justified by reading its handler, not by the shape of its name.
 */
export const READ_COMMANDS: Record<string, ReadRule> = {
  // pure queries over item state
  next: { bare: true },
  status: { bare: true },
  list: { bare: true },
  show: { anyArgs: true },
  brief: { anyArgs: true },
  search: { anyArgs: true },
  triage: { bare: true }, // `triage clear|reject` mutate, so only the bare inbox listing reads
  // `focus` with no args reports the current focus; `focus <project>` and `focus --clear` write config
  focus: { bare: true, mutatingFlags: ["clear"] },
  alerts: { bare: true }, // `alerts snooze <key>` writes an alert_ack
  jobs: { bare: true }, // 218: per-job health, a pure read over job_run + the daemonJobs() declaration
  // people: the listing/detail halves only
  whois: { anyArgs: true },
  person: { subs: ["list", "show"] },
  // coordination: the status halves only (`lease acquire`, `agent register` are writes)
  agents: { bare: true },
  lease: { bare: true, subs: ["status"] },
  // entity registries
  roadmap: { bare: true, subs: ["list"] },
  decision: { bare: true, subs: ["list"] },
  learning: { bare: true, subs: ["list"] },
  "review-miss": { subs: ["top"] },
  machine: { subs: ["audit"] }, // OS-170: a read over item, spinoff and event rows; writes nothing
  log: { subs: ["list"] },
  issue: { bare: true, subs: ["list", "landed", "reconcile", "drift"] },
  spinoff: { subs: ["list", "brief", "show", "overlap", "conflicts"] },
  // ingested sources: the search/listing halves (`* sync` writes)
  gmail: { subs: ["search", "list"] },
  cal: { subs: ["agenda"] },
  agenda: { bare: true },
  whatsapp: { subs: ["search", "recent"] },
  // OB-2006: the wiki pages are files on this machine and its facts are reads; `refresh` writes files, never the tracker
  wiki: { anyArgs: true },
};

/** Commands that always run HERE against the real local DB: the replica plumbing itself. */
export const LOCAL_COMMANDS = new Set<string>(["replica"]);

function matchesPrefix(args: string[], prefix: string): boolean {
  const parts = prefix.split(" ");
  return parts.every((p, i) => args[i] === p);
}

function matchesRule(rule: InvocationRule, args: string[]): boolean {
  for (const denied of rule.deny ?? []) if (matchesPrefix(args, denied)) return false;
  if (rule.anyArgs) return true;
  if (args.length === 0) return rule.bare === true;
  if (rule.notSubs && !rule.notSubs.has(args[0]!)) return true;
  return (rule.subs ?? []).some((sub) => matchesPrefix(args, sub));
}

/**
 * The `spinoff` subcommands, i.e. every first argument that is NOT a ticket ref being enqueued. Here rather
 * than beside the handler (1589) because the split table below has to tell `ob spinoff <ref>` from every
 * subcommand, and this module must not import a command.
 */
export const SPINOFF_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "queue",
  "drain",
  "reconcile",
  "claim",
  "stamp",
  "land",
  "reclaim",
  "watch",
  "cleanup",
  "brief",
  "check",
  "overlap",
  "conflicts",
  "list",
  "show",
  "mix",
  "gateable",
  "abandon",
  "sendback",
  "reopen",
  "handoff",
  "ready",
  "state",
  "phase",
  "trial",
  "tokens",
]);

/** Whether this exact invocation is an allowlisted read. Anything else is a write as far as ob knows. */
export function isReadInvocation(command: string, args: string[], flags: Record<string, unknown> = {}): boolean {
  const rule = READ_COMMANDS[command];
  if (!rule) return false;
  for (const flag of rule.mutatingFlags ?? []) if (flags[flag]) return false;
  return matchesRule(rule, args);
}

// --- the split class (189) ----------------------------------------------------
//
// 183 gave every invocation two answers: an allowlisted read is served HERE from the replica, and
// everything else is dispatched THERE over ssh. A handful of commands fit neither, because they write to
// the database AND their real work has to happen on the machine in front of the owner: dispatched whole
// they write the right rows and then open a tab on a server with no display, reporting success. That
// silent half-success is what this class exists to remove.
//
// The mechanism is deliberately one-directional: the LOCAL process performs its own side effect and
// dispatches its DB half back to the server as an ordinary `ob` sub-invocation. The server never reaches
// into the laptop. A server able to spawn processes on a client is a far larger security surface than a
// client that finishes its own job, and it would have to be reachable INWARDS, which the laptop is not.

/**
 * THE SPLIT CLASS. Membership is declared here, so a future command joins by adding a rule rather than
 * by editing dispatch logic. Each entry was decided by READING the handler and separating its two halves:
 *
 *  - `spinoff <ref>` (1589): local half = the worktree and the T3 thread, opened in the same invocation.
 *    DB half = `spinoff queue` (the row), then the same `spinoff claim` / `spinoff stamp` pair the drain
 *    uses. Dispatched whole it would only queue a row on a server that has no T3 to open it in.
 *  - `spinoff drain`: local half = the worktree and the spawned agent. DB half = the per-row `spinoff
 *    claim` / `spinoff stamp` pair 191 carved out of the sweep, plus `spinoff reclaim` and the `spinoff
 *    land` that retires a merged row (see `drainSpinoffs`).
 *  - `spinoff reconcile`: local half = the git state of THIS machine's checkouts and the token transcript
 *    in its worktrees. DB half = one `spinoff land` per row that has actually merged.
 *  - `spinoff cleanup`: local half = removing worktrees and branches from THIS machine's checkout, which
 *    is the whole point of the command and the one thing the server must never do to its own clone. DB
 *    half = one `agent done` per branch it removed.
 *  - `daemon`: local half = launchd plists in ~/Library/LaunchAgents plus `launchctl`. DB half = EMPTY
 *    (the handler never touches ctx.db), so it is the degenerate member: it runs here and dispatches
 *    nothing. Dispatched whole it would install this Mac's launchd jobs on a Debian box.
 *  - `web`: local half = building and serving the dashboard on this machine's :5050 plus the realtime
 *    socket. DB half = EMPTY (the dashboard is read-only), so the replica is exactly the right handle.
 */
export const SPLIT_COMMANDS: Record<string, InvocationRule> = {
  daemon: { anyArgs: true, bare: true },
  web: { anyArgs: true, bare: true },
  // 191. `spinoff claim|stamp|land|reclaim|queue` are the DB half itself and stay REMOTE (they are ordinary
  // writes, and on the server they are ordinary local writes), so only the three sweeps and the bare
  // enqueue (1589, every first word that is not a subcommand) are listed here.
  spinoff: { subs: ["drain", "cleanup", "reconcile"], notSubs: SPINOFF_SUBCOMMANDS },
};

export function isSplitInvocation(command: string, args: string[]): boolean {
  const rule = SPLIT_COMMANDS[command];
  return rule ? matchesRule(rule, args) : false;
}

/**
 * The commands whose side effect is local AND whose DB half cannot be expressed as `ob` sub-invocations,
 * so they are REFUSED rather than dispatched: loud, on stderr, exit 1, naming what would have happened.
 *
 * Two members. `lease run` (OB-2071) starts its command on THIS machine while the lease lives in the
 * server's table, so one ssh hop would run the command on the server; it works with `OMNISLASH_API`.
 *
 * `ports` (OB-2041). Its lease half is the server's table, but `ss`, `ufw` and the route are
 * facts about THIS machine, and the verbs it prints (`ob ports next` claims a port) must be answered from
 * both at once. Dispatched whole it would read the server's listeners and tell this machine's dev server to
 * bind a port the server has free. With `OMNISLASH_API` it works (a split command over the API); only the
 * legacy ssh `remote_host` mode cannot do both, so it refuses by name.
 *
 * History: 189 put `spinoff drain` and `spinoff cleanup` here because drain's DB half was a per-row
 * claim/lease/launch/stamp pass in one sweep; 191 separated that sweep into `spinoff claim` and `spinoff
 * stamp` (with `reclaim` recovering a claim whose machine never came back), which is what made drain a
 * split command. Refusing it was never survivable: `com.omnislash.spinoff-drain` ran every 45s on this Mac
 * (until 1589), so a refusal stopped spinning off work dead the moment `remote_host` was set.
 *
 * The mechanism stays because a command whose halves will not separate needs it, and because a refusal is
 * still the right answer for one: the alternative was dispatching a sweep that would read an empty process
 * table and delete branches out of the server's own checkout.
 */
export const REFUSED_COMMANDS: Record<string, { rule: InvocationRule; why: string }> = {
  ports: {
    rule: { anyArgs: true, bare: true },
    why:
      "its lease table is the server's but ss, ufw and the route are read on this machine, so one ssh hop cannot answer both. " +
      "Unset remote_host and use OMNISLASH_API",
  },
  // OB-2071: `lease run` starts its command HERE while the lease lives on the server; one ssh hop would run
  // the command on the server instead.
  lease: {
    rule: { subs: ["run"] },
    why: "it runs its command on this machine while the lease table is the server's, so one ssh hop would run the command on the wrong machine. Unset remote_host and use OMNISLASH_API",
  },
};

/** The refusal for this invocation, or null when it is not a refused one. */
export function refusalWhy(command: string, args: string[]): string | null {
  const entry = REFUSED_COMMANDS[command];
  return entry && matchesRule(entry.rule, args) ? entry.why : null;
}

export function refusedMessage(command: string, args: string[], host: string, why: string): string {
  return (
    `'ob ${[command, ...args].join(" ")}' is NOT dispatched to ${host}: ${why}. ` +
    `Nothing ran and nothing was written.`
  );
}

/**
 * `--local` means "no network at all", which a split command cannot honour: its DB half IS the server.
 *
 * The refusal is for the CLASS, so it covers the members whose database half is empty (`daemon`, `web`)
 * as well. Those could be served under `--local` today, and the wording says
 * "when it has one" rather than claiming a half they do not have, but the answer must not depend on which
 * member was invoked: an empty database half is a fact about a handler that can change, and a member that
 * grew one would then start half-running under `--local` without anyone editing this file. `OB_REMOTE=0`
 * remains the way to run any of them with no network at all.
 */
export function splitNeedsServerMessage(command: string, args: string[]): string {
  return (
    `--local cannot serve 'ob ${[command, ...args].join(" ")}': it is a split command, so its side effect ` +
    `runs here while its database half, when it has one, runs on the server. Drop --local, or set ` +
    `OB_REMOTE=0 to run entirely against the local database.`
  );
}

/** A split command that ARRIVED on the server was dispatched by mistake: its local half is not here. */
export function splitOnServerMessage(command: string, args: string[]): string {
  return (
    `'ob ${[command, ...args].join(" ")}' reached this machine over an ssh hop (${HOP_ENV}=1), but it is a ` +
    `split command whose side effect belongs to the machine that dispatched it. Refusing rather than ` +
    `performing it here.`
  );
}

/**
 * Read-only first, because merely asking the question must not write. A WAL database can refuse a
 * read-only open when its `-shm` cannot be created, and answering "not configured" to that would
 * silently drop the client back into local mode against a stale DB, so it falls back to a normal
 * (non-creating) open rather than treating an unreadable database as an unset setting.
 *
 * BOTH opens used to be unopenable, which is what this fix is (1135): `file:<dbPath>?mode=ro` throws
 * SQLITE_CANTOPEN in bun and `{ create: false }` on its own throws "bad parameter or other API misuse",
 * so the `catch` in configuredRemoteHost answered "no remote_host" on every invocation -- the ssh split
 * never engaged on a machine that had a server configured, and the local path silently took the write.
 */
function openForConfigRead(dbPath: string): Database {
  try {
    return openReadOnly(dbPath);
  } catch {
    return new Database(dbPath, { create: false, readwrite: true });
  }
}

/**
 * The configured server, read from the LOCAL database rather than the replica. That resolves the
 * bootstrap deliberately: `remote_host` is this CLIENT's own pointer and therefore lives on the client,
 * while `ob config` is itself a REMOTE command so the server stays the source of truth for every other
 * setting. Changing or clearing the pointer is `OB_REMOTE=0 ob config set remote_host <host>`, which is
 * inert mode writing to this machine's DB.
 *
 * Opened read-only and by hand (not `openDb`) so merely ASKING the question cannot create, migrate or
 * lock anything, and a DB that predates the config table simply answers "not configured".
 *
 * Only the four honest "not configured" cases answer null: `OB_REMOTE=0`, no DB file, no `config` table,
 * and an absent or blank key. ANY other failure to read throws RemoteConfigUnreadable (OB-1912): null
 * means "no server", so answering it for a read error sent the command down the local path and wrote a
 * sqlite the server never saw. `open` is the test seam, so a test can make the open or the query throw.
 */
const CONFIG_READ_BUSY_MS = 5000;

export class RemoteConfigUnreadable extends AppError {}

export function configuredRemoteHost(
  dbPath: string,
  env: Record<string, string | undefined> = process.env,
  open: (dbPath: string) => Database = openForConfigRead,
): string | null {
  if (env[REMOTE_ENV] === "0") return null;
  if (!existsSync(dbPath)) return null;
  let db: Database | undefined;
  try {
    db = open(dbPath);
    // A concurrent first opener migrates under a write lock; wait it out (bounded) rather than treating a
    // momentary "database is locked" as an unreadable setting. A lock that outlasts this still throws.
    db.exec(`PRAGMA busy_timeout = ${CONFIG_READ_BUSY_MS}`);
    const row = orm(db).select({ value: config.value }).from(config).where(eq(config.key, REMOTE_HOST_KEY)).get();
    const host = row?.value?.trim();
    return host && host.length > 0 ? host : null;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    if (cause.includes("no such table")) return null;
    throw new RemoteConfigUnreadable(
      `could not read the ${REMOTE_HOST_KEY} setting in ${dbPath}: ${cause}. Refusing to fall back to a local ` +
        `database the server would never see. ${REMOTE_ENV}=0 forces local mode deliberately.`,
    );
  } finally {
    db?.close();
  }
}

// --- machine-local flags (213) ------------------------------------------------
//
// `--db` names a file on the machine the command was TYPED on, and the whole argv is what crosses the ssh
// hop verbatim, so a forwarded `--db` pointed the server at a path only the client had. That stayed a
// refusal rather than silent data loss for one reason only: 198 refuses to CREATE a database it was not
// asked for. Without that guard the server would have made one at the client's path and accepted writes
// into a decoy. A backstop that happened to be there is not the answer, so the flag is stopped here.
//
// THE RULE IS THE WIDEST ONE THAT IS STILL HONEST: with a server configured, `--db` is refused for every
// mode that consults the server, READS INCLUDED. A replica-served read under `--db` is the same lie in
// the other direction: it would answer with the SERVER's rows while naming a local file, and reading a
// pre-cutover COPY that way is a step in the cutover runbook. Only the replica plumbing itself keeps the
// flag, because managing the per-database replica files is exactly what it is for. With no `remote_host`
// configured nothing here runs at all and `--db` behaves as it always has, which is how every test and
// every script uses it.
//
// THE REST OF THE FLAG TABLE was walked for the same defect (a value naming a path, directory, file or
// checkout on this machine) and none of the others joins this table:
//  - `db snapshot --dir`: the database being snapshotted lives ON the server, so the directory is
//    legitimately a server directory once the command is dispatched.
//  - `person doc add --path`: a local input to a dispatched handler.
//    It fails LOUDLY on the server (there is no such file) rather than resolving to something else, and
//    refusing it here would remove the command with no replacement. Getting the bytes to the server is
//    a separate piece of work, not a flag rule.
//  - `spinoff --repo|--worktree|--branch`, `agent register --worktree|--branch`: these are recorded as
//    DATA about the client's checkout, which is what the row should say. `spinoff <ticket> --repo` also
//    RESOLVES a path, and it resolves on the server once dispatched, which is a split-class question
//    about the command rather than about the flag.
//  - `web --bind`: `web` is a split command whose local half runs here, so it never crosses the wire.
const MACHINE_LOCAL_FLAGS: Record<string, string> = {
  db: "a database file on the machine the command was typed on",
};

export interface MachineLocalFlag {
  name: string;
  value: string;
}

/** The machine-local flags actually present on this invocation. Empty is the normal case. */
export function machineLocalFlagsIn(flags: Record<string, unknown>): MachineLocalFlag[] {
  const found: MachineLocalFlag[] = [];
  for (const name of Object.keys(MACHINE_LOCAL_FLAGS)) {
    const value = flags[name];
    if (typeof value === "string" && value.length > 0) found.push({ name, value });
  }
  return found;
}

/**
 * The refusal. It names the flag, says it is local-only, and gives all three ways through, because the
 * user meant a SPECIFIC database and every honest answer depends on which one they meant.
 */
export function machineLocalFlagMessage(input: {
  flags: MachineLocalFlag[];
  command: string;
  args: string[];
  host: string;
}): string {
  const invocation = `ob ${[input.command, ...input.args].join(" ")}`;
  const named = input.flags.map((f) => `--${f.name} ${f.value}`).join(", ");
  const names = input.flags.map((f) => `--${f.name}`).join(", ");
  const what = input.flags.map((f) => MACHINE_LOCAL_FLAGS[f.name]).join(", ");
  return (
    `${names} is a LOCAL-ONLY flag: it names ${what}, so it is never sent to ${input.host}. ` +
    `'${invocation}' would have run against the server's own database instead of the one ${names} names, ` +
    `so it was refused: nothing ran and nothing was written. ` +
    `To run it against that database, make the invocation inert: OB_REMOTE=0 ob ${named} ${[input.command, ...input.args].join(" ")}. ` +
    `To read this machine's replica of the server, use --local without ${names}. ` +
    `To run it on the server, drop ${names}.`
  );
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  host: string | null;
  /** Why this plan, for the error messages and `replica status`. */
  reason: string;
}

/**
 * The one decision this whole ticket hangs off, taken after the handler is resolved and before any
 * database is opened. No configured host means `local`, i.e. byte-for-byte today's behaviour.
 */
export function planExecution(input: {
  command: string;
  args: string[];
  flags: Record<string, unknown>;
  host: string | null;
  hop?: boolean;
}): ExecutionPlan {
  const { command, args, flags, host, hop = false } = input;
  if (command === "replica" && REPLICA_NO_DB_SUBS.has(args[0] ?? "status")) {
    return { mode: "nodb", host, reason: "answered from the filesystem" };
  }
  // 323. `pg-export` names BOTH of its databases on the command line and opens neither of ob's own, so
  // it is `nodb`: the handler must never inherit a database it was not pointed at. It is also pinned
  // HERE rather than dispatched, because `--from` is a path on the machine the human typed it on, and a
  // silent ssh hop would resolve it against a different filesystem. To run the export on the server,
  // ssh there and run it there -- deliberately, and visibly.
  if (command === "pg-export") {
    return { mode: "nodb", host, reason: "both databases are named explicitly; neither is ob's own" };
  }
  // OB-1969: `models` reads and edits this machine's models file; dispatched over ssh it would hit the server's.
  // With no remote host the plan falls through to local, where `show` reads the real spinoff_tier_models.
  if (command === "models" && host) {
    return { mode: "nodb", host, reason: "the models file is this machine's; never dispatched" };
  }
  // 1803: `project rules` / `project wire` read OmniSlash's `repos/` on this machine; the other subs are data.
  // OB-2103: `rules` also reads the project's stage, but opens the store itself inside the handler, so a
  // machine that cannot open it still gets the rules.
  if (command === "project" && (args[0] === "rules" || args[0] === "wire")) {
    return { mode: "nodb", host, reason: "reads the repo-private files in the OmniSlash checkout; no tracker" };
  }
  if (command === "vision") {
    return { mode: "nodb", host, reason: "mlx-vlm compare runs on this machine; no tracker" };
  }
  // OB-2278: `usage day` reads this machine's Claude transcripts; dispatched over ssh it would read the server's.
  if (command === "usage" && host) {
    return { mode: "nodb", host, reason: "the Claude transcripts are this machine's; never dispatched" };
  }
  // 739: MEMORY.md is this machine's XDG file. Dispatched whole it would write the server's
  // filesystem. Without a remote_host, fall through to local so add can dual-write the learning item.
  if (command === "memory" && host) {
    return { mode: "nodb", host, reason: "MEMORY.md is this machine's XDG file; never dispatched" };
  }
  // The loop guard for the split class, and the one check that runs BEFORE the host test: a correctly
  // configured server has no remote_host at all, so `host === null` would otherwise drop a mistakenly
  // dispatched split command straight into `local` and perform the laptop's side effect on the server.
  if (hop && isSplitInvocation(command, args)) {
    return { mode: "refused", host, reason: splitOnServerMessage(command, args) };
  }
  if (!host) return { mode: "local", host: null, reason: "no remote_host configured" };
  if (LOCAL_COMMANDS.has(command)) {
    return {
      mode: "local",
      host,
      reason: "replica plumbing runs locally",
    };
  }
  // 213, and checked before every remaining mode: a machine-local flag is wrong for all of them, and the
  // refusal has to happen BEFORE the argv is handed to ssh rather than being caught by 198's guard there.
  const stray = machineLocalFlagsIn(flags);
  if (stray.length > 0) {
    return { mode: "refused", host, reason: machineLocalFlagMessage({ flags: stray, command, args, host }) };
  }
  const why = refusalWhy(command, args);
  if (why) return { mode: "refused", host, reason: refusedMessage(command, args, host, why) };
  if (isSplitInvocation(command, args)) {
    if (flags.local) return { mode: "refused", host, reason: splitNeedsServerMessage(command, args) };
    return { mode: "split", host, reason: "side effect here, database half on the server" };
  }
  if (flags.local) return { mode: "replica", host, reason: "--local" };
  if (isReadInvocation(command, args, flags)) return { mode: "replica", host, reason: "allowlisted read" };
  return { mode: "remote", host, reason: "not an allowlisted read" };
}

// --- the ssh seam ------------------------------------------------------------

export interface RemoteResult {
  code: number;
  /** The host could not be reached at all, so the command did NOT run and nothing was applied. */
  connectionFailed: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Injectable so NO test ever shells out to ssh or touches the network. `stream` inherits stdio, which is
 * what keeps the `--json` contract intact: the server's stdout is this process's stdout, byte for byte.
 */
export interface RemoteExec {
  stream(host: string, argv: string[]): { code: number; connectionFailed: boolean };
  capture(host: string, argv: string[]): RemoteResult;
  fetch(host: string, argv: string[]): { code: number; connectionFailed: boolean; stderr: string; bytes: Uint8Array };
}

/** ssh reports its OWN failures as 255, which is how "could not reach the host" stays distinguishable. */
const SSH_CONNECTION_FAILURE = 255;

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** An argv as one line a shell reads back as the same words: only a word that needs it is quoted (OB-1815). */
export function shellWords(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(" ");
}

/** `OB_REMOTE_HOP=1 ob <argv>`, quoted for the remote login shell. */
export function remoteCommand(argv: string[]): string {
  return [`${HOP_ENV}=1`, "ob", ...argv.map(shellQuote)].join(" ");
}

function sshArgv(host: string, argv: string[]): string[] {
  return ["ssh", "-o", "BatchMode=yes", host, remoteCommand(argv)];
}

export function sshExec(): RemoteExec {
  return {
    stream(host, argv) {
      const p = Bun.spawnSync({ cmd: sshArgv(host, argv), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return { code: p.exitCode, connectionFailed: p.exitCode === SSH_CONNECTION_FAILURE };
    },
    capture(host, argv) {
      const p = Bun.spawnSync({ cmd: sshArgv(host, argv), stdout: "pipe", stderr: "pipe" });
      return {
        code: p.exitCode,
        connectionFailed: p.exitCode === SSH_CONNECTION_FAILURE,
        stdout: p.stdout.toString(),
        stderr: p.stderr.toString(),
      };
    },
    fetch(host, argv) {
      const p = Bun.spawnSync({ cmd: sshArgv(host, argv), stdout: "pipe", stderr: "pipe" });
      return {
        code: p.exitCode,
        connectionFailed: p.exitCode === SSH_CONNECTION_FAILURE,
        stderr: p.stderr.toString(),
        bytes: new Uint8Array(p.stdout),
      };
    },
  };
}

/** The loop guard: a server that accidentally has `remote_host` set must fail fast, not ssh to itself. */
export function hopGuardMessage(host: string): string {
  return (
    `refusing to dispatch to ${host}: this ob was itself started by a remote hop (${HOP_ENV}=1) and still ` +
    `has remote_host configured. Clear it on the server with: ${REMOTE_ENV}=0 ob config set remote_host ""`
  );
}

export function isHop(env: Record<string, string | undefined> = process.env): boolean {
  return env[HOP_ENV] === "1";
}

// --- the split seam (189) -----------------------------------------------------

export interface RemoteWriteOutcome {
  ok: boolean;
  /** The failure, ready to print. Null when it succeeded. */
  message: string | null;
  connectionFailed: boolean;
  /**
   * The sub-invocation's stdout (191). A write that ANSWERS is still one write: `spinoff claim --json`
   * takes the row and reports which row it took, and splitting that into a write plus a read would put a
   * window between them in which a second drain could claim the same row.
   */
  stdout: string;
}

/**
 * The DB half of a split command: ONE `ob` sub-invocation, run on the server. Handlers take this off
 * `ctx.remote`, and an ABSENT `ctx.remote` means "there is no server" and the handler writes to its own
 * database exactly as it always has. That is what keeps inert mode byte-for-byte identical, and it is
 * also what makes the same handler correct when it runs ON the server.
 */
export interface RemoteWriter {
  write(argv: string[]): RemoteWriteOutcome;
}

/**
 * Captured rather than streamed, unlike a whole-command dispatch: the split command is still producing
 * its OWN output here, and a sub-invocation's stdout landing in the middle of it would break the --json
 * guarantee for a caller that never asked for two commands.
 */
export function remoteWriter(host: string, exec: RemoteExec): RemoteWriter {
  return {
    write(argv) {
      const result = exec.capture(host, argv);
      if (result.connectionFailed) {
        return { ok: false, connectionFailed: true, message: unreachableMessage(host, argv), stdout: "" };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        return {
          ok: false,
          connectionFailed: false,
          message: detail.length > 0 ? detail : `'ob ${argv.join(" ")}' exited ${result.code} on ${host}`,
          stdout: result.stdout,
        };
      }
      return { ok: true, connectionFailed: false, message: null, stdout: result.stdout };
    },
  };
}

/**
 * THE ORDERING DECISION, and the load-bearing part of 189.
 *
 * A split command does its LOCAL half FIRST and its server half SECOND, so the failure it can leave
 * behind is "something opened here that the server has no row for" and never "a row on the server for
 * something that never opened".
 *
 * That direction is chosen, not incidental. The local half is the half a human can SEE: an agent that
 * started without its row is sitting in front of the owner, it self-heals the moment the agent reports in,
 * and `ob spinoff reconcile` retires the rest. The opposite residue is invisible: a row that claims work
 * is running is precisely what makes a later drain skip it, so a row for an agent that never started is
 * a phantom nothing about which looks wrong until someone waits on it. Ordering therefore fails toward
 * the mistake that announces itself.
 *
 * It is also the order the handlers already run in with no server configured, so inert mode and split
 * mode differ only in WHERE the row lands, never in what happens first.
 *
 * THE ONE DELIBERATE EXCEPTION (191) is `spinoff drain`, which asks the server FIRST. Its server half is
 * a CLAIM, and a claim is not a side effect anyone can see: it is the exclusion that stops two machines
 * launching the same row twice. Ordering it second would mean launching first and asking permission
 * afterwards, and a double-launched agent (two Claude sessions in one worktree) cannot be undone by a
 * message. The residue the claim direction can leave instead -- a row claimed by a machine that crashed
 * before it stamped -- is bounded by the claim lease's TTL and recovered by `ob spinoff reclaim`, so it
 * still fails toward the mistake that heals rather than the one that compounds.
 *
 * `spinoff cleanup` keeps the LOCAL-FIRST rule, and decided it on its own merits rather than by
 * inheriting it. Its server half is not a claim, so 191's exception does not apply: every write it makes
 * is a DELETION of state the local evidence has already proved dead, which means the order cannot change
 * what is decided and neither residue is invisible. A run that stops halfway is reported, idempotent, and
 * finished by running it again. Local first therefore stands: the half that cannot fail over a network
 * goes first, so a partial run has already removed the worktrees nothing would track, and the writes that
 * did not land are still visible as the same phantom rows the next pass will decide on identically.
 *
 * Neither half is rolled back and nothing is queued for retry, for the same reason 183 refuses to queue
 * offline writes: a replay against state that has moved on loses more than it saves. The user is told
 * exactly what exists, what does not, and the one command that finishes the job, and the exit code is
 * non-zero so a script cannot read the partial run as a success.
 */
export function splitPartialFailure(input: { didLocally: string; missing: string; detail: string; recover: string }): string {
  return (
    `${input.didLocally}, but ${input.missing} on the server: ${input.detail}. ` +
    `Nothing was rolled back and nothing is queued. Recover with: ${input.recover}`
  );
}

export function unreachableMessage(host: string, argv: string[]): string {
  return (
    `could not reach ${host} over ssh, so '${argv.join(" ")}' was NOT applied. ` +
    `Nothing is queued: run it again when the host is reachable, or read locally with --local.`
  );
}
