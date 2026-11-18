import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { foldLidChats, searchWhatsapp, syncWhatsapp } from "../src/ingest/whatsapp.ts";
import { asc } from "drizzle-orm";
import type { Store } from "../../../apps/cli/src/db/store.ts";

const PG_BUDGET = spawnBudget(2);

// ob 312. Found on a store paired fresh on 2026-08-17: EVERY message from one contact was ingested twice,
// once under `27000000014@s.whatsapp.net` and once under `70000000000001@lid`, with the SAME bridge id.
// The dedupe key is (chat_jid, id) and the chat jid was stored raw while only the SENDER was canonicalized
// (164), so one conversation became two chats — doubling the feed, doubling AI draft context, and splitting
// per-chat prefs (hide / favorite / ai-off) across two halves of one thread.
//
// Two things are held here. Ingest must not CREATE the duplicate, and a fold must repair the ones already
// stored — but a fold must never lose a message, and must never merge two people on a guess.

const PHONE = "27000000014@s.whatsapp.net";
const LID = "70000000000001@lid";
const LID_LOCAL = "70000000000001";
const OTHER_LID = "55555555555555@lid"; // deliberately NOT in the map

interface Msg {
  id: string;
  chat_jid: string;
  chat_name?: string | null;
  sender?: string | null;
  content?: string | null;
  timestamp?: string;
}

function fixtureBridge(msgs: Msg[]): Database {
  const b = new Database(":memory:");
  b.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT NOT NULL, chat_jid TEXT NOT NULL, sender TEXT, content TEXT, timestamp TEXT,
      is_from_me INTEGER, media_type TEXT, filename TEXT, url TEXT, quoted_message_id TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  const seen = new Set<string>();
  for (const m of msgs) {
    if (!seen.has(m.chat_jid)) {
      // The bridge names a @lid chat with the bare LID digits — which is an id, not a name.
      b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(
        m.chat_jid,
        m.chat_name === undefined ? (m.chat_jid.endsWith("@lid") ? m.chat_jid.split("@")[0]! : "Sophie Pages") : m.chat_name,
      );
      seen.add(m.chat_jid);
    }
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me) VALUES(?,?,?,?,?,0)",
    ).run(m.id, m.chat_jid, m.sender ?? PHONE, m.content ?? "hello", m.timestamp ?? "2026-08-17T19:00:00Z");
  }
  return b;
}

function fixtureContacts(lids: Array<[string, string]>): Database {
  const c = new Database(":memory:");
  c.exec(`
    CREATE TABLE whatsmeow_contacts (
      our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT,
      business_name TEXT, redacted_phone TEXT, PRIMARY KEY (our_jid, their_jid)
    );
    CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE);
  `);
  for (const [lid, pn] of lids) c.query("INSERT INTO whatsmeow_lid_map(lid, pn) VALUES(?, ?)").run(lid, pn);
  return c;
}

async function rows(db: Store) {
  return (await db.q
    .select({
      chat_jid: db.t.whatsappMessage.chat_jid,
      id: db.t.whatsappMessage.id,
      chat_name: db.t.whatsappMessage.chat_name,
    })
    .from(db.t.whatsappMessage)
    .orderBy(asc(db.t.whatsappMessage.chat_jid), asc(db.t.whatsappMessage.id))) as Array<{
    chat_jid: string;
    id: string;
    chat_name: string | null;
  }>;
}

const MAP = new Map([[LID_LOCAL, "27000000014"]]);

describe("ingest no longer creates the @lid duplicate (312)", () => {
  test("the same message under a @lid chat and a phone chat lands ONCE", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const bridge = fixtureBridge([
        { id: "m1", chat_jid: PHONE, content: "As they foldable and like new" },
        { id: "m1", chat_jid: LID, content: "As they foldable and like new" },
      ]);
      const res = await syncWhatsapp(db, { bridge, contacts: fixtureContacts([[LID_LOCAL, "27000000014"]]), backfill: true });
      expect(res.messages).toBe(2); // the bridge really does hold two rows
      expect(res.ingested).toBe(1); // ob holds one
      const stored = (await rows(db));
      expect(stored.length).toBe(1);
      expect(stored[0]!.chat_jid).toBe(PHONE);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a @lid copy arriving FIRST still labels the chat properly, not with the LID digits", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      // Order matters: the update path only ever touches `status`, so a bad chat_name written first would
      // never be corrected by the phone copy that follows.
      const bridge = fixtureBridge([
        { id: "m1", chat_jid: LID, timestamp: "2026-08-17T19:00:00Z" },
        { id: "m1", chat_jid: PHONE, timestamp: "2026-08-17T19:00:01Z" },
      ]);
      await syncWhatsapp(db, { bridge, contacts: fixtureContacts([[LID_LOCAL, "27000000014"]]), backfill: true });
      const stored = (await rows(db));
      expect(stored.length).toBe(1);
      expect(stored[0]!.chat_jid).toBe(PHONE);
      expect(stored[0]!.chat_name).not.toBe(LID_LOCAL);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("an UNMAPPED @lid chat is left alone: a wrong fold merges two people", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const bridge = fixtureBridge([{ id: "x1", chat_jid: OTHER_LID }]);
      await syncWhatsapp(db, { bridge, contacts: fixtureContacts([[LID_LOCAL, "27000000014"]]), backfill: true });
      const stored = (await rows(db));
      expect(stored.length).toBe(1);
      expect(stored[0]!.chat_jid).toBe(OTHER_LID);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("groups and plain phone chats are untouched by canonicalization", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const bridge = fixtureBridge([
        { id: "g1", chat_jid: "120363000000000000@g.us", chat_name: "Ma and children" },
        { id: "p1", chat_jid: PHONE },
      ]);
      await syncWhatsapp(db, { bridge, contacts: fixtureContacts([[LID_LOCAL, "27000000014"]]), backfill: true });
      const jids = (await rows(db)).map((r) => r.chat_jid).sort();
      expect(jids).toEqual(["120363000000000000@g.us", PHONE]);
    } finally {
      await lease.release();
    }
  });
});

