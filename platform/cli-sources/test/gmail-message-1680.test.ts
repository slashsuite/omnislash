// ob 1680 -- `gmail read`, `gmail attachment` and `gmail draft --attach`. A fake GmailDraftClient stands in
// for Google (fixture API payloads through the existing seam), so nothing here touches the network, and
// every test asserts that nothing was sent.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import {
  MAX_ATTACHMENT_BYTES,
  buildRawMessage,
  createGmailDraft,
  rawAttachments,
  renderDraftPreview,
  sendGmailDraft,
  showGmailDraft,
} from "../src/gmail-draft.ts";
import {
  assertMessageId,
  defaultAttachmentDir,
  fetchGmailAttachments,
  htmlToText,
  messageText,
  readGmailMessage,
  renderMessage,
  safeFileName,
  saveAttachments,
} from "../src/gmail-message.ts";
import { HttpGoogleClient, type GmailMessage } from "../src/google.ts";
import { FakeDraftClient } from "./fake-draft-client.ts";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const scratch = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-1680-"));

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x80]);

/** The Ixia-shaped message: multipart/mixed { multipart/alternative { plain, html }, a PDF by id }. */
function invoiceMessage(): GmailMessage {
  return {
    id: "1a17da28a46167ec",
    threadId: "t1",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ixia Vets <accounts@ixia.example>" },
        { name: "To", value: "alex@example.com" },
        { name: "Subject", value: "Invoice 4411" },
        { name: "Date", value: "Tue, 27 Oct 2026 10:00:00 +0200" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64u("Please find the invoice attached.") } },
            { mimeType: "text/html", body: { data: b64u("<p>Please find the <b>invoice</b> attached.</p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "Invoice 4411.pdf", body: { attachmentId: "ATT1", size: PDF.length } },
        { mimeType: "image/png", filename: "logo.png", body: { data: b64u("png!"), size: 4 } },
      ],
    },
  };
}

function clientWithInvoice(): FakeDraftClient {
  const c = new FakeDraftClient();
  c.messages.set("1a17da28a46167ec", invoiceMessage());
  c.attachments.set("1a17da28a46167ec/ATT1", { size: PDF.length, data: b64u(PDF) });
  return c;
}

describe("message text (1680)", () => {
  test("text/plain wins over text/html", () => {
    expect(messageText(invoiceMessage().payload)).toBe("Please find the invoice attached.");
  });

  test("html-only is stripped to text: tags, script/style and entities", () => {
    const html = "<style>p{}</style><p>Total&nbsp;R&amp;D: <b>R 1&#44;200</b></p><script>x()</script><div>bye</div>";
    expect(htmlToText(html)).toBe("Total R&D: R 1,200\nbye");
    expect(messageText({ mimeType: "text/html", body: { data: b64u(html) } })).toBe("Total R&D: R 1,200\nbye");
  });

  test("a text attachment is a file, never the body", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "A", size: 3 } }],
    };
    expect(messageText(payload)).toBe("");
  });

  test("a single-part message reads its own body", () => {
    expect(messageText({ mimeType: "text/plain", body: { data: b64u("  hi  ") } })).toBe("hi");
  });
});

describe("readGmailMessage (1680)", () => {
  test("headers, body and the attachment list, with the attachment id; read-only", async () => {
    const c = clientWithInvoice();
    const m = await readGmailMessage(c, "1a17da28a46167ec");
    expect(m).toMatchObject({
      id: "1a17da28a46167ec",
      thread_id: "t1",
      from: "Ixia Vets <accounts@ixia.example>",
      to: "alex@example.com",
      cc: null,
      subject: "Invoice 4411",
      body: "Please find the invoice attached.",
    });
    expect(m.attachments).toEqual([
      { filename: "Invoice 4411.pdf", mime: "application/pdf", size: PDF.length, attachment_id: "ATT1" },
      { filename: "logo.png", mime: "image/png", size: 4, attachment_id: null },
    ]);
    expect(c.attachmentFetches).toEqual([]);
    expect(c.created).toEqual([]);
    expect(c.sent).toEqual([]);
  });

  test("renders a human view with the sizes and ids", async () => {
    const out = renderMessage(await readGmailMessage(clientWithInvoice(), "1a17da28a46167ec"));
    expect(out).toContain("from:    Ixia Vets <accounts@ixia.example>");
    expect(out).toContain("Invoice 4411.pdf\tapplication/pdf\t14 B\tATT1");
    expect(out).toContain("logo.png\timage/png\t4 B\t(inline)");
    expect(out.endsWith("Please find the invoice attached.")).toBe(true);
  });
});

