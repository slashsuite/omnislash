import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { addPersonFor } from "../../../apps/cli/src/commands/person.ts";
import { eventsBetweenFor, parsePayload } from "../../../apps/cli/src/events.ts";

const PG_BUDGET = spawnBudget(2);
import {
  syncWhatsapp,
  searchWhatsapp,
  recentWhatsapp,
  normalizeTs,
  latestPerChat,
  threadForChat,
  threadPageForChat,
  resolveChatName,
  loadContactNames,
  loadLidMap,
  canonicalJid,
  isConversationJid,
  messagePreview,
} from "../src/ingest/whatsapp.ts";

// Plain code-unit order of the string form, what a bare sort() gives.
const byCodeUnit = (x: string | null, y: string | null) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);

// Fixture-only: a small in-memory SQLite mimicking the Go bridge's chats + messages schema. Tests NEVER
// touch a real bridge/DB — the bridge handle is injected. RFC3339 timestamps (the whatsmeow/go-sqlite3
// default) so the cursor/`--since` string comparison and ORDER BY behave like the real bridge.

const JID_ALICE = "27000000003@s.whatsapp.net"; // person
const JID_BOB = "27000000004@s.whatsapp.net"; // group member
const JID_LID = "199887766554433@lid"; // privacy id — stored as-is, unmapped for v1
const GROUP = "120363000000000000@g.us";

interface FixtureMsg {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
  is_from_me?: number;
  media_type?: string | null;
  quoted_message_id?: string | null;
  filename?: string | null; // bridge `filename`; for a reaction row it carries the reacted-to id (#50)
}

/** Build a read-only-shaped bridge DB (chats + messages) in memory, matching the documented schema. */
function fixtureBridge(msgs: FixtureMsg[]): Database {
  const b = new Database(":memory:");
  b.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE messages (
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      media_type TEXT,
      filename TEXT,
      url TEXT,
      quoted_message_id TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(JID_ALICE, "Alice");
  b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(GROUP, "Deploy Crew");
  b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(JID_LID, null);
  for (const m of msgs) {
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, quoted_message_id) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      m.id,
      m.chat_jid,
      m.sender,
      m.content,
      m.timestamp,
      m.is_from_me ?? 0,
      m.media_type ?? null,
      m.filename ?? null,
      m.quoted_message_id ?? null,
    );
  }
  return b;
}

function defaultMsgs(): FixtureMsg[] {
  return [
    { id: "a1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "lunch at the harbour tomorrow?", timestamp: "2026-07-10T09:00:00Z" },
    { id: "b1", chat_jid: GROUP, sender: JID_BOB, content: "deploy the postgres migration tonight", timestamp: "2026-07-11T10:00:00Z" },
    { id: "c1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "on my way", timestamp: "2026-07-12T11:00:00Z", is_from_me: 1 },
    { id: "d1", chat_jid: JID_LID, sender: JID_LID, content: "privacy id ping", timestamp: "2026-07-13T12:00:00Z" },
  ];
}

async function waRows(lease: PgStoreLease) {
  return (await lease.sql.unsafe("SELECT * FROM whatsapp_message ORDER BY ts, id")) as Array<{
    id: string;
    chat_jid: string;
    chat_name: string | null;
    sender_jid: string | null;
    content: string | null;
    ts: string;
    is_from_me: number | null;
    media_type: string | null;
    quoted_message_id: string | null;
    person_id: number | null;
    raw: string | null;
  }>;
}

describe("whatsapp read-only ingest (099/100)", () => {
  test("normalizeTs handles RFC3339 strings and epoch seconds/millis", async () => {
    expect(normalizeTs("2026-07-10T09:00:00Z")).toBe("2026-07-10T09:00:00.000Z");
    expect(normalizeTs(1_752_138_000)).toBe(new Date(1_752_138_000 * 1000).toISOString());
    expect(normalizeTs(1_752_138_000_000)).toBe(new Date(1_752_138_000_000).toISOString());
  }, PG_BUDGET);

  test("ingests messages; rows land with chat_name, is_from_me, raw JSON", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const res = await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });

    expect(res.messages).toBe(4);
    expect(res.ingested).toBe(4);
    expect(res.events).toBe(4);

    const rows = await waRows(lease);
    expect(rows).toHaveLength(4);

    const a = rows.find((r) => r.id === "a1")!;
    expect(a.chat_name).toBe("Alice");
    expect(a.ts).toBe("2026-07-10T09:00:00.000Z"); // normalized to ISO
    expect(a.is_from_me).toBe(0);

    const c = rows.find((r) => r.id === "c1")!;
    expect(c.is_from_me).toBe(1);
    expect(JSON.parse(c.raw!).content).toBe("on my way");
    await lease.release();
  }, PG_BUDGET);

  test("dedupe on (chat_jid, id): a re-sync adds no rows and the cursor holds", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const first = await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });
    expect(await waRows(lease)).toHaveLength(4);
    expect(first.cursor).toBe("2026-07-13T12:00:00Z"); // max bridge timestamp

    const second = await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });
    expect(await waRows(lease)).toHaveLength(4); // no dupes
    expect(second.ingested).toBe(0); // nothing new landed
    expect(second.messages).toBe(0); // cursor already past everything → bridge returns nothing
    expect(second.cursor).toBe("2026-07-13T12:00:00Z"); // stable
    await lease.release();
  }, PG_BUDGET);

  test("maps a known sender jid → person (enrichment); unmapped + @lid stay NULL", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const alice = await addPersonFor(db, "Alice Contact", { whatsapp_jid: JID_ALICE });
    await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });

    const rows = await waRows(lease);
    expect(rows.find((r) => r.id === "a1")!.person_id).toBe(alice.id); // mapped
    expect(rows.find((r) => r.id === "b1")!.person_id).toBeNull(); // Bob unregistered
    const lid = rows.find((r) => r.id === "d1")!;
    expect(lid.sender_jid).toBe(JID_LID); // @lid stored as-is
    expect(lid.person_id).toBeNull(); // and stays unmapped for v1
    await lease.release();
  }, PG_BUDGET);

  test("mirrors each new message into event(source='whatsapp'); idempotent on re-sync", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });

    const events = await eventsBetweenFor(db, { source: "whatsapp" });
    expect(events).toHaveLength(4);
    // three received ("message") + one outbound ("sent")
    expect(events.filter((e) => e.type === "message")).toHaveLength(3);
    expect(events.filter((e) => e.type === "sent")).toHaveLength(1);
    const bEvent = events.find((e) => parsePayload<{ id: string }>(e).id === "b1")!;
    expect(parsePayload<{ chat_jid: string }>(bEvent).chat_jid).toBe(GROUP);

    await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });
    expect(await eventsBetweenFor(db, { source: "whatsapp" })).toHaveLength(4); // no new events
    await lease.release();
  }, PG_BUDGET);

  test("whatsapp_fts MATCH finds an ingested message by content", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });

    expect((await searchWhatsapp(db, "postgres")).map((h) => h.id)).toEqual(["b1"]);
    expect((await searchWhatsapp(db, "harbour")).map((h) => h.id)).toEqual(["a1"]);
    expect(await searchWhatsapp(db, "nonexistentterm")).toHaveLength(0);
    await lease.release();
  }, PG_BUDGET);

  test("search_vec indexes transcript and media_desc, and a later update is picked up (336)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await db.q.insert(db.t.whatsappMessage).values([
      {
        id: "voice1",
        chat_jid: JID_ALICE,
        chat_name: "Alice",
        sender_jid: JID_ALICE,
        content: null,
        ts: "2026-07-14T09:00:00.000Z",
        is_from_me: 0,
        media_type: "audio",
        transcript: "please fix the leaking sink tomorrow morning",
        created_at: "2026-07-14T09:00:00.000Z",
      },
      {
        id: "img1",
        chat_jid: JID_ALICE,
        chat_name: "Alice",
        sender_jid: JID_ALICE,
        content: null,
        ts: "2026-07-14T09:01:00.000Z",
        is_from_me: 0,
        media_type: "image",
        media_desc: "a photo of a mountain range at golden hour",
        created_at: "2026-07-14T09:01:00.000Z",
      },
      {
        id: "both1",
        chat_jid: JID_ALICE,
        chat_name: "Alice",
        sender_jid: JID_ALICE,
        content: "lunch at the harbour tomorrow?",
        ts: "2026-07-14T09:02:00.000Z",
        is_from_me: 0,
        transcript: "running late for the plumber",
        created_at: "2026-07-14T09:02:00.000Z",
      },
      {
        id: "voice2",
        chat_jid: JID_ALICE,
        chat_name: "Alice",
        sender_jid: JID_ALICE,
        content: null,
        ts: "2026-07-14T09:03:00.000Z",
        is_from_me: 0,
        media_type: "audio",
        transcript: null,
        created_at: "2026-07-14T09:03:00.000Z",
      },
    ]);

    expect((await searchWhatsapp(db, "leaking")).map((h) => h.id)).toEqual(["voice1"]);
    expect((await searchWhatsapp(db, "mountain")).map((h) => h.id)).toEqual(["img1"]);
    expect((await searchWhatsapp(db, "harbour")).map((h) => h.id)).toEqual(["both1"]);
    expect((await searchWhatsapp(db, "plumber")).map((h) => h.id)).toEqual(["both1"]);
    expect(await searchWhatsapp(db, "invoice")).toHaveLength(0);

    await lease.sql.unsafe(
      "UPDATE whatsapp_message SET transcript = 'can you send the invoice today please' WHERE id = 'voice2'",
    );
    expect((await searchWhatsapp(db, "invoice")).map((h) => h.id)).toEqual(["voice2"]);

    const indexes = (await lease.sql.unsafe(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'whatsapp_message'",
    )) as Array<{ indexname: string }>;
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain("idx_whatsapp_message_search_vec");
    expect(names).toContain("idx_whatsapp_message_search_trgm");
    await lease.release();
  }, PG_BUDGET);

  test("--max caps a run and it resumes from the cursor next run", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const bridge = fixtureBridge(defaultMsgs());

    const run1 = await syncWhatsapp(db, { bridge, max: 3 });
    expect(run1.ingested).toBe(3); // oldest three: a1, b1, c1
    expect(run1.capped).toBe(true);
    expect(run1.cursor).toBe("2026-07-12T11:00:00Z"); // c1's timestamp
    expect((await waRows(lease)).map((r) => r.id)).toEqual(["a1", "b1", "c1"]);

    const run2 = await syncWhatsapp(db, { bridge, max: 3 });
    expect(run2.ingested).toBe(1); // just d1 remains
    expect(run2.capped).toBe(false);
    expect(await waRows(lease)).toHaveLength(4);
    await lease.release();
  }, PG_BUDGET);

  test("--since bounds the pull to messages after the instant", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const res = await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()), since: "2026-07-12T00:00:00Z" });
    expect(res.ingested).toBe(2); // c1 + d1 only
    expect((await waRows(lease)).map((r) => r.id).sort()).toEqual(["c1", "d1"]);
    await lease.release();
  }, PG_BUDGET);

  test("recentWhatsapp returns most-recent first, honouring --since + limit", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });

    const recent = await recentWhatsapp(db, { limit: 2 });
    expect(recent.map((h) => h.id)).toEqual(["d1", "c1"]); // newest first

    const windowed = await recentWhatsapp(db, { since: "2026-07-11T12:00:00Z" });
    expect(windowed.map((h) => h.id).sort()).toEqual(["c1", "d1"]);
    await lease.release();
  }, PG_BUDGET);

  test("missing bridge DB → clean error, nothing written", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "whatsapp_db_path", "/nonexistent/does/not/exist/messages.db");
    await expect(syncWhatsapp(db, {})).rejects.toThrow(/cannot read WhatsApp bridge DB/);
    expect(await waRows(lease)).toHaveLength(0);
    await lease.release();
  });
});

