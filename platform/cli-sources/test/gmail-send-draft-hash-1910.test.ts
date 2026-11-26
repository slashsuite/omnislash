// OB-1910 -- `send-draft` sends exactly what was previewed. The confirm carries the draft's hash; the core
// re-reads the draft at send time and sends only while it still hashes to that. An edit is simulated by
// replacing the draft in the fake's `drafts` map between preview and send.
import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { draftHash, renderDraftPreview, sendGmailDraft, showGmailDraft } from "../src/gmail-draft.ts";
import type { GmailDraft } from "../src/google.ts";
import { FakeDraftClient } from "./fake-draft-client.ts";

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");

interface Fields {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  files?: Array<[string, number]>;
  trash?: boolean;
}

function draft(f: Fields = {}): GmailDraft {
  const headers = [
    { name: "To", value: f.to ?? "bob@example.com" },
    ...(f.cc != null ? [{ name: "Cc", value: f.cc }] : []),
    ...(f.bcc != null ? [{ name: "Bcc", value: f.bcc }] : []),
    { name: "Subject", value: f.subject ?? "Invoice" },
  ];
  const text = { mimeType: "text/plain", body: { data: b64u(f.body ?? "Hi Bob, attached.") } };
  const files = f.files ?? [];
  return {
    id: "d1",
    message: {
      id: "m1",
      threadId: "t1",
      ...(f.trash ? { labelIds: ["DRAFT", "TRASH"] } : {}),
      payload: files.length
        ? {
            mimeType: "multipart/mixed",
            headers,
            parts: [
              text,
              ...files.map(([filename, size], i) => ({
                mimeType: "application/pdf",
                filename,
                body: { attachmentId: `A${i}`, size },
              })),
            ],
          }
        : { ...text, headers },
    },
  };
}

function fake(f: Fields = {}): FakeDraftClient {
  const c = new FakeDraftClient();
  c.drafts.set("d1", draft(f));
  return c;
}

describe("draftHash (OB-1910)", () => {
  test("is 12 hex chars and stable for the same content", () => {
    const h = draftHash(draft({ cc: "c@x.com", files: [["a.pdf", 10]] }));
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(draftHash(draft({ cc: "c@x.com", files: [["a.pdf", 10]] }))).toBe(h);
  });

  test("changes when any one field changes", () => {
    const base: Fields = { cc: "c@x.com", bcc: "z@x.com", files: [["a.pdf", 10]] };
    const h = draftHash(draft(base));
    const variants: Fields[] = [
      { ...base, to: "eve@example.com" },
      { ...base, cc: "d@x.com" },
      { bcc: "z@x.com", files: [["a.pdf", 10]] },
      { ...base, bcc: "eve@x.com" },
      { cc: "c@x.com", files: [["a.pdf", 10]] },
      { ...base, subject: "Invoice v2" },
      { ...base, body: "Hi Bob, attached!" },
      { ...base, files: [["b.pdf", 10]] },
      { ...base, files: [["a.pdf", 11]] },
      { ...base, files: [] },
    ];
    for (const v of variants) expect(draftHash(draft(v))).not.toBe(h);
  });

  test("a body edit past the 400-char preview cut changes the hash, though the preview does not", async () => {
    const long = "x".repeat(500);
    const before = fake({ body: long });
    const after = fake({ body: `${long}PS: wire the money elsewhere` });
    const [p1, p2] = [await showGmailDraft(before, "d1"), await showGmailDraft(after, "d1")];
    expect(p1.preview).toBe(p2.preview);
    expect(p1.hash).not.toBe(p2.hash);
  });
});

describe("the preview carries the hash (OB-1910)", () => {
  test("renderDraftPreview prints hash and a non-empty bcc", async () => {
    const p = await showGmailDraft(fake({ bcc: "z@x.com" }), "d1");
    expect(p.hash).toBe(draftHash(draft({ bcc: "z@x.com" })));
    const out = renderDraftPreview(p);
    expect(out).toContain(`hash:    ${p.hash}`);
    expect(out).toContain("bcc:     z@x.com");
    expect(renderDraftPreview(await showGmailDraft(fake(), "d1"))).not.toContain("bcc:");
  });
});

describe("sendGmailDraft binds to the hash (OB-1910)", () => {
  test("preview, then an edit, then send with the old hash refuses (exit 2, new hash named) and sends nothing", async () => {
    const c = fake();
    const { hash: old } = await showGmailDraft(c, "d1");
    c.drafts.set("d1", draft({ to: "eve@example.com" }));
    const err = await sendGmailDraft(c, "d1", true, old!).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(`it is now ${draftHash(draft({ to: "eve@example.com" }))}`);
    expect(c.sent).toEqual([]);
  });

  test("send with the new hash sends exactly once", async () => {
    const c = fake();
    c.drafts.set("d1", draft({ to: "eve@example.com" }));
    const { hash } = await showGmailDraft(c, "d1");
    const r = await sendGmailDraft(c, "d1", true, hash!);
    expect(r.sent_message_id).toBe("sent-d1");
    expect(r.to).toBe("eve@example.com");
    expect(c.sent).toEqual(["d1"]);
  });

  test("a trashed draft refuses by name, even with its own hash", async () => {
    const c = fake({ trash: true });
    const { hash, trashed } = await showGmailDraft(c, "d1");
    expect(trashed).toBe(true);
    await expect(sendGmailDraft(c, "d1", true, hash!)).rejects.toThrow("Trash");
    expect(c.sent).toEqual([]);
  });

  test("an empty hash refuses before Gmail is read", async () => {
    const c = fake();
    for (const h of ["", "   "]) {
      await expect(sendGmailDraft(c, "d1", true, h)).rejects.toThrow("refuses without --hash");
    }
    expect(c.sent).toEqual([]);
  });

  test("a draft Gmail no longer returns keeps the not-found error", async () => {
    const c = new FakeDraftClient();
    await expect(sendGmailDraft(c, "gone", true, "0123456789ab")).rejects.toThrow("no draft gone");
    expect(c.sent).toEqual([]);
  });
});
