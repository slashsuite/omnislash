import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { describeAttachment, sendGateLines, sendWhatsapp } from "../src/whatsapp/send.ts";
import { eventsBetweenFor, parsePayload } from "../../../apps/cli/src/events.ts";

// ob 1683: `whatsapp send --file`. NO live bridge and NO network: the transport is injected, and the
// bridge messages.db is a fixture handle. Nothing here can send a real message.

const TO = "278613687873@s.whatsapp.net";
const TOKEN = "test-bridge-token-abc123";

const dir = mkdtempSync(join(tmpdir(), "ob-wa-file-"));
function fixtureFile(name: string, bytes = "x".repeat(2048)): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

async function withToken(db: Store): Promise<void> {
  const path = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(path, `${TOKEN}\n`, "utf8");
  await setConfig(db, "whatsapp_bridge_token_path", path);
  await setConfig(db, "whatsapp_db_path", join(tmpdir(), `ob-no-such-bridge-${randomUUID()}`, "messages.db"));
}

function fixtureBridge(
  rows: Array<{ id: string; content: string; media_type: string | null; filename: string | null; ts: string }>,
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
  b.query("INSERT INTO chats(jid, name) VALUES(?, ?)").run(TO, "Acme Insurance");
  for (const r of rows) {
    b.query(
      "INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename) VALUES(?,?,?,?,?,1,?,?)",
    ).run(r.id, TO, "27000000011", r.content, r.ts, r.media_type, r.filename);
  }
  return b;
}

function bridgeTs(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMin = -at.getTimezoneOffset();
  const abs = Math.abs(offMin);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${offMin < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function transport(calls: Array<{ url: string; body: Record<string, unknown> }>, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ success: true, message: "sent" }), { status });
  }) as unknown as typeof fetch;
}

describe("describeAttachment (ob 1683)", () => {
  test("a PDF is a document with its filename, size and mime", () => {
    const p = fixtureFile("Claim Form.pdf", "%PDF-1.4 hello");
    expect(describeAttachment(p)).toEqual({
      path: p,
      name: "Claim Form.pdf",
      size: 14,
      mime: "application/pdf",
      kind: "document",
    });
  });

  test("jpg, jpeg and png are images (extension case-insensitive)", () => {
    expect(describeAttachment(fixtureFile("a.JPG")).kind).toBe("image");
    expect(describeAttachment(fixtureFile("a.jpeg")).mime).toBe("image/jpeg");
    expect(describeAttachment(fixtureFile("a.png")).mime).toBe("image/png");
  });

  test("anything else is refused, so a typo'd path cannot ship a key or a database", () => {
    expect(() => describeAttachment(fixtureFile("id_ed25519"))).toThrow(/only .*\.pdf/);
    expect(() => describeAttachment(fixtureFile("notes.txt"))).toThrow(/only .*\.pdf/);
  });

  test("a missing, empty or directory path is refused with a clean error", () => {
    expect(() => describeAttachment(join(dir, "nope.pdf"))).toThrow(/cannot read --file/);
    expect(() => describeAttachment(fixtureFile("empty.pdf", ""))).toThrow(/empty/);
    mkdirSync(join(dir, "folder.pdf"));
    expect(() => describeAttachment(join(dir, "folder.pdf"))).toThrow(/not a regular file/);
  });
});

describe("sendGateLines (ob 1683)", () => {
  test("shows the recipient, the caption AND each file's name/size/mime", () => {
    const a = describeAttachment(fixtureFile("claim.pdf", "x".repeat(10)));
    const b = describeAttachment(fixtureFile("photo.png", "y".repeat(20)));
    const text = sendGateLines(TO, "Morgan's claim", [a, b]).join("\n");
    expect(text).toContain(TO);
    expect(text).toContain("caption: Morgan's claim");
    expect(text).toContain("claim.pdf  10 bytes  application/pdf  (sent as document)");
    expect(text).toContain("photo.png  20 bytes  image/png  (sent as image)");
    expect(text).toContain("caption goes on the first file only");
  });

  test("a text-only send still reads body: ... as before", () => {
    expect(sendGateLines(TO, "hi", []).join("\n")).toContain("body: hi");
  });
});

