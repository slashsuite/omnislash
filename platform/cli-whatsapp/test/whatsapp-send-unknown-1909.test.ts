import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { eventsBetweenFor, parsePayload, recordEventFor } from "../../../apps/cli/src/events.ts";
import {
  BridgeOutcomeUnknown,
  SendMaybeAlreadyGone,
  partialSendMessage,
  sendKey,
  sendWhatsapp,
} from "../src/whatsapp/send.ts";

// OB-1909: a bridge 5xx is remembered as `send_unknown`, so an identical send in the next 24 h refuses until
// the human checks the chat and passes --resend. NO network (injected fetch), NO live DB (a fresh store).

const TO = "27000000003@s.whatsapp.net";

async function store(): Promise<{ db: Store; close: () => void }> {
  const handle = freshDb();
  const db = sqliteStoreFor(handle);
  const path = join(tmpdir(), `ob-bridge-token-${randomUUID()}`);
  writeFileSync(path, "tok\n", "utf8");
  await setConfig(db, "whatsapp_bridge_token_path", path);
  await setConfig(db, "whatsapp_db_path", join(tmpdir(), `ob-no-such-bridge-${randomUUID()}`, "messages.db"));
  return { db, close: () => handle.close() };
}

/** A transport answering each call with the next status in `statuses` (the last one repeats). */
function transport(statuses: number[]): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    const status = statuses[Math.min(n, statuses.length - 1)]!;
    n++;
    const body = status < 300 ? { success: true, message: "sent" } : { success: false, message: "boom" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls: () => n };
}

describe("sendWhatsapp remembers an unknown outcome (OB-1909)", () => {
  test("a 5xx records send_unknown, and an identical send refuses without calling fetch", async () => {
    const { db, close } = await store();
    const t = transport([502]);
    await expect(sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch })).rejects.toBeInstanceOf(
      BridgeOutcomeUnknown,
    );
    const rows = await eventsBetweenFor(db, { source: "whatsapp", type: "send_unknown" });
    expect(rows).toHaveLength(1);
    expect(parsePayload(rows[0]!).key).toBe(sendKey({ to: TO, body: "hi" }));
    expect(rows[0]!.actor).toBe(TO);

    const err = await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMaybeAlreadyGone);
    expect(err.message).toContain(rows[0]!.ts);
    expect(err.message).toContain("ob whatsapp recent");
    expect(err.message).toContain("--resend");
    expect(t.calls()).toBe(1);
    close();
  });

  test("resend: true calls fetch, and the sent that follows clears the refusal", async () => {
    const { db, close } = await store();
    const t = transport([503, 200]);
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch }).catch(() => {});
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, resend: true, fetch: t.fetch });
    expect(t.calls()).toBe(2);
    // the newest attempt is now a `sent`, so a plain identical send goes through
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch });
    expect(t.calls()).toBe(3);
    close();
  });

  test("a different body or recipient is not refused", async () => {
    const { db, close } = await store();
    const t = transport([500, 200]);
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch }).catch(() => {});
    await sendWhatsapp(db, { to: TO, body: "hi there", confirm: true, fetch: t.fetch });
    await sendWhatsapp(db, { to: "27000000004@s.whatsapp.net", body: "hi", confirm: true, fetch: t.fetch });
    expect(t.calls()).toBe(3);
    close();
  });

  test("an attempt older than 24 h is not refused", async () => {
    const { db, close } = await store();
    await recordEventFor(db, {
      ts: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      source: "whatsapp",
      type: "send_unknown",
      actor: TO,
      payload: { key: sendKey({ to: TO, body: "hi" }), chat_jid: TO },
    });
    const t = transport([200]);
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch });
    expect(t.calls()).toBe(1);
    close();
  });

  test("a send_unknown followed by a sent for the same key does not refuse", async () => {
    const { db, close } = await store();
    const key = sendKey({ to: TO, body: "hi" });
    const hourAgo = Date.now() - 60 * 60 * 1000;
    await recordEventFor(db, { ts: new Date(hourAgo).toISOString(), source: "whatsapp", type: "send_unknown", payload: { key } });
    await recordEventFor(db, { ts: new Date(hourAgo + 1000).toISOString(), source: "whatsapp", type: "sent", payload: { key } });
    const t = transport([200]);
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch });
    expect(t.calls()).toBe(1);
    close();
  });

  test("a 2xx records sent with the key", async () => {
    const { db, close } = await store();
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: transport([200]).fetch });
    const rows = await eventsBetweenFor(db, { source: "whatsapp", type: "sent" });
    expect(rows).toHaveLength(1);
    expect(parsePayload(rows[0]!).key).toBe(sendKey({ to: TO, body: "hi" }));
    close();
  });

  test("a 4xx records no send_unknown, and the retry is not refused", async () => {
    const { db, close } = await store();
    const t = transport([400, 200]);
    await expect(sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch })).rejects.not.toBeInstanceOf(
      BridgeOutcomeUnknown,
    );
    expect(await eventsBetweenFor(db, { source: "whatsapp", type: "send_unknown" })).toHaveLength(0);
    await sendWhatsapp(db, { to: TO, body: "hi", confirm: true, fetch: t.fetch });
    expect(t.calls()).toBe(2);
    close();
  });

  test("the key covers the file's name and size", () => {
    const a = sendKey({ to: TO, body: "", file: { name: "a.pdf", size: 10 } });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(sendKey({ to: TO, body: "", file: { name: "a.pdf", size: 11 } })).not.toBe(a);
    expect(sendKey({ to: TO, body: "" })).not.toBe(a);
  });
});

