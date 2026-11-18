import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.ts";
import { acquireFileLock, type AcquireOptions, type FileHold } from "./file-lock.ts";
import { MIGRATIONS_FOLDER, openDb, openReadOnly } from "./db.ts";
import { schemaFingerprintHash } from "./db/fingerprint.ts";
import type { RemoteExec } from "./remote.ts";

// -----------------------------------------------------------------------------
// The local read replica (ticket 183). A whole-file copy of the server's database,
// produced there with VACUUM INTO (the only consistent way to copy a live WAL DB;
// never copy the .sqlite/-wal files by hand) and opened HERE read-only.
//
// The read-only handle is the backstop that makes a classification mistake loud:
// a misclassified write raises SQLITE_READONLY at the point of the mistake instead
// of landing in a file the next refresh silently overwrites. Silent write loss is
// the one failure that would end trust in the tracker.
// -----------------------------------------------------------------------------

/** How old a replica may be before every read says so on stderr. */
export const STALE_AFTER_S = 120;

export interface ReplicaMeta {
  /** The server's change token at the last successful refresh (see `replicaToken`). */
  token: string | null;
  refreshed_at: string | null;
  /** A remote write happened, so the next read refreshes before answering. */
  dirty: boolean;
  last_refresh_ok: boolean;
  last_error: string | null;
  /** The schema fingerprint the replica carried when it was accepted. */
  fingerprint: string | null;
  /**
   * The dirty generation (OB-1931). Every `markReplicaDirty` bumps it; a refresh clears `dirty` only when
   * the generation it saw at its start is still the current one, so a mark landing mid-refresh survives.
   */
  dirty_seq: number;
  /** OB-1931: when a dump last failed the schema-skew check, and the fingerprint this client expected then. */
  skew_at: string | null;
  skew_expected: string | null;
  /** OB-1931: when a refresh last skipped its swap because a reader had the replica open (308). */
  last_deferred_at: string | null;
}

const EMPTY_META: ReplicaMeta = {
  token: null,
  refreshed_at: null,
  dirty: false,
  last_refresh_ok: false,
  last_error: null,
  fingerprint: null,
  dirty_seq: 0,
  skew_at: null,
  skew_expected: null,
  last_deferred_at: null,
};

/**
 * OB-1931: after a schema-skew failure, how long a non-forced refresh waits before downloading the dump
 * again. The server will not change shape on its own inside that window, and each retry is a ~59MB pull.
 */
export const SKEW_BACKOFF_MS = 10 * 60_000;

/** The schema-skew refusal, told apart from other refresh failures so only it starts the backoff. */
export class ReplicaSchemaSkewError extends Error {
  constructor(
    message: string,
    readonly expected: string,
  ) {
    super(message);
    this.name = "ReplicaSchemaSkewError";
  }
}

/** When the skew backoff ends, or null when none is active for `expected` at `now`. */
export function skewBackoffUntil(meta: ReplicaMeta, expected: string | null, now: number = Date.now()): string | null {
  if (!meta.skew_at || !meta.skew_expected) return null;
  if (expected !== null && expected !== meta.skew_expected) return null;
  const at = Date.parse(meta.skew_at);
  if (Number.isNaN(at)) return null;
  const until = at + SKEW_BACKOFF_MS;
  return now < until ? new Date(until).toISOString() : null;
}

export function replicaPath(dbPath: string): string {
  return join(dirname(dbPath), "replica.sqlite");
}

export function replicaMetaPath(dbPath: string): string {
  return join(dirname(dbPath), "replica.meta.json");
}

/**
 * The file every reader and every refresh serialises on (308). Deliberately NOT the replica itself: a
 * lock taken on a file that is about to be renamed away travels with the old inode, so the holder and
 * the next reader would be locking different things.
 */
export function replicaLockPath(dbPath: string): string {
  return join(dirname(dbPath), "replica.lock");
}

