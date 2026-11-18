// OB-2004 -- `ob doc`: reference documents, a living, versioned, non-task record.
//
// Local half: the real command through `runCli` against a temp SQLite file. API half: the same commands
// through the API client against the in-process server (`createObApi`), as `ob decision` is proven.
import { describe, expect, test } from "bun:test";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { computeAlerts } from "../../../apps/cli/src/commands/alerts.ts";
import { createItem, referenceVersions } from "../../../apps/cli/src/items.ts";
import { setTodayRank } from "../../../apps/cli/src/workflow.ts";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";

const TOKEN = "test-token-do-not-log";
const BASE = "https://ob.example.test";
const BODY_ONE = "Bumble bio\n\n  two spaces, a trailing space \nand a last line with no newline";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function ok(db: string, args: string[], deps = {}): Promise<string> {
  const r = await runCli(db, args, deps);
  if (r.code !== 0) throw new Error(`ob ${args.join(" ")} exited ${r.code}: ${r.err}${r.out}`);
  return r.out;
}

/** A fresh DB with the `personal` project and one reference in it; returns the db path and the reference id. */
async function seeded(): Promise<{ path: string; id: string }> {
  const path = freshDbPath();
  await ok(path, ["project", "add", "personal", "--kind", "home"]);
  const id = (await ok(path, ["doc", "add", "Bumble profile", "--project", "personal", "--body", BODY_ONE, "--quiet"])).trim();
  return { path, id };
}

describe("the reference never enters the queue (1)", () => {
  test("not in ob next, ob list --open, ob status focus or blocked, or alert rule 2", async () => {
    const { path, id } = await seeded();
    const db = openDb(path);
    await setTodayRank(db, id, 1);
    db.query("UPDATE item SET priority = 2, updated_at = ? WHERE id = ?").run(daysAgo(30), id);
    const task = await createItem(db, { type: "task", title: "a real task", priority: 2 });
    db.query("UPDATE item SET updated_at = ? WHERE id = ?").run(daysAgo(30), task);

    const next = JSON.parse(await ok(path, ["next", "--json"]));
    expect(JSON.stringify(next)).not.toContain("Bumble profile");
    const list = JSON.parse(await ok(path, ["list", "--open", "--json"]));
    expect(JSON.stringify(list)).not.toContain("Bumble profile");
    expect(JSON.stringify(list)).toContain("a real task");

    const status = JSON.parse(await ok(path, ["status", "--json"]));
    expect(status.focus.map((i: { title: string }) => i.title)).not.toContain("Bumble profile");
    expect(status.blocked.map((i: { title: string }) => i.title)).not.toContain("Bumble profile");

    const keys = (await computeAlerts(sqliteStoreFor(db), { focusProject: null })).map((a) => a.key);
    expect(keys).toContain(`aging:${task}`);
    expect(keys).not.toContain(`aging:${id}`);
  });
});

describe("every change keeps a version (2)", () => {
  test("doc set --body, doc set --title alone, ob edit --body and ob note each write one", async () => {
    const { path, id } = await seeded();
    const db = openDb(path);
    const count = async () => (await referenceVersions(db, id)).length;
    expect(await count()).toBe(0);

    await ok(path, ["doc", "set", id, "--body", "second text"]);
    expect(await count()).toBe(1);
    await ok(path, ["doc", "set", id, "--title", "Bumble profile v2"]);
    expect(await count()).toBe(2);
    await ok(path, ["edit", id, "--body", "third text"]);
    expect(await count()).toBe(3);
    await ok(path, ["note", id, "a note"]);
    expect(await count()).toBe(4);

    const history = JSON.parse(await ok(path, ["doc", "history", id, "--json"]));
    expect(history.map((v: { n: number }) => v.n)).toEqual([4, 3, 2, 1]);
    expect(history[0].body).toBe("third text");
    expect(history[3].title).toBe("Bumble profile");

    // the human form is the text itself: no header and no newline added (printRaw -> process.stdout)
    const realWrite = process.stdout.write.bind(process.stdout);
    let raw = "";
    (process.stdout.write as unknown) = (chunk: string, cb?: () => void) => {
      raw += chunk;
      cb?.();
      return true;
    };
    try {
      await ok(path, ["doc", "show", id, "--version", "1"]);
    } finally {
      (process.stdout.write as unknown) = realWrite;
    }
    expect(raw).toBe(BODY_ONE);
    const v1json = JSON.parse(await ok(path, ["doc", "show", id, "--version", "1", "--json"]));
    expect(v1json.body).toBe(BODY_ONE);
  });

  test("an edit that changes nothing writes no version", async () => {
    const { path, id } = await seeded();
    await ok(path, ["doc", "set", id, "--body", BODY_ONE]);
    expect((await referenceVersions(openDb(path), id)).length).toBe(0);
  });
});

