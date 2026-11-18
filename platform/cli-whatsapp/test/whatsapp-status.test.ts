import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { addPersonFor } from "../../../apps/cli/src/commands/person.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { latestPerChat, threadForChat, isConversationJid } from "../src/ingest/whatsapp.ts";
import { handleWhatsappRequest } from "../../../apps/cli/src/realtime.ts";
import { setChatFavorite } from "../src/whatsapp/prefs.ts";
import {
  STATUS_JID,
  isStatusJid,
  isStatusMediaType,
  isCurrentStatus,
  statusCutoffIso,
  statusTray,
  statusHistoryPage,
  shouldPersistWhatsappMedia,
  prefetchFavoriteStatusMedia,
} from "../src/whatsapp/status.ts";

const PG_BUDGET = spawnBudget(2);

const ALICE = "27000000003@s.whatsapp.net";
const BOB = "27000000004@s.whatsapp.net";
const CAROL = "27000000005@s.whatsapp.net";
const ALICE_PN = "27000000003";
const ALICE_LID_LOCAL = "142932300542115";
const ALICE_LID = `${ALICE_LID_LOCAL}@lid`;
const BROADCAST_LIST = "120363111222333@broadcast";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const CURRENT = "2026-09-12T10:00:00.000Z";
const CURRENT_B = "2026-09-12T11:00:00.000Z";
const EXPIRED = "2026-09-11T10:00:00.000Z";
const EXPIRED_B = "2026-09-11T08:00:00.000Z";

async function setup(): Promise<{ store: Store; release: () => Promise<void> }> {
  const lease = await freshPgStore();
  await setConfig(lease.store, "whatsapp_contacts_db_path", "/nonexistent/does/not/exist/whatsapp.db");
  return { store: lease.store, release: () => lease.release() };
}

async function insertStatus(
  db: Store,
  opts: {
    id: string;
    sender: string;
    ts: string;
    media_type: string | null;
    is_from_me?: number;
    content?: string | null;
    chat_jid?: string;
  },
): Promise<void> {
  await db.q.insert(db.t.whatsappMessage).values({
    id: opts.id,
    chat_jid: opts.chat_jid ?? STATUS_JID,
    chat_name: "Status",
    sender_jid: opts.sender,
    content: opts.content ?? null,
    ts: opts.ts,
    is_from_me: opts.is_from_me ?? 0,
    media_type: opts.media_type,
    created_at: opts.ts,
  });
}

function fixtureContacts(
  rows: Array<{ their_jid: string; full_name?: string | null }>,
  lids: Array<[string, string]> = [],
): Database {
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
    ).run("me@s.whatsapp.net", r.their_jid, null, r.full_name ?? null, null, null);
  }
  for (const [lid, pn] of lids) {
    c.query("INSERT INTO whatsmeow_lid_map(lid, pn) VALUES(?, ?)").run(lid, pn);
  }
  return c;
}

describe("whatsapp status helpers (629)", () => {
  test("isStatusJid is only status@broadcast, not broadcast lists", () => {
    expect(isStatusJid(STATUS_JID)).toBe(true);
    expect(isStatusJid(BROADCAST_LIST)).toBe(false);
    expect(isStatusJid(ALICE)).toBe(false);
    expect(isConversationJid(STATUS_JID)).toBe(false);
    expect(isStatusMediaType("image")).toBe(true);
    expect(isStatusMediaType("video")).toBe(true);
    expect(isStatusMediaType("audio")).toBe(false);
    expect(isStatusMediaType(null)).toBe(false);
  });

  test("isCurrentStatus is a 24h window", () => {
    expect(isCurrentStatus(CURRENT, NOW)).toBe(true);
    expect(isCurrentStatus(EXPIRED, NOW)).toBe(false);
    expect(statusCutoffIso(NOW)).toBe("2026-09-11T12:00:00.000Z");
  });
});

