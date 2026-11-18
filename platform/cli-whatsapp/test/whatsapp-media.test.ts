import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import {
  fetchWhatsappMedia,
  extForMediaType,
  contentTypeForExt,
  isImageMedia,
  isAudioMedia,
  mediaCachePath,
} from "../src/whatsapp/media.ts";
import {
  transcribeWhatsappMessage,
  defaultSttEngine,
  resolveWhisperEngineKind,
  type SttEngine,
} from "../src/whatsapp/transcribe.ts";
import { handleWhatsappRequest } from "../../../apps/cli/src/realtime.ts";
import type { Database } from "bun:sqlite";

// Ticket 158 + 162 — WhatsApp media proxy + voice-note transcription. NO live bridge, network, or
// whisper: the bridge download is a mock fetch, the bridge-saved file is a real temp file, and the STT
// engine is injected. Asserts the proxy never leaks the bearer token, resolves content-type, caches, and
// that transcription stores its result + degrades gracefully when the engine is absent.

const TOKEN = "super-secret-bridge-token-XYZ";
const CHAT = "27000000003@s.whatsapp.net";

/** A DB with a bridge token file configured, plus a fresh temp media cache dir. */
async function setup(): Promise<{ lease: PgStoreLease; db: Store; tokenPath: string; cacheDir: string }> {
  const lease = await freshPgStore();
  const tokenPath = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(tokenPath, TOKEN + "\n");
  await setConfig(lease.store, "whatsapp_bridge_token_path", tokenPath);
  await setConfig(lease.store, "whatsapp_bridge_url", "http://127.0.0.1:8080");
  const cacheDir = mkdtempSync(join(tmpdir(), "ob-wa-media-"));
  return { lease, db: lease.store, tokenPath, cacheDir };
}

async function insertMsg(db: Store, id: string, mediaType: string | null): Promise<void> {
  await db.q.insert(db.t.whatsappMessage).values({
    id,
    chat_jid: CHAT,
    content: null,
    ts: "2026-07-18T00:00:00.000Z",
    media_type: mediaType,
    created_at: "2026-07-18T00:00:00.000Z",
  });
}

/** A real temp file standing in for the file the bridge saved after decrypting the media. */
function bridgeSavedFile(bytes: Uint8Array, ext: string): string {
  const p = join(tmpdir(), `ob-bridge-saved-${randomUUID()}${ext}`);
  writeFileSync(p, bytes);
  return p;
}