describe("folding the rows that were already stored (312)", () => {
  /** Seed the exact shape the live server had: the same id under both chats. */
  async function seedDuplicate(db: Store): Promise<void> {
    for (const [chat_jid, chat_name] of [
      [PHONE, "Sophie Pages"],
      [LID, LID_LOCAL],
    ] as const) {
      await db.q
        .insert(db.t.whatsappMessage)
        .values({
          id: "dup1",
          chat_jid,
          chat_name,
          sender_jid: PHONE,
          content: "As they foldable and like new",
          ts: "2026-08-17T18:43:17.000Z",
          is_from_me: 0,
          raw: "{}",
          created_at: "2026-08-17T19:00:00.000Z",
        });
    }
  }

  test("a duplicate is removed, and the surviving copy is the canonical one", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await seedDuplicate(db);
      expect((await rows(db)).length).toBe(2);
      const fold = await foldLidChats(db, MAP);
      expect(fold).toEqual({ removed: 1, rekeyed: 0 });
      const stored = (await rows(db));
      expect(stored.length).toBe(1);
      expect(stored[0]!.chat_jid).toBe(PHONE);
      expect(stored[0]!.chat_name).toBe("Sophie Pages");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a @lid row with NO twin is re-keyed, never deleted: it is the only copy of that message", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await db.q
        .insert(db.t.whatsappMessage)
        .values({
          id: "only1",
          chat_jid: LID,
          chat_name: LID_LOCAL,
          sender_jid: PHONE,
          content: "the only copy",
          ts: "2026-08-17T18:00:00.000Z",
          is_from_me: 0,
          raw: "{}",
          created_at: "2026-08-17T19:00:00.000Z",
        });
      const fold = await foldLidChats(db, MAP);
      expect(fold).toEqual({ removed: 0, rekeyed: 1 });
      const stored = (await rows(db));
      expect(stored.length).toBe(1);
      expect(stored[0]!.chat_jid).toBe(PHONE);
      // The LID digits were a chat id, not a name, so they do not survive as one.
      expect(stored[0]!.chat_name).toBeNull();
      // And the message itself is still there.
      const content = (await db.q
        .select({ content: db.t.whatsappMessage.content })
        .from(db.t.whatsappMessage)
        .limit(1)) as Array<{ content: string | null }>;
      expect(content[0]!.content).toBe("the only copy");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("the search index goes with a deleted row, with no shadow table to orphan", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await seedDuplicate(db);
      // This used to be the fiddliest part of 312: whatsapp_fts was a hand-maintained shadow table keyed
      // by the row's implicit rowid, so the fold had to delete the fts row FIRST, and an orphan would
      // surface the deleted copy in search forever, pointing at a rowid that might later belong to a
      // different message. search_vec is GENERATED on the row itself now, so it cannot outlive it -- and
      // the assertion is on the search, which is what anyone actually cared about.
      expect((await searchWhatsapp(db, "foldable")).length).toBe(2);
      await foldLidChats(db, MAP);
      const hits = await searchWhatsapp(db, "foldable");
      expect(hits.length).toBe(1);
      expect(hits[0]!.chat_jid).toBe(PHONE);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("an unmapped @lid row is not folded, and an empty map folds nothing at all", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await db.q
        .insert(db.t.whatsappMessage)
        .values({
          id: "u1",
          chat_jid: OTHER_LID,
          chat_name: null,
          sender_jid: null,
          content: "unknown lid",
          ts: "2026-08-17T18:00:00.000Z",
          is_from_me: 0,
          raw: "{}",
          created_at: "2026-08-17T19:00:00.000Z",
        });
      expect(await foldLidChats(db, MAP)).toEqual({ removed: 0, rekeyed: 0 });
      expect(await foldLidChats(db, new Map())).toEqual({ removed: 0, rekeyed: 0 });
      expect((await rows(db))[0]!.chat_jid).toBe(OTHER_LID);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("folding is idempotent: a second pass on a clean store does nothing", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await seedDuplicate(db);
      await foldLidChats(db, MAP);
      expect(await foldLidChats(db, MAP)).toEqual({ removed: 0, rekeyed: 0 });
      expect((await rows(db)).length).toBe(1);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("sync reports what it folded, because a silent repair looks like data loss", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await seedDuplicate(db);
      const bridge = fixtureBridge([{ id: "new1", chat_jid: PHONE, content: "something new" }]);
      const res = await syncWhatsapp(db, {
        bridge,
        contacts: fixtureContacts([[LID_LOCAL, "27000000014"]]),
        backfill: true,
      });
      expect(res.folded).toBe(1);
      expect((await rows(db)).map((r) => r.chat_jid).every((j) => j === PHONE)).toBe(true);
    } finally {
      await lease.release();
    }
  });
});
