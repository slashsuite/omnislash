// OB-1928: every tracker status write goes through the one transition path.
//
// Pinned here: block refuses a done item and a type with no `blocked`; unblock restores the status the
// item was blocked from; `ob state` and the API `/state` `set` share one move function (block, unblock,
// reopen with its mirror); every close (local `close` and `state done`, API close, both `triage reject`
// paths) validates, lands the item's spinoff rows and clears triage; supersede is validated and on the
// trail; an item born done has closed_at. Each item's trail, replayed from its created status, gives its
// current status. In-process only: a fresh SQLite file, a fake T3 seam, a stubbed GitHub issue mover.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem, recordDecision } from "../../../apps/cli/src/decisions.ts";
import { blockItem, closeItem, startItem, transitionTo, unblockItem } from "../../../apps/cli/src/workflow.ts";
import { supersede } from "../../../apps/cli/src/commands/decision.ts";
import { __setSetIssueState, type IssueStateChange } from "../../../apps/cli/src/github-issues.ts";
import { __setT3Seam, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { enqueueSpinoff } from "../../cli-coord/src/commands/spinoff.ts";
import { statusVocab, type Kind } from "../../../apps/cli/src/status.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

const paths: string[] = [];
const restores: Array<() => void> = [];
function scratch(): string {
  const p = freshDbPath();
  paths.push(p);
  return p;
}
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const p of paths.splice(0)) {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  }
});

/** A T3 seam that answers the close path (settle, land reply, queue) and refuses everything else. */
function fakeT3(): void {
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not used on the close path`);
  };
  restores.push(
    __setT3Seam({
      projects: unused("projects") as T3Seam["projects"],
      interrupt: async () => {},
      capabilities: unused("capabilities") as T3Seam["capabilities"],
      list: unused("list") as T3Seam["list"],
      read: unused("read") as T3Seam["read"],
      launch: unused("launch") as T3Seam["launch"],
      rename: unused("rename") as T3Seam["rename"],
      settle: async () => {},
      send: async () => {},
      wait: async () => ({ runId: null, status: "idle", timedOut: false }) as never,
      queue: async () => ({ items: [], complete: true }),
      pin: async () => {},
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {},
    }),
  );
}

/** Records every GitHub issue move the mirror asks for; nothing leaves the process. */
function stubIssueState(): Array<{ number: number; want: string }> {
  const calls: Array<{ number: number; want: string }> = [];
  restores.push(
    __setSetIssueState(async (_db, repo, number, want): Promise<IssueStateChange> => {
      calls.push({ number, want });
      return { number, url: `https://github.com/${repo}/issues/${number}`, title: "t", state: want, already: false };
    }),
  );
  return calls;
}

/** A building spinoff row that serves item `id`. Returns the row id. */
async function seedSpinoff(store: Store, id: string): Promise<number> {
  const created = await enqueueSpinoff(store, {
    ticketRef: id,
    repo: "/r/repo",
    branch: `b-${id}`,
    mode: "interactive",
    brief: "x",
    launcher: "t3",
  });
  return created.row.id;
}

async function stampLaunched(dbPath: string, row: number, itemId: string): Promise<void> {
  const db = openDb(dbPath);
  db.query("UPDATE spinoff SET item_id = ?, status = 'launched' WHERE id = ?").run(itemId, row);
  db.close();
}

function spinoffStatus(dbPath: string, row: number): string {
  const db = openDb(dbPath);
  const r = db.query("SELECT status FROM spinoff WHERE id = ?").get(row) as { status: string };
  db.close();
  return r.status;
}

/**
 * Fold the trail oldest-first from the created status; it must arrive at the item's current status. The
 * trail also carries the item's spinoff ROW moves (tagged `spinoff_row`, in the row's own vocabulary), and
 * those are not item moves, so they are left out of the fold.
 */
