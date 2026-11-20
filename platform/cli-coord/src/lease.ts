// ob 337: the lease primitive through ob 324's store seam.
//
// This one is load-bearing for CORRECTNESS rather than convenience: leases are how two sessions avoid
// clobbering each other's worktrees and gates (decisions #37/#56/#97), and they live IN the database
// being protected, which is exactly why they have to follow the cutover rather than stay behind on a
// file nobody is writing to any more. (ob 308's file-lock is deliberately NOT a lease for the opposite
// reason: it guards the moment before a database is open.)
//
// The conventions are items.ts's: signatures WIDEN to `Database | Store` via asStore, so every unported
// caller and every existing test keeps passing a raw handle and keeps byte-identical sqlite behaviour;
// every function is async and every builder is AWAITED, because .all()/.get()/.run() are the sqlite
// dialect's synchronous terminators.
//
// What the engine differences do and do not touch here:
//   - no aggregate is read, so readNumber is not needed. `ttl_s` is a plain integer column read back as
//     a number on both.
//   - no boolean column and no json column: `expired` is COMPUTED from timestamps, never stored.
//   - the only ordering is `asc(resource)`, and `resource` is the PRIMARY KEY, so it is NOT NULL and the
//     NULLS FIRST (postgres) vs NULLS LAST (sqlite) split cannot reach it. The nullable columns on this
//     table (holder, acquired_at, ttl_s, heartbeat_at) are only ever filtered or read, never ordered by.
//   - `excluded.*` in the upsert is standard on both engines (it is SQLite that copied it from Postgres).
//
// TRANSACTIONS. acquireLease and acquireLeases decide and then write, and that pair must be atomic or
// two sessions can both read "free" and both write themselves in -- the whole point of the primitive. So
// they use Store.txn, which is BEGIN IMMEDIATE on sqlite (317's reason: a deferred transaction that reads
// then writes cannot upgrade its lock and fails instantly with SQLITE_BUSY) and the driver's own
// transaction on Postgres, with the body bound to that connection. The body therefore uses the store it
// is HANDED, never the outer one.
import type { Database } from "bun:sqlite";
import { constants as osConstants, hostname } from "node:os";
import { realpathSync } from "node:fs";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { isApiTransient } from "../../../apps/cli/src/api/client.ts";
import { isTeamRoleAgent } from "../../../apps/cli/src/team.ts";
import type { LeaseWaitTitle } from "./lease-wait-title.ts";

/** Default TTL for ticket: / worktree: / port: / app:<variant> unless the caller passes --ttl (ob 561). */
export const DEFAULT_LEASE_TTL_S = 1200;
/** --wait poll interval. There is no timeout: wait until the hold lapses or is released (ob 561). */
export const LEASE_WAIT_POLL_MS = 1500;

export interface LeaseRow {
  resource: string;
  holder: string | null;
  acquired_at: string | null;
  ttl_s: number | null;
  heartbeat_at: string | null;
}

export interface LeaseStatusRow extends LeaseRow {
  expired: boolean;
}

/** True when the lease's TTL has elapsed relative to `now` (or is unheld/incomplete). */
export function isLeaseExpired(row: LeaseRow, nowMs: number): boolean {
  if (!row.holder || row.ttl_s === null) return true;
  const base = row.heartbeat_at ?? row.acquired_at;
  if (!base) return true;
  const baseMs = new Date(base).getTime();
  if (Number.isNaN(baseMs)) return true;
  return nowMs > baseMs + row.ttl_s * 1000;
}

async function readLease(db: Database | Store, resource: string): Promise<LeaseRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.lease).where(eq(s.t.lease.resource, resource)).limit(1)) as LeaseRow[];
  return rows[0] ?? null;
}

/**
 * OB-1922: when `read` is the row the caller already holds LIVE, `acquired_at` is carried over, so a
 * same-holder re-acquire only moves the expiry (heartbeat_at + ttl_s) and the lease keeps its age. A
 * fresh grant (no row, an expired row, another holder's expired row) starts a new lease at `now`.
 */
function carriedAcquiredAt(read: LeaseRow | null, holder: string, now: string, nowMs: number): string {
  return read && read.holder === holder && read.acquired_at && !isLeaseExpired(read, nowMs) ? read.acquired_at : now;
}