/** A mock bridge fetch that records every call (URL + headers + body) and returns a download response. */
function mockBridge(savedPath: string, filename: string) {
  const calls: Array<{ url: string; auth: string | null; body: string }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    calls.push({ url: u, auth: headers.get("authorization"), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ success: true, message: "ok", filename, path: savedPath }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("whatsapp media — pure helpers", () => {
  test("extForMediaType + contentTypeForExt map image/audio/sticker correctly", () => {
    expect(extForMediaType("image")).toBe(".jpg");
    expect(extForMediaType("audio")).toBe(".ogg");
    expect(extForMediaType("sticker")).toBe(".webp");
    expect(extForMediaType("video")).toBe(".mp4");
    expect(extForMediaType(null)).toBe("");
    expect(contentTypeForExt(".jpg")).toBe("image/jpeg");
    expect(contentTypeForExt(".png")).toBe("image/png");
    expect(contentTypeForExt(".webp")).toBe("image/webp");
    expect(contentTypeForExt(".ogg")).toBe("audio/ogg");
    expect(contentTypeForExt(".bin")).toBe("application/octet-stream");
    expect(isImageMedia("image")).toBe(true);
    expect(isImageMedia("sticker")).toBe(true);
    expect(isImageMedia("audio")).toBe(false);
    expect(isAudioMedia("audio")).toBe(true);
    expect(isAudioMedia("image")).toBe(false);
    expect(contentTypeForExt(".mp4")).toBe("video/mp4");
  });
});

describe("whatsapp media proxy (158/162)", () => {
  test("resolves image vs audio content-type; sends the bearer ONLY to the bridge, never to the caller", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img1", "image");
    const bytes = new TextEncoder().encode("JPEGDATA-abcdef");
    const saved = bridgeSavedFile(bytes, ".jpg");
    const { fetchFn, calls } = mockBridge(saved, "image_x.jpg");

    const media = await fetchWhatsappMedia(db, { chatJid: CHAT, id: "img1", fetch: fetchFn, cacheDir });
    expect(media.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(media.bytes)).toBe("JPEGDATA-abcdef");

    // the bridge saw the token; the returned result carries NO token anywhere
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/api/download");
    expect(JSON.parse(calls[0]!.body)).toEqual({ message_id: "img1", chat_jid: CHAT });
    expect(JSON.stringify(media)).not.toContain(TOKEN);

    // audio resolves to audio/ogg
    await insertMsg(db, "aud1", "audio");
    const audSaved = bridgeSavedFile(new TextEncoder().encode("OGGDATA"), ".ogg");
    const audMock = mockBridge(audSaved, "audio_x.ogg");
    const audio = await fetchWhatsappMedia(db, { chatJid: CHAT, id: "aud1", fetch: audMock.fetchFn, cacheDir });
    expect(audio.contentType).toBe("audio/ogg");
    await lease.release();
  }, PG_BUDGET);

  test("caches to disk keyed by (chat_jid,id) — a second fetch does NOT call the bridge", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img2", "image");
    const saved = bridgeSavedFile(new TextEncoder().encode("CACHED"), ".jpg");
    const { fetchFn, calls } = mockBridge(saved, "image_x.jpg");

    const first = await fetchWhatsappMedia(db, { chatJid: CHAT, id: "img2", fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(1);
    expect(existsSync(mediaCachePath(cacheDir, CHAT, "img2", "image"))).toBe(true);

    const second = await fetchWhatsappMedia(db, { chatJid: CHAT, id: "img2", fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(1); // still one — served from cache
    expect(new TextDecoder().decode(second.bytes)).toBe("CACHED");
    expect(second.bytes).toEqual(first.bytes);
    await lease.release();
  }, PG_BUDGET);

  test("unknown message / non-media row → clean throw (no bridge call)", async () => {
    const { lease, db, cacheDir } = await setup();
    const { fetchFn, calls } = mockBridge("/nope", "x");
    await expect(fetchWhatsappMedia(db, { chatJid: CHAT, id: "ghost", fetch: fetchFn, cacheDir })).rejects.toThrow(
      /no WhatsApp message/,
    );
    await insertMsg(db, "txt1", null); // a text message — has no media
    await expect(fetchWhatsappMedia(db, { chatJid: CHAT, id: "txt1", fetch: fetchFn, cacheDir })).rejects.toThrow(
      /no media/,
    );
    expect(calls).toHaveLength(0);
    await lease.release();
  }, PG_BUDGET);

  test("a bridge failure surfaces as a clean error", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img3", "image");
    const failFetch = (async () =>
      new Response(JSON.stringify({ success: false, message: "not connected" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(fetchWhatsappMedia(db, { chatJid: CHAT, id: "img3", fetch: failFetch, cacheDir })).rejects.toThrow(
      /bridge download failed/,
    );
    await lease.release();
  });

  test("persist:false returns bytes but does not write the ob cache (629 non-favourite Status)", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img-ephemeral", "image");
    const saved = bridgeSavedFile(new TextEncoder().encode("EPHEMERAL"), ".jpg");
    const { fetchFn, calls } = mockBridge(saved, "image_x.jpg");

    const media = await fetchWhatsappMedia(db, {
      chatJid: CHAT,
      id: "img-ephemeral",
      fetch: fetchFn,
      cacheDir,
      persist: false,
    });
    expect(new TextDecoder().decode(media.bytes)).toBe("EPHEMERAL");
    expect(existsSync(mediaCachePath(cacheDir, CHAT, "img-ephemeral", "image"))).toBe(false);
    expect(calls).toHaveLength(1);
    await lease.release();
  }, PG_BUDGET);
});

describe("whatsapp media HTTP endpoint (handleWhatsappRequest)", () => {
  test("GET /api/whatsapp/media streams bytes with content-type + CORS; body carries no token", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img4", "image");
    const saved = bridgeSavedFile(new TextEncoder().encode("PNGISH"), ".jpg");
    // pre-warm the cache so the endpoint (which can't inject fetch) serves from disk without a bridge call
    await fetchWhatsappMedia(db, { chatJid: CHAT, id: "img4", fetch: mockBridge(saved, "image_x.jpg").fetchFn, cacheDir });
    // point the media cache dir config at our tmp dir so the endpoint finds the cache hit
    await setConfig(db, "whatsapp_media_cache_dir", cacheDir);

    const res = await handleWhatsappRequest(
      new Request(`http://localhost:5051/api/whatsapp/media?chat_jid=${encodeURIComponent(CHAT)}&id=img4`, {
        method: "GET",
      }),
      { store: db },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const bodyText = await res!.text();
    expect(bodyText).toBe("PNGISH");
    expect(bodyText).not.toContain(TOKEN);
    await lease.release();
  }, PG_BUDGET);

  test("GET without chat_jid/id → 400", async () => {
    const { lease, db } = await setup();
    const res = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/media?chat_jid=x", { method: "GET" }),
      { store: db },
    );
    expect(res!.status).toBe(400);
    await lease.release();
  }, PG_BUDGET);

  test("OPTIONS preflight → 204 with CORS; a non-whatsapp path → null (falls through)", async () => {
    const { lease, db } = await setup();
    const opt = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/media", { method: "OPTIONS" }),
      { store: db },
    );
    expect(opt!.status).toBe(204);
    expect(opt!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const other = await handleWhatsappRequest(new Request("http://localhost:5051/other", { method: "GET" }), {
      store: db,
    });
    expect(other).toBeNull();
    await lease.release();
  });
});

describe("whatsapp thread HTTP endpoint (168)", () => {
  /** A store with the contacts DB pointed at a nonexistent path so name resolution is deterministic. */
  async function threadDb(): Promise<PgStoreLease> {
    const lease = await freshPgStore();
    await setConfig(lease.store, "whatsapp_contacts_db_path", "/nonexistent/does/not/exist/whatsapp.db");
    return lease;
  }
  async function insertThreadMsg(db: Store, id: string, ts: string): Promise<void> {
    await db.q.insert(db.t.whatsappMessage).values({
      id,
      chat_jid: CHAT,
      chat_name: "Chatty",
      sender_jid: CHAT,
      content: `msg ${id}`,
      ts,
      is_from_me: 0,
      created_at: ts,
    });
  }
  async function getThread(db: Store, qs: string) {
    return handleWhatsappRequest(
      new Request(`http://localhost:5051/api/whatsapp/thread?${qs}`, { method: "GET" }),
      { store: db },
    );
  }

  test("GET returns items oldest→newest, capped server-side at 15 even when 50 requested", async () => {
    const lease = await threadDb();
    const db = lease.store;
    for (let i = 0; i < 20; i++) {
      await insertThreadMsg(db, `t${String(i).padStart(2, "0")}`, `2026-07-18T09:${String(i).padStart(2, "0")}:00.000Z`);
    }
    const res = await getThread(db, `chat_jid=${encodeURIComponent(CHAT)}&limit=50`);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res!.json()) as { items: Array<{ id: string; sender: string; chat_jid: string }> };
    expect(body.items).toHaveLength(15); // hard cap
    expect(body.items[0]!.id).toBe("t05"); // newest-15 window (t05..t19), oldest first
    expect(body.items[14]!.id).toBe("t19");
    expect(body.items[0]!.sender).toBe("Chatty"); // resolved from chat_name (no person/contact)
    await lease.release();
  }, PG_BUDGET);

  test("GET with limit omitted defaults to the last 5", async () => {
    const lease = await threadDb();
    const db = lease.store;
    for (let i = 0; i < 8; i++) await insertThreadMsg(db, `t${i}`, `2026-07-18T09:0${i}:00.000Z`);
    const res = await getThread(db, `chat_jid=${encodeURIComponent(CHAT)}`);
    const body = (await res!.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
    await lease.release();
  }, PG_BUDGET);

  test("GET reports hasMore and pages upward via the `before` cursor (193)", async () => {
    const lease = await threadDb();
    const db = lease.store;
    for (let i = 0; i < 8; i++) await insertThreadMsg(db, `t${i}`, `2026-07-18T09:0${i}:00.000Z`);

    // First page: newest 5 (t3..t7), older messages remain.
    const first = await getThread(db, `chat_jid=${encodeURIComponent(CHAT)}&limit=5`);
    const firstBody = (await first!.json()) as { items: Array<{ id: string; ts: string }>; hasMore: boolean };
    expect(firstBody.items.map((i) => i.id)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
    expect(firstBody.hasMore).toBe(true);

    // Next page: the 3 older than the oldest loaded (t3) → t0..t2, history exhausted.
    const before = encodeURIComponent(firstBody.items[0]!.ts);
    const next = await getThread(db, `chat_jid=${encodeURIComponent(CHAT)}&limit=5&before=${before}`);
    const nextBody = (await next!.json()) as { items: Array<{ id: string }>; hasMore: boolean };
    expect(nextBody.items.map((i) => i.id)).toEqual(["t0", "t1", "t2"]);
    expect(nextBody.hasMore).toBe(false);
    await lease.release();
  }, PG_BUDGET);

  test("GET without chat_jid → 400; an unknown chat → 200 with empty items", async () => {
    const lease = await threadDb();
    const db = lease.store;
    const bad = await getThread(db, "limit=5");
    expect(bad!.status).toBe(400);

    const empty = await getThread(db, "chat_jid=27000000002%40s.whatsapp.net");
    expect(empty!.status).toBe(200);
    expect(((await empty!.json()) as { items: unknown[] }).items).toEqual([]);
    await lease.release();
  });
});

describe("whatsapp voice-note transcription (158)", () => {
  const okEngine: SttEngine = {
    available: () => ({ ok: true }),
    transcribe: async () => ({ ok: true, text: "lunch at the harbour" }),
  };

  test("transcribes an audio message, stores it, and a re-run returns the stored transcript (no re-run)", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "va1", "audio");
    const saved = bridgeSavedFile(new TextEncoder().encode("OGG"), ".ogg");
    const { fetchFn, calls } = mockBridge(saved, "audio_x.ogg");

    let transcribeCalls = 0;
    const countingEngine: SttEngine = {
      available: () => ({ ok: true }),
      transcribe: async () => {
        transcribeCalls++;
        return { ok: true, text: "lunch at the harbour" };
      },
    };

    const first = await transcribeWhatsappMessage(db, { chatJid: CHAT, id: "va1", engine: countingEngine, fetch: fetchFn, cacheDir });
    expect(first).toEqual({ ok: true, text: "lunch at the harbour" });
    expect(transcribeCalls).toBe(1);
    // stored on the row
    const stored = (
      (await lease.sql.unsafe("SELECT transcript FROM whatsapp_message WHERE id='va1'")) as {
        transcript: string;
      }[]
    )[0]!;
    expect(stored.transcript).toBe("lunch at the harbour");

    // re-run: returns the stored transcript WITHOUT downloading or re-running the engine
    const again = await transcribeWhatsappMessage(db, { chatJid: CHAT, id: "va1", engine: countingEngine, fetch: fetchFn, cacheDir });
    expect(again).toEqual({ ok: true, text: "lunch at the harbour" });
    expect(transcribeCalls).toBe(1);
    expect(calls).toHaveLength(1); // media downloaded once
    await lease.release();
  }, PG_BUDGET);

  test("engine unavailable → graceful { ok:false, reason }, no throw, nothing stored, no download", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "va2", "audio");
    const { fetchFn, calls } = mockBridge("/nope", "x");
    const downEngine: SttEngine = {
      available: () => ({ ok: false, reason: "transcription unavailable — whisper not found" }),
      transcribe: async () => ({ ok: false, reason: "should not be called" }),
    };
    const res = await transcribeWhatsappMessage(db, { chatJid: CHAT, id: "va2", engine: downEngine, fetch: fetchFn, cacheDir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unavailable/);
    expect(calls).toHaveLength(0); // never downloaded
    const stored = (
      (await lease.sql.unsafe("SELECT transcript FROM whatsapp_message WHERE id='va2'")) as {
        transcript: string | null;
      }[]
    )[0]!;
    expect(stored.transcript).toBeNull(); // nothing persisted
    await lease.release();
  }, PG_BUDGET);

  test("a non-audio message cannot be transcribed", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img5", "image");
    await expect(
      transcribeWhatsappMessage(db, { chatJid: CHAT, id: "img5", engine: okEngine, cacheDir }),
    ).rejects.toThrow(/not a voice note/);
    await lease.release();
  }, PG_BUDGET);

  test("defaultSttEngine reports unavailable (no whisper/ffmpeg) rather than throwing", async () => {
    // The whisper/ffmpeg resolution reads its config synchronously and is not ported, so this one keeps a
    // raw handle: it is about which binary the engine picks, not about which engine stores the row.
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "whisper_bin_path", "/nonexistent/whisper-xyz");
    await setConfig(db, "ffmpeg_bin_path", "/nonexistent/ffmpeg-xyz");
    const engine = await defaultSttEngine(db);
    const avail = engine.available();
    expect(avail.ok).toBe(false);
    if (!avail.ok) expect(avail.reason).toMatch(/whisper not found/);
    await lease.release();
  }, PG_BUDGET);

  test("POST /api/whatsapp/transcribe degrades gracefully when no local engine is installed", async () => {
    const { lease, db } = await setup();
    await insertMsg(db, "va3", "audio");
    await setConfig(db, "whisper_bin_path", "/nonexistent/whisper-xyz");
    const res = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_jid: CHAT, id: "va3" }),
      }),
      { store: db },
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/unavailable/);
    await lease.release();
  });
});

