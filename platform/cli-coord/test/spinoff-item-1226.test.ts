// ob 1226 — a row bound to the wrong item when its dispatch ref collided with another item's id.
//
// Two numbering sequences collide and always will: ob ids come from `ob add`, hand-charted tickets carry
// wayfinder numbers. Measured live, and worth writing down because it is what every assertion below is
// modelled on:
//
//     item 1133   the STRIP ticket's ob mirror, whose record names wayfinder/tickets/1121-strip-ob.md
//     item 1135   the READYING-NOTE ticket's ob mirror, whose record names wayfinder/tickets/1133-readying-note.md
//
// So the ref "1133" names item 1135 (the path is the specific evidence) and ALSO item 1133 (its id is the
// coincidence). The first version of 1163's join asked about the id first, bound row 595 — dispatched
// `ob spinoff 1133` — to item 1133, and `ob close 1133` then told the readying-note builder, whose thread
// had already finished and been settled, that it had landed. Measured: the land reply RE-ACTIVATES a
// thread, so the wrong join cost a real turn on an unrelated builder (1188).
//
// The rule the fix encodes, in the order the evidence is specific:
//
//     1. the item whose own record NAMES wayfinder/tickets/<ref>-…  (the charter's own fact)
//     2. the row's recorded identity (`spinoff.item_id`, stamped at dispatch)
//     3. the ref AS an item id                                     (the `ob add` numbering — kept)
//
// Everything here runs in-process against a fresh SQLite database and a fake T3 seam: no network, no server.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeRepoDir, freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error } from "../../../apps/cli/src/t3/client.ts";
import { __setT3Seam, settleT3ThreadsForTicket, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { enqueueSpinoff } from "../src/commands/spinoff.ts";
import {
  collidingRefWarning,
  itemDispatchRefs,
  itemTicketPathRefs,
  rowItemId,
  ticketItemIdFor,
  ticketPathClaim,
} from "../src/spinoff-item.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const TS = "2026-10-18T00:00:00.000Z";

/** An ob item with a chosen id — the two colliding mirrors are only reachable by id, so the ids are forced. */
function item(db: ReturnType<typeof freshDb>, id: string, title: string, body: string | null = null): void {
  db.query("INSERT INTO item (id, type, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
    id,
    "task",
    title,
    body,
    "open",
    TS,
    TS,
  );
}

/** The strip ticket's ob mirror (1133 in the live store): its record names wayfinder ticket 1121. */
function stripMirror(db: ReturnType<typeof freshDb>): void {
  item(db, "1133", "S2 · the strip", "wayfinder/tickets/1121-strip-ob.md: the S2 half");
}

/** The readying-note ticket's ob mirror (1135 live): its record names wayfinder ticket 1133. */
function readyingMirror(db: ReturnType<typeof freshDb>): void {
  item(db, "1135", "The readying note", "wayfinder/tickets/1133-readying-note.md: readiness is announced on the architect thread");
}

/**
 * A dispatched row, forced into the shape a test needs: dispatched under `ref`, carrying `thread`, with the
 * recorded identity the caller names (null is the pre-0032 row, a value can be the WRONG one).
 */
async function dispatched(
  db: ReturnType<typeof freshDb>,
  row: { ref: string; thread: string | null; itemId?: string | null },
): Promise<number> {
  const created = await enqueueSpinoff(db, {
    ticketRef: row.ref,
    repo: "/r/repo",
    branch: row.ref.toLowerCase(),
    mode: "interactive",
    brief: "x",
    launcher: "t3",
  });
  db.query("UPDATE spinoff SET item_id = ?, t3_thread_id = ?, status = 'launched' WHERE id = ?").run(
    row.itemId ?? null,
    row.thread,
    created.row.id,
  );
  return created.row.id;
}

/** A T3 seam that records the sends and settles it is handed, and refuses anything else on these paths. */
function fakeSettle(threads: string[]): { settled: string[]; sends: string[] } {
  const settled: string[] = [];
  const sends: string[] = [];
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not used on the settle path`);
  };
  restores.push(
    __setT3Seam({
      projects: unused("projects") as T3Seam["projects"],
      interrupt: async () => {},
      capabilities: unused("capabilities") as T3Seam["capabilities"],
      list: unused("list") as T3Seam["list"],
      read: unused("read") as T3Seam["read"],
      launch: unused("launch") as T3Seam["launch"],
      rename: unused("rename") as T3Seam["rename"],
      settle: async (threadId: string) => {
        if (!threads.includes(threadId)) throw new T3Error("refused", `t3_thread_organize: thread ${threadId} not found`);
        settled.push(threadId);
      },
      send: async (input: { threadId: string }) => {
        if (!threads.includes(input.threadId)) throw new T3Error("refused", `t3_thread_send: thread ${input.threadId} not found`);
        sends.push(input.threadId);
      },
      // The idle answer: the close's land reply waits (bounded) for the noted turn to end before settling.
      wait: async () => ({ runId: null, status: "idle", timedOut: false }) as never,
      // 1205: nothing is HELD by this fake's threads, so a close finds no readying note to withdraw.
      queue: async () => ({ items: [], complete: true }),
      pin: async () => {},
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
    }),
  );
  return { settled, sends };
}

/** The threads a close settled, in the order the close reported them. */
async function settledBy(db: ReturnType<typeof freshDb>, itemId: string): Promise<string[]> {
  return (await settleT3ThreadsForTicket(db, itemId)).map((o) => o.threadId);
}

describe("the ref → item resolution, path evidence first (1226)", () => {
  test("a ref that collides with another item's id resolves to the mirror that NAMES its ticket path", async () => {
    const db = freshDb();
    stripMirror(db);
    readyingMirror(db);

    // The PATH half is specific: item 1135's own record names wayfinder ticket 1133.
    expect(await ticketPathClaim(db, "1133")).toEqual({ kind: "item", itemId: "1135" });
    // …and the bare id is still answered, for the refs no path names (the common case).
    expect(await ticketPathClaim(db, "1135")).toEqual({ kind: "none" });
    expect(await ticketItemIdFor(db, "1135")).toBe("1135");
    // 1121 is the strip ticket's wayfinder number: the mirror that NAMES it is item 1133.
    expect(await ticketItemIdFor(db, "1121")).toBe("1133");

    // Dispatch records the SAME answer, so a row can never be bound to an item dispatch would not pick.
    expect((await enqueueSpinoff(db, { ticketRef: "1133", repo: "/r/repo", branch: "1133", mode: "interactive", brief: "x" })).row.item_id).toBe("1135");
    expect((await enqueueSpinoff(db, { ticketRef: "1121", repo: "/r/repo", branch: "1121", mode: "interactive", brief: "x" })).row.item_id).toBe("1133");
  });

  test("a DEDUPED dispatch re-resolves the row it hands back, and keeps the correction (1226)", async () => {
    const db = freshDb();
    stripMirror(db);
    readyingMirror(db);
    const first = await enqueueSpinoff(db, { ticketRef: "1133", repo: "/r/repo", branch: "1133", mode: "interactive", brief: "x" });
    // the binding the old order left behind: dispatched as 1133, recorded as item 1133
    db.query("UPDATE spinoff SET item_id = '1133' WHERE id = ?").run(first.row.id);

    const again = await enqueueSpinoff(db, { ticketRef: "1133", repo: "/r/repo", branch: "1133", mode: "interactive", brief: "x" });
    expect(again.deduped).toBe(true);
    // An early return that hands back a stale row is a stale row about to be launched, and every join reads
    // what it records — so the identity is re-resolved AND written back.
    expect(again.row.item_id).toBe("1135");
    expect(again.collision).toBe("1133");
    const stored = db.query("SELECT item_id FROM spinoff WHERE id = ?").get(first.row.id) as { item_id: string } | null;
    expect(stored?.item_id).toBe("1135");
  });

  test("a row's identity is its ref's path first, then what it recorded, then the ref as an id", async () => {
    const db = freshDb();
    stripMirror(db);
    readyingMirror(db);
    item(db, "1142", "The stamp route"); // an `ob add` ticket: no record names it as a path

    // the path wins over a recorded identity that contradicts it — the mis-bound row, corrected
    expect(await rowItemId(db, { ticket_ref: "1133", item_id: "1133" })).toBe("1135");
    // a row queued before the identity column existed (row 595's shape)
    expect(await rowItemId(db, { ticket_ref: "1133", item_id: null })).toBe("1135");
    // a recorded identity with no contradicting path stands, even when the ref names no path at all
    expect(await rowItemId(db, { ticket_ref: "1121", item_id: "1133" })).toBe("1133");
    expect(await rowItemId(db, { ticket_ref: "9999", item_id: "1133" })).toBe("1133");
    // the bare-id fallback, which is what binds a row dispatched by its own item id
    expect(await rowItemId(db, { ticket_ref: "1142", item_id: null })).toBe("1142");
    // and a ref that serves nothing stays nothing rather than guessing
    expect(await rowItemId(db, { ticket_ref: "CUE-9894", item_id: null })).toBeNull();
  });

  test("the path refs are kept apart from the item's own id, and a tie is not settled", async () => {
    const db = freshDb();
    const strip = { id: "1133", body: "wayfinder/tickets/1121-strip-ob.md — the S2 half" };
    expect(itemTicketPathRefs(strip)).toEqual(["1121"]);
    expect(itemDispatchRefs(strip)).toEqual(["1133", "1121"]);
    expect(itemTicketPathRefs({ id: "1142", body: null })).toEqual([]);
    // A record naming its OWN id as a path lists it once — never twice, and never twice for dispatch.
    const own = { id: "1142", body: "wayfinder/tickets/1142-the-stamp-route.md — this one" };
    expect(itemTicketPathRefs(own)).toEqual(["1142"]);
    expect(itemDispatchRefs(own)).toEqual(["1142"]);

    // TWO items naming one path is ambiguous, and an ambiguous answer never drops through to a weaker
    // leg: item 9 exists here, and it is still not picked — the weaker evidence must not settle what the
    // stronger one refused to (`none` is the ONE answer that licenses either fallback). A row that
    // RECORDED an item is unresolved too, because that record may itself be the bare-id choice being
    // corrected here — and the key asymmetry is deliberate: a missed settle is a UI tidy-up, a wrong one
    // costs an unrelated builder a real turn (1188).
    item(db, "1", "first", "wayfinder/tickets/9-something.md");
    item(db, "2", "second", "wayfinder/tickets/9-something.md");
    item(db, "9", "the coincidence");
    expect(await ticketPathClaim(db, "9")).toEqual({ kind: "ambiguous" });
    expect(await ticketItemIdFor(db, "9")).toBeNull();
    expect(await rowItemId(db, { ticket_ref: "9", item_id: null })).toBeNull();
    expect(await rowItemId(db, { ticket_ref: "9", item_id: "9" })).toBeNull();
    // …while a ref NOBODY names falls through to the ref as an item id, as it always did
    expect(await ticketPathClaim(db, "9-is-not-a-ref")).toEqual({ kind: "none" });
    expect(await ticketItemIdFor(db, "9")).toBeNull();
    expect(await ticketItemIdFor(db, "1")).toBe("1");
  });
});

describe("closing an item settles the threads that SERVE it, and no others (1226)", () => {
  test("`ob close 1133` tells the strip's thread only — not the readying-note row's", async () => {
    const db = freshDb();
    stripMirror(db);
    readyingMirror(db);
    // row 600's shape: dispatched under the wayfinder number 1121, which item 1133's record names
    await dispatched(db, { ref: "1121", thread: "mcp:strip" });
    // row 595's shape: dispatched under wayfinder 1133, item_id NULL (queued before 0032)
    await dispatched(db, { ref: "1133", itemId: null, thread: "mcp:readying" });
    const fake = fakeSettle(["mcp:strip", "mcp:readying"]);

    // THE PIN. Item 1133's own id is 1133, and ref "1133" belongs to item 1135 — the coincidence must not
    // join them, or a land reply re-activates a builder that finished (measured, 1188).
    expect(await settledBy(db, "1133")).toEqual(["mcp:strip"]);
    expect(fake.settled).toEqual(["mcp:strip"]);
    // and the mirror that actually serves the readying-note row is the one that settles it
    expect(await settledBy(db, "1135")).toEqual(["mcp:readying"]);
    // the wayfinder number is not an item here: nothing may be settled for it either
    expect(await settledBy(db, "1121")).toEqual([]);
  });

  test("a row whose recorded item its ref's ticket path contradicts is re-resolved", async () => {
    const db = freshDb();
    stripMirror(db);
    readyingMirror(db);
    // The wrong binding the old order made: dispatched as 1133, recorded as item 1133.
    await dispatched(db, { ref: "1133", itemId: "1133", thread: "mcp:readying" });
    fakeSettle(["mcp:readying"]);

    expect(await settledBy(db, "1133")).toEqual([]);
    expect(await settledBy(db, "1135")).toEqual(["mcp:readying"]);
  });

  test("the bare-id fallback still binds a row queued before the identity column", async () => {
    const db = freshDb();
    item(db, "1142", "The stamp route");
    await dispatched(db, { ref: "1142", itemId: null, thread: "mcp:1142" });
    fakeSettle(["mcp:1142"]);

    expect(await ticketPathClaim(db, "1142")).toEqual({ kind: "none" });
    expect(await settledBy(db, "1142")).toEqual(["mcp:1142"]);
  });

  test("`ob close 1133` tells the LAND to the strip's builder only, on the CLI (1226)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    stripMirror(db);
    readyingMirror(db);
    await dispatched(db, { ref: "1121", thread: "mcp:strip" });
    await dispatched(db, { ref: "1133", itemId: null, thread: "mcp:readying" });
    db.close();

    // The land reply and the settle act on the SAME rows. The reply is the one that costs a turn — it
    // RE-ACTIVATES whatever thread it reaches — so `ob close 1133` must not reach the readying-note builder,
    // whose row carries the colliding ref "1133" while serving item 1135.
    const fake = fakeSettle(["mcp:strip", "mcp:readying"]);
    const r = await runCli(dbPath, ["close", "1133"]);
    expect(r.code).toBe(0);
    expect(fake.sends).toEqual(["mcp:strip"]);
    expect(fake.settled).toEqual(["mcp:strip"]);
    expect(r.out).not.toContain("mcp:readying");
    expect(r.err).not.toContain("mcp:readying");
  });

  test("`ob close` marks the item's own rows landed, and only those (1589)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    stripMirror(db);
    readyingMirror(db);
    const strip = await dispatched(db, { ref: "1121", thread: "mcp:strip" });
    const readying = await dispatched(db, { ref: "1133", itemId: null, thread: "mcp:readying" });
    db.query("UPDATE spinoff SET status = 'ready-for-gate' WHERE id = ?").run(strip);
    db.close();

    fakeSettle(["mcp:strip", "mcp:readying"]);
    const r = await runCli(dbPath, ["close", "1133"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("marked landed: 1121");
    const after = openDb(dbPath);
    const status = (id: number) => (after.query("SELECT status FROM spinoff WHERE id = ?").get(id) as { status: string }).status;
    expect(status(strip)).toBe("merged");
    expect(status(readying)).toBe("launched"); // the colliding ref serves item 1135, not the one closed
    after.close();
  });

  test("`ob close` leaves an abandoned (failed) row's thread alone: no land reply, no second settle (OB-1685)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    stripMirror(db);
    const abandoned = await dispatched(db, { ref: "1121", thread: "mcp:abandoned" });
    db.query("UPDATE spinoff SET status = 'failed', error = 'abandoned: dropped' WHERE id = ?").run(abandoned);
    db.close();

    const fake = fakeSettle(["mcp:abandoned"]);
    const r = await runCli(dbPath, ["close", "1133"]);
    expect(r.code).toBe(0);
    expect(fake.sends).toEqual([]);
    expect(fake.settled).toEqual([]);
    expect(r.out).toContain("failed or abandoned");
  });

  test("a row whose ref will not resolve is NAMED, never skipped in silence (1226)", async () => {    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // One ref, two mirrors claiming it: the tracker contradicts itself, so NOTHING here may pick.
    item(db, "1", "first mirror", "wayfinder/tickets/9-something.md");
    item(db, "2", "second mirror", "wayfinder/tickets/9-something.md");
    item(db, "9", "the stamp route"); // an `ob add` item whose id the two mirrors also claim as a path
    await dispatched(db, { ref: "9", itemId: null, thread: "mcp:ambiguous" });
    db.close();

    const fake = fakeSettle(["mcp:ambiguous"]);
    const r = await runCli(dbPath, ["close", "9"]);
    expect(r.code).toBe(0);
    // "could not tell" is not "nothing there": the thread is left alone AND the close says which row.
    expect(fake.sends).toEqual([]);
    expect(fake.settled).toEqual([]);
    expect(r.err).toContain("spinoff #1 (ref '9')");
    expect(r.err).toContain("left unresolved");
  });

  test("an unresolved candidate suppresses the no-row line, which would contradict it (1226)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // A HAND-CHARTED item (its record names wayfinder 1124), so the 1163 no-row line WOULD have fired —
    // "looked for 1134 or 1124" — right after the close named the row it could not settle.
    item(db, "1", "first mirror", "wayfinder/tickets/1124-one.md");
    item(db, "2", "second mirror", "wayfinder/tickets/1124-two.md");
    item(db, "1134", "T3 integration P1", "wayfinder/tickets/1124-t3-read-surface.md — the read half");
    await dispatched(db, { ref: "1124", itemId: null, thread: "mcp:ambiguous" });
    db.close();

    const fake = fakeSettle(["mcp:ambiguous"]);
    const r = await runCli(dbPath, ["close", "1134"]);
    expect(r.code).toBe(0);
    expect(fake.settled).toEqual([]);
    expect(r.err).toContain("spinoff #1 (ref '1124')");
    expect(r.err).not.toContain("no spinoff row serves it");
  });
  test("a serving row with no thread id suppresses the no-row line too (1226)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // A hand-charted item (1134, whose record names wayfinder 1124) with a row that SERVES it but recorded
    // no builder thread (the 1142 field-drop shape). The settle has nothing to do — and the close must not
    // follow that with "no spinoff row serves it", which is a different fact and a false one.
    item(db, "1134", "T3 integration P1", "wayfinder/tickets/1124-t3-read-surface.md — the read half");
    await dispatched(db, { ref: "1124", itemId: null, thread: null });
    // …and a thread on this machine for ANOTHER ticket, so a "no spinoff row serves it" line would actually
    // be earned by 1163's rule — which is what makes the assertion below a pin rather than a fixture that
    // could never reach the branch.
    await dispatched(db, { ref: "9999", thread: "mcp:other" });
    db.close();

    const fake = fakeSettle(["mcp:other"]);
    const r = await runCli(dbPath, ["close", "1134"]);
    expect(r.code).toBe(0);
    expect(fake.settled).toEqual([]);
    expect(fake.sends).toEqual([]);
    expect(r.err).not.toContain("no spinoff row serves it");
  });
});

describe("a colliding ref is REPORTED rather than picked silently (1226)", () => {
  test("the line names both items, and stays silent in every ordinary case", () => {
    expect(collidingRefWarning("1133", "1135", "1133")).toBe(
      "spinoff: '1133' is both item 1133's id and the ticket path item 1135 names — bound to 1135, the path being the specific evidence",
    );
    // silent when the ref is its own item, names no item, or resolved to nothing at all
    expect(collidingRefWarning("1142", "1142", "1142")).toBeNull();
    expect(collidingRefWarning("1124", "1134", null)).toBeNull();
    expect(collidingRefWarning("1124", null, null)).toBeNull();
  });

  test("`ob spinoff 1133` binds to item 1135 and says why, on the CLI", async () => {
    const dbPath = freshDbPath();
    const repo = fakeRepoDir();
    const db = openDb(dbPath);
    stripMirror(db);
    readyingMirror(db);
    db.close();

    const r = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "1133", "--repo", repo, "--branch", "1133"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("both item 1133's id and the ticket path item 1135 names");
    expect(r.err).toContain("bound to 1135");
    const rows = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as Array<{ item_id: string | null }>;
    expect(rows[0]!.item_id).toBe("1135");

    // and a ref that IS its own item — the common case — says nothing at all
    const plain = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "1135", "--repo", repo, "--branch", "1135"]);
    expect(plain.code).toBe(0);
    expect(plain.err).toBe("");
  });
});