// ── chat-list + contact-name resolution (156) ──────────────────────────────────────────────────────

const J = {
  alice: "27000000003@s.whatsapp.net", // person mapped → real_name wins
  carol: "27000000005@s.whatsapp.net", // whatsmeow full_name only
  dave: "27000000006@s.whatsapp.net", // whatsmeow push_name only
  jordan: "27000000007@s.whatsapp.net", // whatsmeow business_name only
  frank: "27000000008@s.whatsapp.net", // whatsmeow first_name only
  gary: "27000000009@s.whatsapp.net", // no contact → messages.db chat_name
  lid: "199887766554433@lid", // no contact, no chat_name → shortened jid
  group: "120363000000000000@g.us", // group → keeps chat_name (group name)
};

/** A read-only-shaped bridge (chats + messages) with arbitrary chat names. */
function bridgeWith(chats: Array<[string, string | null]>, msgs: FixtureMsg[]): Database {
  const b = new Database(":memory:");
  b.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT NOT NULL, chat_jid TEXT NOT NULL, sender TEXT, content TEXT, timestamp TEXT,
      is_from_me INTEGER, media_type TEXT, filename TEXT, url TEXT, quoted_message_id TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  for (const [jid, name] of chats) b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(jid, name);
  for (const m of msgs) {
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_message_id) VALUES(?,?,?,?,?,?,?,?)",
    ).run(m.id, m.chat_jid, m.sender, m.content, m.timestamp, m.is_from_me ?? 0, m.media_type ?? null, m.quoted_message_id ?? null);
  }
  return b;
}

interface ContactSeed {
  their_jid: string;
  first_name?: string | null;
  full_name?: string | null;
  push_name?: string | null;
  business_name?: string | null;
}

/**
 * A read-only-shaped whatsmeow_contacts DB (the bridge's own address book, sibling of messages.db). Also
 * carries the `whatsmeow_lid_map (lid, pn)` table (164) — pass `lids` as `[lidLocal, pnLocal]` pairs.
 */
function fixtureContacts(rows: ContactSeed[], lids: Array<[string, string]> = []): Database {
  const c = new Database(":memory:");
  c.exec(`
    CREATE TABLE whatsmeow_contacts (
      our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT,
      business_name TEXT, redacted_phone TEXT, PRIMARY KEY (our_jid, their_jid)
    );
    CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE);
  `);
  for (const r of rows) {
    c.query(
      "INSERT INTO whatsmeow_contacts(our_jid, their_jid, first_name, full_name, push_name, business_name) VALUES(?,?,?,?,?,?)",
    ).run("me@s.whatsapp.net", r.their_jid, r.first_name ?? null, r.full_name ?? null, r.push_name ?? null, r.business_name ?? null);
  }
  for (const [lid, pn] of lids) {
    c.query("INSERT INTO whatsmeow_lid_map(lid, pn) VALUES(?, ?)").run(lid, pn);
  }
  return c;
}

