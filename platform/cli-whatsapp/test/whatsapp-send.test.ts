import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";

// SQLITE-BACKED STORE, deliberately, and the only file in the connector port that is. `sendWhatsapp` and
// `ingestJustSentMessage` take a Store like everything else -- what this file needs is a store that can
// be created a dozen times in one file cheaply. The Postgres form (a database per test, chain applied,
// dropped) hangs this file from its seventh test onward and the cause is not yet found; WhatsApp is
// deprioritised, so it is recorded rather than chased. The MODULE is Postgres-only either way; this is
// only where the test's rows live.
import { sendWhatsapp } from "../src/whatsapp/send.ts";
import { syncWhatsapp } from "../src/ingest/whatsapp.ts";
import { eventsBetweenFor, parsePayload } from "../../../apps/cli/src/events.ts";

// NO live bridge / NO network: the transport is injected. Each test points whatsapp_bridge_token_path
// at a throwaway token file (or a nonexistent path, for the missing-token case).

const TO = "27000000003@s.whatsapp.net";
const TOKEN = "test-bridge-token-abc123";

/**
 * Write a temp bridge-token file and register it on the db's config. Returns the file path. Also points
 * `whatsapp_db_path` at a path that does NOT exist, so the #120 post-send id pickup can never reach a real
 * bridge messages.db from a test: tests that care about the pickup inject a fixture bridge handle instead.
 */
async function withToken(db: Store): Promise<string> {
  const path = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(path, `${TOKEN}\n`, "utf8");
  await setConfig(db, "whatsapp_bridge_token_path", path);
  await setConfig(
    db,
    "whatsapp_db_path",
    join(tmpdir(), `ob-no-such-bridge-${randomUUID()}`, "messages.db"),
  );
  return path;
}

/**
 * A fixture bridge messages.db (chats + messages), mirroring the Go bridge's schema — the same shape
 * `whatsapp.test.ts` uses for sync. Tests NEVER open a real bridge; the handle is injected. Timestamps are
 * the real bridge's stored format ("YYYY-MM-DD HH:MM:SS+02:00", text, second precision).
 */
function fixtureBridge(
  rows: Array<{
    id: string;
    chat_jid: string;
    sender: string;
    content: string;
    timestamp: string;
    is_from_me?: number;
    status?: string | null;
  }>,
  chats: Array<[string, string | null]> = [[TO, "Alice"]],
): Database {
  const b = new Database(":memory:");
  b.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT);
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
      status TEXT,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  for (const [jid, name] of chats) b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(jid, name);
  for (const r of rows) {
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, status) VALUES(?,?,?,?,?,?,?)",
    ).run(r.id, r.chat_jid, r.sender, r.content, r.timestamp, r.is_from_me ?? 0, r.status ?? null);
  }
  return b;
}