/**
 * Insert the row only when no row exists (OB-2288). True when this call inserted it. On Postgres a
 * concurrent uncommitted insert of the same key blocks this one until it commits, then it does nothing,
 * so two acquirers that both read the row absent cannot both get it.
 */
async function insertLeaseIfAbsent(
  db: Database | Store,
  resource: string,
  holder: string,
  ttlS: number,
  now: string,
): Promise<boolean> {
  const s = asStore(db);
  const rows = (await s.q
    .insert(s.t.lease)
    .values({ resource, holder, acquired_at: now, ttl_s: ttlS, heartbeat_at: now })
    .onConflictDoNothing({ target: s.t.lease.resource })
    .returning({ resource: s.t.lease.resource })) as Array<{ resource: string }>;
  return rows.length > 0;
}

/**
 * Compare-and-swap the row (OB-2288): write only if it still names the holder and heartbeat it had
 * when `read` was taken. True when this call wrote it. On Postgres a concurrent update blocks this one
 * until it commits, and the WHERE is then checked against the new row, so only one of two racers wins.
 */
async function casUpdateLease(
  db: Database | Store,
  read: LeaseRow,
  holder: string,
  ttlS: number,
  now: string,
  nowMs: number,
): Promise<boolean> {
  const s = asStore(db);
  const col = s.t.lease;
  const rows = (await s.q
    .update(col)
    .set({ holder, acquired_at: carriedAcquiredAt(read, holder, now, nowMs), ttl_s: ttlS, heartbeat_at: now })
    .where(
      and(
        eq(col.resource, read.resource),
        read.holder === null ? isNull(col.holder) : eq(col.holder, read.holder),
        read.heartbeat_at === null ? isNull(col.heartbeat_at) : eq(col.heartbeat_at, read.heartbeat_at),
      ),
    )
    .returning({ resource: col.resource })) as Array<{ resource: string }>;
  return rows.length > 0;
}

/** True when `row` is a live hold by someone other than `holder`. */
function heldByOther(row: LeaseRow | null, holder: string, nowMs: number): row is LeaseRow & { holder: string } {
  return !!row?.holder && row.holder !== holder && !isLeaseExpired(row, nowMs);
}

/** How many times one key re-reads after its write lost to a concurrent change before giving up. */
const CLAIM_ATTEMPTS = 3;

/** Who a denial names when the key kept changing under every attempt but no live holder was read. */
const CONTENDED = "a concurrent acquirer";

/**
 * Write `holder`'s lease on `key`, starting from `read` (OB-2288). Never overwrites a row that changed
 * since it was read: a lost write re-reads, and denies when the row now names another live holder (the
 * racer that won). A row that changed but is still free (released, or refreshed by its own expired
 * holder) is tried again.
 */
async function claimLease(
  tx: Store,
  key: string,
  read: LeaseRow | null,
  holder: string,
  ttlS: number,
  now: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; row: LeaseRow | null }> {
  let row = read;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    if (heldByOther(row, holder, nowMs)) return { ok: false, row };
    const won = row
      ? await casUpdateLease(tx, row, holder, ttlS, now, nowMs)
      : await insertLeaseIfAbsent(tx, key, holder, ttlS, now);
    if (won) return { ok: true };
    row = await readLease(tx, key);
  }
  return { ok: false, row };
}

/**
 * Acquire (or refresh) a lease in a single transaction.
 * Grants if the row is absent, the existing lease is expired, or it is already
 * held by the same holder (heartbeat refresh). Otherwise denies and reports the
 * live holder. Two concurrent acquirers never both get it (OB-2288): the write is a compare-and-swap
 * against the row that was read.
 */
export async function acquireLease(
  db: Database | Store,
  resource: string,
  holder: string,
  ttlS: number,
): Promise<{ ok: boolean; holder: string }> {
  const s = asStore(db);
  const now = nowIso();
  const nowMs = new Date(now).getTime();
  return s.txn("acquire the lease", async (tx) => {
    const claimed = await claimLease(tx, resource, await readLease(tx, resource), holder, ttlS, now, nowMs);
    if (claimed.ok) return { ok: true, holder };
    return { ok: false, holder: claimed.row?.holder || CONTENDED };
  });
}