/** One message per chat, ascending timestamps (group newest). */
function oneEachMsgs(): FixtureMsg[] {
  return [
    { id: "m_alice", chat_jid: J.alice, sender: J.alice, content: "hi from alice", timestamp: "2026-07-10T09:00:00Z" },
    { id: "m_carol", chat_jid: J.carol, sender: J.carol, content: "hi carol", timestamp: "2026-07-10T09:01:00Z" },
    { id: "m_dave", chat_jid: J.dave, sender: J.dave, content: "hi dave", timestamp: "2026-07-10T09:02:00Z" },
    { id: "m_jordan", chat_jid: J.jordan, sender: J.jordan, content: "hi jordan", timestamp: "2026-07-10T09:03:00Z" },
    { id: "m_frank", chat_jid: J.frank, sender: J.frank, content: "hi frank", timestamp: "2026-07-10T09:04:00Z" },
    { id: "m_gary", chat_jid: J.gary, sender: J.gary, content: "hi gary", timestamp: "2026-07-10T09:05:00Z" },
    { id: "m_lid", chat_jid: J.lid, sender: J.lid, content: "hi lid", timestamp: "2026-07-10T09:06:00Z" },
    { id: "m_group", chat_jid: J.group, sender: J.alice, content: "hi group", timestamp: "2026-07-10T09:07:00Z" },
  ];
}

const ONE_EACH_CHATS: Array<[string, string | null]> = [
  [J.alice, "Alice ChatName"], // person must win over this chat_name
  [J.carol, null],
  [J.dave, null],
  [J.jordan, null],
  [J.frank, null],
  [J.gary, "Gary Chat"],
  [J.lid, null],
  [J.group, "Deploy Crew"],
];

function contactSeeds(): ContactSeed[] {
  return [
    { their_jid: J.alice, full_name: "Alice Whatsmeow" }, // person must win over this too
    { their_jid: J.carol, full_name: "Carol Full" },
    { their_jid: J.dave, push_name: "Dave Push" },
    { their_jid: J.jordan, business_name: "Jordan Biz" },
    { their_jid: J.frank, first_name: "Frank First" },
    // gary + lid: intentionally absent
  ];
}

describe("whatsapp chat-list + contact names (156)", () => {
  test("resolveChatName order: person > whatsmeow > chat_name > jid; groups keep chat_name", async () => {
    expect(resolveChatName({ chatJid: J.alice, chatName: "Chat", personName: "Person", contactName: "Contact" })).toBe("Person");
    expect(resolveChatName({ chatJid: J.alice, chatName: "Chat", personName: null, contactName: "Contact" })).toBe("Contact");
    expect(resolveChatName({ chatJid: J.alice, chatName: "Chat", personName: null, contactName: null })).toBe("Chat");
    expect(resolveChatName({ chatJid: J.alice, chatName: null, personName: null, contactName: null })).toBe("27000000003");
    // group: chat_name (group name) wins even when a person/contact somehow resolves
    expect(resolveChatName({ chatJid: J.group, chatName: "Deploy Crew", personName: "Someone", contactName: "Else" })).toBe("Deploy Crew");
    expect(resolveChatName({ chatJid: J.group, chatName: null, personName: null, contactName: null })).toBe("120363000000000000");
  }, PG_BUDGET);

  test("full resolution order end-to-end (person > full > push > business > first > chat_name > jid)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await addPersonFor(db, "Alice Person", { whatsapp_jid: J.alice });
    await syncWhatsapp(db, { bridge: bridgeWith(ONE_EACH_CHATS, oneEachMsgs()) });

    const items = await latestPerChat(db, { contacts: fixtureContacts(contactSeeds()) });
    const nameByJid = new Map(items.map((i) => [i.chat_jid, i.name]));

    expect(nameByJid.get(J.alice)).toBe("Alice Person"); // person real_name wins
    expect(nameByJid.get(J.carol)).toBe("Carol Full"); // whatsmeow full_name
    expect(nameByJid.get(J.dave)).toBe("Dave Push"); // whatsmeow push_name
    expect(nameByJid.get(J.jordan)).toBe("Jordan Biz"); // whatsmeow business_name
    expect(nameByJid.get(J.frank)).toBe("Frank First"); // whatsmeow first_name
    expect(nameByJid.get(J.gary)).toBe("Gary Chat"); // messages.db chat_name
    expect(nameByJid.get(J.lid)).toBe("199887766554433"); // shortened jid fallback (@lid unmapped)
    expect(nameByJid.get(J.group)).toBe("Deploy Crew"); // group keeps its chat_name
    await lease.release();
  }, PG_BUDGET);

  test("latestPerChat: exactly one row per chat_jid, newest chat first, bounded by limit", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "a1", chat_jid: J.alice, sender: J.alice, content: "first", timestamp: "2026-07-10T08:00:00Z" },
      { id: "a2", chat_jid: J.alice, sender: J.alice, content: "middle", timestamp: "2026-07-10T09:00:00Z" },
      { id: "a3", chat_jid: J.alice, sender: J.alice, content: "latest alice", timestamp: "2026-07-10T10:00:00Z", is_from_me: 1 },
      { id: "c1", chat_jid: J.carol, sender: J.carol, content: "old carol", timestamp: "2026-07-11T08:00:00Z" },
      { id: "c2", chat_jid: J.carol, sender: J.carol, content: "latest carol", timestamp: "2026-07-11T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice"], [J.carol, "Carol"]], msgs) });

    const items = await latestPerChat(db, { contacts: fixtureContacts([]) });
    expect(items).toHaveLength(2); // one row per chat_jid
    expect(items.map((i) => i.chat_jid)).toEqual([J.carol, J.alice]); // newest chat (carol) first
    expect(items[0]!.preview).toBe("latest carol");
    const alice = items.find((i) => i.chat_jid === J.alice)!;
    expect(alice.preview).toBe("latest alice");
    expect(alice.is_from_me).toBe(1); // last message was outbound

    const bounded = await latestPerChat(db, { limit: 1, contacts: fixtureContacts([]) });
    expect(bounded).toHaveLength(1);
    expect(bounded[0]!.chat_jid).toBe(J.carol);
    await lease.release();
  }, PG_BUDGET);

  test("contacts DB absent → graceful fallback to chat_name/jid, never a crash", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "whatsapp_contacts_db_path", "/nonexistent/does/not/exist/whatsapp.db",
    );
    await addPersonFor(db, "Alice Person", { whatsapp_jid: J.alice });
    await syncWhatsapp(db, { bridge: bridgeWith(ONE_EACH_CHATS, oneEachMsgs()) });

    // No contacts override → the reader derives the (missing) configured path and returns an empty map.
    const items = await latestPerChat(db);
    const nameByJid = new Map(items.map((i) => [i.chat_jid, i.name]));
    expect(nameByJid.get(J.alice)).toBe("Alice Person"); // person still resolves (registry, not contacts)
    expect(nameByJid.get(J.gary)).toBe("Gary Chat"); // chat_name fallback
    expect(nameByJid.get(J.carol)).toBe("27000000005"); // no person/contact/chat_name → shortened jid
    await lease.release();
  }, PG_BUDGET);

  test("loadContactNames tolerates a contacts DB missing the whatsmeow_contacts table", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const broken = new Database(":memory:"); // no whatsmeow_contacts table
    expect((await loadContactNames(db, { contacts: broken })).size).toBe(0); // empty, not a throw
    broken.close();
    await lease.release();
  }, PG_BUDGET);

  test("empty DB → latestPerChat returns [] (the snapshot field is always an array; UI guards with ?? [])", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    expect(await latestPerChat(db, { contacts: fixtureContacts([]) })).toEqual([]);
    await lease.release();
  }, PG_BUDGET);

  test("messagePreview truncates long bodies and drops empty/whitespace to null", async () => {
    expect(messagePreview("short")).toBe("short");
    expect(messagePreview("   ")).toBeNull();
    expect(messagePreview(null)).toBeNull();
    const long = "x".repeat(250);
    const preview = messagePreview(long)!;
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(200);
  });
});

