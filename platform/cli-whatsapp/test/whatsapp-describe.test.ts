import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";

const PG_BUDGET = spawnBudget(2);
import {
  describeWhatsappImage,
  storeMediaDesc,
  defaultVisionEngine,
  type VisionEngine,
} from "../src/whatsapp/describe.ts";

// Ticket 198b — WhatsApp image vision-description + cache. NO live bridge, network, or vision
// subprocess (mlx_vlm.generate / claude -p): the bridge download is a mock fetch, the bridge-saved
// file is a real temp file, and the vision engine is injected. Asserts describe stores its result,
// reuses the cache, and degrades gracefully. (Engine-level plumbing — argv, banner, timeouts,
// selection — is covered in whatsapp-vision-engine.test.ts.)

const TOKEN = "super-secret-bridge-token-XYZ";
const CHAT = "27000000003@s.whatsapp.net";

async function setup(): Promise<{ lease: PgStoreLease; db: Store; cacheDir: string }> {
  const lease = await freshPgStore();
  const tokenPath = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(tokenPath, TOKEN + "\n");
  await setConfig(lease.store, "whatsapp_bridge_token_path", tokenPath);
  await setConfig(lease.store, "whatsapp_bridge_url", "http://127.0.0.1:8080");
  const cacheDir = mkdtempSync(join(tmpdir(), "ob-wa-media-"));
  return { lease, db: lease.store, cacheDir };
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

function bridgeSavedFile(bytes: Uint8Array, ext: string): string {
  const p = join(tmpdir(), `ob-bridge-saved-${randomUUID()}${ext}`);
  writeFileSync(p, bytes);
  return p;
}

function mockBridge(savedPath: string, filename: string) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true, message: "ok", filename, path: savedPath }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("whatsapp image description (198b)", () => {
  const okEngine: VisionEngine = {
    available: () => ({ ok: true }),
    describe: async () => ({ ok: true, text: "a photo of a leaking sink" }),
  };

  test("describes an image, stores media_desc, and a re-run returns the stored desc (no re-run)", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img1", "image");
    const saved = bridgeSavedFile(new TextEncoder().encode("JPEG"), ".jpg");
    const { fetchFn, calls } = mockBridge(saved, "image_x.jpg");

    let describeCalls = 0;
    const countingEngine: VisionEngine = {
      available: () => ({ ok: true }),
      describe: async () => {
        describeCalls++;
        return { ok: true, text: "a photo of a leaking sink" };
      },
    };

    const first = await describeWhatsappImage(db, { chatJid: CHAT, id: "img1", engine: countingEngine, fetch: fetchFn, cacheDir });
    expect(first).toEqual({ ok: true, text: "a photo of a leaking sink" });
    expect(describeCalls).toBe(1);
    const stored = (
      (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='img1'")) as {
        media_desc: string;
      }[]
    )[0]!;
    expect(stored.media_desc).toBe("a photo of a leaking sink");

    // re-run: returns the stored description WITHOUT downloading or re-running the engine
    const again = await describeWhatsappImage(db, { chatJid: CHAT, id: "img1", engine: countingEngine, fetch: fetchFn, cacheDir });
    expect(again).toEqual({ ok: true, text: "a photo of a leaking sink" });
    expect(describeCalls).toBe(1);
    expect(calls).toHaveLength(1); // media downloaded once
    await lease.release();
  }, PG_BUDGET);

  test("engine unavailable → graceful { ok:false }, no throw, nothing stored, no download", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img2", "image");
    const { fetchFn, calls } = mockBridge("/nope", "x");
    const downEngine: VisionEngine = {
      available: () => ({ ok: false, reason: "image description unavailable — claude CLI not found on PATH" }),
      describe: async () => ({ ok: false, reason: "should not be called" }),
    };
    const res = await describeWhatsappImage(db, { chatJid: CHAT, id: "img2", engine: downEngine, fetch: fetchFn, cacheDir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unavailable/);
    expect(calls).toHaveLength(0); // never downloaded
    const stored = (
      (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='img2'")) as {
        media_desc: string | null;
      }[]
    )[0]!;
    expect(stored.media_desc).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("a non-image message cannot be described", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "aud1", "audio");
    await expect(
      describeWhatsappImage(db, { chatJid: CHAT, id: "aud1", engine: okEngine, cacheDir }),
    ).rejects.toThrow(/not an image/);
    await lease.release();
  }, PG_BUDGET);

  test("an empty description from the engine is not stored (graceful ok:false)", async () => {
    const { lease, db, cacheDir } = await setup();
    await insertMsg(db, "img3", "image");
    const saved = bridgeSavedFile(new TextEncoder().encode("JPEG"), ".jpg");
    const { fetchFn } = mockBridge(saved, "image_x.jpg");
    const blankEngine: VisionEngine = {
      available: () => ({ ok: true }),
      describe: async () => ({ ok: true, text: "   " }),
    };
    const res = await describeWhatsappImage(db, { chatJid: CHAT, id: "img3", engine: blankEngine, fetch: fetchFn, cacheDir });
    expect(res.ok).toBe(false);
    const stored = (
      (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='img3'")) as {
        media_desc: string | null;
      }[]
    )[0]!;
    expect(stored.media_desc).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("storeMediaDesc persists on the row (idempotent)", async () => {
    const { lease, db } = await setup();
    await insertMsg(db, "img4", "image");
    await storeMediaDesc(db, CHAT, "img4", "a sunset");
    expect(
      (
        (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='img4'")) as {
          media_desc: string;
        }[]
      )[0]!.media_desc,
    ).toBe("a sunset");
    await storeMediaDesc(db, CHAT, "img4", "a clearer sunset");
    expect(
      (
        (await lease.sql.unsafe("SELECT media_desc FROM whatsapp_message WHERE id='img4'")) as {
          media_desc: string;
        }[]
      )[0]!.media_desc,
    ).toBe("a clearer sunset");
    await lease.release();
  }, PG_BUDGET);

  test("defaultVisionEngine reports unavailable rather than throwing when the mlx-vlm binary is absent", async () => {
    const { lease, db } = await setup();
    // Force the default-engine pre-flight DOWN deterministically regardless of what this machine has on
    // PATH: an absolute path that cannot exist. available() must return ok:false, never throw.
    await setConfig(db, "vision_bin_path", "/definitely/not/installed/mlx_vlm.generate");
    const engine = await defaultVisionEngine(db);
    const avail = engine.available();
    expect(avail.ok).toBe(false);
    if (!avail.ok) expect(avail.reason).toMatch(/mlx-vlm not found/);
    await lease.release();
  });
});