/**
 * The fairness half of the same mechanism (308). `flock` grants a shared hold to anyone who asks, even
 * with an exclusive waiter already queued, so a machine that is reading the replica more or less
 * continuously -- a spinoff drain every 45s, a daemon, several builders -- can starve the swap forever
 * and leave the replica permanently stale. Measured on a reader loop with no gate: 3 swaps landed in
 * 8 seconds against 41 deferrals.
 *
 * So a swap takes THIS one first, and holds it for as long as it is waiting. A reader passes through it
 * before taking its own hold and lets go immediately, which costs a reader nothing when no swap is
 * pending and makes every reader queue behind one that is. Both sides take gate then replica, in that
 * order, so the pair cannot deadlock, and both are bounded by their own timeout anyway.
 */
export function replicaSwapGatePath(dbPath: string): string {
  return join(dirname(dbPath), "replica.swap-gate");
}

/**
 * OB-1931: the lock every meta read-modify-write takes. Always the INNERMOST lock: taken after the swap
 * gate and `replica.lock` where the swap holds them, and held only for the read, the change and the write.
 */
function replicaMetaLockPath(dbPath: string): string {
  return join(dirname(dbPath), "replica.meta.lock");
}

export function schemaCachePath(dbPath: string): string {
  return join(dirname(dbPath), "replica.schema.json");
}

export function readMeta(dbPath: string): ReplicaMeta {
  const path = replicaMetaPath(dbPath);
  if (!existsSync(path)) return { ...EMPTY_META };
  try {
    return { ...EMPTY_META, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ReplicaMeta>) };
  } catch {
    return { ...EMPTY_META };
  }
}

/**
 * Atomic (OB-1931): written to a sibling temp file and renamed over the real one, so a reader never sees
 * a half-written meta (which `readMeta` would otherwise take for EMPTY_META).
 */
export function writeMeta(dbPath: string, meta: ReplicaMeta): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const path = replicaMetaPath(dbPath);
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * OB-1931: the one way the meta changes. `change` receives the CURRENT meta, read under an exclusive
 * `replica.meta.lock`, and returns the next one. When the lock cannot be had the update runs unlocked,
 * the same degrade `openReplicaOnce` makes: a meta write is never refused. Never call this from inside
 * another `change`.
 */
function updateMeta(dbPath: string, change: (current: ReplicaMeta) => ReplicaMeta): ReplicaMeta {
  const hold = acquireFileLock(replicaMetaLockPath(dbPath), "exclusive", { waitMs: REPLICA_READ_WAIT_MS });
  try {
    const next = change(readMeta(dbPath));
    writeMeta(dbPath, next);
    return next;
  } finally {
    hold?.release();
  }
}

/** Trigger (a): a remote write happened, so the next read refreshes before it answers. */
export function markReplicaDirty(dbPath: string): void {
  updateMeta(dbPath, (m) => ({ ...m, dirty: true, dirty_seq: m.dirty_seq + 1 }));
}

export function replicaAgeSeconds(meta: ReplicaMeta, now: number = Date.now()): number | null {
  if (!meta.refreshed_at) return null;
  const at = Date.parse(meta.refreshed_at);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "never refreshed";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Decompress into a buffer node:fs will take: Bun's zlib types and node:fs's disagree on the flavour. */
export function gunzip(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  return Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>) as Uint8Array<ArrayBuffer>;
}

// --- the change token --------------------------------------------------------

/**
 * The server's cheap "has anything changed" token: size plus nanosecond mtime of the database AND its
 * -wal sidecar. The live DB is ~59MB, so a blind copy on every refresh is far too expensive to do on
 * the cadence a dirty read wants. It is safe to skip on an unchanged token because under WAL every
 * commit appends to (or truncates) the -wal file and a checkpoint rewrites the main file, so a write
 * that moved neither file's size NOR its nanosecond mtime would have to have completed inside the same
 * nanosecond as the previous one, on both files.
 */
export function replicaToken(dbPath: string): string {
  const parts: string[] = [];
  for (const path of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(path)) {
      parts.push("-");
      continue;
    }
    const st = statSync(path, { bigint: true });
    parts.push(`${st.size}:${st.mtimeNs}`);
  }
  return parts.join("/");
}

// --- the schema-skew guard ---------------------------------------------------