describe("fetchGmailAttachments (1680)", () => {
  test("all of them: the by-id one is fetched, the inline one is not", async () => {
    const c = clientWithInvoice();
    const r = await fetchGmailAttachments(c, "1a17da28a46167ec");
    expect(r.message_id).toBe("1a17da28a46167ec");
    expect(r.attachments.map((a) => a.filename)).toEqual(["Invoice 4411.pdf", "logo.png"]);
    expect(Buffer.from(r.attachments[0]!.data_base64, "base64").equals(PDF)).toBe(true);
    expect(Buffer.from(r.attachments[1]!.data_base64, "base64").toString()).toBe("png!");
    expect(c.attachmentFetches).toEqual(["1a17da28a46167ec/ATT1"]);
    expect(c.sent).toEqual([]);
  });

  test("--name picks one and fetches only that one", async () => {
    const c = clientWithInvoice();
    const r = await fetchGmailAttachments(c, "1a17da28a46167ec", "logo.png");
    expect(r.attachments.map((a) => a.filename)).toEqual(["logo.png"]);
    expect(c.attachmentFetches).toEqual([]);
  });

  test("an unknown --name is a usage error that lists the real names", async () => {
    const err = await fetchGmailAttachments(clientWithInvoice(), "1a17da28a46167ec", "nope.pdf").catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain("no attachment named 'nope.pdf'");
    expect(err.message).toContain("Invoice 4411.pdf, logo.png");
  });

  test("a message without attachments says so", async () => {
    const c = new FakeDraftClient();
    c.messages.set("m1", { id: "m1", payload: { mimeType: "text/plain", body: { data: b64u("x") } } });
    await expect(fetchGmailAttachments(c, "m1")).rejects.toThrow("has no attachments");
  });

  test("Gmail returning no data for an attachment is an error, not an empty file", async () => {
    const c = clientWithInvoice();
    c.attachments.set("1a17da28a46167ec/ATT1", { size: 0 });
    await expect(fetchGmailAttachments(c, "1a17da28a46167ec", "Invoice 4411.pdf")).rejects.toThrow("returned no data");
  });
});

describe("saveAttachments (1680)", () => {
  const file = (filename: string, text: string) => ({
    filename,
    mime: "text/plain",
    size: text.length,
    data_base64: Buffer.from(text).toString("base64"),
  });

  test("writes the exact bytes and returns the paths", async () => {
    const dir = join(scratch(), "out");
    const r = await fetchGmailAttachments(clientWithInvoice(), "1a17da28a46167ec");
    const paths = saveAttachments(r.attachments, dir);
    expect(paths).toEqual([join(dir, "Invoice 4411.pdf"), join(dir, "logo.png")]);
    expect(readFileSync(paths[0]!).equals(PDF)).toBe(true);
  });

  test("never overwrites silently: refuses before writing ANY file, --force replaces", () => {
    const dir = scratch();
    writeFileSync(join(dir, "b.txt"), "mine");
    expect(() => saveAttachments([file("a.txt", "A"), file("b.txt", "B")], dir)).toThrow("refusing to overwrite");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("mine");
    saveAttachments([file("a.txt", "A"), file("b.txt", "B")], dir, { force: true });
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("B");
  });

  test("two attachments of one name both survive: the second becomes 'name (2).ext'", () => {
    const dir = scratch();
    const paths = saveAttachments([file("scan.pdf", "1"), file("scan.pdf", "2")], dir);
    expect(paths.map((p) => p.slice(dir.length + 1))).toEqual(["scan.pdf", "scan (2).pdf"]);
    expect(readFileSync(paths[1]!, "utf8")).toBe("2");
  });

  test("a sender-chosen path in the name cannot leave the directory", () => {
    const dir = scratch();
    const paths = saveAttachments(
      [file("../../etc/evil.sh", "x"), file("..\\..\\win.ini", "y"), file("..", "z"), file("", "w")],
      dir,
    );
    expect(paths.map((p) => p.slice(dir.length + 1))).toEqual(["evil.sh", "win.ini", "attachment-3", "attachment-4"]);
    for (const p of paths) expect(p.startsWith(`${dir}/`)).toBe(true);
    expect(safeFileName("a\x00b\nc.txt", "f")).toBe("abc.txt");
  });

  test("the default dir is $TMPDIR/ob-gmail/<id>, never a hardcoded /tmp", () => {
    const was = process.env.TMPDIR;
    process.env.TMPDIR = "/scratch/elsewhere";
    try {
      expect(defaultAttachmentDir("abc123")).toBe("/scratch/elsewhere/ob-gmail/abc123");
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  });

  test("a message id is a single path-safe token", () => {
    expect(assertMessageId("1a17da28a46167ec")).toBe("1a17da28a46167ec");
    for (const bad of ["", undefined, "../x", "a/b", "a b", ".."]) expect(() => assertMessageId(bad)).toThrow(UsageError);
  });
});

// --- --attach: a MIME round trip ----------------------------------------------------------------------

interface ParsedPart {
  headers: Record<string, string>;
  body: Buffer;
}

/** A small independent multipart/mixed parser: the proof that what buildRawMessage wrote reads back. */
function parseMime(raw: string): { headers: Record<string, string>; parts: ParsedPart[] } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, ...rest] = text.split("\r\n\r\n");
  const parseHeaders = (block: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  };
  const headers = parseHeaders(head!);
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
  if (!boundary) return { headers, parts: [] };
  const body = rest.join("\r\n\r\n");
  const chunks = body.split(`--${boundary}`).slice(1, -1);
  expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  const parts = chunks.map((chunk) => {
    const c = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const [ph, ...pb] = c.split("\r\n\r\n");
    const ph2 = parseHeaders(ph!);
    expect(ph2["content-transfer-encoding"]).toBe("base64");
    return { headers: ph2, body: Buffer.from(pb.join("\r\n\r\n").replace(/\r\n/g, ""), "base64") };
  });
  return { headers, parts };
}