describe("whatsapp status tray (629)", () => {
  test("groups current image/video per sender; excludes own, expired, chats, broadcast lists, audio", async () => {
    const { store, release } = await setup();
    await addPersonFor(store, "Alice", { whatsapp_jid: ALICE });
    await insertStatus(store, { id: "a1", sender: ALICE, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "a2", sender: ALICE, ts: CURRENT_B, media_type: "video" });
    await insertStatus(store, { id: "a-old", sender: ALICE, ts: EXPIRED, media_type: "image" });
    await insertStatus(store, { id: "b1", sender: BOB, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "mine", sender: ALICE, ts: CURRENT, media_type: "image", is_from_me: 1 });
    await insertStatus(store, { id: "aud", sender: CAROL, ts: CURRENT, media_type: "audio" });
    await insertStatus(store, {
      id: "bl",
      sender: ALICE,
      ts: CURRENT,
      media_type: "image",
      chat_jid: BROADCAST_LIST,
    });
    await store.q.insert(store.t.whatsappMessage).values({
      id: "chat1",
      chat_jid: ALICE,
      sender_jid: ALICE,
      content: "hi",
      ts: CURRENT,
      is_from_me: 0,
      media_type: null,
      created_at: CURRENT,
    });

    const page = await statusTray(store, { now: NOW });
    expect(page.people.map((p) => p.sender_jid)).toEqual([ALICE, BOB]);
    const alice = page.people[0]!;
    expect(alice.name).toBe("Alice");
    expect(alice.items.map((i) => i.id)).toEqual(["a2", "a1"]);
    expect(alice.items.map((i) => i.media_type)).toEqual(["video", "image"]);
    expect(page.people[1]!.items.map((i) => i.id)).toEqual(["b1"]);
    expect(page.hasMore).toBe(true);

    expect((await latestPerChat(store)).map((c) => c.chat_jid)).toEqual([ALICE]);
    expect(await threadForChat(store, STATUS_JID)).toEqual([]);
    await release();
  }, PG_BUDGET);

  test("favourite flag follows the sender's 1:1 chat pref (190)", async () => {
    const { store, release } = await setup();
    await insertStatus(store, { id: "a1", sender: ALICE, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "b1", sender: BOB, ts: CURRENT, media_type: "image" });
    await setChatFavorite(store, ALICE, true);

    const page = await statusTray(store, { now: NOW });
    expect(page.people.find((p) => p.sender_jid === ALICE)!.favorite).toBe(true);
    expect(page.people.find((p) => p.sender_jid === BOB)!.favorite).toBe(false);
    await release();
  }, PG_BUDGET);

  test("Status name is the same as the chat list across LID vs phone jid (633)", async () => {
    const { store, release } = await setup();
    const lids: Array<[string, string]> = [[ALICE_LID_LOCAL, ALICE_PN]];
    await addPersonFor(store, "Alice", { whatsapp_jid: ALICE });
    await insertStatus(store, { id: "lid1", sender: ALICE_LID, ts: CURRENT, media_type: "image" });
    await store.q.insert(store.t.whatsappMessage).values({
      id: "chat-alice",
      chat_jid: ALICE,
      chat_name: "Alice Chat",
      sender_jid: ALICE,
      content: "hi",
      ts: CURRENT,
      is_from_me: 0,
      media_type: null,
      created_at: CURRENT,
    });
    await setChatFavorite(store, ALICE, true);
    const contacts = fixtureContacts([{ their_jid: ALICE, full_name: "Alice Whatsmeow" }], lids);
    const page = await statusTray(store, { now: NOW, contacts });
    const chats = await latestPerChat(store, { contacts });
    const aliceStatus = page.people.find((p) => p.sender_jid === ALICE)!;
    const aliceChat = chats.find((c) => c.chat_jid === ALICE)!;
    expect(aliceStatus.name).toBe("Alice");
    expect(aliceStatus.name).toBe(aliceChat.name);
    expect(aliceStatus.favorite).toBe(true);
    expect(aliceStatus.name).not.toMatch(/^\d+$/);
    expect(await shouldPersistWhatsappMedia(store, STATUS_JID, "lid1", { contacts })).toBe(true);
    contacts.close();
    await release();
  }, PG_BUDGET);

  test("without a person, Status uses the chat-list whatsmeow / chat_name (not the number)", async () => {
    const { store, release } = await setup();
    const lids: Array<[string, string]> = [[ALICE_LID_LOCAL, ALICE_PN]];
    await insertStatus(store, { id: "lid1", sender: ALICE_LID, ts: CURRENT, media_type: "image" });
    const withContact = fixtureContacts([{ their_jid: ALICE, full_name: "Alice Whatsmeow" }], lids);
    expect((await statusTray(store, { now: NOW, contacts: withContact })).people[0]!.name).toBe("Alice Whatsmeow");
    withContact.close();

    await store.q.insert(store.t.whatsappMessage).values({
      id: "chat-alice",
      chat_jid: ALICE,
      chat_name: "Alice Chat",
      sender_jid: ALICE,
      content: "hi",
      ts: CURRENT,
      is_from_me: 0,
      media_type: null,
      created_at: CURRENT,
    });
    const lidsOnly = fixtureContacts([], lids);
    expect((await statusTray(store, { now: NOW, contacts: lidsOnly })).people[0]!.name).toBe("Alice Chat");
    lidsOnly.close();
    await release();
  }, PG_BUDGET);

  test("favouriting via @lid marks the phone-jid Status row (633)", async () => {
    const { store, release } = await setup();
    const contacts = fixtureContacts([], [[ALICE_LID_LOCAL, ALICE_PN]]);
    await insertStatus(store, { id: "p1", sender: ALICE, ts: CURRENT, media_type: "image" });
    await setChatFavorite(store, ALICE_LID, true, { contacts });

    const page = await statusTray(store, { now: NOW, contacts });
    expect(page.people.find((p) => p.sender_jid === ALICE)!.favorite).toBe(true);
    expect(await shouldPersistWhatsappMedia(store, STATUS_JID, "p1", { contacts })).toBe(true);
    contacts.close();
    await release();
  }, PG_BUDGET);

  test("history page returns expired items strictly before the cursor and reports hasMore", async () => {
    const { store, release } = await setup();
    await insertStatus(store, { id: "now", sender: ALICE, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "old1", sender: ALICE, ts: EXPIRED, media_type: "image" });
    await insertStatus(store, { id: "old2", sender: BOB, ts: EXPIRED_B, media_type: "video" });

    const tray = await statusTray(store, { now: NOW });
    expect(tray.people).toHaveLength(1);
    expect(tray.hasMore).toBe(true);

    const hist = await statusHistoryPage(store, { before: statusCutoffIso(NOW), now: NOW, limit: 10 });
    const ids = hist.people.flatMap((p) => p.items.map((i) => i.id)).sort();
    expect(ids).toEqual(["old1", "old2"]);
    expect(hist.hasMore).toBe(false);

    const tiny = await statusHistoryPage(store, { before: statusCutoffIso(NOW), now: NOW, limit: 1 });
    expect(tiny.people.flatMap((p) => p.items)).toHaveLength(1);
    expect(tiny.hasMore).toBe(true);

    const aliceOnly = await statusHistoryPage(store, {
      before: statusCutoffIso(NOW),
      now: NOW,
      limit: 10,
      senderJid: ALICE,
    });
    expect(aliceOnly.people.map((p) => p.sender_jid)).toEqual([ALICE]);
    expect(aliceOnly.people[0]!.items.map((i) => i.id)).toEqual(["old1"]);
    await release();
  }, PG_BUDGET);

  test("shouldPersistWhatsappMedia: chats yes; status only when the sender is a favourite", async () => {
    const { store, release } = await setup();
    await store.q.insert(store.t.whatsappMessage).values({
      id: "c1",
      chat_jid: ALICE,
      sender_jid: ALICE,
      ts: CURRENT,
      is_from_me: 0,
      media_type: "image",
      created_at: CURRENT,
    });
    await insertStatus(store, { id: "s1", sender: ALICE, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "s2", sender: BOB, ts: CURRENT, media_type: "video" });
    await setChatFavorite(store, ALICE, true);

    expect(await shouldPersistWhatsappMedia(store, ALICE, "c1")).toBe(true);
    expect(await shouldPersistWhatsappMedia(store, STATUS_JID, "s1")).toBe(true);
    expect(await shouldPersistWhatsappMedia(store, STATUS_JID, "s2")).toBe(false);
    await release();
  }, PG_BUDGET);

  test("prefetchFavoriteStatusMedia downloads only favourite current items", async () => {
    const { store, release } = await setup();
    const tokenPath = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
    writeFileSync(tokenPath, "tok\n");
    await setConfig(store, "whatsapp_bridge_token_path", tokenPath);
    await setConfig(store, "whatsapp_bridge_url", "http://127.0.0.1:8080");
    const cacheDir = mkdtempSync(join(tmpdir(), "ob-wa-status-"));

    await insertStatus(store, { id: "fav", sender: ALICE, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "other", sender: BOB, ts: CURRENT, media_type: "image" });
    await insertStatus(store, { id: "oldfav", sender: ALICE, ts: EXPIRED, media_type: "image" });
    await setChatFavorite(store, ALICE, true);

    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: false, message: "skip" }), { status: 503 });
    }) as unknown as typeof fetch;

    const saved = await prefetchFavoriteStatusMedia(store, { now: NOW, fetch: fetchFn, cacheDir });
    expect(saved).toBe(0);
    expect(calls).toHaveLength(1);
    await release();
  }, PG_BUDGET);
});

