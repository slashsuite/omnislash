// ob 1757 -- `ob gmail draft` / `ob gmail send-draft` over the API. The client half runs on a stubbed
// transport (no network); the server half on a real store via the ob 325 harness with a fake Gmail drafts
// client injected, so no draft is created and nothing is sent anywhere real.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { FakeDraftClient } from "../../cli-sources/test/fake-draft-client.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const README = cliDocs();
const PG_BUDGET = spawnBudget(2);

const PREVIEW = {
  id: "r1",
  message_id: "m1",
  thread_id: "t1",
  to: "bob@example.com",
  cc: null,
  subject: "Invoice",
  in_reply_to: null,
  preview: "Hi Bob",
  hash: "0123456789ab",
};

function stub(answers: Record<string, unknown>): { transport: ApiTransport; calls: ApiRequest[] } {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const key = `${req.method} ${req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]}`;
    if (!(key in answers)) {
      return { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }) };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

const api = (s: { transport: ApiTransport }) => ({ api: { base: BASE, token: "t", transport: s.transport } });

describe("docs (1757)", () => {
  test("HELP, README and ob-infra name draft and send-draft --confirm --hash", () => {
    const help = `${renderSubcommandHelp("gmail", "draft")}\n${renderSubcommandHelp("gmail", "send-draft")}`;
    for (const doc of [help, README]) {
      expect(doc).toContain("gmail draft");
      expect(doc).toContain("send-draft <draft-id> --confirm --hash <hex>");
    }
    expect(README).toContain("/api/ob/gmail/drafts");
  });
});

describe("`ob gmail draft` over a stub transport (1757)", () => {
  test("POSTs /gmail/drafts with the fields and prints the id, preview and DRAFT ONLY", async () => {
    const s = stub({ "POST /gmail/drafts": PREVIEW });
    const r = await runCli(
      freshDbPath(),
      ["gmail", "draft", "--to", "bob@example.com", "--subject", "Invoice", "--body", "Hi Bob", "--cc", "c@x.com"],
      api(s),
    );
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({
      to: "bob@example.com",
      subject: "Invoice",
      body: "Hi Bob",
      cc: "c@x.com",
    });
    expect(r.out).toContain("draft r1");
    expect(r.out).toContain("DRAFT ONLY — nothing was sent");
    expect(r.out).toContain("ob gmail send-draft r1");
    expect(r.out).not.toContain("--confirm");
  });

  test("--body-file is read on THIS machine and its text travels; --reply-to rides along", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-1757-"));
    const file = join(dir, "body.txt");
    writeFileSync(file, "line one\nline two\n");
    const s = stub({ "POST /gmail/drafts": PREVIEW });
    const r = await runCli(
      freshDbPath(),
      ["gmail", "draft", "--to", "a@x.com", "--body-file", file, "--reply-to", "orig"],
      api(s),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ to: "a@x.com", body: "line one\nline two\n", reply_to: "orig" });
  });

  test("missing --to or a body is a usage error BEFORE any request", async () => {
    for (const args of [["gmail", "draft", "--body", "x", "--subject", "s"], ["gmail", "draft", "--to", "a@x.com"]]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), args, api(s));
      expect(r.code).toBe(2);
      expect(s.calls).toEqual([]);
    }
  });
});