export type LeaseWaitSleep = (ms: number) => void | Promise<void>;

/**
 * Poll `attempt` until it grants. No deadline: --wait waits for the hold to lapse or be released,
 * never times out at 60s (ob 561). Tests inject `sleep` so they do not wall-clock wait.
 *
 * An attempt that gets no answer from the ob API (unreachable, or a call timeout) counts as "not granted
 * yet" (OB-2157): a deploy restart refuses connections for a few seconds, and a waiter that died on one
 * refused poll lost its place for nothing. Any other error still ends the wait.
 */
export async function waitUntilAcquired<T extends { ok: boolean }>(
  attempt: () => Promise<T>,
  opts: {
    pollMs?: number;
    sleep?: LeaseWaitSleep;
    resource?: string;
    log?: (line: string) => void;
    /** The thread-title marker for the wait (OB-2153): marked on the first denial, restored however it ends. */
    title?: LeaseWaitTitle;
  } = {},
): Promise<T> {
  const pollMs = opts.pollMs ?? LEASE_WAIT_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const outage = apiOutageReporter(opts.resource ?? "the lease", opts.log ?? ((line) => console.error(line)));
  const title = opts.title?.enabled ? opts.title : null;
  if (!title) {
    for (;;) {
      const result = await tryAttempt(attempt, outage);
      if (result?.ok) return result;
      await sleep(pollMs);
    }
  }
  // A marked title must come back on Ctrl-C too (OB-2153), so a titled wait catches the signals while it is
  // queued: the signal stops the wait before any further attempt, the title is restored, and the caller exits
  // 128 + the signal, as the default handler would have. The sleep is async here so the handler can run.
  let signalled: NodeJS.Signals | null = null;
  let wake: (() => void) | null = null;
  const handlers = LEASE_WAIT_SIGNALS.map((sig) => {
    const h = () => {
      signalled ??= sig;
      wake?.();
    };
    process.on(sig, h);
    return [sig, h] as const;
  });
  const nap = async (ms: number) => {
    if (opts.sleep) return void (await opts.sleep(ms));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  };
  try {
    for (;;) {
      if (signalled) throw new LeaseWaitSignalled(signalled);
      const result = await tryAttempt(attempt, outage);
      if (result?.ok) return result;
      if (result) await title.waiting();
      if (signalled) throw new LeaseWaitSignalled(signalled);
      await nap(pollMs);
    }
  } finally {
    await title.done();
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

const LEASE_WAIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** A titled `lease acquire --wait` stopped by a signal while queued (OB-2153); `exitCode` is 128 + the signal. */
export class LeaseWaitSignalled extends Error {
  readonly exitCode: number;
  constructor(readonly signal: NodeJS.Signals) {
    super(`interrupted by ${signal} while waiting`);
    this.exitCode = 128 + (osConstants.signals[signal] ?? 0);
  }
}

/** Says once that the API went away and once that it came back, however many polls the outage spans. */
export interface ApiOutageReporter {
  down(): void;
  up(): void;
}

export function apiOutageReporter(resource: string, log: (line: string) => void): ApiOutageReporter {
  let down = false;
  return {
    down() {
      if (!down) log(`ob API unreachable, still waiting for ${resource}`);
      down = true;
    },
    up() {
      if (down) log("ob API back");
      down = false;
    },
  };
}

/** One attempt: its result, or null when the API gave no answer (reported once per outage). */
export async function tryAttempt<T>(attempt: () => Promise<T>, outage: ApiOutageReporter): Promise<T | null> {
  try {
    const r = await attempt();
    outage.up();
    return r;
  } catch (err) {
    if (!isApiTransient(err)) throw err;
    outage.down();
    return null;
  }
}

/**
 * Delete the lease when it is `holder`'s, when it has EXPIRED, or when `force`. Returns whether a row
 * was deleted.
 *
 * Expired counts as releasable so release is symmetric with acquire (#75): `acquireLease` already grants
 * over an expired row to any holder, so an expired lease protects nothing, and demanding `--force` to
 * tidy one taught `--force` for a case that never needed it. A LIVE lease held by someone else still
 * needs `force`, which is the whole point of the primitive (decisions #56/#97).
 */
export async function releaseLease(
  db: Database | Store,
  resource: string,
  holder: string,
  force = false,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const s = asStore(db);
  const row = await readLease(s, resource);
  if (!row) return false;
  if (!force && row.holder !== holder && !isLeaseExpired(row, nowMs)) return false;
  await s.q.delete(s.t.lease).where(eq(s.t.lease.resource, resource));
  return true;
}

/**
 * OB-1922: a heartbeat on a lease the caller holds but which has already EXPIRED. It is refused rather
 * than revived: once the TTL lapsed, any other holder could have acquired the row (acquireLease grants
 * over an expired lease), so bringing it back silently would hand out a hold nobody checked. The holder
 * must `ob lease acquire` again, which decides afresh.
 */
export class LeaseExpiredError extends Error {
  override readonly name = "LeaseExpiredError";
  constructor(
    readonly resource: string,
    readonly holder: string,
  ) {
    super(`${resource} expired before ${holder} beat it: acquire it again ('ob lease acquire ${resource} --holder ${holder}')`);
  }
}

/**
 * Refresh heartbeat_at=now if the lease is held LIVE by `holder`. Returns false when the row is absent
 * or names another holder; throws LeaseExpiredError when it is `holder`'s but its TTL has lapsed
 * (OB-1922). The read and the write are one transaction so the expiry is judged on the row written.
 */
export async function heartbeatLease(db: Database | Store, resource: string, holder: string): Promise<boolean> {
  const s = asStore(db);
  const now = nowIso();
  const nowMs = new Date(now).getTime();
  return s.txn("beat the lease", async (tx) => {
    const row = await readLease(tx, resource);
    if (!row || row.holder !== holder) return false;
    if (isLeaseExpired(row, nowMs)) throw new LeaseExpiredError(resource, holder);
    // conditional on the beat we read, so a row changed under us (postgres takes no lock on the read)
    // is a missed beat, never a write onto someone else's lease
    const changed = (await tx.q
      .update(tx.t.lease)
      .set({ heartbeat_at: now })
      .where(
        and(
          eq(tx.t.lease.resource, resource),
          eq(tx.t.lease.holder, holder),
          row.heartbeat_at === null ? isNull(tx.t.lease.heartbeat_at) : eq(tx.t.lease.heartbeat_at, row.heartbeat_at),
        ),
      )
      .returning({ resource: tx.t.lease.resource })) as { resource: string }[];
    if (changed.length === 1) return true;
    // a same-holder beat raced this one and moved heartbeat_at: the lease is still ours if it is live
    const now2 = await readLease(tx, resource);
    return !!now2 && now2.holder === holder && !isLeaseExpired(now2, Date.now());
  });
}

/**
 * Beat a lease, and when it has expired take it again with a fresh acquire (OB-1922). For a holder that
 * must not lose its lease to a pause (the spinoff launch claim): the acquire is refused when another
 * holder took the lease live in the meantime, and a re-taken lease starts a new `acquired_at`, so
 * nothing is revived. True when the holder holds the lease live afterwards.
 */
export async function heartbeatOrReacquire(db: Database | Store, resource: string, holder: string, ttlS: number): Promise<boolean> {
  try {
    return await heartbeatLease(db, resource, holder);
  } catch (e) {
    if (!(e instanceof LeaseExpiredError)) throw e;
    return (await acquireLeases(db, [resource], holder, ttlS)).ok;
  }
}

/** OB-1922: how long an expired row is kept (for `ob lease status` to show) before it is swept. */
export const LEASE_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Delete every row that expired more than a day ago (OB-1922: nothing else removes a lease nobody
 * releases, so they built up). A row expired for less than that stays so `ob lease status` can still
 * show who held it. "Expired a day ago" is `isLeaseExpired` judged a day earlier, so an incomplete row
 * (no holder, no ttl, no timestamp: never written by an acquire) also goes. Returns the swept resources.
 *
 * Decide-then-delete, so it is one transaction, and each delete is conditional on the row still being
 * the one that was judged (same holder and beat): a key re-acquired since the read is left alone.
 */
export async function sweepExpiredLeases(db: Database | Store, nowMs: number = Date.now()): Promise<string[]> {
  return asStore(db).txn("sweep expired leases", async (tx) => {
    const rows = (await tx.q.select().from(tx.t.lease).orderBy(asc(tx.t.lease.resource))) as LeaseRow[];
    const swept: string[] = [];
    for (const row of rows) {
      if (!isLeaseExpired(row, nowMs - LEASE_SWEEP_AFTER_MS)) continue;
      const l = tx.t.lease;
      const gone = (await tx.q
        .delete(l)
        .where(
          and(
            eq(l.resource, row.resource),
            row.holder === null ? isNull(l.holder) : eq(l.holder, row.holder),
            row.heartbeat_at === null ? isNull(l.heartbeat_at) : eq(l.heartbeat_at, row.heartbeat_at),
          ),
        )
        .returning({ resource: l.resource })) as { resource: string }[];
      if (gone.length === 1) swept.push(row.resource);
    }
    return swept;
  });
}

/** All leases with a computed `expired` flag. */
export async function leaseStatus(db: Database | Store): Promise<LeaseStatusRow[]> {
  const s = asStore(db);
  const nowMs = Date.now();
  // resource is the primary key, so it is NOT NULL and this ordering is identical on both engines.
  const rows = (await s.q.select().from(s.t.lease).orderBy(asc(s.t.lease.resource))) as LeaseRow[];
  return rows.map((row) => ({ ...row, expired: isLeaseExpired(row, nowMs) }));
}

/**
 * Holders whose leases have all elapsed (they still hold at least one expired row, and no live one).
 * Used to stale matching agent rows without `agent done` (ob 561). A holder with any live lease stays live.
 */
export async function expiredLeaseHolders(db: Database | Store, nowMs: number = Date.now()): Promise<Set<string>> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.lease)) as LeaseRow[];
  const live = new Set<string>();
  const expired = new Set<string>();
  for (const row of rows) {
    if (!row.holder) continue;
    if (isLeaseExpired(row, nowMs)) expired.add(row.holder);
    else live.add(row.holder);
  }
  for (const holder of live) expired.delete(holder);
  return expired;
}

