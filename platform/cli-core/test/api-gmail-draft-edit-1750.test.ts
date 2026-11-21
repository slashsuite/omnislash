// OB-1750 -- `ob gmail drafts` / `draft-edit` / `draft-delete` over the API. The client half runs on a stubbed
// transport (no network); the server half on a real store via the ob 325 harness with a fake Gmail drafts
// client injected, so nothing real is edited, deleted or sent.
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

const BASE = "https://ob.example.test";
const README = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");
const PG_BUDGET = spawnBudget(2);

const PREVIEW = {
  id: "d1",
  message_id: "m1",
  thread_id: "t1",
  to: "bob@example.com",
  cc: null,
  subject: "Invoice",
  in_reply_to: null,
  preview: "Hi Bob",
  attachments: [],
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
const scratch = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-1750-"));

describe("docs (OB-1750)", () => {
  test("HELP and README name the three commands, --confirm on delete and the routes", () => {
    const help = [
      renderSubcommandHelp("gmail", "drafts"),
      renderSubcommandHelp("gmail", "draft-edit"),
      renderSubcommandHelp("gmail", "draft-delete"),
    ].join("\n");
    for (const doc of [help, README]) {
      for (const c of ["gmail drafts", "gmail draft-edit", "gmail draft-delete"]) expect(doc).toContain(c);
    }
    expect(help).toContain("--confirm");
    expect(README).toContain("/api/ob/gmail/drafts/:id/edit");
    expect(README).toContain("draft-delete");
  });
});

describe("`ob gmail drafts` over a stub transport (OB-1750)", () => {
  test("GETs /gmail/drafts?limit and prints id, to, subject", async () => {
    const s = stub({ "GET /gmail/drafts": { drafts: [PREVIEW, { ...PREVIEW, id: "d2", subject: "" }] } });
    const r = await runCli(freshDbPath(), ["gmail", "drafts", "--limit", "5"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls[0]!.method).toBe("GET");
    expect(s.calls[0]!.url).toContain("/gmail/drafts?limit=5");
    expect(r.out).toContain("d1\tbob@example.com\tInvoice");
    expect(r.out).toContain("d2\tbob@example.com\t(no subject)");
  });
});

describe("`ob gmail draft-edit` over a stub transport (OB-1750)", () => {
  test("POSTs only the flags passed to /gmail/drafts/d1/edit and says nothing was sent", async () => {
    const s = stub({ "POST /gmail/drafts/d1/edit": { ...PREVIEW, subject: "Fixed" } });
    const r = await runCli(freshDbPath(), ["gmail", "draft-edit", "d1", "--subject", "Fixed"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ subject: "Fixed" });
    expect(r.out).toContain("DRAFT UPDATED — nothing was sent");
    expect(r.out).toContain("ob gmail send-draft d1");
    expect(r.out).not.toContain("--confirm");
  });

  test("--body-file and --attach are read HERE and their bytes travel; --no-attach sends attachments:[]", async () => {
    const dir = scratch();
    const body = join(dir, "b.txt");
    const file = join(dir, "n.txt");
    writeFileSync(body, "new words\n");
    writeFileSync(file, "hello");
    const s = stub({ "POST /gmail/drafts/d1/edit": PREVIEW });
    expect((await runCli(freshDbPath(), ["gmail", "draft-edit", "d1", "--body-file", body, "--attach", file], api(s))).code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({
      body: "new words\n",
      attachments: [{ filename: "n.txt", mime: "text/plain", data_base64: Buffer.from("hello").toString("base64") }],
    });
    const t = stub({ "POST /gmail/drafts/d1/edit": PREVIEW });
    expect((await runCli(freshDbPath(), ["gmail", "draft-edit", "d1", "--no-attach"], api(t))).code).toBe(0);
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ attachments: [] });
  });

  test("no id, nothing to change, or --attach with --no-attach is a usage error BEFORE any request", async () => {
    for (const args of [["gmail", "draft-edit", "--subject", "x"], ["gmail", "draft-edit", "d1", "--attach", "/etc/hostname", "--no-attach"]]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), args, api(s));
      expect(r.code).toBe(2);
      expect(s.calls).toEqual([]);
    }
  });
});

