// OB-1750 -- list, edit and delete Gmail drafts. A fake GmailDraftClient stands in for Google, so nothing
// here touches the network, and `sent`/`created` stay empty throughout: none of the three sends anything.
import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { deleteGmailDraft, editGmailDraft, listGmailDrafts, renderDraftPreview } from "../src/gmail-draft.ts";
import { HttpGoogleClient, type GmailDraft } from "../src/google.ts";
import { FakeDraftClient } from "./fake-draft-client.ts";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe]);

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** The first text/plain part's body, whether the message is single-part or multipart. */
function bodyOf(raw: string): string {
  const text = decodeRaw(raw);
  const m = /Content-Type: text\/plain[^\r]*\r\n(?:Content-Transfer-Encoding: base64\r\n)?\r\n([A-Za-z0-9+/=\r\n]+)/.exec(text);
  return Buffer.from((m?.[1] ?? "").replace(/\s/g, ""), "base64").toString("utf8");
}

function plainDraft(id: string, o: { to?: string; cc?: string; subject?: string; body?: string } = {}): GmailDraft {
  return {
    id,
    message: {
      id: `m-${id}`,
      threadId: `t-${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "To", value: o.to ?? "bob@example.com" },
          ...(o.cc === "" ? [] : [{ name: "Cc", value: o.cc ?? "carol@example.com" }]),
          { name: "Subject", value: o.subject ?? "Invoice" },
        ],
        body: { data: b64u(o.body ?? "Hi Bob, attached.") },
      },
    },
  };
}

/** A reply draft with a stored PDF (by id) and an inline file. */
function replyDraftWithFiles(id: string): GmailDraft {
  return {
    id,
    message: {
      id: `m-${id}`,
      threadId: "t-thread",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "To", value: "bob@example.com" },
          { name: "Subject", value: "Re: Plans" },
          { name: "In-Reply-To", value: "<abc@mail>" },
          { name: "References", value: "<root@mail> <abc@mail>" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64u("original words") } },
          { mimeType: "application/pdf", filename: "Quote.pdf", body: { attachmentId: "ATT1", size: PDF.length } },
          { mimeType: "image/png", filename: "logo.png", body: { data: b64u("png!"), size: 4 } },
        ],
      },
    },
  };
}

function untouched(c: FakeDraftClient): void {
  expect(c.sent).toEqual([]);
  expect(c.created).toEqual([]);
}

describe("listGmailDrafts (OB-1750)", () => {
  test("one preview per draft, newest first", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1", { subject: "One" }));
    c.drafts.set("d2", plainDraft("d2", { subject: "Two" }));
    c.drafts.set("d3", plainDraft("d3", { subject: "Three" }));
    const all = await listGmailDrafts(c);
    expect(all.map((d) => d.id)).toEqual(["d3", "d2", "d1"]);
    expect(all[0]).toMatchObject({ to: "bob@example.com", subject: "Three" });
    untouched(c);
  });

  test("--limit stops early", async () => {
    const c = new FakeDraftClient();
    for (const id of ["d1", "d2", "d3"]) c.drafts.set(id, plainDraft(id));
    expect((await listGmailDrafts(c, 1)).map((d) => d.id)).toEqual(["d3"]);
  });

  test("OB-1752: a draft in Gmail's Trash is listed, flagged, and does not hide behind drafts.get", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1", { subject: "Live" }));
    const gone = plainDraft("d2", { subject: "Discarded in Gmail" });
    gone.message!.labelIds = ["DRAFT", "TRASH"];
    c.drafts.set("d2", gone);
    // The premise, as Gmail has it: readable by id, absent from a default list.
    expect((await c.gmailGetDraft("d2")).id).toBe("d2");
    expect((await c.gmailListDrafts({})).drafts?.map((d) => d.id)).toEqual(["d1"]);
    const all = await listGmailDrafts(c);
    expect(all.map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(all[0]!.trashed).toBe(true);
    expect("trashed" in all[1]!).toBe(false);
    expect(renderDraftPreview(all[0]!)).toContain("in Gmail's Trash");
    untouched(c);
  });

  test("no drafts is an empty list, and a bad limit is a usage error", async () => {
    const c = new FakeDraftClient();
    expect(await listGmailDrafts(c)).toEqual([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(listGmailDrafts(c, bad)).rejects.toThrow(UsageError);
  });
});

describe("editGmailDraft (OB-1750)", () => {
  test("changing the subject keeps To, Cc, body and the thread; the id survives and nothing is sent", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1"));
    const p = await editGmailDraft(c, "d1", { subject: "Invoice (corrected)" });
    expect(p).toMatchObject({ id: "d1", to: "bob@example.com", cc: "carol@example.com", subject: "Invoice (corrected)", preview: "Hi Bob, attached." });
    expect(c.updated).toHaveLength(1);
    expect(c.updated[0]).toMatchObject({ id: "d1", threadId: "t-d1" });
    const text = decodeRaw(c.updated[0]!.raw);
    expect(text).toContain("To: bob@example.com");
    expect(text).toContain("Cc: carol@example.com");
    expect(text).toContain("Subject: Invoice (corrected)");
    expect(bodyOf(c.updated[0]!.raw)).toBe("Hi Bob, attached.");
    untouched(c);
  });

  test("a new body replaces only the body", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1"));
    const p = await editGmailDraft(c, "d1", { body: "Fixed line.\n" });
    expect(p.subject).toBe("Invoice");
    expect(bodyOf(c.updated[0]!.raw)).toBe("Fixed line.\n");
  });

  test("cc:'' clears Cc; a new to/cc replaces it", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1"));
    const cleared = await editGmailDraft(c, "d1", { cc: "" });
    expect(cleared.cc).toBeNull();
    expect(decodeRaw(c.updated[0]!.raw)).not.toContain("Cc:");
    const replaced = await editGmailDraft(c, "d1", { to: "dan@example.com", cc: "eve@example.com" });
    expect(replaced).toMatchObject({ to: "dan@example.com", cc: "eve@example.com" });
  });

  test("a reply keeps its thread and In-Reply-To, and References is not doubled", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", replyDraftWithFiles("d1"));
    c.attachments.set("m-d1/ATT1", { size: PDF.length, data: b64u(PDF) });
    const p = await editGmailDraft(c, "d1", { subject: "Re: Plans (v2)" });
    expect(p.thread_id).toBe("t-thread");
    expect(p.in_reply_to).toBe("<abc@mail>");
    expect(c.updated[0]!.threadId).toBe("t-thread");
    const text = decodeRaw(c.updated[0]!.raw);
    expect(text).toContain("In-Reply-To: <abc@mail>");
    expect(text).toContain("References: <root@mail> <abc@mail>");
    expect(text).not.toContain("<abc@mail> <abc@mail>");
  });

  test("files are kept when no attachments are passed: stored and inline bytes are re-sent", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", replyDraftWithFiles("d1"));
    c.attachments.set("m-d1/ATT1", { size: PDF.length, data: b64u(PDF) });
    const p = await editGmailDraft(c, "d1", { body: "new words" });
    expect(p.attachments?.map((a) => a.filename)).toEqual(["Quote.pdf", "logo.png"]);
    expect(c.attachmentFetches).toEqual(["m-d1/ATT1"]);
    const text = decodeRaw(c.updated[0]!.raw);
    expect(text).toContain("Quote.pdf");
    expect(text).toContain("logo.png");
    expect(text).toContain(PDF.toString("base64").slice(0, 12));
  });

  test("a kept file over the 10 MB cap does not block a subject fix; a new one over it does", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", replyDraftWithFiles("d1"));
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    c.attachments.set("m-d1/ATT1", { size: big.length, data: big.toString("base64url") });
    await editGmailDraft(c, "d1", { subject: "typo fixed" });
    expect(c.updated).toHaveLength(1);
    await expect(
      editGmailDraft(c, "d1", { attachments: [{ filename: "b.bin", mime: "application/octet-stream", data_base64: big.toString("base64") }] }),
    ).rejects.toThrow("the limit is 10.0 MB");
  });

  test("attachments: [] drops the files; a list replaces them", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", replyDraftWithFiles("d1"));
    const dropped = await editGmailDraft(c, "d1", { attachments: [] });
    expect(dropped.attachments).toEqual([]);
    expect(c.attachmentFetches).toEqual([]);
    expect(decodeRaw(c.updated[0]!.raw)).not.toContain("Quote.pdf");

    const replaced = await editGmailDraft(c, "d1", {
      attachments: [{ filename: "new.txt", mime: "text/plain", data_base64: Buffer.from("hello").toString("base64") }],
    });
    expect(replaced.attachments).toEqual([{ filename: "new.txt", mime: "text/plain", size: 5 }]);
    expect(decodeRaw(c.updated[1]!.raw)).toContain("new.txt");
    expect(decodeRaw(c.updated[1]!.raw)).not.toContain("Quote.pdf");
  });

  test("an empty edit, an empty body, a header injection and a missing draft are refused; nothing is updated", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1"));
    await expect(editGmailDraft(c, "d1", {})).rejects.toThrow("needs something to change");
    await expect(editGmailDraft(c, "d1", { body: "" })).rejects.toThrow("body cannot be empty");
    await expect(editGmailDraft(c, "d1", { subject: "Hi\nBcc: evil@x.com" })).rejects.toThrow(UsageError);
    await expect(editGmailDraft(c, "d1", { to: "a@x.com\r\nBcc: evil@x.com" })).rejects.toThrow(UsageError);
    await expect(editGmailDraft(c, "nope", { subject: "x" })).rejects.toThrow("no draft nope");
    expect(c.updated).toEqual([]);
    untouched(c);
  });
});

describe("deleteGmailDraft (OB-1750)", () => {
  test("with confirm it removes that draft, reports which, and sends nothing", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", plainDraft("d1"));
    c.drafts.set("d2", plainDraft("d2"));
    const r = await deleteGmailDraft(c, "d1", true);
    expect(r).toMatchObject({ id: "d1", deleted: true, to: "bob@example.com", subject: "Invoice" });
    expect(c.deleted).toEqual(["d1"]);
    expect([...c.drafts.keys()]).toEqual(["d2"]);
    untouched(c);
  });

  test("a wrong id fails on the read, before any delete", async () => {
    const c = new FakeDraftClient();
    await expect(deleteGmailDraft(c, "nope", true)).rejects.toThrow("no draft nope");
    expect(c.deleted).toEqual([]);
  });
});

describe("HttpGoogleClient draft list/update/delete over a fake fetch (OB-1750)", () => {
  test("list, update and delete use the right URL, method and body; delete accepts Gmail's empty 204", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ id: "d1" }), { status: 200 });
    };
    const client = new HttpGoogleClient({ access_token: "t" }, undefined, { fetch });
    await client.gmailListDrafts({ maxResults: 5 });
    await client.gmailListDrafts({ maxResults: 5, includeSpamTrash: true });
    await client.gmailUpdateDraft("d 1", { raw: "UkFX", threadId: "t1" });
    await client.gmailDeleteDraft("d 1");
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
    expect(calls).toEqual([
      { url: `${base}?maxResults=5`, method: undefined, body: undefined },
      { url: `${base}?includeSpamTrash=true&maxResults=5`, method: undefined, body: undefined },
      { url: `${base}/d%201`, method: "PUT", body: { id: "d 1", message: { raw: "UkFX", threadId: "t1" } } },
      { url: `${base}/d%201`, method: "DELETE", body: undefined },
    ]);
  });
});