/** The default holder id for a lease taken by an `ob` invocation: `<pid>@<host>`. */
export function leaseHolderId(): string {
  return `${process.pid}@${hostname()}`;
}

// ---------------------------------------------------------------------------
// key classes (#97): tickets/worktrees/apps lease like ports (decision #37)
// ---------------------------------------------------------------------------
// The lease primitive is resource-agnostic, but the resources sessions actually contend over have a
// shape worth naming, so a guard can derive the keys covering "the thing about to be destroyed":
//   ticket:<ref>      the unit of work an architect gates/reviews/lands (`ticket:96`)
//   worktree:<path>   the physical checkout that gets removed (absolute path, trailing slash stripped)
//   app:<name>        a single-instance GUI app only one session may drive/verify (`app:<name>`)
//   port:<n>          the pre-existing class (decision #37, a dev server)
//   spinoff:<id>      the launch claim on one spinoff queue row (OB-1921, `spinoffClaimKey`; OB-1922)
//   cpu:<name>        a machine-wide CPU slot only one run may hold (OB-2071, `cpu:browser`): every
//                     Storybook and Playwright run takes it through `ob lease run`
//   flake:slot        the one flake fix on the whole machine (OB-2230): `ob spinoff` takes it for a
//                     `flake` ticket's builder and the handoff, close, abandon or a failed launch frees it
// A ticket maps ~1:1 to a worktree today, but adopted worktrees (#61) break that, so BOTH are keys and
// holding EITHER blocks a destructive path. Ticket refs normalise loosely (a leading `#` dropped,
// lowercased, non-`[a-z0-9._/-]` runs collapsed to `-`) so `#96`, `96` and `ticket:96` agree.

