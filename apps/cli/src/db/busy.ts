import type { Database } from "bun:sqlite";
import { AppError } from "../errors.ts";

// ── contention on the shared database (317) ────────────────────────────────────────────────────────
//
// Since the cutover to the Proxmox box (185) every write from every machine, plus ~10 server timers,
// funnels into ONE sqlite file. Contention is the normal case now, and two writes died of it on the
// same day: an `omnislash-cal-sync` run ("error: database is locked", then "Failed to start
// omnislash-cal-sync.service") and an `ob agent register` dispatched over ssh, which succeeded on a
// plain retry seconds later, unchanged.
//
// WHY openDb's busy_timeout AND its retry loop (223) BOTH MISSED THEM. Neither is broken:
//
//   - `PRAGMA busy_timeout = 5000` is set on the write handle, and it does work: a plain autocommit
//     write against a database whose write lock is held blocks for the holder and then succeeds
//     (measured: 1596ms against a 2s holder).
//   - openDb's retry loop covers the OPEN (the pragmas, the baseline adoption, the migrations) and
//     returns a handle. Every statement a command runs afterwards is outside it, by construction.
//
// What actually failed is the shape BOTH of those writes share: `db.transaction(...)()`, which bun
// (like better-sqlite3) starts with a DEFERRED `BEGIN`. A deferred transaction that READS and then
// WRITES (`registerAgent` reads the existing row before upserting it; the calendar ingest reads
// before inserting) takes a read lock first and then has to UPGRADE it. SQLite refuses that upgrade
// IMMEDIATELY with SQLITE_BUSY and does NOT invoke the busy handler, because a connection that waited
// while holding a read lock could deadlock against the writer it is waiting for. So busy_timeout is
// bypassed entirely: measured, the deferred transaction fails in 1ms with "database is locked" where
// the same body as IMMEDIATE waits 1580ms and commits.
//
// Hence the two things here: writeTxn takes the write lock UP FRONT (BEGIN IMMEDIATE), which puts the
// wait back under busy_timeout, and withBusyRetry retries the whole transaction a bounded number of
// times for the case where even that budget runs out.
//
// SQLITE_BUSY is the one sqlite error that is always safe to retry: the lock was never acquired, so
// nothing was written and there is no partial state to double-apply. That safety does NOT extend to
// anything else, so nothing else is retried here. SQLITE_IOERR in particular must keep surfacing (a
// replica race is being diagnosed under 308, and sweeping it in would hide it).

export function matchesSqliteError(err: unknown, predicate: (message: string) => boolean): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && predicate(message)) return true;
  }
  return false;
}

/** Genuine contention, and the ONLY class worth retrying. Notably NOT "already exists": that never
 *  becomes true on a later attempt, and retrying it six times was what turned a one-line diagnosis
 *  into a hand-hashed journal (223). SQLITE_LOCKED (a table locked by another connection) is the same
 *  promise as SQLITE_BUSY, the statement was refused before it changed anything. */
export function isBusyFailure(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) return true;
  }
  return matchesSqliteError(
    err,
    (message) => /database is locked/i.test(message) || /database table is locked/i.test(message),
  );
}

const REASON_MAX_CHARS = 300;

/** The sqlite reason a human needs, and nothing else. bun:sqlite's own message is already exactly
 *  right ("table `credential_check` already exists"); it was drizzle's DrizzleQueryError wrapping it
 *  in `Failed to run the query '<the entire .sql file>'` that buried it, so the live failure printed a
 *  migration's comment header where its cause belonged. */
export function sqliteReason(err: unknown): string {
  let reason = "unknown error";
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) reason = message;
  }
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > REASON_MAX_CHARS ? `${oneLine.slice(0, REASON_MAX_CHARS)}...` : oneLine;
}

/** How many times a contended write is attempted in total, and the wall-clock the retries may span.
 *  BOTH bound it: a command or a systemd timer must fail with something a human can read rather than
 *  hang, so the loop stops at whichever comes first. Each attempt carries its own busy_timeout budget
 *  on top, which is where the real waiting happens. */
export const WRITE_ATTEMPTS = 5;
export const WRITE_BUDGET_MS = 15_000;
const RETRY_BASE_MS = 40;

/** Jittered so ten timers that all lost the same lock do not queue up and collide again in lockstep. */
function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * (attempt + 1) + Math.floor(Math.random() * RETRY_BASE_MS);
}

export class DatabaseBusyError extends AppError {
  constructor(what: string, attempts: number, elapsedMs: number, cause: unknown) {
    super(
      [
        `could not ${what}: the database is locked by another process, and still was after ${attempts} attempts over ${elapsedMs}ms.`,
        `  nothing was written (sqlite refuses a contended write before it changes anything), so running this again is safe`,
        `  sqlite said: ${sqliteReason(cause)}`,
      ].join("\n"),
    );
    this.cause = cause;
  }
}

/**
 * Run `body`, retrying it ONLY while sqlite reports contention. `what` names the write in the failure
 * ("register agent"), because a timer's journal line is all a human gets.
 *
 * The retry is safe precisely because it is scoped to SQLITE_BUSY/SQLITE_LOCKED: the write never
 * started, so re-running the body cannot double-apply it. `body` must therefore be pure database
 * work: a body with side effects outside the database does not belong in here.
 */
export function withBusyRetry<T>(what: string, body: () => T): T {
  const startedAt = Date.now();
  let lastError: unknown;
  let made = 0;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    made++;
    try {
      return body();
    } catch (err) {
      if (!isBusyFailure(err)) throw err;
      lastError = err;
      const isLast = attempt === WRITE_ATTEMPTS - 1 || Date.now() - startedAt >= WRITE_BUDGET_MS;
      if (isLast) break;
      Bun.sleepSync(backoffMs(attempt));
    }
  }
  throw new DatabaseBusyError(what, made, Date.now() - startedAt, lastError);
}

/**
 * withBusyRetry for an ASYNC body (337).
 *
 * The store seam's write transaction has to await, because the Postgres client is not synchronous, and
 * `withBusyRetry`'s `Bun.sleepSync` would block the event loop that the awaited work needs in order to
 * finish. Same bounds, same rule about WHAT is retried: contention only, and a body that is anything but
 * database work does not belong in here.
 */
export async function withBusyRetryAsync<T>(what: string, body: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  let made = 0;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    made++;
    try {
      return await body();
    } catch (err) {
      if (!isBusyFailure(err)) throw err;
      lastError = err;
      const isLast = attempt === WRITE_ATTEMPTS - 1 || Date.now() - startedAt >= WRITE_BUDGET_MS;
      if (isLast) break;
      await Bun.sleep(backoffMs(attempt));
    }
  }
  throw new DatabaseBusyError(what, made, Date.now() - startedAt, lastError);
}

/**
 * THE write-transaction seam. Use this instead of `db.transaction(...)()` for anything that writes:
 * it opens with BEGIN IMMEDIATE, so the write lock is taken before the body reads anything and the
 * wait for it is served by busy_timeout rather than refused outright, and it retries the whole
 * transaction on contention within the bound above.
 *
 * A busy failure on an immediate transaction happens at the BEGIN, before the body runs at all, so a
 * retry re-runs a body that had no chance to do anything the first time.
 */
export function writeTxn<T>(db: Database, what: string, body: () => T): T {
  const tx = db.transaction(body);
  return withBusyRetry(what, () => tx.immediate() as T);
}
