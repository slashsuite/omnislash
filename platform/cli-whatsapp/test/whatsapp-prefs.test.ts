import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { syncWhatsapp, latestPerChat } from "../src/ingest/whatsapp.ts";
import {
  getChatPref,
  setChatHidden,
  setChatAiDisabled,
  setChatFavorite,
  listHiddenChats,
  listFavoriteChats,
} from "../src/whatsapp/prefs.ts";
import { suggestReplyGated } from "../src/whatsapp/suggest.ts";

// ── ticket 169: WhatsApp per-chat preferences (hide + AI-disable) ─────────────────────────────────────
// Prefs are keyed by the CANONICAL chat_jid (164). Tests are hermetic: the bridge + contacts handles are
// injected in-memory; no real DB / claude process is ever touched.

const JID_ALICE = "27000000003@s.whatsapp.net";
const JID_CAROL = "27000000005@s.whatsapp.net";

// @lid canonicalization fixtures (mirrors whatsapp.test.ts)
const LID_LOCAL = "142932300542115";
const TINO_LID = `${LID_LOCAL}@lid`;
const TINO_PHONE = "27000000011@s.whatsapp.net";
const TINO_PN_LOCAL = "27000000011";

interface FixtureMsg {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
  is_from_me?: number;
}

/** A read-only-shaped bridge (chats + messages) in memory. */
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
    ).run(m.id, m.chat_jid, m.sender, m.content, m.timestamp, m.is_from_me ?? 0, null, null);
  }
  return b;
}

/** A read-only-shaped whatsapp.db carrying only the lid↔pn map (164). */
function fixtureLidContacts(lids: Array<[string, string]>): Database {
  const c = new Database(":memory:");
  c.exec(`
    CREATE TABLE whatsmeow_contacts (our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT, business_name TEXT, PRIMARY KEY (our_jid, their_jid));
    CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE);
  `);
  for (const [lid, pn] of lids) c.query("INSERT INTO whatsmeow_lid_map(lid, pn) VALUES(?, ?)").run(lid, pn);
  return c;
}

function twoChats(): { chats: Array<[string, string | null]>; msgs: FixtureMsg[] } {
  return {
    chats: [
      [JID_ALICE, "Alice"],
      [JID_CAROL, "Carol"],
    ],
    msgs: [
      { id: "a1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "hi alice", timestamp: "2026-07-10T09:00:00Z" },
      { id: "c1", chat_jid: JID_CAROL, sender: JID_CAROL, content: "hi carol", timestamp: "2026-07-11T09:00:00Z" },
    ],
  };
}

describe("whatsapp per-chat prefs — setters + getters (169)", () => {
  test("getChatPref defaults to { hidden: false, ai_disabled: false, favorite: false } for an unknown chat", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: false, ai_disabled: false, favorite: false });
    await lease.release();
  }, PG_BUDGET);

  test("setChatHidden / setChatAiDisabled upsert independently (one flag never clobbers the other)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setChatHidden(db, JID_ALICE, true);
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: true, ai_disabled: false, favorite: false });

    await setChatAiDisabled(db, JID_ALICE, true); // must not reset hidden
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: true, ai_disabled: true, favorite: false });

    await setChatHidden(db, JID_ALICE, false); // must not reset ai_disabled
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: false, ai_disabled: true, favorite: false });

    await setChatAiDisabled(db, JID_ALICE, false);
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: false, ai_disabled: false, favorite: false });
    await lease.release();
  }, PG_BUDGET);

  test("setChatFavorite upserts independently — never clobbers hidden or ai_disabled (190a)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setChatHidden(db, JID_ALICE, true);
    await setChatAiDisabled(db, JID_ALICE, true);

    await setChatFavorite(db, JID_ALICE, true); // must not reset hidden/ai_disabled
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: true, ai_disabled: true, favorite: true });

    await setChatHidden(db, JID_ALICE, false); // must not reset favorite
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: false, ai_disabled: true, favorite: true });

    await setChatFavorite(db, JID_ALICE, false);
    expect(await getChatPref(db, JID_ALICE)).toEqual({ hidden: false, ai_disabled: true, favorite: false });
    await lease.release();
  }, PG_BUDGET);

  test("listHiddenChats returns only the hidden chats' canonical jids", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setChatHidden(db, JID_ALICE, true);
    await setChatAiDisabled(db, JID_CAROL, true); // ai-disabled but NOT hidden
    expect(await listHiddenChats(db)).toEqual([JID_ALICE]);
    await lease.release();
  }, PG_BUDGET);

  test("listFavoriteChats returns only the favourited chats' canonical jids (190a)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setChatFavorite(db, JID_ALICE, true);
    await setChatHidden(db, JID_CAROL, true); // hidden but NOT favourited
    expect(await listFavoriteChats(db)).toEqual([JID_ALICE]);
    await lease.release();
  }, PG_BUDGET);

  test("prefs are keyed by the CANONICAL jid: an @lid and its phone-jid share one pref", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const contacts = fixtureLidContacts([[LID_LOCAL, TINO_PN_LOCAL]]);

    // set via the @lid jid → stored under the canonical phone-jid
    await setChatHidden(db, TINO_LID, true, { contacts });
    expect(await listHiddenChats(db)).toEqual([TINO_PHONE]); // canonical key, not the raw @lid

    // read back via EITHER jid → same pref
    expect((await getChatPref(db, TINO_PHONE, { contacts })).hidden).toBe(true);
    expect((await getChatPref(db, TINO_LID, { contacts })).hidden).toBe(true);

    // set ai-off via the phone-jid → same single row
    await setChatAiDisabled(db, TINO_PHONE, true, { contacts });
    expect(await getChatPref(db, TINO_LID, { contacts })).toEqual({ hidden: true, ai_disabled: true, favorite: false });
    expect(
      ((await lease.sql.unsafe("SELECT count(*)::int AS n FROM whatsapp_chat_pref")) as { n: number }[])[0]!.n,
    ).toBe(1); // ONE row, not two
    contacts.close();
    await lease.release();
  });
});