export const LEASE_KEY_CLASSES = ["ticket", "worktree", "app", "port", "spinoff", "cpu", "flake"] as const;
export type LeaseKeyClass = (typeof LEASE_KEY_CLASSES)[number];

/** `ticket:<normalised-ref>` for a ticket ref, or null when the ref is empty. Pure. */
export function ticketLeaseKey(ref: string | null | undefined): string | null {
  const norm = (ref ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return norm ? `ticket:${norm}` : null;
}

/**
 * `worktree:<canonical-path>` for a checkout, or null when empty. The path is RESOLVED through symlinks
 * (best effort) because the same tree is named differently by different callers: on macOS `$PWD` says
 * `/var/folders/...` while `git worktree list --porcelain` says `/private/var/folders/...`, so a lease
 * taken on one alias would silently fail to guard the other, so the guard would not fire at all. A path
 * that cannot be resolved (already removed, or a test fixture that never existed) keeps its literal
 * form, with trailing slashes stripped either way.
 */
export function worktreeLeaseKey(path: string | null | undefined): string | null {
  const p = (path ?? "").trim().replace(/\/+$/, "");
  if (!p) return null;
  try {
    return `worktree:${realpathSync(p).replace(/\/+$/, "")}`;
  } catch {
    return `worktree:${p}`;
  }
}

/** `app:<name>` for a single-instance app, or null when empty. Pure. */
export function appLeaseKey(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().toLowerCase();
  return n ? `app:${n}` : null;
}

/**
 * Canonicalise a resource a CALLER typed so it is the exact string the guards derive (#97). Without
 * this, `ob lease acquire ticket:CUE-1234` would store a key the guard's `ticket:cue-1234` never
 * matches, and the lease would look held while protecting nothing. Unknown classes pass through
 * untouched (the primitive stays resource-agnostic).
 */
export function normalizeLeaseResource(resource: string): string {
  const cls = leaseKeyClass(resource);
  const value = resource.slice(resource.indexOf(":") + 1);
  if (cls === "ticket") return ticketLeaseKey(value) ?? resource;
  if (cls === "worktree") return worktreeLeaseKey(value) ?? resource;
  if (cls === "app") return appLeaseKey(value) ?? resource;
  return resource;
}

/** The key class of a resource string, or null when it carries no known prefix. Pure. */
export function leaseKeyClass(resource: string): LeaseKeyClass | null {
  const i = resource.indexOf(":");
  if (i <= 0) return null;
  const cls = resource.slice(0, i);
  return (LEASE_KEY_CLASSES as readonly string[]).includes(cls) ? (cls as LeaseKeyClass) : null;
}

/** A live (unexpired) hold on a resource: what a contended caller is told about. */
export interface LeaseHold {
  resource: string;
  holder: string;
  since: string | null;
  ttl_s: number | null;
}

/** The live hold on `resource`, or null when free/expired (an expired hold is reclaimable). */
export async function liveHold(
  db: Database | Store,
  resource: string,
  nowMs: number = Date.now(),
): Promise<LeaseHold | null> {
  const row = await readLease(db, resource);
  if (!row || !row.holder || isLeaseExpired(row, nowMs)) return null;
  return { resource, holder: row.holder, since: row.acquired_at, ttl_s: row.ttl_s };
}

/**
 * The RECORDED hold on `resource` whether or not it is still live, with `expired` saying which, or null
 * when nothing is recorded. `liveHold` answers "may I proceed?"; this answers "who does the row name?",
 * which is what a not-yours message must print to be actionable (#75).
 */
export async function recordedHold(
  db: Database | Store,
  resource: string,
  nowMs: number = Date.now(),
): Promise<(LeaseHold & { expired: boolean }) | null> {
  const row = await readLease(db, resource);
  if (!row || !row.holder) return null;
  return {
    resource,
    holder: row.holder,
    since: row.acquired_at,
    ttl_s: row.ttl_s,
    expired: isLeaseExpired(row, nowMs),
  };
}

/**
 * The first of `resources` held LIVE by a holder that is not one of `self`, i.e. the reason a caller
 * must not proceed. Null when every resource is free, expired, or already ours. Nulls in `resources`
 * are ignored so callers can pass the key builders' output straight through.
 */
export async function foreignHold(
  db: Database | Store,
  resources: Array<string | null>,
  self: string[],
  nowMs: number = Date.now(),
): Promise<LeaseHold | null> {
  const s = asStore(db);
  const mine = new Set(self);
  for (const resource of resources) {
    if (!resource) continue;
    const hold = await liveHold(s, resource, nowMs);
    if (hold && !mine.has(hold.holder)) return hold;
  }
  return null;
}

/** The one-line contention message every guard reports: `<resource> held by <holder> since <ts>`. Pure. */
export function formatHold(hold: LeaseHold): string {
  return `${hold.resource} held by ${hold.holder} since ${hold.since ?? "unknown"} (ttl ${hold.ttl_s ?? "?"}s)`;
}

/**
 * The remedy clause EVERY not-yours / contended message ends with (#75). The normal way to act on a
 * lease is to NAME its holder, so that is what gets suggested; `--force` is named only as the
 * break-a-dead-holder escape hatch, never as the first thing to try.
 *
 * The messages this replaces offered `--force` and nothing else, so an architect who simply forgot the
 * `--holder` it acquired with was told to break a live lease: the exact habit decisions #56/#97 forbid,
 * taught by the tool itself. The message is the teaching surface, so it teaches the safe move.
 */
export function holderRemedy(retry: string, holder: string, expired = false): string {
  const escape = expired
    ? "its TTL has already lapsed, so --force is safe on this one"
    : "use --force ONLY if that holder is gone";
  return `if that holder is you, re-run as it: '${retry} --holder ${holder}' (${escape})`;
}

/**
 * What `ob lease release|heartbeat` prints when the resource is not the caller's to act on (#75): who
 * the row actually names, and the `--holder` retry that works. Pure.
 */
export function formatNotHeld(
  verb: "release" | "heartbeat",
  resource: string,
  caller: string,
  recorded: { holder: string; expired: boolean } | null,
): string {
  const nothing = verb === "release" ? "nothing released" : "nothing beaten";
  if (!recorded) return `${resource} is not held by anyone, ${nothing}`;
  const state = recorded.expired ? "was held by" : "is held by";
  const retry = `ob lease ${verb} ${resource}`;
  return `${resource} ${state} ${recorded.holder}, not ${caller}, ${nothing}: ${holderRemedy(retry, recorded.holder, recorded.expired)}`;
}

/**
 * Acquire ALL of `resources` for `holder` atomically: every key is checked for a live foreign hold
 * FIRST, so a denial acquires nothing (no half-held set). Already-ours keys refresh. Nulls ignored.
 */
export async function acquireLeases(
  db: Database | Store,
  resources: Array<string | null>,
  holder: string,
  ttlS: number,
): Promise<{ ok: true } | { ok: false; hold: LeaseHold }> {
  const s = asStore(db);
  const keys = [...new Set(resources.filter((r): r is string => !!r))];
  if (keys.length === 0) return { ok: true };
  const now = nowIso();
  const nowMs = new Date(now).getTime();
  try {
    return await s.txn("acquire the leases", async (tx) => {
      const rows = new Map<string, LeaseRow | null>();
      for (const key of keys) {
        const row = await readLease(tx, key);
        if (heldByOther(row, holder, nowMs)) return { ok: false as const, hold: leaseHold(key, row) };
        rows.set(key, row);
      }
      for (const key of keys) {
        const claimed = await claimLease(tx, key, rows.get(key) ?? null, holder, ttlS, now, nowMs);
        // A key lost to a concurrent acquirer after others were written: throw so the txn rolls every
        // written key back, and the loser holds none of the set (OB-2288).
        if (!claimed.ok) throw new LostLeaseRace(leaseHold(key, claimed.row));
      }
      return { ok: true as const };
    });
  } catch (err) {
    if (err instanceof LostLeaseRace) return { ok: false, hold: err.hold };
    throw err;
  }
}

function leaseHold(resource: string, row: LeaseRow | null): LeaseHold {
  return { resource, holder: row?.holder || CONTENDED, since: row?.acquired_at ?? null, ttl_s: row?.ttl_s ?? null };
}

/** Thrown inside acquireLeases' txn to roll it back when a key is lost to a concurrent acquirer. */
class LostLeaseRace extends Error {
  constructor(readonly hold: LeaseHold) {
    super(`lost the race for ${hold.resource} to ${hold.holder}`);
  }
}

/** Every resource currently recorded as held by `holder`, ordered. Does not delete. */
export async function listLeasesByHolder(db: Database | Store, holder: string): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ resource: s.t.lease.resource })
    .from(s.t.lease)
    .where(eq(s.t.lease.holder, holder))
    .orderBy(asc(s.t.lease.resource))) as Array<{ resource: string }>;
  return rows.map((r) => r.resource);
}