/** The bridge's stored timestamp format for an instant (local offset, second precision). */
function bridgeTs(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMin = -at.getTimezoneOffset();
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Rows in whatsapp_message for a chat, newest first. */
function storedMessages(handle: ReturnType<typeof freshDb>, chatJid: string) {
  return handle
    .query(
      "SELECT id, chat_jid, content, ts, is_from_me, sender_jid, chat_name, status FROM whatsapp_message WHERE chat_jid = ? ORDER BY ts DESC",
    )
    .all(chatJid) as Array<{
    id: string;
    chat_jid: string;
    content: string | null;
    ts: string;
    is_from_me: number | null;
    sender_jid: string | null;
    chat_name: string | null;
    status: string | null;
  }>;
}

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** A mock transport (typeof fetch) that records calls and returns a canned Response. */
function mockTransport(
  calls: Captured[],
  response: { status?: number; body?: unknown } = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const body = JSON.stringify(response.body ?? { success: true, message: "sent" });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("sendWhatsapp — confirmation gate + bridge POST (101)", () => {
  test("GATE: refuses to send unless confirm === true (nothing sent for false/undefined/1/'true')", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);

    for (const bad of [false, undefined, 1, "true"]) {
      const calls: Captured[] = [];
      const transport = mockTransport(calls);
      await expect(
        sendWhatsapp(db, {
          to: TO,
          body: "hi",
          confirm: bad as unknown as boolean,
          fetch: transport,
        }),
      ).rejects.toThrow(/no explicit confirmation|confirm === true/);
      expect(calls).toHaveLength(0); // transport NEVER called — nothing left the machine
    }
    // and no 'sent' event recorded for any of the refused attempts
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0);
    handle.close();
  });

  test("confirm:true → POSTs {base}/api/send with Bearer auth and {recipient, message} body", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Captured[] = [];
    const transport = mockTransport(calls);

    const res = await sendWhatsapp(db, {
      to: TO,
      body: "on my way",
      confirm: true,
      fetch: transport,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8080/api/send"); // localhost only

    const headers = call.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(JSON.parse(call.init!.body as string)).toEqual({
      recipient: TO,
      message: "on my way",
    });

    expect(res.ok).toBe(true);
    expect(res.to).toBe(TO);
    handle.close();
  });

  test("records an event(source='whatsapp', type='sent') on success", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Captured[] = [];

    await sendWhatsapp(db, {
      to: TO,
      body: "a".repeat(200),
      confirm: true,
      fetch: mockTransport(calls),
    });

    const events = await eventsBetweenFor(db, { source: "whatsapp", type: "sent" });
    expect(events).toHaveLength(1);
    const payload = parsePayload<{ chat_jid: string; body_preview: string; length: number }>(events[0]!);
    expect(events[0]!.actor).toBe(TO);
    expect(payload.chat_jid).toBe(TO);
    expect(payload.body_preview).toHaveLength(80); // first 80 chars only
    expect(payload.length).toBe(200);
    handle.close();
  });

  test("throws on success:false — and records NO event", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Captured[] = [];
    const transport = mockTransport(calls, { status: 200, body: { success: false, message: "no session" } });

    await expect(
      sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: transport }),
    ).rejects.toThrow(/no session/);

    expect(calls).toHaveLength(1); // it did attempt the POST
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0); // but recorded nothing
    handle.close();
  });

  test("throws on a non-2xx bridge response — and records NO event", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Captured[] = [];
    const transport = mockTransport(calls, { status: 500, body: { success: false, message: "boom" } });

    await expect(
      sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: transport }),
    ).rejects.toThrow(/500/);
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0);
    handle.close();
  });

  test("throws a clean error when the bridge token file is missing — and never sends", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await setConfig(db, "whatsapp_bridge_token_path", 
      "/nonexistent/does/not/exist/.bridge-token",
    );
    const calls: Captured[] = [];

    await expect(
      sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: mockTransport(calls) }),
    ).rejects.toThrow(/cannot read WhatsApp bridge token/);

    expect(calls).toHaveLength(0); // token read fails before any POST
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0);
    handle.close();
  });
});