async function expectTrailReplays(db: Store | ReturnType<typeof openDb>, id: string, created: string): Promise<void> {
  const it = (await getItem(db, id))!;
  const vocab = statusVocab(it.type, it.project_kind as Kind | null);
  const trail = (await decisionsForItem(db, id, 1000))
    .reverse()
    .filter((d) => d.spinoff_row == null || (vocab.includes(d.from) && vocab.includes(d.to)));
  let s = created;
  for (const d of trail) {
    expect(d.from).toBe(s);
    s = d.to;
  }
  expect(s).toBe((await getItem(db, id))!.status);
}

function apiFor(store: Store) {
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  return async (p: string, body: unknown = {}) => {
    const res = await api(
      new Request(`${BASE}${OB_API_PREFIX}${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

describe("block and unblock (OB-1928)", () => {
  test("block refuses a done item and a type whose vocabulary has no blocked", async () => {
    const db = openDb(scratch());
    const done = await createItem(db, { type: "task", title: "finished" });
    await closeItem(db, done);
    await expect(blockItem(db, done, "why", null)).rejects.toThrow("cannot transition from 'done' to 'blocked'");
    for (const type of ["roadmap", "decision"]) {
      const id = await createItem(db, { type, title: type });
      await expect(blockItem(db, id, "why", null)).rejects.toThrow("status 'blocked' is not valid");
    }
    await expectTrailReplays(db, done, "open");
  });

  test("block from in_progress, then unblock, restores in_progress and clears the block fields", async () => {
    const db = openDb(scratch());
    const id = await createItem(db, { type: "task", title: "blocked mid-flight" });
    await startItem(db, id);
    await blockItem(db, id, "waiting on access", "ops");
    await unblockItem(db, id);
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("in_progress");
    expect(it.block_reason).toBeNull();
    expect(it.block_owner).toBeNull();
    const [last] = await decisionsForItem(db, id);
    expect(`${last!.from} -> ${last!.to}`).toBe("blocked -> in_progress");
    await expectTrailReplays(db, id, "open");
  });

  test("unblock falls back to open for a legacy done -> blocked row, and when the trail has none", async () => {
    const db = openDb(scratch());
    const legacy = await createItem(db, { type: "task", title: "legacy" });
    await recordDecision(db, legacy, "open", "done");
    db.query("UPDATE item SET status = 'blocked', block_reason = 'x' WHERE id = ?").run(legacy);
    await recordDecision(db, legacy, "done", "blocked");
    await unblockItem(db, legacy);
    expect((await getItem(db, legacy))!.status).toBe("open");
    expect((await getItem(db, legacy))!.closed_at).toBeNull();

    const bare = await createItem(db, { type: "task", title: "no trail" });
    db.query("UPDATE item SET status = 'blocked' WHERE id = ?").run(bare);
    await unblockItem(db, bare);
    expect((await getItem(db, bare))!.status).toBe("open");

    // A legacy blocked row of a type with no `open` is refused by name, not written outside its vocabulary.
    const dec = await createItem(db, { type: "decision", title: "legacy decision" });
    db.query("UPDATE item SET status = 'blocked' WHERE id = ?").run(dec);
    await expect(unblockItem(db, dec)).rejects.toThrow("status 'open' is not valid");
    expect((await getItem(db, dec))!.status).toBe("blocked");
  });

  test("unblock falls back to open when the table has no edge back from blocked (merged)", async () => {
    const db = openDb(scratch());
    const id = await createItem(db, { type: "task", title: "blocked after merge" });
    for (const to of ["in_progress", "ready", "merged"]) await transitionTo(db, id, to);
    await blockItem(db, id, "deploy stuck", null);
    await unblockItem(db, id);
    expect((await getItem(db, id))!.status).toBe("open");
    await expectTrailReplays(db, id, "open");
  });

  test("closing a blocked item clears the block fields and stamps closed_at", async () => {
    const db = openDb(scratch());
    const id = await createItem(db, { type: "task", title: "closed while blocked" });
    await blockItem(db, id, "stuck", "me");
    await closeItem(db, id);
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("done");
    expect(it.block_reason).toBeNull();
    expect(it.closed_at).not.toBeNull();
    await expectTrailReplays(db, id, "open");
  });
});

describe("ob state goes through the one move function (OB-1928)", () => {
  test("`state ready` on a blocked item clears the block and records blocked -> ready; `state blocked` again is refused", async () => {
    const dbPath = scratch();
    const id = await createItem(openDb(dbPath), { type: "task", title: "state from blocked" });
    expect((await runCli(dbPath, ["state", id, "blocked", "--reason", "first"])).code).toBe(0);
    const again = await runCli(dbPath, ["state", id, "blocked", "--reason", "overwrite"]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already blocked");
    const db = openDb(dbPath);
    expect((await getItem(db, id))!.block_reason).toBe("first");

    expect((await runCli(dbPath, ["state", id, "ready"])).code).toBe(0);
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("ready");
    expect(it.block_reason).toBeNull();
    expect(it.block_owner).toBeNull();
    const [last] = await decisionsForItem(db, id);
    expect(`${last!.from} -> ${last!.to}`).toBe("blocked -> ready");
    await expectTrailReplays(db, id, "open");
  });

  test("`state open` on a done item is a reopen and runs the reopen mirror", async () => {
    const calls = stubIssueState();
    fakeT3();
    const dbPath = scratch();
    const id = await createItem(openDb(dbPath), { type: "task", title: "reopen through state" });
    expect((await runCli(dbPath, ["issue", "link", id, "#41"])).code).toBe(0);
    expect((await runCli(dbPath, ["close", id])).code).toBe(0);
    const r = await runCli(dbPath, ["state", id, "open"]);
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      { number: 41, want: "closed" },
      { number: 41, want: "open" },
    ]);
    expect(r.out).toContain("reopened issue #41");
    const db = openDb(dbPath);
    expect((await getItem(db, id))!.closed_at).toBeNull();
    await expectTrailReplays(db, id, "open");
  });

  test("the API `set` action shares it: refuses re-blocking, unblocks, and reopens with the mirror", async () => {
    const calls = stubIssueState();
    const store = await openStore({ kind: "sqlite", path: scratch(), create: true });
    const call = apiFor(store);
    const id = await createItem(store, { type: "task", title: "api moves" });
    expect((await call(`/items/${id}/state`, { action: "set", status: "blocked", reason: "r" })).status).toBe(200);
    expect((await call(`/items/${id}/state`, { action: "set", status: "blocked", reason: "r2" })).status).not.toBe(200);
    expect((await getItem(store, id))!.block_reason).toBe("r");
    expect((await call(`/items/${id}/state`, { action: "set", status: "in_progress" })).body.status).toBe("in_progress");
    expect((await getItem(store, id))!.block_reason).toBeNull();
    expect((await call(`/items/${id}/close`, { github: false })).status).toBe(200);
    const re = await call(`/items/${id}/state`, { action: "set", status: "open" });
    expect(re.status).toBe(200);
    expect(re.body.status).toBe("open");
    // No issue link: the mirror ran and reported that there was nothing to move.
    expect(re.body.tracker).toMatchObject({ skipped: "no-link", issue_error: null });
    expect(calls).toEqual([]);
    await expectTrailReplays(store, id, "open");
  });
});

describe("every close lands the spinoff rows and clears triage (OB-1928)", () => {
  for (const door of ["state done", "close", "triage reject"] as const) {
    test(`local \`${door}\``, async () => {
      fakeT3();
      const dbPath = scratch();
      const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
      const id = await createItem(store, { type: "task", title: door, triage: true });
      const row = await seedSpinoff(store, id);
      await stampLaunched(dbPath, row, id);
      const argv = door === "state done" ? ["state", id, "done"] : door === "close" ? ["close", id] : ["triage", "reject", id];
      const r = await runCli(dbPath, argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain("marked landed: OB-1");
      expect(spinoffStatus(dbPath, row)).toBe("merged");
      const db = openDb(dbPath);
      const it = (await getItem(db, id))!;
      expect(it.status).toBe("done");
      expect(it.triage).toBe(0);
      const moves = (await decisionsForItem(db, id)).filter((d) => d.spinoff_row == null);
      expect(moves.map((d) => `${d.from} -> ${d.to}`)).toEqual(["open -> done"]);
      await expectTrailReplays(db, id, "open");
    });
  }

  for (const door of ["close", "triage reject"] as const) {
    test(`API ${door}`, async () => {
      const dbPath = scratch();
      const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
      const call = apiFor(store);
      const id = await createItem(store, { type: "task", title: door, triage: true });
      const row = await seedSpinoff(store, id);
      await stampLaunched(dbPath, row, id);
      const res = await call(door === "close" ? `/items/${id}/close` : `/triage/${id}/reject`, door === "close" ? { github: true } : undefined);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: "done", skipped: "no-link", issue_error: null });
      expect(spinoffStatus(dbPath, row)).toBe("merged");
      const it = (await getItem(store, id))!;
      expect(it.triage).toBe(0);
      await expectTrailReplays(store, id, "open");
    });
  }

  test("a refused close leaves triage set (local and API triage reject on a decision)", async () => {
    const dbPath = scratch();
    const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
    const id = await createItem(store, { type: "decision", title: "cannot be done", triage: true });
    const r = await runCli(dbPath, ["triage", "reject", id]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("status 'done' is not valid");
    const res = await apiFor(store)(`/triage/${id}/reject`);
    expect(res.status).not.toBe(200);
    const it = (await getItem(store, id))!;
    expect(it.status).toBe("draft");
    expect(it.triage).toBe(1);
    expect(await decisionsForItem(store, id)).toEqual([]);
  });

  test("a plain transitionTo close clears triage too", async () => {
    const db = openDb(scratch());
    const id = await createItem(db, { type: "task", title: "plain close", triage: true });
    await transitionTo(db, id, "done");
    expect((await getItem(db, id))!.triage).toBe(0);
  });
});