// ── @lid ↔ phone-jid canonicalization (164) ─────────────────────────────────────────────────────────

const LID_LOCAL = "142932300542115"; // the privacy-id local part (what whatsmeow_lid_map.lid holds)
const TINO_LID = `${LID_LOCAL}@lid`; // same conversation, stored under the @lid privacy id
const TINO_PHONE = "27000000011@s.whatsapp.net"; // …and under the phone-jid (the canonical target)
const TINO_PN_LOCAL = "27000000011";
const UNMAPPED_LID = "999888777666555@lid"; // an @lid with no lid-map row → stays its own chat

describe("whatsapp @lid canonicalization (164)", () => {
  test("canonicalJid: mapped @lid → phone-jid; unmapped @lid + non-@lid jids pass through", async () => {
    const map = new Map([[LID_LOCAL, TINO_PN_LOCAL]]);
    expect(canonicalJid(TINO_LID, map)).toBe(TINO_PHONE); // mapped @lid → <pn>@s.whatsapp.net
    expect(canonicalJid(UNMAPPED_LID, map)).toBe(UNMAPPED_LID); // unmapped @lid unchanged
    expect(canonicalJid(TINO_PHONE, map)).toBe(TINO_PHONE); // phone-jid unchanged
    expect(canonicalJid(J.group, map)).toBe(J.group); // group jid unchanged
    expect(canonicalJid(TINO_LID, new Map())).toBe(TINO_LID); // empty map → @lid unchanged
  }, PG_BUDGET);

  test("loadLidMap normalises full-jid lid/pn values to bare local parts; graceful when absent", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // Bridge may store either bare numbers or full jids — both must normalise to local parts.
    const contacts = fixtureContacts([], [[`${LID_LOCAL}@lid`, `${TINO_PN_LOCAL}@s.whatsapp.net`]]);
    const map = await loadLidMap(db, { contacts });
    expect(map.get(LID_LOCAL)).toBe(TINO_PN_LOCAL);
    contacts.close();

    // No whatsmeow_lid_map table → empty map, never a throw.
    const bare = new Database(":memory:");
    expect((await loadLidMap(db, { contacts: bare })).size).toBe(0);
    bare.close();

    // Contacts DB configured but absent → empty map (no crash).
    await setConfig(db, "whatsapp_contacts_db_path", "/nonexistent/does/not/exist/whatsapp.db",
    );
    expect((await loadLidMap(db)).size).toBe(0);
    await lease.release();
  }, PG_BUDGET);

  test("latestPerChat: an @lid chat and its phone-jid chat collapse into one canonical named chat", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      // phone-jid conversation: older
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "under phone jid", timestamp: "2026-07-10T08:00:00Z" },
      // @lid conversation (same person): NEWER → should win as the merged chat's latest message
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "under lid jid", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], msgs) });

    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    const items = await latestPerChat(db, { contacts });

    expect(items).toHaveLength(1); // the two rows merged into ONE chat
    const chat = items[0]!;
    expect(chat.chat_jid).toBe(TINO_PHONE); // carries the canonical (phone) jid → Reply targets phone
    expect(chat.name).toBe("tino🌸"); // resolved contact name (no raw number)
    expect(chat.preview).toBe("under lid jid"); // newest message across BOTH rows
    expect(chat.ts).toBe("2026-07-10T09:00:00.000Z");
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("latestPerChat: an UNMAPPED @lid stays its own row (graceful, shows the shortened jid)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "phone", timestamp: "2026-07-10T08:00:00Z" },
      { id: "u1", chat_jid: UNMAPPED_LID, sender: UNMAPPED_LID, content: "mystery", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [UNMAPPED_LID, null]], msgs) });

    // lid map only maps TINO's lid — the UNMAPPED_LID has no row.
    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    const items = await latestPerChat(db, { contacts });
    const byJid = new Map(items.map((i) => [i.chat_jid, i]));

    expect(items).toHaveLength(2); // no collapse for the unmapped @lid
    expect(byJid.get(TINO_PHONE)!.name).toBe("tino🌸");
    expect(byJid.get(UNMAPPED_LID)!.name).toBe("999888777666555"); // shortened jid fallback
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("latestPerChat: lid-map table missing / contacts absent → no crash, @lid stays separate", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "phone", timestamp: "2026-07-10T08:00:00Z" },
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "lid", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], msgs) });

    // Contacts handle with NO whatsmeow_lid_map table (and no contacts) → both loaders degrade to empty.
    const bare = new Database(":memory:");
    const items = await latestPerChat(db, { contacts: bare });
    expect(items).toHaveLength(2); // no map → no collapse, but no crash either
    const byJid = new Map(items.map((i) => [i.chat_jid, i.chat_jid]));
    expect(byJid.has(TINO_PHONE)).toBe(true);
    expect(byJid.has(TINO_LID)).toBe(true); // stays under its raw @lid jid
    bare.close();
    await lease.release();
  }, PG_BUDGET);

  test("ingest person-mapping: an @lid sender maps to the same person as their phone-jid", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const tino = await addPersonFor(db, "Tino", { whatsapp_jid: TINO_PHONE });
    const msgs: FixtureMsg[] = [
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "hi from my lid", timestamp: "2026-07-10T09:00:00Z" },
    ];
    // Inject the contacts fixture so the lid map is available at ingest (hermetic — no real DB read).
    await syncWhatsapp(db, {
      bridge: bridgeWith([[TINO_LID, null]], msgs),
      contacts: fixtureContacts([], [[LID_LOCAL, TINO_PN_LOCAL]]),
    });

    const rows = await waRows(lease);
    const l1 = rows.find((r) => r.id === "l1")!;
    expect(l1.sender_jid).toBe(TINO_LID); // raw @lid sender still stored as-is
    expect(l1.person_id).toBe(tino.id); // …but enriched to Tino via the canonical phone-jid
    await lease.release();
  }, PG_BUDGET);

  test("ingest without a contacts handle stays hermetic: @lid sender remains unmapped", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await addPersonFor(db, "Tino", { whatsapp_jid: TINO_PHONE });
    const msgs: FixtureMsg[] = [
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "hi", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_LID, null]], msgs) }); // no contacts → empty lid map
    expect((await waRows(lease)).find((r) => r.id === "l1")!.person_id).toBeNull();
    await lease.release();
  });
});

// ── per-chat thread panel reader (168) ──────────────────────────────────────────────────────────────

