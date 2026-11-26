// OB-1765 (OB-1760 phase 0d) -- the ob API reads the native WhatsApp screen needs: the Status tray + history
// page and the chat list. Read-only: no send is reachable. Real Postgres via the 325 harness, no network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { OB_API_PREFIX, OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { setChatHidden } from "../../cli-whatsapp/src/whatsapp/prefs.ts";
import { STATUS_JID } from "../../cli-whatsapp/src/whatsapp/status.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const README = cliDocs();
const ALICE = "27000000003@s.whatsapp.net";
const BOB = "27000000004@s.whatsapp.net";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function post(store: Store, o: { id: string; chat: string; sender: string; ts: string; media?: string | null; fromMe?: number; content?: string }) {
  await store.q.insert(store.t.whatsappMessage).values({
    id: o.id,
    chat_jid: o.chat,
    chat_name: o.chat === STATUS_JID ? "Status" : o.id,
    sender_jid: o.sender,
    content: o.content ?? null,
    ts: o.ts,
    is_from_me: o.fromMe ?? 0,
    media_type: o.media === undefined ? null : o.media,
    created_at: o.ts,
  });
}

async function withApi(fn: (ctx: { store: Store; call: (path: string, opts?: { method?: string; token?: string | null }) => Promise<{ status: number; body: any }> }) => Promise<void>) {
  const lease = await freshPgStore();
  const store = lease.store;
  await setConfig(store, "whatsapp_contacts_db_path", "/nonexistent/does/not/exist/whatsapp.db");
  const api = createObApi({ store: async () => store, token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }) });
  const call = async (path: string, opts: { method?: string; token?: string | null } = {}) => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const res = await api(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method: opts.method ?? "GET",
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn({ store, call });
  } finally {
    await lease.release();
  }
}

describe("contract + docs (1765)", () => {
  test("both routes are served-surface entries and documented in the README", () => {
    for (const p of ["/api/ob/whatsapp/status", "/api/ob/whatsapp/chats"]) {
      expect(OB_API_ROUTES.some((r) => `${OB_API_PREFIX}${r.path}` === p)).toBe(true);
      expect(README).toContain(p);
    }
  });
});

describe("GET /whatsapp/status (1765)", () => {
  test("refuses a missing bearer token", async () => {
    await withApi(async ({ call }) => {
      expect((await call("/whatsapp/status", { token: null })).status).toBe(401);
      expect((await call("/whatsapp/chats", { token: null })).status).toBe(401);
    });
  });

  test("the tray is the last 24h of others' image/video, grouped per person; older posts are history", async () => {
    await withApi(async ({ store, call }) => {
      await post(store, { id: "s1", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(2), media: "image" });
      await post(store, { id: "s2", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(1), media: "video" });
      await post(store, { id: "s3", chat: STATUS_JID, sender: BOB, ts: hoursAgo(3), media: "image" });
      await post(store, { id: "mine", chat: STATUS_JID, sender: "me@s.whatsapp.net", ts: hoursAgo(1), media: "image", fromMe: 1 });
      await post(store, { id: "text", chat: STATUS_JID, sender: BOB, ts: hoursAgo(1), media: null, content: "hi" });
      await post(store, { id: "old", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(30), media: "image" });
      const r = await call("/whatsapp/status");
      expect(r.status).toBe(200);
      expect(r.body.hasMore).toBe(true);
      const byJid = Object.fromEntries(r.body.people.map((p: any) => [p.sender_jid, p.items.map((i: any) => i.id).sort()]));
      expect(byJid).toEqual({ [ALICE]: ["s1", "s2"], [BOB]: ["s3"] });
    });
  });

  test("?before= is a history page of older posts, narrowed by ?sender=, and limit is capped", async () => {
    await withApi(async ({ store, call }) => {
      await post(store, { id: "o1", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(30), media: "image" });
      await post(store, { id: "o2", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(40), media: "image" });
      await post(store, { id: "o3", chat: STATUS_JID, sender: BOB, ts: hoursAgo(35), media: "image" });
      const before = encodeURIComponent(hoursAgo(24));
      const all = await call(`/whatsapp/status?before=${before}`);
      expect(all.status).toBe(200);
      expect(all.body.people.flatMap((p: any) => p.items.map((i: any) => i.id)).sort()).toEqual(["o1", "o2", "o3"]);
      const one = await call(`/whatsapp/status?before=${before}&sender=${encodeURIComponent(ALICE)}&limit=1`);
      expect(one.body.people.flatMap((p: any) => p.items.map((i: any) => i.id))).toEqual(["o1"]);
      expect(one.body.hasMore).toBe(true);
    });
  });

  test("a bad limit or a non-ISO before is a 400", async () => {
    await withApi(async ({ call }) => {
      expect((await call("/whatsapp/status?limit=0")).status).toBe(400);
      expect((await call("/whatsapp/status?before=yesterday")).status).toBe(400);
    });
  });

  test("POST is not a route: nothing here can send", async () => {
    await withApi(async ({ call }) => {
      expect((await call("/whatsapp/status", { method: "POST" })).status).toBeGreaterThanOrEqual(404);
      expect((await call("/whatsapp/chats", { method: "POST" })).status).toBeGreaterThanOrEqual(404);
    });
  });
});

describe("GET /whatsapp/chats (1765)", () => {
  test("one row per chat, newest first, the Status broadcast and hidden chats left out; hidden=true brings them back", async () => {
    await withApi(async ({ store, call }) => {
      await post(store, { id: "a1", chat: ALICE, sender: ALICE, ts: hoursAgo(5), content: "older" });
      await post(store, { id: "a2", chat: ALICE, sender: ALICE, ts: hoursAgo(1), content: "newest alice" });
      await post(store, { id: "b1", chat: BOB, sender: BOB, ts: hoursAgo(3), content: "bob" });
      await post(store, { id: "st", chat: STATUS_JID, sender: ALICE, ts: hoursAgo(1), media: "image" });
      const r = await call("/whatsapp/chats");
      expect(r.status).toBe(200);
      expect(r.body.chats.map((c: any) => [c.chat_jid, c.preview])).toEqual([
        [ALICE, "newest alice"],
        [BOB, "bob"],
      ]);
      await setChatHidden(store, BOB, true);
      expect((await call("/whatsapp/chats")).body.chats.map((c: any) => c.chat_jid)).toEqual([ALICE]);
      const all = await call("/whatsapp/chats?hidden=true&limit=1");
      expect(all.body.chats).toHaveLength(1);
    });
  });
});