describe("supersede is validated and on the trail (OB-1928)", () => {
  test("two lines when the new decision was a draft, one when it was already accepted", async () => {
    const db = openDb(scratch());
    const a = await createItem(db, { type: "decision", title: "A" });
    const b = await createItem(db, { type: "decision", title: "B" });
    await supersede(db, b, a);
    expect((await decisionsForItem(db, a)).map((d) => `${d.from} -> ${d.to}`)).toEqual(["draft -> superseded"]);
    expect((await decisionsForItem(db, b)).map((d) => `${d.from} -> ${d.to}`)).toEqual(["draft -> accepted"]);

    const c = await createItem(db, { type: "decision", title: "C" });
    await supersede(db, b, c); // b already accepted: only c moves
    expect(await decisionsForItem(db, b)).toHaveLength(1);
    expect((await decisionsForItem(db, c)).map((d) => `${d.from} -> ${d.to}`)).toEqual(["draft -> superseded"]);
    for (const id of [a, b, c]) await expectTrailReplays(db, id, "draft");
  });

  test("a superseded decision cannot be made accepted again, and the refused supersede writes nothing", async () => {
    const db = openDb(scratch());
    const a = await createItem(db, { type: "decision", title: "A" });
    const b = await createItem(db, { type: "decision", title: "B" });
    const d = await createItem(db, { type: "decision", title: "D" });
    await supersede(db, b, a);
    await expect(supersede(db, a, d)).rejects.toThrow("cannot transition from 'superseded' to 'accepted'");
    expect((await getItem(db, a))!.status).toBe("superseded");
    expect((await getItem(db, d))!.status).toBe("draft");
    expect(await decisionsForItem(db, d)).toEqual([]);
    const links = db.query("SELECT COUNT(*) AS n FROM item_link WHERE from_item = ? AND to_item = ?").get(a, d) as { n: number };
    expect(links.n).toBe(0);
  });
});

describe("createItem (OB-1928)", () => {
  test("an item born done has closed_at; one born open does not", async () => {
    const db = openDb(scratch());
    const done = await createItem(db, { type: "task", title: "born done", status: "done" });
    const open = await createItem(db, { type: "task", title: "born open" });
    expect((await getItem(db, done))!.closed_at).not.toBeNull();
    expect((await getItem(db, open))!.closed_at).toBeNull();
    await expectTrailReplays(db, done, "done");
  });
});