const att = (filename: string, data: Buffer, mime = "application/pdf") => ({ filename, mime, data_base64: data.toString("base64") });

describe("--attach MIME round trip (1680)", () => {
  test("no attachments: the message is byte-for-byte what it was (a single text/plain part)", () => {
    const raw = buildRawMessage({ to: "a@x.com", subject: "Hi", body: "hello" });
    const { headers, parts } = parseMime(raw);
    expect(headers["content-type"]).toBe('text/plain; charset="UTF-8"');
    expect(parts).toEqual([]);
  });

  test("text part + files come back identical, with binary bytes intact", () => {
    const big = Buffer.alloc(100_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const raw = buildRawMessage({
      to: "a@x.com",
      subject: "Claim",
      body: "see attached — héllo",
      attachments: rawAttachments([att("Invoice 4411.pdf", PDF), att("big.bin", big, "application/octet-stream")]),
    });
    const { headers, parts } = parseMime(raw);
    expect(headers["mime-version"]).toBe("1.0");
    expect(headers["content-type"]).toStartWith("multipart/mixed; boundary=");
    expect(headers.to).toBe("a@x.com");
    expect(parts).toHaveLength(3);
    expect(parts[0]!.headers["content-type"]).toBe('text/plain; charset="UTF-8"');
    expect(parts[0]!.body.toString("utf8")).toBe("see attached — héllo");
    expect(parts[1]!.headers["content-disposition"]).toBe('attachment; filename="Invoice 4411.pdf"');
    expect(parts[1]!.headers["content-type"]).toBe('application/pdf; name="Invoice 4411.pdf"');
    expect(parts[1]!.body.equals(PDF)).toBe(true);
    expect(parts[2]!.body.equals(big)).toBe(true);
    // Lines stay within RFC 5322's 78-character guidance for the base64 payloads.
    for (const line of Buffer.from(raw, "base64url").toString("utf8").split("\r\n")) expect(line.length).toBeLessThanOrEqual(98);
  });

  test("a non-ASCII filename gets an ASCII fallback and an RFC 2231 form", () => {
    const raw = buildRawMessage({
      to: "a@x.com",
      subject: "s",
      body: "b",
      attachments: rawAttachments([att("Fakturë – Mei.pdf", PDF)]),
    });
    const { parts } = parseMime(raw);
    const d = parts[1]!.headers["content-disposition"]!;
    expect(d).toContain('filename="Faktur_ _ Mei.pdf"');
    expect(d).toContain("filename*=UTF-8''" + encodeURIComponent("Fakturë – Mei.pdf"));
  });

  test("a quote or backslash in the name cannot break out of the header", () => {
    const raw = buildRawMessage({
      to: "a@x.com",
      subject: "s",
      body: "b",
      attachments: rawAttachments([att('a"b\\c.pdf', PDF)]),
    });
    const d = parseMime(raw).parts[1]!.headers["content-disposition"]!;
    expect(d).toStartWith('attachment; filename="a_b_c.pdf"');
  });

  test("a CR/LF in a filename is refused (no header injection)", () => {
    expect(() => rawAttachments([att("a.pdf\r\nBcc: evil@x.com", PDF)])).toThrow(UsageError);
  });

  test("a bad mime type falls back to octet-stream; bad base64 is refused", () => {
    expect(rawAttachments([att("a.bin", PDF, "x/y\r\nz")])[0]!.mime).toBe("application/octet-stream");
    expect(() => rawAttachments([{ filename: "a", data_base64: "not base64!" }])).toThrow("not valid base64");
    expect(() => rawAttachments([{ filename: "", data_base64: "" }])).toThrow("needs a filename");
  });

  test("over the size cap is refused with both numbers", () => {
    const half = Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1);
    expect(() => rawAttachments([att("a", half), att("b", half)])).toThrow("the limit is 10.0 MB");
  });
});