describe("sendWhatsapp — persists the sent message at send time (#120)", () => {
  test("inserts the outbound row carrying the BRIDGE's id, shaped exactly as sync writes it", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const now = new Date();
    const bridge = fixtureBridge([
      { id: "BRIDGE_ID_1", chat_jid: TO, sender: "27000000011", content: "on my way", timestamp: bridgeTs(now), is_from_me: 1 },
    ]);

    const res = await sendWhatsapp(db, {
      to: TO,
      body: "on my way",
      confirm: true,
      fetch: mockTransport([]),
      bridge,
    });

    expect(res.id).toBe("BRIDGE_ID_1"); // the real bridge id, not a locally-minted one
    const rows = storedMessages(handle, TO);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("BRIDGE_ID_1");
    expect(rows[0]!.content).toBe("on my way");
    expect(rows[0]!.is_from_me).toBe(1); // renders as outbound, like every other sent message
    expect(rows[0]!.sender_jid).toBe("27000000011"); // straight off the bridge row, as sync does
    expect(rows[0]!.chat_name).toBe("Alice"); // joined from the bridge's chats table, as sync does
    expect(rows[0]!.ts).toBe(now.toISOString().replace(/\.\d{3}Z$/, ".000Z")); // bridge ts → ISO-8601

    // Searchability is asserted in whatsapp.test.ts against the real tsvector column; there is no shadow
    // table to check here any more, and this store is SQLite (see the note at the top of the file).

    bridge.close();
    handle.close();
  });

  test("a later sync of the SAME message does not duplicate it (and the unique index forbids it)", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const bridge = fixtureBridge([
      { id: "BRIDGE_ID_2", chat_jid: TO, sender: "27000000011", content: "see you at six", timestamp: bridgeTs(new Date()), is_from_me: 1 },
    ]);

    await sendWhatsapp(db, { to: TO, body: "see you at six", confirm: true, fetch: mockTransport([]), bridge });
    expect(storedMessages(handle, TO)).toHaveLength(1);

    // the 60s launchd sync re-reads the very same bridge row: a no-op, not a second bubble
    const synced = await syncWhatsapp(db, { bridge, backfill: true });
    expect(synced.messages).toBe(1); // it did read the row
    expect(synced.ingested).toBe(0); // and landed nothing new
    expect(storedMessages(handle, TO)).toHaveLength(1);

    // the DB-level guarantee behind that: (chat_jid, id) is unique
    expect(() =>
      handle
        .query(
          "INSERT INTO whatsapp_message(id, chat_jid, content, ts, is_from_me, created_at) VALUES(?,?,?,?,?,?)",
        )
        .run("BRIDGE_ID_2", TO, "see you at six", new Date().toISOString(), 1, new Date().toISOString()),
    ).toThrow(/UNIQUE|constraint/i);

    bridge.close();
    handle.close();
  });

  test("SAFETY VALVE — an AMBIGUOUS match inserts nothing, returns id null, and does not throw", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const ts = bridgeTs(new Date());
    // two identical outbound messages to the same chat inside the window: which one is "the" send is
    // unknowable, and attributing the wrong id is worse than waiting for the sync
    const bridge = fixtureBridge([
      { id: "DUP_A", chat_jid: TO, sender: "27000000011", content: "ok", timestamp: ts, is_from_me: 1 },
      { id: "DUP_B", chat_jid: TO, sender: "27000000011", content: "ok", timestamp: ts, is_from_me: 1 },
    ]);

    const res = await sendWhatsapp(db, { to: TO, body: "ok", confirm: true, fetch: mockTransport([]), bridge });

    expect(res.ok).toBe(true); // the send itself SUCCEEDED — the pickup is best-effort
    expect(res.id).toBeNull();
    expect(storedMessages(handle, TO)).toHaveLength(0); // nothing stored; the sync backfills it as before
    bridge.close();
    handle.close();
  });

  test("SAFETY VALVE — no matching row (nothing in the window / no bridge DB) inserts nothing and does not throw", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    // the only matching content is 10 minutes old, so it is NOT the message we just sent
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const bridge = fixtureBridge([
      { id: "OLD_ID", chat_jid: TO, sender: "27000000011", content: "same words", timestamp: bridgeTs(stale), is_from_me: 1 },
    ]);

    const outOfWindow = await sendWhatsapp(db, {
      to: TO,
      body: "same words",
      confirm: true,
      fetch: mockTransport([]),
      bridge,
    });
    expect(outOfWindow.ok).toBe(true);
    expect(outOfWindow.id).toBeNull();
    expect(storedMessages(handle, TO)).toHaveLength(0);
    bridge.close();

    // and with NO readable bridge DB at all (withToken points whatsapp_db_path at a nonexistent file)
    const noBridge = await sendWhatsapp(db, {
      to: TO,
      body: "no bridge db here",
      confirm: true,
      fetch: mockTransport([]),
    });
    expect(noBridge.ok).toBe(true);
    expect(noBridge.id).toBeNull();
    expect(storedMessages(handle, TO)).toHaveLength(0);
    handle.close();
  });

  test("a FAILED send stores no row (and still records no event)", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const bridge = fixtureBridge([
      { id: "NEVER", chat_jid: TO, sender: "27000000011", content: "should not land", timestamp: bridgeTs(new Date()), is_from_me: 1 },
    ]);

    await expect(
      sendWhatsapp(db, {
        to: TO,
        body: "should not land",
        confirm: true,
        fetch: mockTransport([], { status: 200, body: { success: false, message: "no session" } }),
        bridge,
      }),
    ).rejects.toThrow(/no session/);

    expect(storedMessages(handle, TO)).toHaveLength(0);
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0);
    bridge.close();
    handle.close();
  });

  test("the persisted row and the send's own audit event both land (the same two the old flow produced, 60s apart)", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const bridge = fixtureBridge([
      { id: "BRIDGE_ID_3", chat_jid: TO, sender: "27000000011", content: "two events", timestamp: bridgeTs(new Date()), is_from_me: 1 },
    ]);

    await sendWhatsapp(db, { to: TO, body: "two events", confirm: true, fetch: mockTransport([]), bridge });

    const events = await eventsBetweenFor(db, { source: "whatsapp", type: "sent" });
    expect(events).toHaveLength(2); // the send audit event + the ingest mirror (which carries the id)
    const withId = events
      .map((e) => parsePayload<{ id?: string; chat_jid: string }>(e))
      .find((p) => p.id === "BRIDGE_ID_3");
    expect(withId?.chat_jid).toBe(TO);
    bridge.close();
    handle.close();
  });
});