describe("a reference has no status to move (3)", () => {
  test("close, start and block refuse, name ob doc, and leave it active", async () => {
    const { path, id } = await seeded();
    for (const args of [["close", id], ["start", id], ["block", id, "--reason", "x"]]) {
      const r = await runCli(path, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("ob doc");
    }
    const shown = JSON.parse(await ok(path, ["doc", "show", id, "--json"]));
    expect(shown.status).toBe("active");
  });
});

describe("list, show, search (4)", () => {
  test("ob search finds a word in the body; doc list --project personal lists it; show --json has the whole body", async () => {
    const { path, id } = await seeded();
    expect(await ok(path, ["search", "trailing"])).toContain("Bumble profile");
    expect(await ok(path, ["doc", "list", "--project", "personal"])).toContain("Bumble profile");
    expect(await ok(path, ["doc", "--project", "personal"])).toContain("Bumble profile");
    expect(JSON.parse(await ok(path, ["doc", "show", id, "--json"])).body).toBe(BODY_ONE);
  });

  test("add needs --project and a body; show refuses a task; bad --version is a usage error", async () => {
    const { path, id } = await seeded();
    expect((await runCli(path, ["doc", "add", "x", "--body", "y"])).code).not.toBe(0);
    expect((await runCli(path, ["doc", "add", "x", "--project", "personal"])).code).not.toBe(0);
    const task = (await ok(path, ["add", "just a task", "--project", "acme", "--quiet"])).trim();
    expect((await runCli(path, ["doc", "show", task])).code).not.toBe(0);
    expect((await runCli(path, ["doc", "show", id, "--version", "9"])).code).not.toBe(0);
  });
});

describe("ob rm takes the versions with it", () => {
  test("no reference_version event is left behind", async () => {
    const { path, id } = await seeded();
    await ok(path, ["doc", "set", id, "--body", "second"]);
    await ok(path, ["rm", id]);
    const n = openDb(path).query("SELECT count(*) AS n FROM event WHERE type = 'reference_version'").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("editing a task writes no reference_version (6)", () => {
  test("ob edit --body and ob note on a task add no event", async () => {
    const path = freshDbPath();
    const task = (await ok(path, ["add", "a task", "--project", "acme", "--body", "first", "--quiet"])).trim();
    await ok(path, ["edit", task, "--body", "second"]);
    await ok(path, ["note", task, "more"]);
    const db = openDb(path);
    const n = db.query("SELECT count(*) AS n FROM event WHERE type = 'reference_version'").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("over the API (5)", () => {
  test("doc is routed and has a client handler", () => {
    expect(API_ROUTED_COMMANDS.has("doc")).toBe(true);
    expect(typeof API_HANDLERS.doc).toBe("function");
  });

  test("doc add, set, history and show work through the client against the in-process server", async () => {
    const serverPath = freshDbPath();
    await ok(serverPath, ["project", "add", "personal", "--kind", "home"]);
    const db = openDb(serverPath);
    const store = sqliteStoreFor(db);
    const obApi = createObApi({
      store: async () => store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    const transport: ApiTransport = async (req) => {
      const res = await obApi(
        new Request(req.url.replace(BASE, "http://api-host.local"), {
          method: req.method,
          headers: { authorization: `Bearer ${TOKEN}`, ...(req.body === undefined ? {} : { "content-type": "application/json" }) },
          ...(req.body === undefined ? {} : { body: req.body }),
        }),
      );
      return { status: res.status, body: await res.text() };
    };
    const deps = { api: { base: BASE, token: TOKEN, transport } };
    const clientDb = freshDbPath();

    const id = (await ok(clientDb, ["doc", "add", "Bumble profile", "--project", "personal", "--body", BODY_ONE, "--quiet"], deps)).trim();
    expect(id.length).toBeGreaterThan(0);
    await ok(clientDb, ["doc", "set", id, "--body", "replaced"], deps);
    await ok(clientDb, ["doc", "set", id, "--title", "Renamed"], deps);

    const history = JSON.parse(await ok(clientDb, ["doc", "history", id, "--json"], deps));
    expect(history.map((v: { n: number }) => v.n)).toEqual([2, 1]);
    const v1 = JSON.parse(await ok(clientDb, ["doc", "show", id, "--version", "1", "--json"], deps));
    expect(v1.body).toBe(BODY_ONE);
    const now = JSON.parse(await ok(clientDb, ["doc", "show", id, "--json"], deps));
    expect(now.body).toBe("replaced");
    expect(now.title).toBe("Renamed");
    expect(await ok(clientDb, ["doc", "list", "--project", "personal"], deps)).toContain("Renamed");

    // the server's own store holds the versions
    expect((await referenceVersions(store, id)).length).toBe(2);
  }, spawnBudget(1));
});