/** A cheap identity for THIS client's migration chain: the journal plus every migration's SQL. */
function migrationChainHash(): string {
  const journal = readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8");
  const entries = (JSON.parse(journal) as { entries: { tag: string }[] }).entries;
  const h = createHash("sha256").update(journal);
  for (const entry of entries) h.update(readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8"));
  return h.digest("hex").slice(0, 16);
}

/**
 * The schema shape this client understands, as the 097 fingerprint hash. Derived by building a throwaway
 * DB from this checkout's migration chain, then cached against that chain's hash: the answer only changes
 * when the migrations do, and rebuilding it on every `ob next` would put a full DDL run in the read path.
 */
export function expectedFingerprint(dbPath: string): string {
  const chain = migrationChainHash();
  const cache = schemaCachePath(dbPath);
  if (existsSync(cache)) {
    try {
      const cached = JSON.parse(readFileSync(cache, "utf8")) as { chain?: string; fingerprint?: string };
      if (cached.chain === chain && cached.fingerprint) return cached.fingerprint;
    } catch {
      // a corrupt cache is recomputed, never trusted
    }
  }
  const scratch = join(tmpdir(), `ob-schema-${randomUUID()}.sqlite`);
  try {
    // deliberateSqlite (337): a throwaway file whose only purpose is to be migrated so its SQLITE schema
    // can be fingerprinted. It is never the tracker, so the two-live-stores guard does not apply.
    const db = openDb(scratch, { create: true, deliberateSqlite: true });
    const fingerprint = schemaFingerprintHash(db);
    db.close();
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, `${JSON.stringify({ chain, fingerprint }, null, 2)}\n`);
    return fingerprint;
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${scratch}${suffix}`, { force: true });
  }
}

// --- opening the replica -----------------------------------------------------

/**
 * The read-only handle. Read-only is not a convention here, it is the enforcement: every write path in
 * `ob` raises SQLITE_READONLY against it, so a command wrongly classified as a read fails loudly at the
 * exact statement that would have been lost. (This was spelled `file:<path>?mode=ro`, which bun cannot
 * open at all -- see `openReadOnly` -- so every replica read threw SQLITE_CANTOPEN instead.)
 */
export function openReplicaReadOnly(path: string): Database {
  if (!existsSync(path)) throw new AppError(`no replica at ${path} (run: ob replica refresh)`);
  return openReadOnly(path);
}

/**
 * A read that lost a race with a refresh REPLACING the replica underneath it (308).
 *
 * The refresh is atomic for the directory entry -- scratch file, then `renameSync` -- but a reader that
 * opens or reads across that replacement gets `SQLITE_IOERR`, surfaced as "disk I/O error". With
 * `com.omnislash.spinoff-drain` running every 45s, any `ob` command can lose that race: with the job
 * loaded `ob spinoff drain` failed 5 times out of 5, and with it stopped, 5 of 6 succeeded. The same
 * binary succeeding and failing on consecutive runs is what proved this a race rather than a code path.
 *
 * This is deliberately NOT folded into `openDb`'s retry loop, which retries `SQLITE_BUSY` and nothing
 * else (223) so that a deterministic failure surfaces on the first attempt. That rule is right and stays.
 * The replica is the one file in the system another process legitimately replaces whole while this one
 * reads it, so an IOERR here has a known transient cause that an IOERR on the authoritative database
 * does not. Bounded to a few attempts: a replica that is genuinely unreadable still fails, and quickly.
 */
function isLostReplicaRace(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_IOERR")) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && /disk i\/o error/i.test(message)) return true;
  }
  return false;
}

/** How many times a read may lose the race before the failure is treated as real. */
export const REPLICA_REOPEN_ATTEMPTS = 3;

/**
 * Run `open` again when it lost the race, and only then. Exported so the retry can be tested with a
 * stub that fails the way a replacement does: a test that merely opens a healthy replica would pass
 * with this whole guard deleted, which is no test at all.
 */
export function retryOnReplacement<T>(open: () => T, attempts = REPLICA_REOPEN_ATTEMPTS): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return open();
    } catch (err) {
      // An AppError is this module's own deterministic refusal (no replica, wrong schema) and never
      // becomes true on a retry, so it propagates on the first attempt exactly as before.
      if (err instanceof AppError || !isLostReplicaRace(err) || attempt >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
    }
  }
}

/**
 * How long a reader waits for a refresh's swap window to close before it reads anyway. The window is a
 * single `rename()`, so this is only ever paid once and only in microseconds; the budget is generous
 * because the cost of exceeding it (reading unprotected, exactly as before 308) is the cost of a lost
 * race, and the cost of waiting forever would be a hung `ob`.
 */
export const REPLICA_READ_WAIT_MS = 5_000;

/**
 * How long a refresh waits for open readers to clear before it gives up on replacing the replica. A
 * reader holds from `openReplicaForRead` to `close()`, which is one command, so a few seconds covers
 * an overlapping invocation. Giving up leaves the previous replica in place and the meta dirty, so the
 * next command tries again: a slightly stale replica is a correct answer, a wedged one is not.
 */
export const REPLICA_SWAP_WAIT_MS = 5_000;

/**
 * The SHARED half of 308. The reader holds it for the LIFETIME of the handle, not just the open: on
 * macOS, SQLite checks that the path it opened still resolves to the inode it opened and returns
 * SQLITE_IOERR_VNODE ("disk I/O error") for every subsequent read once a rename has moved that path,
 * and the poisoning is permanent -- a reader that has crossed one swap never recovers, so retrying the
 * statement (or handing each reader its own hardlink) cannot help. Only keeping the swap from landing
 * while the handle is open does.
 */
export function openReplicaForRead(
  dbPath: string,
  attempts = REPLICA_REOPEN_ATTEMPTS,
  lock: AcquireOptions = {},
): Database {
  return retryOnReplacement(() => openReplicaOnce(dbPath, lock), attempts);
}

/** Tie the hold to the handle, so every existing `close()` releases it and none has to be taught to. */
function releaseWhenClosed(db: Database, hold: FileHold): Database {
  const close = db.close.bind(db);
  db.close = (throwOnError?: boolean) => {
    try {
      return close(throwOnError);
    } finally {
      hold.release();
    }
  };
  return db;
}

function openReplicaOnce(dbPath: string, lock: AcquireOptions = {}): Database {
  const path = replicaPath(dbPath);
  // Gate first (so a waiting swap goes ahead of this reader), then the replica itself, which is held
  // until the handle closes. A refusal on either means a swap is in flight and would not clear inside
  // the budget; reading anyway is the pre-308 behaviour and the right degrade, since a command that
  // could be answered is answered.
  const gate = acquireFileLock(replicaSwapGatePath(dbPath), "shared", { waitMs: REPLICA_READ_WAIT_MS, ...lock });
  const hold = acquireFileLock(replicaLockPath(dbPath), "shared", { waitMs: REPLICA_READ_WAIT_MS, ...lock });
  gate?.release();
  let handedOver = false;
  try {
    const db = openReplicaReadOnly(path);
    try {
      const actual = schemaFingerprintHash(db);
      const expected = expectedFingerprint(dbPath);
      if (actual !== expected) {
        throw new AppError(
          `replica schema does not match this client (replica ${actual}, expected ${expected}). ` +
            `The server is on a different schema: update this checkout, or run 'ob replica refresh' after the ` +
            `server has deployed. Refusing to read a shape ob does not understand.`,
        );
      }
    } catch (err) {
      db.close();
      throw err;
    }
    handedOver = true;
    return hold ? releaseWhenClosed(db, hold) : db;
  } finally {
    if (!handedOver) hold?.release();
  }
}

// --- the server half ---------------------------------------------------------

/**
 * VACUUM INTO a temp file, gzip it to stdout, delete the temp. Keeps the whole protocol inside `ob` and
 * off sqlite3(1), which the server need not have. Raw SQL by necessity: VACUUM has no ORM form.
 */
export function dumpReplicaBytes(db: Database): Uint8Array {
  const scratch = join(tmpdir(), `ob-dump-${randomUUID()}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${scratch.replaceAll("'", "''")}'`);
    return Bun.gzipSync(new Uint8Array(readFileSync(scratch)));
  } finally {
    rmSync(scratch, { force: true });
  }
}