describe("`ob gmail send-draft` over a stub transport (1757)", () => {
  test("without --confirm it shows the recipients/subject and hash, refuses (exit 2) and never POSTs send", async () => {
    const s = stub({ "GET /gmail/drafts/r1": PREVIEW });
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1"], api(s));
    expect(r.code).toBe(2);
    expect(r.out).toContain("to:      bob@example.com");
    expect(r.out).toContain("subject: Invoice");
    expect(r.out).toContain("hash:    0123456789ab");
    expect(r.err).toContain("refuses without --confirm and --hash");
    expect(r.err).toContain("ob gmail send-draft r1 --confirm --hash 0123456789ab");
    expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("OB-1910: --confirm without --hash (or an empty one) is the preview and exit 2, never a send", async () => {
    for (const extra of [[], ["--hash", ""], ["--hash", "  "]]) {
      const s = stub({ "GET /gmail/drafts/r1": PREVIEW });
      const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1", "--confirm", ...extra], api(s));
      expect(r.code).toBe(2);
      expect(r.err).toContain("--confirm --hash 0123456789ab");
      expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });

  test("OB-1910: a trashed draft's preview says it cannot be sent", async () => {
    const s = stub({ "GET /gmail/drafts/r1": { ...PREVIEW, trashed: true } });
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("Trash");
    expect(r.err).not.toContain("--hash 0123456789ab");
  });

  test("--yes is not --confirm", async () => {
    const s = stub({ "GET /gmail/drafts/r1": PREVIEW });
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1", "--yes"], api(s));
    expect(r.code).toBe(2);
    expect(s.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("with --confirm --hash it POSTs /gmail/drafts/r1/send {confirm:true,hash} and prints who it went to", async () => {
    const s = stub({ "POST /gmail/drafts/r1/send": { ...PREVIEW, sent_message_id: "s9" } });
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1", "--confirm", "--hash", "0123456789ab"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ confirm: true, hash: "0123456789ab" });
    expect(r.out).toContain("sent draft r1 → message s9");
    expect(r.out).toContain("to:      bob@example.com");
  });

  test("OB-1910: a host refusal (stale hash) is exit 2 in API mode too", async () => {
    const calls: ApiRequest[] = [];
    const transport: ApiTransport = async (req) => {
      calls.push(req);
      return { status: 400, body: JSON.stringify({ error: { code: "usage", message: "the draft changed since the hash you confirmed (it is now ffffffffffff)" } }) };
    };
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "r1", "--confirm", "--hash", "0123456789ab"], api({ transport }));
    expect(r.code).toBe(2);
    expect(r.err).toContain("ffffffffffff");
    expect(calls).toHaveLength(1);
  });

  test("a missing draft id is a usage error before any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["gmail", "send-draft", "--confirm"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("requires a <draft-id>");
    expect(s.calls).toEqual([]);
  });
});

// --- server half ---------------------------------------------------------------------------------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

async function withApi(fn: (call: (path: string, body?: unknown) => Promise<{ status: number; body: any }>, g: FakeDraftClient) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const gmailDrafts = new FakeDraftClient();
  const app = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    gmailDrafts,
  });
  const call = async (path: string, body?: unknown) => {
    const res = await app(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${TOKEN_S}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call, gmailDrafts);
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("server /gmail/drafts (1757)", () => {
  test("POST /gmail/drafts creates a draft through the injected client and sends nothing", async () => {
    await withApi(async (call, g) => {
      const res = await call("/gmail/drafts", { to: "a@x.com", subject: "Hi", body: "hello\n" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "r1", to: "a@x.com", subject: "Hi", preview: "hello\n" });
      expect(g.created).toHaveLength(1);
      expect(g.sent).toEqual([]);
    });
  }, PG_BUDGET);

  test("send without confirm:true is a named 400 and Gmail is never asked to send", async () => {
    await withApi(async (call, g) => {
      g.drafts.set("d1", { id: "d1", message: { id: "m", payload: { headers: [{ name: "To", value: "b@x.com" }] } } });
      for (const body of [{ hash: "abc" }, { confirm: false, hash: "abc" }]) {
        const res = await call("/gmail/drafts/d1/send", body);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain("refuses without --confirm");
      }
      const typo = await call("/gmail/drafts/d1/send", { confirm: "true", hash: "abc" });
      expect(typo.status).toBe(400);
      expect(g.sent).toEqual([]);
    });
  }, PG_BUDGET);

  test("OB-1910: send with confirm:true and no hash (or a non-string one) is a 400 before Gmail is called", async () => {
    await withApi(async (call, g) => {
      g.drafts.set("d1", { id: "d1", message: { id: "m", payload: { headers: [{ name: "To", value: "b@x.com" }] } } });
      for (const body of [{ confirm: true }, { confirm: true, hash: 42 }, { confirm: true, hash: "" }, { confirm: true, hash: null }]) {
        const res = await call("/gmail/drafts/d1/send", body);
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain("hash");
      }
      expect(g.sent).toEqual([]);
    });
  }, PG_BUDGET);

  test("GET a draft previews it; send with confirm:true sends that draft", async () => {
    await withApi(async (call, g) => {
      g.drafts.set("d1", { id: "d1", message: { id: "m", payload: { headers: [{ name: "To", value: "b@x.com" }, { name: "Subject", value: "S" }] } } });
      const show = await call("/gmail/drafts/d1");
      expect(show.status).toBe(200);
      expect(show.body).toMatchObject({ id: "d1", to: "b@x.com", subject: "S" });
      expect(g.sent).toEqual([]);
      const sent = await call("/gmail/drafts/d1/send", { confirm: true, hash: show.body.hash });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ id: "d1", to: "b@x.com", sent_message_id: "sent-d1" });
      expect(g.sent).toEqual(["d1"]);
    });
  }, PG_BUDGET);
});

// --- 1680: read, attachment and --attach over the API ----------------------------------------------------

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a]);
const MSG_READ = {
  id: "1a17da28a46167ec",
  thread_id: "t1",
  from: "Ixia <a@ixia.example>",
  to: "me@example.com",
  cc: null,
  subject: "Invoice 4411",
  date: null,
  body: "Please find the invoice attached.",
  attachments: [{ filename: "Invoice 4411.pdf", mime: "application/pdf", size: PDF_BYTES.length, attachment_id: "ATT1" }],
};
const ATTACHMENTS = {
  message_id: "1a17da28a46167ec",
  attachments: [
    { filename: "Invoice 4411.pdf", mime: "application/pdf", size: PDF_BYTES.length, data_base64: PDF_BYTES.toString("base64") },
  ],
};

