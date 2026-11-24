// OS-170: `ob machine audit` lists items and spinoff rows in states their machine lacks, spinoff rows parked in
// `launching`/`launched`, and the would-refuse events grouped. Read-only. Fresh SQLite file per test; the API
// leg runs the real server over that store through an in-process transport, so no network is touched.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { recordEventFor } from "../../../apps/cli/src/events.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE } from "../../../apps/cli/src/machine-shadow.ts";
import { machineAudit, renderMachineAudit, type MachineAudit } from "../../../apps/cli/src/machine-audit.ts";
import { cmdMachine } from "../../../apps/cli/src/commands/machine.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX, matchApiRoute } from "../../../apps/cli/src/api/contract.ts";
import { loadScopedTokens, sha256Hex } from "../../../apps/cli/src/api/scoped-tokens.ts";
import { runApi } from "../../../apps/cli/src/api/run.ts";
import { planExecution } from "../../../apps/cli/src/remote.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { isApiRouted } from "../../../apps/cli/src/api/routing.ts";
import { POSTGRES_SERVABLE_COMMANDS } from "../../../apps/cli/src/db/servable.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const paths: string[] = [];
const scratch = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "ob-machine-audit-170-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function db(): Database {
  const p = freshDbPath();
  paths.push(p);
  return openDb(p);
}

async function spinoffRow(s: Store, ticket: string, status: string, at: string): Promise<number> {
  const [row] = await s.q
    .insert(s.t.spinoff)
    .values({
      ticket_ref: ticket,
      repo: "/repo",
      branch: ticket.toLowerCase(),
      worktree: `/wt/${ticket}`,
      mode: "t3",
      brief: "b",
      status,
      request_at: at,
      launched_at: status === "pending" ? null : at,
    })
    .returning({ id: s.t.spinoff.id });
  return row!.id;
}

async function wouldRefuse(s: Store, at: string, payload: Record<string, unknown>, itemId: string | null): Promise<void> {
  await recordEventFor(s, { ts: at, source: MACHINE_SHADOW_SOURCE, type: MACHINE_WOULD_REFUSE, itemId, actor: null, payload });
}

/** The seed every test reads: one item in a state its machine lacks, one stale row, two same-key events. */
async function seed(d: Database) {
  const s = asStore(d);
  const good = await createItem(d, { type: "task", title: "fine" });
  const bad = await createItem(d, { type: "task", title: "stuck in a linear state" });
  await s.q.update(s.t.item).set({ status: "qa_rework" }).where(eq(s.t.item.id, bad));
  const badRef = (await getItem(d, bad))!.ref ?? bad;

  const stale = await spinoffRow(s, "OS-1", "launched", daysAgo(10));
  await spinoffRow(s, "OS-2", "launched", daysAgo(2)); // in a long-running state, but recent
  await spinoffRow(s, "OS-3", "ready-for-gate", daysAgo(30)); // old, but not a long-running state
  const odd = await spinoffRow(s, "OS-4", "building", daysAgo(1)); // not a spinoff machine state

  const base = { machine: "task", from: "open", event: "to:merged", to: "merged", why: "machine", today: "allowed", message: "m" };
  await wouldRefuse(s, daysAgo(3), { ...base, id: good }, good);
  await wouldRefuse(s, daysAgo(1), { ...base, id: bad }, bad);
  await wouldRefuse(s, daysAgo(2), { machine: "spinoff", id: String(stale), rowId: stale, from: "launched", event: "claim", to: "launching", why: "machine", today: "allowed", message: "m" }, null);
  await wouldRefuse(s, daysAgo(20), { ...base, id: good }, good); // before --since
  return { s, good, bad, badRef, stale, odd };
}

async function snapshot(s: Store) {
  return {
    items: await s.q.select().from(s.t.item),
    spinoffs: await s.q.select().from(s.t.spinoff),
    events: await s.q.select().from(s.t.event),
  };
}

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  return { out, restore: () => void (console.log = log) };
}

function expectSeededAudit(a: MachineAudit, ids: Awaited<ReturnType<typeof seed>>): void {
  expect(a.unresolvable.items).toEqual([{ ref: ids.badRef, machine: "task", status: "qa_rework" }]);
  expect(a.unresolvable.spinoffs).toEqual([{ row: `#${ids.odd}`, ticket: "OS-4", status: "building" }]);
  expect(a.unresolvable.count).toBe(2);
  expect(a.stale.rows).toEqual([{ row: `#${ids.stale}`, ticket: "OS-1", status: "launched", updated: daysAgo(10) }]);
  expect(a.stale.count).toBe(1);
  expect(a.wouldRefuse.count).toBe(3);
  expect(a.wouldRefuse.groups).toEqual([
    { machine: "task", from: "open", event: "to:merged", today: "allowed", count: 2, example: ids.bad },
    { machine: "spinoff", from: "launched", event: "claim", today: "allowed", count: 1, example: `#${ids.stale}` },
  ]);
}