describe("`ob gmail draft-delete` over a stub transport (OB-1750)", () => {
  test("without --confirm (--yes is not it) it shows the draft, refuses (exit 2) and never DELETEs", async () => {
    for (const extra of [[], ["--yes"]]) {
      const s = stub({ "GET /gmail/drafts/d1": PREVIEW });
      const r = await runCli(freshDbPath(), ["gmail", "draft-delete", "d1", ...extra], api(s));
      expect(r.code).toBe(2);
      expect(r.out).toContain("subject: Invoice");
      expect(r.err).toContain("refuses without --confirm");
      expect(s.calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });

  test("with --confirm it DELETEs /gmail/drafts/d1?confirm=true and says which draft went", async () => {
    const s = stub({ "DELETE /gmail/drafts/d1": { ...PREVIEW, deleted: true } });
    const r = await runCli(freshDbPath(), ["gmail", "draft-delete", "d1", "--confirm"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toContain("/gmail/drafts/d1?confirm=true");
    expect(r.out).toContain("deleted draft d1 (nothing was sent)");
    expect(r.out).toContain("subject: Invoice");
  });
});

// --- server half ---------------------------------------------------------------------------------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withApi(fn: (call: Call, g: FakeDraftClient) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const gmailDrafts = new FakeDraftClient();
  const app = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    gmailDrafts,
  });
  const call: Call = async (method, path, body) => {
    const res = await app(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method,
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

const seed = (g: FakeDraftClient, id: string, subject = "S") =>
  g.drafts.set(id, {
    id,
    message: {
      id: `m-${id}`,
      threadId: `t-${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "To", value: "b@x.com" }, { name: "Cc", value: "c@x.com" }, { name: "Subject", value: subject }],
        body: { data: Buffer.from("hello").toString("base64url") },
      },
    },
  });

describe("`ob gmail drafts` marks a trashed draft (OB-1752)", () => {
  test("text output appends [trash]; --json keeps the flag", async () => {
    const s = stub({ "GET /gmail/drafts": { drafts: [{ ...PREVIEW, id: "d2", trashed: true }, PREVIEW] } });
    const r = await runCli(freshDbPath(), ["gmail", "drafts"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("d2\tbob@example.com\tInvoice\t[trash]");
    expect(r.out).toContain("d1\tbob@example.com\tInvoice");
    expect(r.out).not.toContain("d1\tbob@example.com\tInvoice\t[trash]");
    const j = await runCli(freshDbPath(), ["gmail", "drafts", "--json"], api(s));
    expect(JSON.parse(j.out)[0].trashed).toBe(true);
  });
});

describe("server /gmail/drafts list, edit and delete (OB-1750)", () => {
  // One database for the lot: none of these routes touch the store.
  test("list, edit in place, refuse an empty edit, refuse an unconfirmed delete, then delete", async () => {
    await withApi(async (call, g) => {
      seed(g, "d1", "One");
      seed(g, "d2", "Two");
      const all = await call("GET", "/gmail/drafts");
      expect(all.status).toBe(200);
      expect(all.body.drafts.map((d: any) => d.subject)).toEqual(["Two", "One"]);
      // OB-1752: a draft discarded in Gmail is only labelled TRASH. drafts.get reads it and a default drafts.list
      // omits it (the fake does the same), so `ob gmail drafts` once printed [] with it still readable by id.
      seed(g, "d3", "Discarded in Gmail");
      g.drafts.get("d3")!.message!.labelIds = ["DRAFT", "TRASH"];
      expect((await call("GET", "/gmail/drafts/d3")).body).toMatchObject({ id: "d3", trashed: true });
      expect((await call("GET", "/gmail/drafts")).body.drafts.map((d: any) => [d.id, d.trashed ?? false])).toEqual([["d3", true], ["d2", false], ["d1", false]]);
      g.drafts.delete("d3");
      expect((await call("GET", "/gmail/drafts?limit=1")).body.drafts).toHaveLength(1);
      expect((await call("GET", "/gmail/drafts?limit=0")).status).toBe(400);

      const edit = await call("POST", "/gmail/drafts/d1/edit", { subject: "Fixed" });
      expect(edit.status).toBe(200);
      expect(edit.body).toMatchObject({ id: "d1", to: "b@x.com", cc: "c@x.com", subject: "Fixed", preview: "hello" });
      expect(g.updated).toHaveLength(1);
      expect(g.updated[0]).toMatchObject({ id: "d1", threadId: "t-d1" });
      expect((await call("POST", "/gmail/drafts/d1/edit", {})).status).toBe(400);
      expect(g.updated).toHaveLength(1);

      const refused = await call("DELETE", "/gmail/drafts/d1");
      expect(refused.status).toBe(400);
      expect(refused.body.error.message).toContain("refuses without --confirm");
      expect(g.deleted).toEqual([]);

      const res = await call("DELETE", "/gmail/drafts/d1?confirm=true");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "d1", deleted: true, to: "b@x.com" });
      expect(g.deleted).toEqual(["d1"]);
      expect([...g.drafts.keys()]).toEqual(["d2"]);
      expect(g.sent).toEqual([]);
      expect(g.created).toEqual([]);
    });
  }, PG_BUDGET);
});
