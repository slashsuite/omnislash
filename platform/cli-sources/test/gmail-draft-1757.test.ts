// ob 1757 -- Gmail drafts: create a DRAFT, send only an existing draft, and only with confirm. A fake
// GmailDraftClient stands in for Google, so nothing here touches the network.
import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { buildRawMessage, createGmailDraft, sendGmailDraft } from "../src/gmail-draft.ts";
import { HttpGoogleClient, type GmailDraft } from "../src/google.ts";
import { FakeDraftClient } from "./fake-draft-client.ts";

function decodeRaw(raw: string): { headers: string; body: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [headers, b64] = text.split("\r\n\r\n");
  return { headers: headers!, body: Buffer.from(b64!.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

function storedDraft(id: string): GmailDraft {
  return {
    id,
    message: {
      id: "m9",
      threadId: "t9",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "To", value: "bob@example.com" },
          { name: "Cc", value: "carol@example.com" },
          { name: "Subject", value: "Invoice" },
        ],
        body: { data: Buffer.from("Hi Bob, attached.").toString("base64url") },
      },
    },
  };
}

describe("buildRawMessage (1757)", () => {
  test("a plain draft carries To/Cc/Subject and a base64 UTF-8 body", () => {
    const { headers, body } = decodeRaw(
      buildRawMessage({ to: "a@x.com", cc: "c@x.com", subject: "Hi", body: "héllo\nworld" }),
    );
    expect(headers).toContain("To: a@x.com");
    expect(headers).toContain("Cc: c@x.com");
    expect(headers).toContain("Subject: Hi");
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).not.toContain("In-Reply-To");
    expect(body).toBe("héllo\nworld");
  });

  test("a non-ASCII subject is an RFC 2047 encoded-word", () => {
    const { headers } = decodeRaw(buildRawMessage({ to: "a@x.com", subject: "Grüße", body: "b" }));
    expect(headers).toContain(`Subject: =?UTF-8?B?${Buffer.from("Grüße").toString("base64")}?=`);
  });
});

describe("createGmailDraft (1757)", () => {
  test("a CR/LF in a header value is refused before Google is called (no header injection)", async () => {
    const c = new FakeDraftClient();
    await expect(createGmailDraft(c, { to: "a@x.com\r\nBcc: evil@x.com", subject: "Hi", body: "b" })).rejects.toThrow(
      UsageError,
    );
    await expect(createGmailDraft(c, { to: "a@x.com", subject: "Hi\nBcc: e@x", body: "b" })).rejects.toThrow(
      "subject must be a single line",
    );
    expect(c.created).toEqual([]);
  });

  test("missing subject without --reply-to is a usage error", async () => {
    const c = new FakeDraftClient();
    await expect(createGmailDraft(c, { to: "a@x.com", body: "b" })).rejects.toThrow("requires --subject");
    expect(c.created).toEqual([]);
  });

  test("--reply-to threads the draft and sets In-Reply-To/References and a Re: subject", async () => {
    const c = new FakeDraftClient();
    c.messages.set("orig", {
      id: "orig",
      threadId: "t42",
      payload: {
        headers: [
          { name: "Subject", value: "Plans" },
          { name: "Message-ID", value: "<abc@mail>" },
          { name: "References", value: "<root@mail>" },
        ],
      },
    });
    const p = await createGmailDraft(c, { to: "a@x.com", body: "sounds good", reply_to: "orig" });
    expect(c.created[0]!.threadId).toBe("t42");
    const { headers } = decodeRaw(c.created[0]!.raw);
    expect(headers).toContain("Subject: Re: Plans");
    expect(headers).toContain("In-Reply-To: <abc@mail>");
    expect(headers).toContain("References: <root@mail> <abc@mail>");
    expect(p.thread_id).toBe("t42");
    expect(p.in_reply_to).toBe("<abc@mail>");
  });
});

describe("sendGmailDraft (1757)", () => {
  test("refuses without confirm and calls nothing", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", storedDraft("d1"));
    await expect(sendGmailDraft(c, "d1", false, "abc123abc123")).rejects.toThrow("refuses without --confirm");
    expect(c.sent).toEqual([]);
  });

});

describe("HttpGoogleClient drafts over a fake fetch (1757)", () => {
  test("create POSTs /drafts with {message:{raw,threadId}}; send POSTs /drafts/send with {id}", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: "x1" }), { status: 200 });
    };
    const c = new HttpGoogleClient({ access_token: "t" }, undefined, { fetch });
    await c.gmailCreateDraft({ raw: "UkFX", threadId: "t1" });
    await c.gmailSendDraft("d 1");
    await c.gmailGetDraft("d1");
    expect(calls[0]).toEqual({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      method: "POST",
      body: { message: { raw: "UkFX", threadId: "t1" } },
    });
    expect(calls[1]).toEqual({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
      method: "POST",
      body: { id: "d 1" },
    });
    expect(calls[2]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=full");
  });
});