describe("partialSendMessage (OB-1909)", () => {
  const files = ["a.pdf", "b.png", "c.png"];

  test("a 5xx at file 2: file 1 went, file 2 may have gone, the command sends file 3 only, without --body", () => {
    const m = partialSendMessage({ to: TO, body: "cap", files, sent: 1, failedUnknown: true });
    expect(m).toContain("sent 1 of 3 files");
    expect(m).toContain("went: a.pdf");
    expect(m).toContain("b.png may have gone");
    expect(m).toContain(`If it did not: ob whatsapp send --to ${TO} --file b.png --resend`);
    expect(m).toContain(`To send the rest: ob whatsapp send --to ${TO} --file c.png`);
    expect(m).not.toContain("--body");
    expect(m).not.toContain("--file a.pdf");
  });

  test("a 4xx at file 2: the command sends files 2 and 3", () => {
    const m = partialSendMessage({ to: TO, body: "cap", files, sent: 1, failedUnknown: false });
    expect(m).toContain("b.png was not sent");
    expect(m).toContain(`ob whatsapp send --to ${TO} --file b.png --file c.png`);
    expect(m).not.toContain("--body");
  });

  test("a 5xx at file 1: the caption rides with the maybe-gone file, not the rest; a 5xx at the last file prints no rest", () => {
    const m = partialSendMessage({ to: TO, body: "cap", files, sent: 0, failedUnknown: true });
    expect(m).toContain(`If it did not: ob whatsapp send --to ${TO} --body cap --file a.pdf --resend`);
    expect(m).toContain(`To send the rest: ob whatsapp send --to ${TO} --file b.png --file c.png`);
    const last = partialSendMessage({ to: TO, body: "cap", files, sent: 2, failedUnknown: true });
    expect(last).toContain("If it did not: ");
    expect(last).not.toContain("To send the rest");
  });

  test("a 4xx at file 1 carries --body, quoted, and quotes a path with a space", () => {
    const m = partialSendMessage({ to: TO, body: "the cap", files: ["my a.pdf", "b.png"], sent: 0, failedUnknown: false });
    expect(m).toContain(`ob whatsapp send --to ${TO} --body 'the cap' --file 'my a.pdf' --file b.png`);
  });
});