describe("sendWhatsapp --file (ob 1683)", () => {
  test("GATE: a file is refused without confirm === true, and nothing is POSTed", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf"));
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    for (const confirm of [false, undefined, 1, "true"] as unknown[]) {
      await expect(
        sendWhatsapp(db, { to: TO, body: "", file, confirm: confirm as boolean, fetch: transport(calls) }),
      ).rejects.toThrow(/no explicit confirmation/);
    }
    expect(calls).toHaveLength(0);
    handle.close();
  });

  test("POSTs media_path (absolute) with the caption as message", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf"));
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await sendWhatsapp(db, { to: TO, body: "Claim for Morgan", file, confirm: true, fetch: transport(calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/api/send");
    expect(calls[0]!.body).toEqual({ recipient: TO, message: "Claim for Morgan", media_path: file.path });
    expect(file.path.startsWith("/")).toBe(true);
    handle.close();
  });

  test("a file needs no caption, but text with no body and no file is still refused", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const file = describeAttachment(fixtureFile("photo.jpg"));
    await sendWhatsapp(db, { to: TO, body: "", file, confirm: true, fetch: transport(calls) });
    expect(calls[0]!.body.message).toBe("");
    await expect(sendWhatsapp(db, { to: TO, body: "", confirm: true, fetch: transport(calls) })).rejects.toThrow(
      /requires a message body/,
    );
    handle.close();
  });

  test("a text send is unchanged: no media_path key at all", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: transport(calls) });
    expect(calls[0]!.body).toEqual({ recipient: TO, message: "hi" });
    handle.close();
  });

  test("mirrors the sent document into the store with media_type set, under the bridge's id", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf"));
    const bridge = fixtureBridge([
      { id: "DOC_1", content: "Claim for Morgan", media_type: "document", filename: "claim.pdf", ts: bridgeTs(new Date()) },
    ]);
    const res = await sendWhatsapp(db, {
      to: TO,
      body: "Claim for Morgan",
      file,
      confirm: true,
      fetch: transport([]),
      bridge,
    });
    expect(res.id).toBe("DOC_1");
    const rows = handle
      .query("SELECT id, content, media_type, is_from_me FROM whatsapp_message WHERE chat_jid = ?")
      .all(TO) as Array<{ id: string; content: string; media_type: string | null; is_from_me: number }>;
    expect(rows).toEqual([{ id: "DOC_1", content: "Claim for Morgan", media_type: "document", is_from_me: 1 }]);
    bridge.close();
    handle.close();
  });

  test("an uncaptioned image matches on media_type, not on the empty content of a text row", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("photo.png"));
    const now = bridgeTs(new Date());
    const bridge = fixtureBridge([
      { id: "TXT_EMPTY", content: "", media_type: null, filename: null, ts: now },
      { id: "IMG_1", content: "", media_type: "image", filename: "image_1.png", ts: now },
    ]);
    const res = await sendWhatsapp(db, { to: TO, body: "", file, confirm: true, fetch: transport([]), bridge });
    expect(res.id).toBe("IMG_1");
    const row = handle.query("SELECT media_type FROM whatsapp_message WHERE id = 'IMG_1'").get() as {
      media_type: string;
    };
    expect(row.media_type).toBe("image");
    bridge.close();
    handle.close();
  });

  test("no matching bridge row stores nothing and does not throw (the sync backfills it)", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf"));
    const res = await sendWhatsapp(db, { to: TO, body: "x", file, confirm: true, fetch: transport([]), bridge: fixtureBridge([]) });
    expect(res.id).toBeNull();
    handle.close();
  });

  test("the audit event records the file's name, size, mime and kind", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf", "x".repeat(300)));
    await sendWhatsapp(db, { to: TO, body: "cap", file, confirm: true, fetch: transport([]) });
    const evs = await eventsBetweenFor(db, { source: "whatsapp", type: "sent" });
    expect(evs).toHaveLength(1);
    expect(parsePayload<{ media: unknown }>(evs[0]!).media).toEqual({ name: "claim.pdf", size: 300, mime: "application/pdf", type: "document" });
    handle.close();
  });

  test("a failed file send throws and records no event", async () => {
    const handle = freshDb();
    const db = sqliteStoreFor(handle);
    await withToken(db);
    const file = describeAttachment(fixtureFile("claim.pdf"));
    await expect(
      sendWhatsapp(db, { to: TO, body: "", file, confirm: true, fetch: transport([], 500) }),
    ).rejects.toThrow(/send failed \(500\)/);
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "sent" })).toHaveLength(0);
    handle.close();
  });
});