/** Release every lease held by `holder` (clean exit / `ob agent done`). Returns the released resources. */
export async function releaseLeasesByHolder(db: Database | Store, holder: string): Promise<string[]> {
  const s = asStore(db);
  const resources = await listLeasesByHolder(s, holder);
  if (resources.length === 0) return [];
  await s.q.delete(s.t.lease).where(eq(s.t.lease.holder, holder));
  return resources;
}

/** Every recorded lease resource, ordered. Does not delete. */
export async function listAllLeaseResources(db: Database | Store): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ resource: s.t.lease.resource })
    .from(s.t.lease)
    .orderBy(asc(s.t.lease.resource))) as Array<{ resource: string }>;
  return rows.map((r) => r.resource);
}

/** Release every lease (ob 437). Fresh means fresh — ticket/worktree/port/spinoff/app included. */
export async function releaseAllLeases(db: Database | Store): Promise<string[]> {
  const s = asStore(db);
  const resources = await listAllLeaseResources(s);
  if (resources.length === 0) return [];
  await s.q.delete(s.t.lease).where(inArray(s.t.lease.resource, resources));
  return resources;
}

/**
 * Refresh every LIVE lease held by `holder` (so a long gate/build never expires under itself). An
 * expired one is left as it is, not revived (OB-1922): another holder may already have been entitled to
 * it, and the holder takes it back with a fresh acquire. Returns what was beaten and what had expired,
 * so the caller can say so rather than let a builder carry on believing it still holds its ticket.
 */