describe("whatsapp voice-note transcription — whisper.cpp engine (201)", () => {
  /** Set a config key on the store (setConfig upserts, so tests can override). */
  const cfg = (db: Store, key: string, value: string): Promise<unknown> => setConfig(db, key, value);

  /** A real temp file standing in for an installed binary/model (resolveBin only existsSync-checks paths). */
  function stubFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ob-whisper-stub-"));
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\n");
    return p;
  }

  /** A fake subprocess with a chosen exit code + stderr, matching the shape transcribe.ts consumes. */
  function fakeProc(code: number, stderr = ""): unknown {
    return {
      exited: Promise.resolve(code),
      stdout: new Response("").body,
      stderr: new Response(stderr).body,
    };
  }

  describe("engine auto-detection (resolveWhisperEngineKind)", () => {
    test("whisper_bin_path basename 'whisper-cli' → whisper.cpp", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_bin_path", "/opt/homebrew/bin/whisper-cli");
      expect(await resolveWhisperEngineKind(db)).toBe("whisper.cpp");
      await lease.release();
    }, PG_BUDGET);

    test("whisper_bin_path basename 'main' → whisper.cpp", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_bin_path", "/usr/local/bin/main");
      expect(await resolveWhisperEngineKind(db)).toBe("whisper.cpp");
      await lease.release();
    }, PG_BUDGET);

    test("whisper_bin_path basename 'whisper' → openai-whisper", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_bin_path", "/usr/local/bin/whisper");
      expect(await resolveWhisperEngineKind(db)).toBe("openai-whisper");
      await lease.release();
    }, PG_BUDGET);

    test("unset whisper_bin_path → defaults to whisper.cpp (the installed flavour)", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      expect(await resolveWhisperEngineKind(db)).toBe("whisper.cpp");
      await lease.release();
    }, PG_BUDGET);

    test("explicit whisper_engine config overrides the basename", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_bin_path", "/opt/homebrew/bin/whisper-cli"); // basename says whisper.cpp
      await cfg(db, "whisper_engine", "openai-whisper"); // …but config wins
      expect(await resolveWhisperEngineKind(db)).toBe("openai-whisper");
      await cfg(db, "whisper_engine", "whisper.cpp");
      expect(await resolveWhisperEngineKind(db)).toBe("whisper.cpp");
      await lease.release();
    });
  });

  describe("whisper.cpp available()", () => {
    test("ok when whisper-cli, ffmpeg AND the model .bin all resolve", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_engine", "whisper.cpp");
      await cfg(db, "whisper_bin_path", stubFile("whisper-cli"));
      await cfg(db, "ffmpeg_bin_path", stubFile("ffmpeg"));
      await cfg(db, "whisper_model", stubFile("ggml-base.bin"));
      expect((await defaultSttEngine(db)).available()).toEqual({ ok: true });
      await lease.release();
    }, PG_BUDGET);

    test("ok:false naming the model path when the model .bin is missing", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_engine", "whisper.cpp");
      await cfg(db, "whisper_bin_path", stubFile("whisper-cli"));
      await cfg(db, "ffmpeg_bin_path", stubFile("ffmpeg"));
      await cfg(db, "whisper_model", "/nonexistent/ggml-base.bin");
      const avail = (await defaultSttEngine(db)).available();
      expect(avail.ok).toBe(false);
      if (!avail.ok) expect(avail.reason).toMatch(/model not found at \/nonexistent\/ggml-base\.bin/);
      await lease.release();
    }, PG_BUDGET);

    test("ok:false when ffmpeg is missing", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_engine", "whisper.cpp");
      await cfg(db, "whisper_bin_path", stubFile("whisper-cli"));
      await cfg(db, "ffmpeg_bin_path", "/nonexistent/ffmpeg");
      await cfg(db, "whisper_model", stubFile("ggml-base.bin"));
      const avail = (await defaultSttEngine(db)).available();
      expect(avail.ok).toBe(false);
      if (!avail.ok) expect(avail.reason).toMatch(/ffmpeg not found/);
      await lease.release();
    }, PG_BUDGET);

    test("ok:false when whisper-cli is missing", async () => {
      const lease = await freshPgStore();
      const db = lease.store;
      await cfg(db, "whisper_engine", "whisper.cpp");
      await cfg(db, "whisper_bin_path", "/nonexistent/whisper-cli");
      await cfg(db, "ffmpeg_bin_path", stubFile("ffmpeg"));
      await cfg(db, "whisper_model", stubFile("ggml-base.bin"));
      const avail = (await defaultSttEngine(db)).available();
      expect(avail.ok).toBe(false);
      if (!avail.ok) expect(avail.reason).toMatch(/whisper not found/);
      await lease.release();
    });
  });

  describe("whisper.cpp transcribe() (mocked spawn — no real ffmpeg/whisper)", () => {
    async function cppDb(): Promise<{
      lease: PgStoreLease;
      db: Store;
      ffmpegPath: string;
      whisperPath: string;
    }> {
      const lease = await freshPgStore();
      const db = lease.store;
      const ffmpegPath = stubFile("ffmpeg");
      const whisperPath = stubFile("whisper-cli");
      await cfg(db, "whisper_engine", "whisper.cpp");
      await cfg(db, "whisper_bin_path", whisperPath);
      await cfg(db, "ffmpeg_bin_path", ffmpegPath);
      await cfg(db, "whisper_model", stubFile("ggml-base.bin"));
      return { lease, db, ffmpegPath, whisperPath };
    }

    test("ffmpeg-decode then whisper-cli → returns the trimmed transcript", async () => {
      const { lease, db, ffmpegPath } = await cppDb();
      const spy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
        const argv = cmd;
        if (argv[0] === ffmpegPath) {
          // ffmpeg pre-decode → success (whisper.cpp reads the wav next)
          return fakeProc(0) as any;
        }
        // whisper-cli: writes "<stem>.txt" (the arg after -of), with -otxt
        expect(argv).toContain("-otxt");
        expect(argv).toContain("-np");
        const ofIdx = argv.indexOf("-of");
        writeFileSync(`${argv[ofIdx + 1]}.txt`, "  lunch at the harbour  \n");
        return fakeProc(0) as any;
      });
      try {
        const res = await (await defaultSttEngine(db)).transcribe("/tmp/voice.ogg");
        expect(res).toEqual({ ok: true, text: "lunch at the harbour" });
        // ffmpeg then whisper-cli — two spawns
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
        await lease.release();
      }
    }, PG_BUDGET);

    test("non-zero ffmpeg exit → ok:false (no throw), whisper never runs", async () => {
      const { lease, db, ffmpegPath } = await cppDb();
      let whisperRuns = 0;
      const spy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
        if (cmd[0] === ffmpegPath) return fakeProc(1, "ffmpeg: bad input") as any;
        whisperRuns++;
        return fakeProc(0) as any;
      });
      try {
        const res = await (await defaultSttEngine(db)).transcribe("/tmp/voice.ogg");
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toMatch(/ffmpeg exited 1/);
        expect(whisperRuns).toBe(0);
      } finally {
        spy.mockRestore();
        await lease.release();
      }
    }, PG_BUDGET);

    test("non-zero whisper-cli exit → ok:false (no throw)", async () => {
      const { lease, db, ffmpegPath } = await cppDb();
      const spy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
        if (cmd[0] === ffmpegPath) return fakeProc(0) as any;
        return fakeProc(2, "whisper: model load failed") as any;
      });
      try {
        const res = await (await defaultSttEngine(db)).transcribe("/tmp/voice.ogg");
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toMatch(/whisper exited 2/);
      } finally {
        spy.mockRestore();
        await lease.release();
      }
    }, PG_BUDGET);

    test("whisper-cli succeeds but produces no .txt → ok:false", async () => {
      const { lease, db, ffmpegPath } = await cppDb();
      const spy = spyOn(Bun, "spawn").mockImplementation((cmd: any) => {
        // both exit 0, but nothing writes the output file
        void ffmpegPath;
        return fakeProc(0) as any;
      });
      try {
        const res = await (await defaultSttEngine(db)).transcribe("/tmp/voice.ogg");
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toMatch(/no output/);
      } finally {
        spy.mockRestore();
        await lease.release();
      }
    });
  });
});