describe("whatsapp status HTTP endpoint (629)", () => {
  test("GET /api/whatsapp/status returns the current tray; before= pages history", async () => {
    const { store, release } = await setup();
    const now = Date.now();
    const current = new Date(now - 2 * 3600 * 1000).toISOString();
    const expired = new Date(now - 26 * 3600 * 1000).toISOString();
    await insertStatus(store, { id: "now", sender: ALICE, ts: current, media_type: "image" });
    await insertStatus(store, { id: "old", sender: BOB, ts: expired, media_type: "video" });

    const trayRes = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/status", { method: "GET" }),
      { store },
    );
    expect(trayRes!.status).toBe(200);
    const tray = (await trayRes!.json()) as { people: Array<{ sender_jid: string }>; hasMore: boolean };
    expect(tray.people.map((p) => p.sender_jid)).toEqual([ALICE]);
    expect(tray.hasMore).toBe(true);

    const histRes = await handleWhatsappRequest(
      new Request(
        `http://localhost:5051/api/whatsapp/status?before=${encodeURIComponent(new Date(now - 24 * 3600 * 1000).toISOString())}`,
        { method: "GET" },
      ),
      { store },
    );
    const hist = (await histRes!.json()) as { people: Array<{ sender_jid: string; items: Array<{ id: string }> }> };
    expect(hist.people.map((p) => p.sender_jid)).toEqual([BOB]);
    expect(hist.people[0]!.items.map((i) => i.id)).toEqual(["old"]);
    await release();
  }, PG_BUDGET);
});
