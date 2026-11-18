// OB-1754: OB-1751's bare-number refusal also fires in API mode (how every machine runs ob). The real CLI client
// talks to the real API server (createObApi) over a SQLite store, through an in-process transport: no network.
import { describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

const BASE = "https://ob.example.test";
const TOKEN = "a-test-bearer-token-that-is-long-enough";

/** id 1 = PS-1, id 2 = OB-1, id 3 = OB-2: bare `1` and `2` are each also the other's OB-n; bare `3` is clean. */
async function drifted() {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  await registerProject(db, { name: "pixelslash", kind: "side" });
  const ps = await createItem(db, { type: "task", title: "ps one", projectId: "pixelslash" });
  const a = await createItem(db, { type: "task", title: "ob one" });
  const b = await createItem(db, { type: "task", title: "ob two" });
  const store = sqliteStoreFor(db);
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }),
  });
  const transport: ApiTransport = async (req) => {
    const res = await api(
      new Request(req.url, { method: req.method, headers: req.headers, ...(req.body === undefined ? {} : { body: req.body }) }),
    );
    return { status: res.status, body: await res.text() };
  };
  // The CLI side has no database in API mode; `dbPath` only keeps runCli's env pointed at a throwaway file.
  const cli = (args: string[]) => runCli(freshDbPath(), args, { api: { base: BASE, token: TOKEN, transport } });
  return { db, ps, a, b, cli };
}

describe("a bare number that is also a different OB-n key, through the API (OB-1754)", () => {
  test("`note <bare>` is refused with both items named, and writes nothing", async () => {
    const { db, ps, a, cli } = await drifted();
    const r = await cli(["note", "1", "hello"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/'1' is ambiguous.*PS-1.*OB-1/);
    expect((await getItem(db, ps))?.body ?? "").not.toContain("hello");
    expect((await getItem(db, a))?.body ?? "").not.toContain("hello");
  });

  test("the typed ref and an unambiguous number still work", async () => {
    const { db, ps, a, b, cli } = await drifted();
    expect((await cli(["note", "OB-1", "to the key"])).code).toBe(0);
    expect((await getItem(db, a))?.body).toContain("to the key");
    expect((await cli(["note", "ps-1", "to the ps"])).code).toBe(0);
    expect((await getItem(db, ps))?.body).toContain("to the ps");
    expect((await cli(["note", "3", "clean"])).code).toBe(0);
    expect((await getItem(db, b))?.body).toContain("clean");
  });

  test("show, close and edit refuse too, and change nothing", async () => {
    const { db, ps, cli } = await drifted();
    for (const args of [["show", "1"], ["close", "1"], ["edit", "1", "--title", "renamed"]]) {
      const r = await cli(args);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/ambiguous/);
    }
    const row = await getItem(db, ps);
    expect(row?.status).not.toBe("done");
    expect(row?.title).toBe("ps one");
  });
});