export async function dumpReplica(
  db: Database,
  write: (bytes: Uint8Array) => unknown | Promise<unknown>,
): Promise<number> {
  const gz = dumpReplicaBytes(db);
  await write(gz);
  return gz.byteLength;
}

// --- the client half ---------------------------------------------------------

export interface RefreshOutcome {
  refreshed: boolean;
  /** The token was unchanged, so the transfer was skipped. */
  skipped: boolean;
  /**
   * 308: another process had the replica OPEN, so the swap was not made. Not an error -- the previous
   * replica is intact, the meta stays dirty, and the next command refreshes.
   */
  deferred: boolean;
  reachable: boolean;
  token: string | null;
  bytes: number;
  error: string | null;
}

/**
 * Pull the server's dump into place. Written to a temp path, verified (it opens and its schema matches
 * what this client expects) and only then `rename()`d in, so a refresh killed halfway can never leave a
 * half-written replica behind.
 */
export function refreshReplica(input: {
  dbPath: string;
  host: string;
  exec: RemoteExec;
  force?: boolean;
  /** 308: how the swap takes its exclusive hold. Tests drive the contended and unavailable cases here. */
  lock?: AcquireOptions;
  /** The clock, for the meta timestamps and the skew backoff. Tests pass one rather than sleeping. */
  now?: () => number;
}): RefreshOutcome {
  const { dbPath, host, exec, force } = input;
  const now = input.now ?? Date.now;
  const meta = readMeta(dbPath);
  // OB-1931: the dirty generation this refresh can vouch for. A mark that lands after this point bumps
  // the generation, and the success paths below then leave `dirty` set.
  const seenSeq = meta.dirty_seq;
  const cleared = (m: ReplicaMeta): Pick<ReplicaMeta, "dirty"> => ({ dirty: m.dirty_seq === seenSeq ? false : m.dirty });
  const failed = (error: string) =>
    updateMeta(dbPath, (m) => ({ ...m, last_refresh_ok: false, last_error: error }));
  const target = replicaPath(dbPath);

  const tokenResult = exec.capture(host, ["replica", "token"]);
  if (tokenResult.connectionFailed || tokenResult.code !== 0) {
    const error = tokenResult.connectionFailed
      ? `could not reach ${host} over ssh`
      : `ob replica token failed on ${host}: ${tokenResult.stderr.trim() || `exit ${tokenResult.code}`}`;
    failed(error);
    return {
      refreshed: false,
      skipped: false,
      deferred: false,
      reachable: !tokenResult.connectionFailed,
      token: null,
      bytes: 0,
      error,
    };
  }
  const token = tokenResult.stdout.trim();

  if (!force && token.length > 0 && token === meta.token && existsSync(target)) {
    // The server confirmed this replica current, so its age restarts now (OB-1931).
    updateMeta(dbPath, (m) => ({
      ...m,
      ...cleared(m),
      refreshed_at: new Date(now()).toISOString(),
      last_refresh_ok: true,
      last_error: null,
    }));
    return { refreshed: false, skipped: true, deferred: false, reachable: true, token, bytes: 0, error: null };
  }

  // OB-1931: a dump that failed the skew check will fail it again until the server deploys or this
  // checkout updates, so a ~59MB download is not repeated on every read inside the backoff.
  if (!force && meta.skew_at) {
    const until = skewBackoffUntil(meta, expectedFingerprint(dbPath), now());
    if (until) {
      return {
        refreshed: false,
        skipped: false,
        deferred: false,
        reachable: true,
        token,
        bytes: 0,
        error: `schema skew: backing off until ${until}; ob replica refresh --force retries now`,
      };
    }
  }

  const dump = exec.fetch(host, ["replica", "dump"]);
  if (dump.connectionFailed || dump.code !== 0) {
    const error = dump.connectionFailed
      ? `could not reach ${host} over ssh`
      : `ob replica dump failed on ${host}: ${dump.stderr.trim() || `exit ${dump.code}`}`;
    failed(error);
    return {
      refreshed: false,
      skipped: false,
      deferred: false,
      reachable: !dump.connectionFailed,
      token,
      bytes: 0,
      error,
    };
  }

  mkdirSync(dirname(target), { recursive: true });
  const scratch = `${target}.incoming-${randomUUID()}`;
  try {
    writeFileSync(scratch, gunzip(dump.bytes));
    let fingerprint: string;
    try {
      const probe = openReplicaReadOnly(scratch);
      fingerprint = schemaFingerprintHash(probe);
      probe.close();
    } catch (err) {
      throw new Error(`the dump from ${host} did not open as a database: ${(err as Error).message}`);
    }
    const expected = expectedFingerprint(dbPath);
    if (fingerprint !== expected) {
      throw new ReplicaSchemaSkewError(
        `schema skew: ${host} is on fingerprint ${fingerprint}, this client expects ${expected}. The replica was NOT replaced.`,
        expected,
      );
    }
    // 308, THE SWAP WINDOW. The rename is atomic for the directory entry and still fatal to a reader
    // that has the old inode open, so it may only land when no reader holds the replica. Taken AFTER the
    // transfer and the verification, so readers wait on a rename rather than on a 59MB download.
    const gate = acquireFileLock(replicaSwapGatePath(dbPath), "exclusive", {
      waitMs: REPLICA_SWAP_WAIT_MS,
      ...input.lock,
    });
    const swap =
      gate &&
      acquireFileLock(replicaLockPath(dbPath), "exclusive", {
        waitMs: REPLICA_SWAP_WAIT_MS,
        ...input.lock,
      });
    if (!swap) {
      gate?.release();
      // Only the deferral is recorded (OB-1931): `dirty` stays as it is, so the next command refreshes.
      updateMeta(dbPath, (m) => ({ ...m, last_deferred_at: new Date(now()).toISOString() }));
      return { refreshed: false, skipped: false, deferred: true, reachable: true, token, bytes: 0, error: null };
    }
    try {
      renameSync(scratch, target);
      updateMeta(dbPath, (m) => ({
        ...m,
        ...cleared(m),
        token,
        refreshed_at: new Date(now()).toISOString(),
        last_refresh_ok: true,
        last_error: null,
        fingerprint,
        skew_at: null,
        skew_expected: null,
        last_deferred_at: null,
      }));
    } finally {
      swap.release();
      gate?.release();
    }
    return {
      refreshed: true,
      skipped: false,
      deferred: false,
      reachable: true,
      token,
      bytes: dump.bytes.byteLength,
      error: null,
    };
  } catch (err) {
    const error = (err as Error).message;
    if (err instanceof ReplicaSchemaSkewError) {
      const at = new Date(now()).toISOString();
      updateMeta(dbPath, (m) => ({
        ...m,
        last_refresh_ok: false,
        last_error: error,
        skew_at: at,
        skew_expected: err.expected,
      }));
    } else {
      failed(error);
    }
    return { refreshed: false, skipped: false, deferred: false, reachable: true, token, bytes: 0, error };
  } finally {
    rmSync(scratch, { force: true });
  }
}

export interface StalenessNotice {
  stale: boolean;
  message: string | null;
}

/**
 * The one-line marker that keeps a stale answer from passing as a live one. It goes to STDERR so a
 * `--json` consumer's stdout is untouched and the cli.ts:889 guarantee still holds.
 */
export function stalenessNotice(input: {
  meta: ReplicaMeta;
  unreachable: boolean;
  now?: number;
  staleAfterS?: number;
}): StalenessNotice {
  const age = replicaAgeSeconds(input.meta, input.now ?? Date.now());
  const limit = input.staleAfterS ?? STALE_AFTER_S;
  const old = age === null || age > limit;
  if (!old && !input.unreachable) return { stale: false, message: null };
  const suffix = input.unreachable ? " (server unreachable)" : "";
  return { stale: true, message: `replica as of ${formatAge(age)}${suffix}` };
}