describe("docs (1680)", () => {
  test("HELP, README and ob-infra name read, attachment and --attach", () => {
    const help = [
      renderSubcommandHelp("gmail", "read"),
      renderSubcommandHelp("gmail", "attachment"),
      renderSubcommandHelp("gmail", "draft"),
    ].join("\n");
    for (const doc of [help, README]) {
      expect(doc).toContain("gmail read");
      expect(doc).toContain("gmail attachment");
    }
    for (const doc of [help, README]) expect(doc).toContain("--attach");
    expect(README).toContain("/api/ob/gmail/messages/");
  });
});

describe("`ob gmail read` / `attachment` over a stub transport (1680)", () => {
  test("read GETs /gmail/messages/<id> and prints the headers, body and attachment list", async () => {
    const s = stub({ "GET /gmail/messages/1a17da28a46167ec": MSG_READ });
    const r = await runCli(freshDbPath(), ["gmail", "read", "1a17da28a46167ec"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(r.out).toContain("subject: Invoice 4411");
    expect(r.out).toContain("Invoice 4411.pdf\tapplication/pdf");
    expect(r.out).toContain("Please find the invoice attached.");
  });

  test("read --json prints the message object", async () => {
    const s = stub({ "GET /gmail/messages/1a17da28a46167ec": MSG_READ });
    const r = await runCli(freshDbPath(), ["--json", "gmail", "read", "1a17da28a46167ec"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(MSG_READ);
  });

  test("read without an id, or with a path-ish one, is a usage error BEFORE any request", async () => {
    for (const args of [["gmail", "read"], ["gmail", "read", "../x"]]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), args, api(s));
      expect(r.code).toBe(2);
      expect(s.calls).toEqual([]);
    }
  });

  test("attachment writes the bytes HERE, to --out, and prints the path", async () => {
    const out = mkdtempSync(join(tmpdir(), "ob-1680-"));
    const s = stub({ "GET /gmail/messages/1a17da28a46167ec/attachments": ATTACHMENTS });
    const r = await runCli(freshDbPath(), ["gmail", "attachment", "1a17da28a46167ec", "--out", out], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(out, "Invoice 4411.pdf"));
    expect(readFileSync(join(out, "Invoice 4411.pdf")).equals(PDF_BYTES)).toBe(true);
  });

  test("attachment --name rides as ?name=; a second save refuses without --force", async () => {
    const out = mkdtempSync(join(tmpdir(), "ob-1680-"));
    const s = stub({ "GET /gmail/messages/1a17da28a46167ec/attachments": ATTACHMENTS });
    const args = ["gmail", "attachment", "1a17da28a46167ec", "--name", "Invoice 4411.pdf", "--out", out];
    expect((await runCli(freshDbPath(), args, api(s))).code).toBe(0);
    expect(s.calls[0]!.url).toContain("?name=Invoice+4411.pdf");
    const again = await runCli(freshDbPath(), args, api(s));
    expect(again.code).toBe(2);
    expect(again.err).toContain("refusing to overwrite");
    expect((await runCli(freshDbPath(), [...args, "--force"], api(s))).code).toBe(0);
  });
});

describe("`ob gmail draft --attach` over a stub transport (1680)", () => {
  test("the file is read on THIS machine and its bytes travel as base64", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-1680-"));
    const file = join(dir, "Invoice 4411.pdf");
    writeFileSync(file, PDF_BYTES);
    const s = stub({ "POST /gmail/drafts": { ...PREVIEW, attachments: [{ filename: "Invoice 4411.pdf", mime: "application/pdf", size: 8 }] } });
    const r = await runCli(
      freshDbPath(),
      ["gmail", "draft", "--to", "a@x.com", "--subject", "s", "--body", "b", "--attach", file],
      api(s),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!).attachments).toEqual([
      { filename: "Invoice 4411.pdf", mime: "application/pdf", data_base64: PDF_BYTES.toString("base64") },
    ]);
    expect(r.out).toContain("attach:  Invoice 4411.pdf (application/pdf, 8 B)");
    expect(r.out).toContain("DRAFT ONLY — nothing was sent");
  });

  test("--attach is repeatable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-1680-"));
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    const s = stub({ "POST /gmail/drafts": PREVIEW });
    const r = await runCli(freshDbPath(), ["gmail", "draft", "--to", "a@x.com", "--subject", "s", "--body", "b", "--attach", a, "--attach", b], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!).attachments.map((x: { filename: string }) => x.filename)).toEqual(["a.txt", "b.txt"]);
  });

  test("a missing --attach file is a usage error BEFORE any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["gmail", "draft", "--to", "a@x.com", "--subject", "s", "--body", "b", "--attach", "/nope/missing.pdf"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot read --attach /nope/missing.pdf");
    expect(s.calls).toEqual([]);
  });
});

