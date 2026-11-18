import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { fetchWhatsappAvatar, avatarCachePath, avatarCacheDir, AVATAR_TTL_MS } from "../src/whatsapp/avatar.ts";
import { handleWhatsappRequest } from "../../../apps/cli/src/realtime.ts";
import type { Database } from "bun:sqlite";

// Ticket 163 — WhatsApp profile-picture (avatar) proxy. NO live bridge or network: the bridge fetch is a
// mock. Asserts the proxy never leaks the bearer token, streams the bytes on 200, passes a bridge 404
// through as null (→ the client shows initials), and caches to disk keyed by jid (a second fetch is served
// from cache with no bridge call).

const TOKEN = "super-secret-bridge-token-XYZ";
const JID = "27000000003@s.whatsapp.net";
const GROUP = "27000000001-1446981737@g.us";

/** A DB with a bridge token file configured, plus a fresh temp avatar cache dir. */
async function setup(): Promise<{ lease: PgStoreLease; db: Store; cacheDir: string }> {
  const lease = await freshPgStore();
  const tokenPath = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(tokenPath, TOKEN + "\n");
  await setConfig(lease.store, "whatsapp_bridge_token_path", tokenPath);
  await setConfig(lease.store, "whatsapp_bridge_url", "http://127.0.0.1:8080");
  const cacheDir = mkdtempSync(join(tmpdir(), "ob-wa-avatars-"));
  return { lease, db: lease.store, cacheDir };
}

/** A mock bridge fetch that records each call (URL + auth header) and returns the given image response. */
function mockBridge(status: number, bytes?: Uint8Array) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (status === 200) {
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    return new Response("not found", { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("whatsapp avatar proxy (163)", () => {
  test("streams bytes; sends the bearer ONLY to the bridge, never to the caller", async () => {
    const { lease, db, cacheDir } = await setup();
    const bytes = new TextEncoder().encode("JPEG-AVATAR-BYTES");
    const { fetchFn, calls } = mockBridge(200, bytes);

    const avatar = await fetchWhatsappAvatar(db, { jid: JID, fetch: fetchFn, cacheDir });
    expect(avatar).not.toBeNull();
    expect(avatar!.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(avatar!.bytes)).toBe("JPEG-AVATAR-BYTES");

    // the bridge saw the token; the returned result carries NO token anywhere
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8080/api/avatar?jid=${encodeURIComponent(JID)}`);
    expect(JSON.stringify(avatar)).not.toContain(TOKEN);
    await lease.release();
  }, PG_BUDGET);

  test("a bridge 404 (no picture) → null (so the caller 404s → initials fallback), nothing cached", async () => {
    const { lease, db, cacheDir } = await setup();
    const { fetchFn, calls } = mockBridge(404);
    const avatar = await fetchWhatsappAvatar(db, { jid: JID, fetch: fetchFn, cacheDir });
    expect(avatar).toBeNull();
    expect(calls).toHaveLength(1);
    expect(existsSync(avatarCachePath(cacheDir, JID))).toBe(false); // negative result not cached
    await lease.release();
  }, PG_BUDGET);

  test("caches to disk keyed by jid — a second fetch does NOT call the bridge", async () => {
    const { lease, db, cacheDir } = await setup();
    const { fetchFn, calls } = mockBridge(200, new TextEncoder().encode("CACHED-PIC"));

    const first = await fetchWhatsappAvatar(db, { jid: GROUP, fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(1);
    expect(existsSync(avatarCachePath(cacheDir, GROUP))).toBe(true);

    const second = await fetchWhatsappAvatar(db, { jid: GROUP, fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(1); // still one — served from cache
    expect(new TextDecoder().decode(second!.bytes)).toBe("CACHED-PIC");
    expect(second!.bytes).toEqual(first!.bytes);
    await lease.release();
  }, PG_BUDGET);

  test("a stale cache entry (older than the TTL) is refetched from the bridge", async () => {
    const { lease, db, cacheDir } = await setup();
    const { fetchFn, calls } = mockBridge(200, new TextEncoder().encode("FRESH"));
    await fetchWhatsappAvatar(db, { jid: JID, fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(1);

    // age the cache file well past the TTL
    const old = (Date.now() - AVATAR_TTL_MS - 60_000) / 1000;
    utimesSync(avatarCachePath(cacheDir, JID), old, old);

    await fetchWhatsappAvatar(db, { jid: JID, fetch: fetchFn, cacheDir });
    expect(calls).toHaveLength(2); // stale → refetched
    await lease.release();
  }, PG_BUDGET);

  test("avatarCacheDir derives an omnislash wa-avatars dir when unset", async () => {
    const { lease, db } = await setup();
    expect(await avatarCacheDir(db)).toContain(join("omnislash", "wa-avatars"));
    await lease.release();
  });
});

describe("whatsapp avatar HTTP endpoint (handleWhatsappRequest)", () => {
  test("GET /api/whatsapp/avatar streams bytes with content-type + CORS; body carries no token", async () => {
    const { lease, db, cacheDir } = await setup();
    // pre-warm the cache so the endpoint (which can't inject fetch) serves from disk without a bridge call
    await fetchWhatsappAvatar(db, {
      jid: JID,
      fetch: mockBridge(200, new TextEncoder().encode("PIC-BYTES")).fetchFn,
      cacheDir,
    });
    await setConfig(db, "whatsapp_avatar_cache_dir", cacheDir);

    const res = await handleWhatsappRequest(
      new Request(`http://localhost:5051/api/whatsapp/avatar?jid=${encodeURIComponent(JID)}`, { method: "GET" }),
      { store: db },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const bodyText = await res!.text();
    expect(bodyText).toBe("PIC-BYTES");
    expect(bodyText).not.toContain(TOKEN);
    await lease.release();
  }, PG_BUDGET);

  test("GET whose avatar fetch fails resolves to 404 (client falls back to initials)", async () => {
    const { lease, db, cacheDir } = await setup();
    // Deterministic (no live bridge): an unreadable token path makes fetchWhatsappAvatar throw before any
    // network call; the endpoint's catch resolves it to 404 (the client then shows initials).
    await setConfig(db, "whatsapp_avatar_cache_dir", cacheDir);
    await setConfig(db, "whatsapp_bridge_token_path", "/nonexistent/does/not/exist/.bridge-token");
    const res = await handleWhatsappRequest(
      new Request(`http://localhost:5051/api/whatsapp/avatar?jid=${encodeURIComponent("nobody@s.whatsapp.net")}`, {
        method: "GET",
      }),
      { store: db },
    );
    expect(res!.status).toBe(404);
    await lease.release();
  }, PG_BUDGET);

  test("GET without jid → 400", async () => {
    const { lease, db } = await setup();
    const res = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/avatar", { method: "GET" }),
      { store: db },
    );
    expect(res!.status).toBe(400);
    await lease.release();
  }, PG_BUDGET);

  test("OPTIONS preflight → 204 with CORS", async () => {
    const { lease, db } = await setup();
    const opt = await handleWhatsappRequest(
      new Request("http://localhost:5051/api/whatsapp/avatar", { method: "OPTIONS" }),
      { store: db },
    );
    expect(opt!.status).toBe(204);
    expect(opt!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await lease.release();
  });
});