describe("whatsapp per-chat thread (168)", () => {
  test("threadForChat: newest window, oldest→newest, ≤ limit, resolved labels + preview/media", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await addPersonFor(db, "Alice Person", { whatsapp_jid: J.alice });
    const msgs: FixtureMsg[] = [
      { id: "a1", chat_jid: J.alice, sender: J.alice, content: "one", timestamp: "2026-07-10T09:00:00Z" },
      { id: "a2", chat_jid: J.alice, sender: J.alice, content: "two", timestamp: "2026-07-10T09:01:00Z" },
      { id: "a3", chat_jid: J.alice, sender: J.alice, content: "three", timestamp: "2026-07-10T09:02:00Z", is_from_me: 1 },
      { id: "a4", chat_jid: J.alice, sender: J.alice, content: "four", timestamp: "2026-07-10T09:03:00Z" },
      { id: "a5", chat_jid: J.alice, sender: J.alice, content: "", timestamp: "2026-07-10T09:04:00Z", media_type: "image" },
      { id: "a6", chat_jid: J.alice, sender: J.alice, content: "six", timestamp: "2026-07-10T09:05:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice ChatName"]], msgs) });

    const items = await threadForChat(db, J.alice, { limit: 5, contacts: fixtureContacts([]) });
    expect(items).toHaveLength(5); // ≤ limit
    expect(items.map((i) => i.id)).toEqual(["a2", "a3", "a4", "a5", "a6"]); // newest-5 window, oldest → newest
    expect(items[0]!.sender).toBe("Alice Person"); // inbound → resolved person real_name
    expect(items[1]!.sender).toBe("you"); // outbound → "you"
    expect(items[1]!.is_from_me).toBe(1);
    expect(items.every((i) => i.chat_jid === J.alice)).toBe(true); // canonical jid on every row

    const media = items.find((i) => i.id === "a5")!;
    expect(media.media_type).toBe("image"); // media fields carried (id + media_type for the 158/162 proxy)
    expect(media.preview).toBeNull(); // empty body → null preview
    expect(items.find((i) => i.id === "a6")!.preview).toBe("six"); // text preview present
    await lease.release();
  }, PG_BUDGET);

  test("threadForChat: limit defaults to 20 and never exceeds the stored count", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      chat_jid: J.alice,
      sender: J.alice,
      content: `m${i}`,
      timestamp: `2026-07-10T09:0${i}:00Z`,
    }));
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice"]], msgs) });
    const items = await threadForChat(db, J.alice, { contacts: fixtureContacts([]) });
    expect(items.map((i) => i.id)).toEqual(["m0", "m1", "m2"]);
    await lease.release();
  }, PG_BUDGET);

  test("threadForChat: an @lid chat and its phone-jid chat unify into one canonical thread", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    const msgs: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "under phone", timestamp: "2026-07-10T08:00:00Z" },
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "under lid", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], msgs), contacts });

    // Querying by EITHER jid yields the same unified thread; every row carries the canonical phone jid.
    for (const jid of [TINO_PHONE, TINO_LID]) {
      const items = await threadForChat(db, jid, { limit: 15, contacts });
      expect(items.map((i) => i.id)).toEqual(["p1", "l1"]); // both rows merged, oldest → newest
      expect(items.every((i) => i.chat_jid === TINO_PHONE)).toBe(true); // canonical jid
      expect(items[1]!.sender).toBe("tino🌸"); // resolved via the whatsmeow contact (canonical sender)
    }
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("threadForChat: an unknown chat → []", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, {
      bridge: bridgeWith(
        [[J.alice, "Alice"]],
        [{ id: "a1", chat_jid: J.alice, sender: J.alice, content: "hi", timestamp: "2026-07-10T09:00:00Z" }],
      ),
    });
    expect(await threadForChat(db, "27000000002@s.whatsapp.net", { contacts: fixtureContacts([]) })).toEqual([]);
    await lease.release();
  });
});

// ── group-thread sender names — resolve each participant (192) ───────────────────────────────────────

describe("whatsapp group thread sender names (192)", () => {
  const P_BOB = "27000000004@s.whatsapp.net"; // group participant with a whatsmeow push_name
  const P_MYSTERY = "27000000010@s.whatsapp.net"; // participant with no person + no contact → short jid

  test("threadForChat: each group message resolves to ITS participant, not the group name", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await addPersonFor(db, "Alice Person", { whatsapp_jid: J.alice });
    // Group messages: sender_jid is the PARTICIPANT (≠ the group chat_jid). Mix registered person, a
    // whatsmeow contact, an @lid participant (canonicalizes to a phone with a contact), self, and an
    // unresolved participant.
    const msgs: FixtureMsg[] = [
      { id: "g1", chat_jid: J.group, sender: J.alice, content: "alice in group", timestamp: "2026-07-10T09:00:00Z" },
      { id: "g2", chat_jid: J.group, sender: P_BOB, content: "bob in group", timestamp: "2026-07-10T09:01:00Z" },
      { id: "g3", chat_jid: J.group, sender: TINO_LID, content: "tino via lid", timestamp: "2026-07-10T09:02:00Z" },
      { id: "g4", chat_jid: J.group, sender: "me@s.whatsapp.net", content: "me in group", timestamp: "2026-07-10T09:03:00Z", is_from_me: 1 },
      { id: "g5", chat_jid: J.group, sender: P_MYSTERY, content: "mystery in group", timestamp: "2026-07-10T09:04:00Z" },
    ];
    const contacts = fixtureContacts(
      [
        { their_jid: P_BOB, push_name: "Bob Push" },
        { their_jid: TINO_PHONE, full_name: "tino🌸" },
      ],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    await syncWhatsapp(db, { bridge: bridgeWith([[J.group, "Deploy Crew"]], msgs), contacts });

    const items = await threadForChat(db, J.group, { limit: 10, contacts });
    const senderById = new Map(items.map((i) => [i.id, i.sender]));

    expect(senderById.get("g1")).toBe("Alice Person"); // registered person real_name
    expect(senderById.get("g2")).toBe("Bob Push"); // whatsmeow contact push_name
    expect(senderById.get("g3")).toBe("tino🌸"); // @lid participant → canonical phone contact
    expect(senderById.get("g4")).toBe("you"); // self (is_from_me)
    expect(senderById.get("g5")).toBe("27000000010"); // unresolved → short jid, NOT "Deploy Crew"
    // the crux: no group message is ever labelled with the group name
    expect(items.every((i) => i.sender !== "Deploy Crew")).toBe(true);
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("threadForChat: a 1:1 chat still falls back to chat_name (unchanged by the group fix)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // No person, no contact → 1:1 keeps the chat_name fallback (there chat_name IS the contact).
    await syncWhatsapp(db, {
      bridge: bridgeWith(
        [[J.gary, "Gary Chat"]],
        [{ id: "x1", chat_jid: J.gary, sender: J.gary, content: "hi", timestamp: "2026-07-10T09:00:00Z" }],
      ),
    });
    const items = await threadForChat(db, J.gary, { contacts: fixtureContacts([]) });
    expect(items[0]!.sender).toBe("Gary Chat"); // 1:1 chat_name fallback preserved
    await lease.release();
  }, PG_BUDGET);

  // ── "load earlier" pagination (193): page UP via a `before` cursor + a hasMore flag ──────────────────
  test("threadPageForChat: pages upward via `before`, hasMore true until the history is exhausted", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // 12 messages, one per minute, oldest → newest.
    const msgs: FixtureMsg[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      chat_jid: J.alice,
      sender: J.alice,
      content: `msg ${i}`,
      timestamp: `2026-07-10T09:${String(i).padStart(2, "0")}:00Z`,
    }));
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice"]], msgs) });
    const contacts = fixtureContacts([]);

    // First page: the newest 5 (p7..p11), oldest → newest, with older messages remaining.
    const first = await threadPageForChat(db, J.alice, { limit: 5, contacts });
    expect(first.items.map((i) => i.id)).toEqual(["p7", "p8", "p9", "p10", "p11"]);
    expect(first.hasMore).toBe(true);

    // Middle page: the 5 older than the oldest loaded (p7) → p2..p6, still more remaining.
    const middle = await threadPageForChat(db, J.alice, { limit: 5, before: first.items[0]!.ts!, contacts });
    expect(middle.items.map((i) => i.id)).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(middle.hasMore).toBe(true);

    // Last page: the remaining older-than-p2 (p0, p1) → history exhausted, hasMore false.
    const last = await threadPageForChat(db, J.alice, { limit: 5, before: middle.items[0]!.ts!, contacts });
    expect(last.items.map((i) => i.id)).toEqual(["p0", "p1"]);
    expect(last.hasMore).toBe(false);

    // Paging past the start returns an empty batch, hasMore false (button hides).
    const past = await threadPageForChat(db, J.alice, { limit: 5, before: last.items[0]!.ts!, contacts });
    expect(past.items).toEqual([]);
    expect(past.hasMore).toBe(false);

    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("threadPageForChat: a thread shorter than the page → single page, hasMore false", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, {
      bridge: bridgeWith(
        [[J.alice, "Alice"]],
        [
          { id: "a1", chat_jid: J.alice, sender: J.alice, content: "one", timestamp: "2026-07-10T09:00:00Z" },
          { id: "a2", chat_jid: J.alice, sender: J.alice, content: "two", timestamp: "2026-07-10T09:01:00Z" },
        ],
      ),
    });
    const page = await threadPageForChat(db, J.alice, { limit: 5, contacts: fixtureContacts([]) });
    expect(page.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(page.hasMore).toBe(false);
    await lease.release();
  });
});