describe("whatsapp latestPerChat honours prefs (169)", () => {
  test("hidden chats are excluded by default; shown with includeHidden; flags carried on the item", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { chats, msgs } = twoChats();
    await syncWhatsapp(db, { bridge: bridgeWith(chats, msgs) });

    await setChatHidden(db, JID_ALICE, true);
    await setChatAiDisabled(db, JID_CAROL, true);

    // default: Alice is hidden → only Carol shows
    const visible = await latestPerChat(db);
    expect(visible.map((c) => c.chat_jid)).toEqual([JID_CAROL]);
    const carol = visible[0]!;
    expect(carol.hidden).toBe(false);
    expect(carol.ai_disabled).toBe(true); // ai-disabled but still visible

    // includeHidden: both show, Alice carries hidden: true
    const all = await latestPerChat(db, { includeHidden: true });
    const byJid = new Map(all.map((c) => [c.chat_jid, c]));
    expect(byJid.size).toBe(2);
    expect(byJid.get(JID_ALICE)!.hidden).toBe(true);
    expect(byJid.get(JID_CAROL)!.hidden).toBe(false);
    await lease.release();
  }, PG_BUDGET);

  test("favorite is surfaced on each feed item (190a)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { chats, msgs } = twoChats();
    await syncWhatsapp(db, { bridge: bridgeWith(chats, msgs) });

    await setChatFavorite(db, JID_ALICE, true);

    const feed = await latestPerChat(db);
    const byJid = new Map(feed.map((c) => [c.chat_jid, c]));
    expect(byJid.get(JID_ALICE)!.favorite).toBe(true);
    expect(byJid.get(JID_CAROL)!.favorite).toBe(false);
    await lease.release();
  }, PG_BUDGET);

  test("hiding filters BEFORE the limit slice, so a hidden chat never shrinks the visible page", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const chats: Array<[string, string | null]> = [
      [JID_ALICE, "Alice"],
      [JID_CAROL, "Carol"],
    ];
    const msgs: FixtureMsg[] = [
      { id: "a1", chat_jid: JID_ALICE, sender: JID_ALICE, content: "newer", timestamp: "2026-07-12T09:00:00Z" },
      { id: "c1", chat_jid: JID_CAROL, sender: JID_CAROL, content: "older", timestamp: "2026-07-10T09:00:00Z" },
    ];
    await syncWhatsapp(db, { bridge: bridgeWith(chats, msgs) });

    // Alice is the newest chat; hide her. With limit 1, the visible page must still be Carol (not empty).
    await setChatHidden(db, JID_ALICE, true);
    const page = await latestPerChat(db, { limit: 1 });
    expect(page.map((c) => c.chat_jid)).toEqual([JID_CAROL]);
    await lease.release();
  });
});

describe("suggestReplyGated — server-side AI gate (169)", () => {
  test("an ai_disabled chat REFUSES: never runs claude, returns { draft: '', aiDisabled: true }", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setChatAiDisabled(db, JID_ALICE, true);

    let ran = false;
    const res = await suggestReplyGated(db, {
      chatJid: JID_ALICE,
      run: async () => {
        ran = true;
        return "should never be produced";
      },
    });
    expect(res).toEqual({ draft: "", aiDisabled: true });
    expect(ran).toBe(false); // the runner (claude) was never invoked
    await lease.release();
  }, PG_BUDGET);

  test("an AI-enabled chat delegates to suggestWhatsappReply and returns the draft", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const res = await suggestReplyGated(db, {
      chatJid: JID_ALICE,
      run: async () => "sounds good, see you then",
    });
    expect(res.aiDisabled).toBeUndefined();
    expect(res.draft).toBe("sounds good, see you then");
    await lease.release();
  });
});