describe("server /gmail/messages and draft attachments (1680)", () => {
  function seed(g: FakeDraftClient): void {
    g.messages.set("m1", {
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "Invoice" }, { name: "From", value: "a@ixia.example" }],
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("see pdf").toString("base64url") } },
          { mimeType: "application/pdf", filename: "i.pdf", body: { attachmentId: "A1", size: PDF_BYTES.length } },
        ],
      },
    });
    g.attachments.set("m1/A1", { size: PDF_BYTES.length, data: PDF_BYTES.toString("base64url") });
  }

  test("GET /gmail/messages/:id reads the message and touches no attachment", async () => {
    await withApi(async (call, g) => {
      seed(g);
      const res = await call("/gmail/messages/m1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "m1", subject: "Invoice", body: "see pdf" });
      expect(res.body.attachments).toEqual([{ filename: "i.pdf", mime: "application/pdf", size: 8, attachment_id: "A1" }]);
      expect(g.attachmentFetches).toEqual([]);
      expect(g.sent).toEqual([]);
    });
  }, PG_BUDGET);

  test("GET /gmail/messages/:id/attachments returns the bytes; ?name= picks one; unknown is a named 4xx", async () => {
    await withApi(async (call, g) => {
      seed(g);
      const all = await call("/gmail/messages/m1/attachments");
      expect(all.status).toBe(200);
      expect(Buffer.from(all.body.attachments[0].data_base64, "base64").equals(PDF_BYTES)).toBe(true);
      const one = await call("/gmail/messages/m1/attachments?name=i.pdf");
      expect(one.body.attachments).toHaveLength(1);
      const none = await call("/gmail/messages/m1/attachments?name=zzz.pdf");
      expect(none.status).toBeGreaterThanOrEqual(400);
      expect(none.status).toBeLessThan(500);
      expect(none.body.error.message).toContain("no attachment named 'zzz.pdf'");
    });
  }, PG_BUDGET);

  test("POST /gmail/drafts with attachments builds a multipart draft and sends nothing", async () => {
    await withApi(async (call, g) => {
      const res = await call("/gmail/drafts", {
        to: "a@x.com",
        subject: "Claim",
        body: "attached",
        attachments: [{ filename: "i.pdf", mime: "application/pdf", data_base64: PDF_BYTES.toString("base64") }],
      });
      expect(res.status).toBe(200);
      expect(res.body.attachments).toEqual([{ filename: "i.pdf", mime: "application/pdf", size: 8 }]);
      const raw = Buffer.from(g.created[0]!.raw, "base64url").toString("utf8");
      expect(raw).toContain("multipart/mixed");
      expect(raw).toContain('filename="i.pdf"');
      expect(g.sent).toEqual([]);
    });
  }, PG_BUDGET);

  test("a malformed attachments field is a named 400 and creates no draft", async () => {
    await withApi(async (call, g) => {
      for (const attachments of ["x", [1], [{ filename: "", data_base64: "" }], [{ filename: "a", data_base64: 5 }]]) {
        const res = await call("/gmail/drafts", { to: "a@x.com", subject: "s", body: "b", attachments });
        expect(res.status).toBe(400);
      }
      expect(g.created).toEqual([]);
    });
  }, PG_BUDGET);

  test("a draft body over 1 MB is accepted (files ride in it); the other routes keep the 1 MB cap", async () => {
    await withApi(async (call, g) => {
      const big = Buffer.alloc(2_000_000, 7).toString("base64");
      const ok = await call("/gmail/drafts", {
        to: "a@x.com",
        subject: "s",
        body: "b",
        attachments: [{ filename: "big.bin", data_base64: big }],
      });
      expect(ok.status).toBe(200);
      expect(g.created).toHaveLength(1);
      const tooBig = await call("/gmail/drafts/d1/send", { confirm: false, pad: "x".repeat(1_100_000) });
      expect(tooBig.status).toBe(413);
    });
  }, PG_BUDGET);
});