// ── group message whose sender is the group's own jid → unattributable, never the raw group id (196) ──

describe("whatsapp group thread unattributable sender (196)", () => {
  const GROUP_LOCAL = J.group.split("@")[0]!; // the group's own local part
  const P_UNMAPPED_LID = "9999999999@lid"; // @lid with NO lid-map entry (genuinely unknown person)

  test("threadForChat: a group message whose sender IS the group jid → neutral label, never the group id", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // Live bug (196, "Ma and children"): inbound group rows carry the GROUP's own local part as `sender`
    // (chat_jid has the @g.us suffix, the sender does not). Plus a self message and an unmapped @lid.
    const msgs: FixtureMsg[] = [
      { id: "u1", chat_jid: J.group, sender: GROUP_LOCAL, content: "group-id sender", timestamp: "2026-07-10T09:00:00Z" },
      { id: "u2", chat_jid: J.group, sender: J.group, content: "full group-jid sender", timestamp: "2026-07-10T09:01:00Z" },
      { id: "u3", chat_jid: J.group, sender: GROUP_LOCAL, content: "own group message", timestamp: "2026-07-10T09:02:00Z", is_from_me: 1 },
      { id: "u4", chat_jid: J.group, sender: P_UNMAPPED_LID, content: "unmapped lid", timestamp: "2026-07-10T09:03:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[J.group, "Deploy Crew"]], msgs), contacts: fixtureContacts([]) });

    const items = await threadForChat(db, J.group, { limit: 10, contacts: fixtureContacts([]) });
    const senderById = new Map(items.map((i) => [i.id, i.sender]));

    // sender == group local part → unattributable (never the raw group id, never the group name)
    expect(senderById.get("u1")).toBe("unknown");
    // sender == full group jid → same, compared on the local part
    expect(senderById.get("u2")).toBe("unknown");
    // own group message → "you"
    expect(senderById.get("u3")).toBe("you");
    // unmapped @lid → the person's short jid, never the group id / group name
    expect(senderById.get("u4")).toBe("9999999999");
    // the crux: the raw group id is NEVER rendered as a sender
    expect(items.every((i) => i.sender !== GROUP_LOCAL && i.sender !== J.group)).toBe(true);
    expect(items.every((i) => i.sender !== "Deploy Crew")).toBe(true);
    await lease.release();
  });
});

// ── reaction target ingest (#50) ────────────────────────────────────────────────────────────────────

describe("whatsapp reaction ingest (#50)", () => {
  test("a reaction row lands with media_type=reaction, the emoji in content, and the reacted-to id in quoted_message_id (from the bridge filename)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const res = await syncWhatsapp(db, {
      bridge: fixtureBridge([
        { id: "m1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "lunch?", timestamp: "2026-07-10T09:00:00Z" },
        // The bridge persists a reaction as media_type="reaction", emoji in content, reacted-to id in filename.
        { id: "r1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "👍", timestamp: "2026-07-10T09:01:00Z", media_type: "reaction", filename: "m1" },
      ]),
    });
    expect(res.ingested).toBe(2);

    const rows = await waRows(lease);
    const r = rows.find((x) => x.id === "r1")!;
    expect(r.media_type).toBe("reaction");
    expect(r.content).toBe("👍");
    expect(r.quoted_message_id).toBe("m1"); // reacted-to id recovered from the bridge `filename` column
  }, PG_BUDGET);

  test("a normal reply keeps its own quoted_message_id and never adopts filename", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, {
      bridge: fixtureBridge([
        { id: "m1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "lunch?", timestamp: "2026-07-10T09:00:00Z" },
        { id: "m2", chat_jid: JID_ALICE, sender: JID_ALICE, content: "yes!", timestamp: "2026-07-10T09:02:00Z", quoted_message_id: "m1", filename: "photo.jpg" },
      ]),
    });
    const r = (await waRows(lease)).find((x) => x.id === "m2")!;
    expect(r.quoted_message_id).toBe("m1"); // the real reply target, NOT the media filename
  });
});

// ── delivery/read status ingest (186b) ───────────────────────────────────────────────────────────────

/** A read-only-shaped bridge whose `messages` table carries the 186a `status` column. */
function bridgeWithStatus(
  chats: Array<[string, string | null]>,
  msgs: Array<FixtureMsg & { status?: string | null }>,
): Database {
  const b = new Database(":memory:");
  b.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
    CREATE TABLE messages (
      id TEXT NOT NULL, chat_jid TEXT NOT NULL, sender TEXT, content TEXT, timestamp TEXT,
      is_from_me INTEGER, media_type TEXT, filename TEXT, url TEXT, quoted_message_id TEXT, status TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  for (const [jid, name] of chats) b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(jid, name);
  for (const m of msgs) {
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, quoted_message_id, status) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(m.id, m.chat_jid, m.sender, m.content, m.timestamp, m.is_from_me ?? 0, m.media_type ?? null, m.quoted_message_id ?? null, m.status ?? null);
  }
  return b;
}