export async function heartbeatLeasesByHolder(
  db: Database | Store,
  holder: string,
): Promise<{ beat: string[]; reacquired: string[] }> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ resource: s.t.lease.resource, ttl_s: s.t.lease.ttl_s })
    .from(s.t.lease)
    .where(eq(s.t.lease.holder, holder))
    .orderBy(asc(s.t.lease.resource))) as { resource: string; ttl_s: number | null }[];
  // Each key goes through the one checked beat, so a lease that lapses mid-loop is never revived: it is
  // acquired afresh, which a live holder that took it in the meantime refuses (OB-1922).
  const beat: string[] = [];
  const reacquired: string[] = [];
  for (const r of rows) {
    try {
      if (await heartbeatLease(s, r.resource, holder)) beat.push(r.resource);
    } catch (e) {
      if (!(e instanceof LeaseExpiredError)) throw e;
      if ((await acquireLeases(s, [r.resource], holder, r.ttl_s ?? DEFAULT_LEASE_TTL_S)).ok) reacquired.push(r.resource);
    }
  }
  return { beat, reacquired };
}

/**
 * OS-110: the ticket:/worktree: keys an agent's row records that another session now holds LIVE. Its own
 * heartbeat only beats rows still in its name, so a lease that lapsed and was taken would otherwise vanish
 * from its list with no warning, and two sessions act on one ticket. A team role hold is never lost: the lease
 * row cannot tell one taken from a lapsed builder from the normal ones (a builder registered under it, the
 * architect gating after the handoff, the ticket it keeps through a sendback), and the handoff fence passes
 * it for the same reason.
 */
