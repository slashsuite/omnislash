// OB-1961 -- `--from`: a draft goes out as a verified Gmail Send-as alias. A fake GmailDraftClient with a
// Send-as list stands in for Google, so nothing here touches the network and nothing is sent.
import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import {
  createGmailDraft,
  draftHash,
  editGmailDraft,
  FROM_DEFAULT,
  renderDraftPreview,
  showGmailDraft,
} from "../src/gmail-draft.ts";
import { draftEditFromFlags, draftRequestFromFlags, renderDeleted, renderSent } from "../src/commands/gmail.ts";
import { GoogleHttpError, type GmailDraft } from "../src/google.ts";
import { FakeDraftClient } from "./fake-draft-client.ts";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const headerLine = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(decodeRaw(raw))?.[1];

function client(): FakeDraftClient {
  const c = new FakeDraftClient();
  c.sendAs = [
    { sendAsEmail: "me@example.com", isPrimary: true, isDefault: true },
    { sendAsEmail: "Alex@Studio.Example.com", displayName: "Alex Example", verificationStatus: "accepted" },
    { sendAsEmail: "later@example.com", verificationStatus: "pending" },
  ];
  return c;
}

function draft(id: string, from?: string): GmailDraft {
  return {
    id,
    message: {
      id: `m-${id}`,
      threadId: `t-${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [
          ...(from ? [{ name: "From", value: from }] : []),
          { name: "To", value: "bob@example.com" },
          { name: "Subject", value: "Invoice" },
        ],
        body: { data: b64u("Hi Bob") },
      },
    },
  };
}

const REQ = { to: "bob@example.com", subject: "Hi", body: "hello" };

describe("createGmailDraft --from (OB-1961)", () => {
  test("a verified alias writes a From header built from the matched entry", async () => {
    const c = client();
    const p = await createGmailDraft(c, { ...REQ, from: "alex@studio.example.com" });
    expect(headerLine(c.created[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
    expect(p.from).toBe('"Alex Example" <Alex@Studio.Example.com>');
    expect(c.sent).toEqual([]);
  });

  test("a Name <addr> flag matches on the address, and the header never echoes the flag's name", async () => {
    const c = client();
    await createGmailDraft(c, { ...REQ, from: "Someone Else <ALEX@studio.example.com>" });
    expect(headerLine(c.created[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
  });

  test("the primary address is usable and, with no display name, is written bare", async () => {
    const c = client();
    await createGmailDraft(c, { ...REQ, from: "me@example.com" });
    expect(headerLine(c.created[0]!.raw, "From")).toBe("me@example.com");
  });

  test("a non-ASCII display name is an RFC 2047 encoded word", async () => {
    const c = client();
    c.sendAs = [{ sendAsEmail: "j@x.com", displayName: "Alex Exämple", verificationStatus: "accepted" }];
    await createGmailDraft(c, { ...REQ, from: "j@x.com" });
    expect(headerLine(c.created[0]!.raw, "From")).toBe(`=?UTF-8?B?${Buffer.from("Alex Exämple").toString("base64")}?= <j@x.com>`);
  });

  test("an unlisted address is refused naming the usable ones, and nothing is created", async () => {
    const c = client();
    const err = await createGmailDraft(c, { ...REQ, from: "stranger@evil.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("stranger@evil.com");
    expect(err.message).toContain("me@example.com, Alex@Studio.Example.com");
    expect(err.message).not.toContain("later@example.com,");
    expect(err.message).toContain("Send mail as");
    expect(c.created).toEqual([]);
  });

  test("a listed but unverified alias is refused", async () => {
    const c = client();
    const err = await createGmailDraft(c, { ...REQ, from: "later@example.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("not verified (pending)");
    expect(c.created).toEqual([]);
  });

  test("no --from makes no Send-as call and writes no From header", async () => {
    const c = client();
    const p = await createGmailDraft(c, REQ);
    expect(c.sendAsCalls).toBe(0);
    expect(headerLine(c.created[0]!.raw, "From")).toBeUndefined();
    expect(p.from).toBeNull();
  });

  test("a 403 on the Send-as list is refused by name with the scope needed", async () => {
    const c = client();
    c.sendAsError = new GoogleHttpError(403, "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs");
    const err = await createGmailDraft(c, { ...REQ, from: "me@example.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("gmail.settings.basic");
    expect(c.created).toEqual([]);
  });
});

describe("editGmailDraft --from (OB-1961)", () => {
  test("keeps the draft's existing From when --from is not given, with no Send-as call", async () => {
    const c = client();
    c.drafts.set("d1", draft("d1", '"Alex Example" <Alex@Studio.Example.com>'));
    const p = await editGmailDraft(c, "d1", { subject: "New" });
    expect(headerLine(c.updated[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
    expect(p.from).toBe('"Alex Example" <Alex@Studio.Example.com>');
    expect(c.sendAsCalls).toBe(0);
  });

  test("--from replaces it, after the Send-as check", async () => {
    const c = client();
    c.drafts.set("d1", draft("d1", "old@example.com"));
    await editGmailDraft(c, "d1", { from: "alex@studio.example.com" });
    expect(headerLine(c.updated[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
  });

  test("--from alone is a valid edit; a bad one is refused and updates nothing", async () => {
    const c = client();
    c.drafts.set("d1", draft("d1"));
    await expect(editGmailDraft(c, "d1", { from: "nope@x.com" })).rejects.toThrow("not one of this account's Send-as");
    expect(c.updated).toEqual([]);
  });

  test("a draft with no From stays without one", async () => {
    const c = client();
    c.drafts.set("d1", draft("d1"));
    const p = await editGmailDraft(c, "d1", { subject: "x" });
    expect(headerLine(c.updated[0]!.raw, "From")).toBeUndefined();
    expect(p.from).toBeNull();
  });
});

describe("hash and rendering (OB-1961)", () => {
  test("the hash changes when only From changes", () => {
    expect(draftHash(draft("d1", "a@x.com"))).not.toBe(draftHash(draft("d1", "b@x.com")));
    expect(draftHash(draft("d1", "a@x.com"))).not.toBe(draftHash(draft("d1")));
    expect(draftHash(draft("d1", "a@x.com"))).toBe(draftHash(draft("d1", "a@x.com")));
  });

  test("a draft with no From renders the default placeholder; one with a From renders it", async () => {
    const c = client();
    c.drafts.set("none", draft("none"));
    c.drafts.set("alias", draft("alias", "j@x.com"));
    expect(renderDraftPreview(await showGmailDraft(c, "none"))).toContain(`from:    ${FROM_DEFAULT}`);
    expect(renderDraftPreview(await showGmailDraft(c, "alias"))).toContain("from:    j@x.com");
  });

  test("sent and deleted renderings carry the from", async () => {
    const c = client();
    c.drafts.set("alias", draft("alias", "j@x.com"));
    c.drafts.set("none", draft("none"));
    const alias = await showGmailDraft(c, "alias");
    const none = await showGmailDraft(c, "none");
    expect(renderSent({ ...alias, sent_message_id: "s1" })).toContain("from:    j@x.com");
    expect(renderSent({ ...none, sent_message_id: "s1" })).toContain(`from:    ${FROM_DEFAULT}`);
    expect(renderDeleted({ ...alias, deleted: true })).toContain("from:    j@x.com");
  });
});

describe("flags (OB-1961)", () => {
  test("--from reaches the request and the edit", () => {
    expect(draftRequestFromFlags({ to: "a@x.com", body: "b", from: "j@x.com" } as never).from).toBe("j@x.com");
    expect(draftRequestFromFlags({ to: "a@x.com", body: "b" } as never)).not.toHaveProperty("from");
    expect(draftEditFromFlags({ from: "j@x.com" } as never)).toEqual({ from: "j@x.com" });
  });
});

describe("the API route carries from end to end (OB-1961)", () => {
  const TOKEN = "a-test-bearer-token-that-is-long-enough";
  function app(g: FakeDraftClient) {
    return createObApi({
      store: async () => ({}) as Store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
      gmailDrafts: g,
    });
  }
  const post = async (a: ReturnType<typeof app>, path: string, body: unknown) => {
    const res = await a(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  test("POST /gmail/drafts with from writes the From header", async () => {
    const g = client();
    const a = app(g);
    const ok = await post(a, "/gmail/drafts", { ...REQ, from: "alex@studio.example.com" });
    expect(ok.status).toBe(200);
    expect(ok.body.from).toBe('"Alex Example" <Alex@Studio.Example.com>');
    expect(headerLine(g.created[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
  });

  test("POST /gmail/drafts/:id/edit with from replaces the From", async () => {
    const g = client();
    g.drafts.set("d1", draft("d1", "old@example.com"));
    const res = await post(app(g), "/gmail/drafts/d1/edit", { from: "alex@studio.example.com" });
    expect(res.status).toBe(200);
    expect(headerLine(g.updated[0]!.raw, "From")).toBe('"Alex Example" <Alex@Studio.Example.com>');
  });
});