describe("machineAudit (OS-170)", () => {
  test("lists the unresolvable item and row, the stale launched row and the grouped would-refuse events", async () => {
    const d = db();
    const ids = await seed(d);
    const a = await machineAudit(ids.s, { now: NOW, since: daysAgo(7) });
    expectSeededAudit(a, ids);
    expect(a.stale.staleDays).toBe(7);
    // Default since is seven days before now, so the 20-day-old event is left out.
    expect((await machineAudit(ids.s, { now: NOW })).wouldRefuse.count).toBe(3);
    // A wider window takes it in, and --stale-days 1 takes the 2-day-old row too, oldest first.
    const wide = await machineAudit(ids.s, { now: NOW, since: daysAgo(30), staleDays: 1 });
    expect(wide.wouldRefuse.groups[0]!.count).toBe(3);
    expect(wide.stale.rows.map((r) => r.ticket)).toEqual(["OS-1", "OS-2"]);

    const text = renderMachineAudit(a);
    expect(text).toContain("unresolvable: 2");
    expect(text).toContain(`${ids.badRef}\ttask\tqa_rework`);
    expect(text).toContain("stale (launching/launched, not moved for 7+ days): 1");
    expect(text).toContain(`2\ttask\topen\tto:merged\ttoday allowed\tnewest ${ids.bad}`);
  });

  test("an empty store has three empty sections", async () => {
    const a = await machineAudit(asStore(db()), { now: NOW });
    expect([a.unresolvable.count, a.stale.count, a.wouldRefuse.count]).toEqual([0, 0, 0]);
  });

  test("ob machine audit prints the sections, --json the same data, and writes nothing", async () => {
    const d = db();
    const ids = await seed(d);
    const before = await snapshot(ids.s);
    const cap = capture();
    try {
      await cmdMachine({ db: d, store: ids.s, dbPath: "", mode: "human", flags: { since: daysAgo(7) }, args: ["audit"] } as never);
      await cmdMachine({ db: d, store: ids.s, dbPath: "", mode: "json", flags: { since: daysAgo(7) }, args: ["audit"] } as never);
    } finally {
      cap.restore();
    }
    expect(cap.out[0]).toContain("unresolvable: 2");
    const json = JSON.parse(cap.out[1]!) as MachineAudit;
    expect(Object.keys(json)).toEqual(["unresolvable", "stale", "wouldRefuse"]);
    expect(json.unresolvable.items[0]!.status).toBe("qa_rework");
    expect(json.wouldRefuse.groups[0]!.count).toBe(2);
    expect(json.stale.rows[0]!.ticket).toBe("OS-1");
    expect(await snapshot(ids.s)).toEqual(before);

    await expect(cmdMachine({ store: ids.s, mode: "human", flags: {}, args: ["fix"] } as never)).rejects.toThrow("unknown machine subcommand");
    await expect(cmdMachine({ store: ids.s, mode: "human", flags: { "stale-days": "x" }, args: ["audit"] } as never)).rejects.toThrow("--stale-days");
    await expect(cmdMachine({ store: ids.s, mode: "human", flags: { since: "nope" }, args: ["audit"] } as never)).rejects.toThrow("--since");
  });
});

describe("GET /machine/audit (OS-170)", () => {
  const ADMIN = "an-admin-bearer-token-that-is-long-enough";
  const ALICE = "alice-scoped-token-0123456789abcdef0123456789";

  function serve(store: Store) {
    const tokens = join(scratch, `tokens-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tokens, JSON.stringify([{ user: "alice", sha256: sha256Hex(ALICE), projects: ["alpha"], families: ["items", "next", "search", "projects"] }]));
    chmodSync(tokens, 0o600);
    return createObApi({
      store: async () => store,
      token: () => ({ token: ADMIN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
      scopedTokens: () => loadScopedTokens(tokens),
    });
  }

  test("the route is in the admin family machine; the command is API-routed, servable from Postgres and replica-read", () => {
    expect(matchApiRoute("GET", ["machine", "audit"])?.family).toBe("machine");
    expect(isApiRouted("machine")).toBe(true);
    expect(POSTGRES_SERVABLE_COMMANDS.has("machine")).toBe(true);
    expect(planExecution({ command: "machine", args: ["audit"], flags: {}, host: "server" }).mode).toBe("replica");
  });

  test("ob machine audit over the API answers the same data and writes nothing; a scoped token is refused", async () => {
    const d = db();
    const ids = await seed(d);
    const api = serve(ids.s);
    const before = await snapshot(ids.s);
    const transport: ApiTransport = async (req) => {
      const res = await api(new Request(req.url, { method: req.method, headers: req.headers, body: req.body }));
      return { status: res.status, body: await res.text() };
    };
    const cap = capture();
    let code: number;
    try {
      code = await runApi({
        command: "machine",
        args: ["audit"],
        flags: { json: true, since: daysAgo(7), "stale-days": "7" },
        base: "http://api-host.local",
        token: ADMIN,
        transport,
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const json = JSON.parse(cap.out.join("\n")) as MachineAudit;
    // The server's clock is the real one; the seed is relative to NOW, which is close enough for these rows.
    expect(json.unresolvable.items).toEqual([{ ref: ids.badRef, machine: "task", status: "qa_rework" }]);
    expect(json.wouldRefuse.groups[0]).toMatchObject({ count: 2, example: ids.bad });

    const scoped = await api(
      new Request(`http://api-host.local${OB_API_PREFIX}/machine/audit`, { headers: { authorization: `Bearer ${ALICE}` } }),
    );
    expect(scoped.status).toBe(403);
    expect(((await scoped.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const badQuery = await api(
      new Request(`http://api-host.local${OB_API_PREFIX}/machine/audit?stale_days=x`, { headers: { authorization: `Bearer ${ADMIN}` } }),
    );
    expect(badQuery.status).toBe(400);
    expect(await snapshot(ids.s)).toEqual(before);
  });
});