describe("whatsapp delivery/read status ingest (186b)", () => {
  test("ingests messages.status when the bridge column is present", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs = [
      { id: "s1", chat_jid: J.alice, sender: "me", content: "delivered one", timestamp: "2026-07-10T09:00:00Z", is_from_me: 1, status: "delivered" },
      { id: "s2", chat_jid: J.alice, sender: "me", content: "read one", timestamp: "2026-07-10T09:01:00Z", is_from_me: 1, status: "read" },
      { id: "s3", chat_jid: J.alice, sender: "me", content: "just sent", timestamp: "2026-07-10T09:02:00Z", is_from_me: 1, status: null },
      { id: "s4", chat_jid: J.alice, sender: J.alice, content: "inbound", timestamp: "2026-07-10T09:03:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWithStatus([[J.alice, "Alice"]], msgs) });

    const rows = await waRows(lease) as unknown as Array<{ id: string; status: string | null }>;
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    expect(statusById.get("s1")).toBe("delivered");
    expect(statusById.get("s2")).toBe("read");
    // 1936: a fresh outbound message is `sent`, so NULL keeps its single meaning (inbound / pre-186a).
    expect(statusById.get("s3")).toBe("sent");
    expect(statusById.get("s4")).toBeNull(); // inbound has no status
    await lease.release();
  }, PG_BUDGET);

  test("carries status onto thread items + latestPerChat", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs = [
      { id: "s1", chat_jid: J.alice, sender: "me", content: "hi there", timestamp: "2026-07-10T09:00:00Z", is_from_me: 1, status: "read" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWithStatus([[J.alice, "Alice"]], msgs) });

    const thread = await threadForChat(db, J.alice, { contacts: fixtureContacts([]) });
    expect(thread[0]!.status).toBe("read");

    const chats = await latestPerChat(db, { contacts: fixtureContacts([]) });
    expect(chats.find((c) => c.chat_jid === J.alice)!.status).toBe("read");
    await lease.release();
  }, PG_BUDGET);

  test("status advances on re-read (upsert): delivered → read on an existing row", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const at = "2026-07-10T09:00:00Z";
    await syncWhatsapp(db, {
      bridge: bridgeWithStatus([[J.alice, "Alice"]], [{ id: "s1", chat_jid: J.alice, sender: "me", content: "hi", timestamp: at, is_from_me: 1, status: "delivered" }]),
    });
    expect((await waRows(lease) as unknown as Array<{ id: string; status: string | null }>).find((r) => r.id === "s1")!.status).toBe("delivered");

    // A later receipt: same message, now read. backfill re-reads past the cursor so the row is revisited.
    const res = await syncWhatsapp(db, {
      bridge: bridgeWithStatus([[J.alice, "Alice"]], [{ id: "s1", chat_jid: J.alice, sender: "me", content: "hi", timestamp: at, is_from_me: 1, status: "read" }]),
      backfill: true,
    });
    expect(res.ingested).toBe(0); // no NEW row landed
    expect((await waRows(lease) as unknown as Array<{ id: string; status: string | null }>).find((r) => r.id === "s1")!.status).toBe("read"); // …but status upserted
    await lease.release();
  }, PG_BUDGET);

  test("tolerates a pre-186a bridge with no status column (existing fixtures stay green)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // defaultMsgs()'s fixtureBridge has NO status column — sync must not reference it and must not throw.
    const res = await syncWhatsapp(db, { bridge: fixtureBridge(defaultMsgs()) });
    expect(res.ingested).toBe(4);
    const rows = await waRows(lease) as unknown as Array<{ id: string; status: string | null; is_from_me: number | null }>;
    // An absent column cannot carry a receipt, but an outbound row still lands as `sent` (1936): the
    // stored status is ob's own knowledge of the row, not something the bridge has to offer.
    expect(rows.filter((r) => r.is_from_me === 1).every((r) => r.status === "sent")).toBe(true);
    expect(rows.filter((r) => r.is_from_me !== 1).every((r) => r.status === null)).toBe(true);
    await lease.release();
  });
});

// ── receipts only move forward, and the 48h sweep reaches them (1936) ────────────────────────────────
// The bridge can re-read an old row, and the cursor select can step past a message before its receipt
// lands. Both used to lose a receipt: the upsert wrote whatever it saw (read → delivered regressed) and
// a receipt older than the cursor was never selected at all.

const watchedStatus = async (lease: PgStoreLease) =>
  new Map(
    (await waRows(lease) as unknown as Array<{ id: string; status: string | null }>).map((r) => [
      r.id,
      r.status,
    ]),
  );

describe("whatsapp receipts only move forward (1936)", () => {
  test("a later `delivered` does not undo a stored `read`; `delivered` → `read`; and `played` beats `read`", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const at = "2026-07-10T09:00:00Z";
    const bridgeWith = (status: string) =>
      bridgeWithStatus([[J.alice, "Alice"]], [
        { id: "s1", chat_jid: J.alice, sender: "me", content: "hi", timestamp: at, is_from_me: 1, status },
      ]);

    // Stored `read`.
    await syncWhatsapp(db, { bridge: bridgeWith("read") });
    expect((await watchedStatus(lease)).get("s1")).toBe("read");

    // A lagging `delivered` re-read must NOT move it backwards.
    await syncWhatsapp(db, { bridge: bridgeWith("delivered"), backfill: true });
    expect((await watchedStatus(lease)).get("s1")).toBe("read");

    // An advance still lands: `played` beats `read`.
    await syncWhatsapp(db, { bridge: bridgeWith("played"), backfill: true });
    expect((await watchedStatus(lease)).get("s1")).toBe("played");

    // An unknown status string is ignored rather than stored.
    await syncWhatsapp(db, { bridge: bridgeWith("something-new"), backfill: true });
    expect((await watchedStatus(lease)).get("s1")).toBe("played");

    // A row stored before 186a is NULL, which ranks as `sent` on an outbound row, so a receipt still lands.
    await lease.sql.unsafe("UPDATE whatsapp_message SET status = NULL WHERE id = 's1'");
    await syncWhatsapp(db, { bridge: bridgeWith("delivered"), backfill: true });
    expect((await watchedStatus(lease)).get("s1")).toBe("delivered");

    // An INBOUND row has no receipt at all: a stray bridge status is ignored on the way in, and a later
    // one cannot write over it either, so NULL keeps its single meaning (1936).
    const later = "2026-07-10T09:30:00Z"; // newer than the cursor, so the forward select reaches it
    const inbound = (status: string | null) =>
      bridgeWithStatus([[J.alice, "Alice"]], [
        { id: "in1", chat_jid: J.alice, sender: J.alice, content: "hi back", timestamp: later, is_from_me: 0, status },
      ]);
    await syncWhatsapp(db, { bridge: inbound("read") });
    expect((await watchedStatus(lease)).get("in1")).toBeNull();
    await syncWhatsapp(db, { bridge: inbound("played"), backfill: true });
    expect((await watchedStatus(lease)).get("in1")).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("the 48h sweep records a receipt the cursor stepped past, and leaves an older message alone", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago: inside the sweep
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 3d ago: outside it
    const rows = (status: (id: string) => string | null) => [
      { id: "old1", chat_jid: J.alice, sender: "me", content: "long delivered", timestamp: old, is_from_me: 1, status: status("old1") },
      { id: "new1", chat_jid: J.alice, sender: "me", content: "just read", timestamp: recent, is_from_me: 1, status: status("new1") },
    ];

    // First pass: both land as `sent` and the cursor moves past BOTH (the newer timestamp is the last one).
    await syncWhatsapp(db, { bridge: bridgeWithStatus([[J.alice, "Alice"]], rows(() => null)) });
    const first = await watchedStatus(lease);
    expect(first.get("old1")).toBe("sent");
    expect(first.get("new1")).toBe("sent");

    // Their receipts arrive now. The cursor select cannot see either row (`timestamp > cursor` is false),
    // so only the sweep can reach them - and only the one inside 48 hours.
    const res = await syncWhatsapp(db, { bridge: bridgeWithStatus([[J.alice, "Alice"]], rows((id) => (id === "new1" ? "read" : "played"))) });
    expect(res.messages).toBe(0); // the forward select genuinely saw nothing
    const after = await watchedStatus(lease);
    expect(after.get("new1")).toBe("read");
    expect(after.get("old1")).toBe("sent"); // older than 48 hours: never touched
    await lease.release();
  }, PG_BUDGET);
});

describe("whatsapp cursor is the latest instant, not the largest string (1936)", () => {
  test("a +02:00 value that sorts AFTER a Z value in text is not chosen as the high-water mark", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // Text order says "…T11:00:00+02:00" > "…T09:30:00Z"; time order says the opposite (11:00+02:00 is
    // 09:00Z). The cursor must follow TIME and still be stored in the bridge's own raw format.
    const res = await syncWhatsapp(db, {
      bridge: bridgeWithStatus([[J.alice, "Alice"]], [
        { id: "early", chat_jid: J.alice, sender: J.alice, content: "early by clock", timestamp: "2026-07-10T11:00:00+02:00" },
        { id: "late", chat_jid: J.alice, sender: J.alice, content: "later by clock", timestamp: "2026-07-10T09:30:00Z" },
      ]),
    });
    expect(res.ingested).toBe(2);
    // This is the value `setCursorFor` stores, and it is the bridge's OWN raw text, so the SQL compare
    // at the next select still works.
    expect(res.cursor).toBe("2026-07-10T09:30:00Z"); // the 09:30Z instant, not the text-larger +02:00 one
    await lease.release();
  }, PG_BUDGET);
});