describe("createGmailDraft with attachments (1680)", () => {
  test("creates ONE draft carrying the files, lists them in the preview, and sends nothing", async () => {
    const c = new FakeDraftClient();
    const p = await createGmailDraft(c, {
      to: "claims@insurer.example.com",
      subject: "Claim for Morgan",
      body: "invoice attached",
      attachments: [att("Invoice 4411.pdf", PDF)],
    });
    expect(c.created).toHaveLength(1);
    expect(c.sent).toEqual([]);
    const { parts } = parseMime(c.created[0]!.raw);
    expect(parts[1]!.body.equals(PDF)).toBe(true);
    expect(p.attachments).toEqual([{ filename: "Invoice 4411.pdf", mime: "application/pdf", size: PDF.length }]);
    const view = renderDraftPreview(p);
    expect(view).toContain("attach:  Invoice 4411.pdf (application/pdf, 14 B)");
  });

  test("a refused attachment creates no draft at all", async () => {
    const c = new FakeDraftClient();
    await expect(
      createGmailDraft(c, { to: "a@x.com", subject: "s", body: "b", attachments: [{ filename: "x", data_base64: "%%%" }] }),
    ).rejects.toThrow("not valid base64");
    expect(c.created).toEqual([]);
  });

  test("a stored draft's preview (send-draft) shows the files it carries, from the Gmail payload", async () => {
    const c = new FakeDraftClient();
    c.drafts.set("d1", {
      id: "d1",
      message: {
        id: "m1",
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "To", value: "b@x.com" }, { name: "Subject", value: "S" }],
          parts: [
            { mimeType: "text/plain", body: { data: b64u("hi") } },
            { mimeType: "application/pdf", filename: "Invoice 4411.pdf", body: { attachmentId: "A", size: 2048 } },
          ],
        },
      },
    });
    const p = await showGmailDraft(c, "d1");
    expect(p.attachments).toEqual([{ filename: "Invoice 4411.pdf", mime: "application/pdf", size: 2048 }]);
    expect(renderDraftPreview(p)).toContain("attach:  Invoice 4411.pdf (application/pdf, 2.0 KB)");
    await expect(sendGmailDraft(c, "d1", false, p.hash!)).rejects.toThrow("refuses without --confirm");
    expect(c.sent).toEqual([]);
  });
});

describe("HttpGoogleClient attachments over a fake fetch (1680)", () => {
  test("GETs /messages/<id>/attachments/<attId> with both ids URL-encoded", async () => {
    const urls: string[] = [];
    const fetch = async (input: string | URL): Promise<Response> => {
      urls.push(String(input));
      return new Response(JSON.stringify({ size: 3, data: "YWJj" }), { status: 200 });
    };
    const c = new HttpGoogleClient({ access_token: "t" }, undefined, { fetch });
    expect(await c.gmailGetAttachment("m 1", "A/B")).toEqual({ size: 3, data: "YWJj" });
    expect(urls).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/messages/m%201/attachments/A%2FB"]);
  });
});