export async function lostLeasesOf(
  db: Database | Store,
  agent: { id: string; ticket: string | null; worktree: string | null },
  nowMs: number = Date.now(),
): Promise<LeaseHold[]> {
  const s = asStore(db);
  const lost: LeaseHold[] = [];
  for (const resource of [ticketLeaseKey(agent.ticket), worktreeLeaseKey(agent.worktree)]) {
    const hold = resource ? await liveHold(s, resource, nowMs) : null;
    if (hold && hold.holder !== agent.id && !isTeamRoleAgent(hold.holder)) lost.push(hold);
  }
  return lost;
}

/** The line `ob agent heartbeat` prints on stderr for each lost lease (OS-110). Pure. */
export function formatLostLease(hold: { resource: string; holder: string; since: string | null }): string {
  return `lost: ${hold.resource} is now held by ${hold.holder} since ${hold.since ?? "unknown"}; stop work on this ticket and ask the architect`;
}

/** What `ob agent heartbeat` warns when the holder had leases that expired and were not revived. Pure. */
export function formatReacquiredLeases(holder: string, reacquired: string[]): string {
  return `${holder}: ${reacquired.join(", ")} had expired and ${reacquired.length === 1 ? "was" : "were"} acquired again as a fresh lease (new acquired_at)`;
}