// ── ingest cleanup: exclude Status/@broadcast (175) + thread dedup (174) ─────────────────────────────

const STATUS = "status@broadcast"; // WhatsApp Status — logged as a chat but not a conversation
const BROADCAST_LIST = "120363111222333@broadcast"; // a broadcast list — also excluded

describe("whatsapp exclude Status / @broadcast (175)", () => {
  test("isConversationJid: false for any @broadcast, true for group / phone / @lid", async () => {
    expect(isConversationJid(STATUS)).toBe(false);
    expect(isConversationJid(BROADCAST_LIST)).toBe(false);
    expect(isConversationJid(J.alice)).toBe(true); // phone-jid
    expect(isConversationJid(J.group)).toBe(true); // group
    expect(isConversationJid(TINO_LID)).toBe(true); // @lid privacy id
  }, PG_BUDGET);

  test("latestPerChat excludes @broadcast chats; groups + phone + @lid still show", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "al", chat_jid: J.alice, sender: J.alice, content: "hi alice", timestamp: "2026-07-10T09:00:00Z" },
      { id: "gr", chat_jid: J.group, sender: J.alice, content: "hi group", timestamp: "2026-07-10T09:01:00Z" },
      { id: "st", chat_jid: STATUS, sender: J.alice, content: "a status update", timestamp: "2026-07-10T09:02:00Z" },
      { id: "bl", chat_jid: BROADCAST_LIST, sender: J.alice, content: "a broadcast", timestamp: "2026-07-10T09:03:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice"], [J.group, "Crew"], [STATUS, "Status"], [BROADCAST_LIST, "List"]], msgs) });

    // All four rows stay ingested (read-side filter only, non-destructive).
    expect(await waRows(lease)).toHaveLength(4);

    const jids = (await latestPerChat(db, { contacts: fixtureContacts([]) })).map((i) => i.chat_jid);
    expect(jids).toContain(J.alice);
    expect(jids).toContain(J.group);
    expect(jids).not.toContain(STATUS);
    expect(jids).not.toContain(BROADCAST_LIST);
    await lease.release();
  }, PG_BUDGET);

  test("threadForChat on a @broadcast jid → [] (never surfaced as a thread)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await syncWhatsapp(db, {
      bridge: bridgeWith(
        [[STATUS, "Status"]],
        [{ id: "st", chat_jid: STATUS, sender: J.alice, content: "a status", timestamp: "2026-07-10T09:00:00Z" }],
      ),
    });
    expect(await threadForChat(db, STATUS, { contacts: fixtureContacts([]) })).toEqual([]);
    await lease.release();
  });
});

describe("whatsapp thread dedup — same msg under phone + @lid (174)", () => {
  test("a phone-jid row + an identical @lid row collapse into ONE (name-resolved, phone copy)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // Same message, same ts + content + direction, logged under BOTH the phone-jid and the @lid.
    const msgs: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "coffee soon?", timestamp: "2026-07-10T09:00:00Z" },
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "coffee soon?", timestamp: "2026-07-10T09:00:00Z" },
    ];
    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], msgs), contacts });

    for (const jid of [TINO_PHONE, TINO_LID]) {
      const items = await threadForChat(db, jid, { limit: 15, contacts });
      expect(items).toHaveLength(1); // the duplicate copy is collapsed
      expect(items[0]!.id).toBe("p1"); // the phone-jid copy is preferred over the @lid copy
      expect(items[0]!.sender).toBe("tino🌸"); // resolved to a real name
      expect(items[0]!.chat_jid).toBe(TINO_PHONE); // canonical jid carried
    }
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("dedup within ~1s tolerance (copies logged a fraction of a second apart)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "on my way", timestamp: "2026-07-10T09:00:00.000Z", is_from_me: 1 },
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "on my way", timestamp: "2026-07-10T09:00:00.700Z", is_from_me: 1 },
    ];
    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], msgs), contacts });

    const items = await threadForChat(db, TINO_PHONE, { contacts });
    expect(items).toHaveLength(1); // within 1s + same content + same direction → one message
    expect(items[0]!.sender).toBe("you"); // outbound
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("genuinely-distinct messages are NOT collapsed", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const contacts = fixtureContacts(
      [{ their_jid: TINO_PHONE, full_name: "tino🌸" }],
      [[LID_LOCAL, TINO_PN_LOCAL]],
    );

    // (a) different content at the same instant → both kept
    const distinctContent: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "first thought", timestamp: "2026-07-10T09:00:00Z" },
      { id: "l1", chat_jid: TINO_LID, sender: TINO_LID, content: "second thought", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null], [TINO_LID, null]], distinctContent), contacts });
    expect((await threadForChat(db, TINO_PHONE, { contacts })).map((i) => i.content).sort(byCodeUnit)).toEqual([
      "first thought",
      "second thought",
    ]);
    await lease.release();

    // (b) identical content but > ~1s apart → both kept (a real repeated message, not a dup copy)
    const lease2 = await freshPgStore();
    const db2 = lease2.store;
    const repeated: FixtureMsg[] = [
      { id: "p1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "hello?", timestamp: "2026-07-10T09:00:00Z" },
      { id: "p2", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "hello?", timestamp: "2026-07-10T09:00:05Z" },
    ];
    await syncWhatsapp(db2, { bridge: bridgeWith([[TINO_PHONE, null]], repeated), contacts });
    expect(await threadForChat(db2, TINO_PHONE, { contacts })).toHaveLength(2);
    contacts.close();
    await lease2.release();
  }, PG_BUDGET);

  test("distinct media (empty bodies, different ids) within 1s are NOT collapsed", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const contacts = fixtureContacts([{ their_jid: TINO_PHONE, full_name: "tino🌸" }], [[LID_LOCAL, TINO_PN_LOCAL]]);
    const twoPhotos: FixtureMsg[] = [
      { id: "m1", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "", timestamp: "2026-07-10T09:00:00.100Z", media_type: "image" },
      { id: "m2", chat_jid: TINO_PHONE, sender: TINO_PHONE, content: "", timestamp: "2026-07-10T09:00:00.600Z", media_type: "image" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[TINO_PHONE, null]], twoPhotos), contacts });
    expect(await threadForChat(db, TINO_PHONE, { contacts })).toHaveLength(2); // empty bodies + distinct ids → kept
    contacts.close();
    await lease.release();
  }, PG_BUDGET);

  test("normal single-jid threads are unaffected by dedup", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const msgs: FixtureMsg[] = [
      { id: "a1", chat_jid: J.alice, sender: J.alice, content: "one", timestamp: "2026-07-10T09:00:00Z" },
      { id: "a2", chat_jid: J.alice, sender: J.alice, content: "two", timestamp: "2026-07-10T09:01:00Z" },
      { id: "a3", chat_jid: J.alice, sender: J.alice, content: "three", timestamp: "2026-07-10T09:02:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith([[J.alice, "Alice"]], msgs) });
    expect((await threadForChat(db, J.alice, { contacts: fixtureContacts([]) })).map((i) => i.id)).toEqual(["a1", "a2", "a3"]);
    await lease.release();
  });
});
