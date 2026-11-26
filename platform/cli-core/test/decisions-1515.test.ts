// ob 1515 — every status change takes a note, and the trail is readable back.
//
// What is pinned here, in the order the ticket asks for it:
//
//   * every listed command ACCEPTS --note/-m (a close, a reopen, a block that only has --note, an
//     unblock, a start/ready through `state`);
//   * the note is STORED with who/when/from→to, and `ob show` prints it;
//   * a transition with NO note is still recorded (from → to, no text) — the trail is about the move,
//     not only about the explanation;
//   * it round-trips over the API, and an older host — one that reads only the fields it knows — neither
//     fails on the note nor is required to have recorded it.
//
// The store is the ordinary `event` table (source `ob`, type `transition`), so this also pins that the
// trail survives a second process reading the same file, which is what `ob show` after `ob close` is.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem, recordDecision } from "../../../apps/cli/src/decisions.ts";
import { blockItem, closeItem, reopenItem, startItem, unblockItem } from "../../../apps/cli/src/workflow.ts";
import { renderItemDetail } from "../../../apps/cli/src/api/render.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { claimSpinoffRow, enqueueSpinoff, landArgv, remoteSpinoffSteps, stampSpinoff } from "../../cli-coord/src/commands/spinoff.ts";
import type { EnqueueInput } from "../../cli-coord/src/commands/spinoff.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

const paths: string[] = [];
function scratch(): string {
  const p = freshDbPath();
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    try {
      rmSync(p, { force: true });
      rmSync(`${p}-wal`, { force: true });
      rmSync(`${p}-shm`, { force: true });
    } catch {
      // A test that never opened the file leaves nothing to remove.
    }
  }
});

describe("the decision trail (1515)", () => {
  test("records who, when and from → to; a note is optional but kept when given", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "notes on transitions" });

    await startItem(db, id, { note: "picking it up", actor: "1515" });
    await closeItem(db, id); // no note
    await reopenItem(db, id, { note: "reopened: the fix missed the API path", actor: "human" });

    const trail = await decisionsForItem(db, id);
    expect(trail.map((d) => `${d.from} → ${d.to}`)).toEqual(["done → open", "in_progress → done", "open → in_progress"]);

    const [reopen, closed, started] = trail;
    expect(reopen!.note).toBe("reopened: the fix missed the API path");
    expect(reopen!.who).toBe("human");
    // The no-note close is still a record: the transition happened and the trail says so.
    expect(closed!.note).toBeNull();
    expect(closed!.who).toBe("human");
    expect(started!.who).toBe("1515");
    expect(started!.note).toBe("picking it up");
    expect(started!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(started!.spinoff_row).toBeNull();
  });

  test("block keeps its reason on the item, accepts --note as the same words, and unblock records too", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "blocked" });

    // No note given: the block's own reason is what the transition is about.
    await blockItem(db, id, "waiting on the schema", null);
    await unblockItem(db, id, { note: "schema landed" });

    const trail = await decisionsForItem(db, id);
    expect(trail.map((d) => `${d.from} → ${d.to}`)).toEqual(["blocked → open", "open → blocked"]);
    expect(trail[1]!.note).toBe("waiting on the schema");
    expect(trail[0]!.note).toBe("schema landed");
  });

  test("a spinoff row's move can carry the row id, so `ob show` links the trail back to it", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "dispatched" });
    await recordDecision(db, id, "—", "queued", { note: "tier complex: migration + leases", actor: "architect-acme", spinoffRow: 636 });
    const [d] = await decisionsForItem(db, id);
    expect(d!.spinoff_row).toBe(636);
    expect(d!.from).toBe("—");
    expect(d!.to).toBe("queued");
  });
});

describe("the commands take the flag (1515)", () => {
  test("close, reopen, start/ready, block with only --note, unblock — and `ob show` prints Decisions", async () => {
    const dbPath = scratch();
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "flag surface" });

    const start = await runCli(dbPath, ["start", id, "-m", "first call"]);
    expect(start.code).toBe(0);
    const ready = await runCli(dbPath, ["ready", id, "--note", "gate is clear"]);
    expect(ready.code).toBe(0);
    const block = await runCli(dbPath, ["block", id, "--note", "waiting on review"]);
    expect(block.code).toBe(0);
    const unblock = await runCli(dbPath, ["unblock", id, "-m", "review came back"]);
    expect(unblock.code).toBe(0);
    const close = await runCli(dbPath, ["close", id, "--note", "shipped"]);
    expect(close.code).toBe(0);
    const reopen = await runCli(dbPath, ["reopen", id, "-m", "the API half missed"]);
    expect(reopen.code).toBe(0);

    const shown = await runCli(dbPath, ["show", id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Decisions:");
    expect(shown.out).toContain("shipped");
    expect(shown.out).toContain("open → in_progress");
    // Six moves, and every one is listed — note or not.
    const lines = shown.out.split("\n").filter((l) => /· .+ · .+ → /.test(l));
    expect(lines.length).toBe(6);

    const json = JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out) as {
      decisions: Array<{ from: string; to: string; note: string | null; who: string }>;
    };
    expect(json.decisions[0]).toMatchObject({ from: "done", to: "open", note: "the API half missed" });
    expect(json.decisions.every((d) => d.who === "human")).toBe(true);
  });

  test("agent done and a forced lease release take the note, and land on the ticket's trail", async () => {
    const dbPath = scratch();
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "retirements" });

    const reg = await runCli(dbPath, ["agent", "register", "--id", "1515", "--ticket", id]);
    expect(reg.code).toBe(0);
    const done = await runCli(dbPath, ["agent", "done", "1515", "--note", "build committed, row handed off"]);
    expect(done.code).toBe(0);

    await runCli(dbPath, ["lease", "acquire", `ticket:${id}`, "--holder", "ghost"]);
    const forced = await runCli(dbPath, [
      "lease", "release", `ticket:${id}`, "--holder", "architect-acme", "--force", "--note", "holder is gone (lease expired)",
    ]);
    expect(forced.code).toBe(0);

    const trail = await decisionsForItem(db, id);
    expect(trail.map((d) => `${d.who}: ${d.from} → ${d.to}`)).toEqual([
      `architect-acme: lease ticket:${id} → released (forced)`,
      "1515: agent 1515 → done",
    ]);
    expect(trail[0]!.note).toBe("holder is gone (lease expired)");
    expect(trail[1]!.note).toBe("build committed, row handed off");
  });

  test("`state <id> <state>` takes the note too", async () => {
    const dbPath = scratch();
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "state move" });
    const r = await runCli(dbPath, ["state", id, "in_progress", "--note", "started through state"]);
    expect(r.code).toBe(0);
    const trail = await decisionsForItem(db, id);
    expect(trail[0]).toMatchObject({ from: "open", to: "in_progress", note: "started through state" });
  });

  test("a retried close is not a decision: done → done never reaches the trail", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "idempotent close" });
    await closeItem(db, id, { note: "shipped" });
    // `ob close` is safe to re-run; it must not turn that into a second, fake decision.
    await closeItem(db, id, { note: "second close" });
    const trail = await decisionsForItem(db, id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ from: "open", to: "done", note: "shipped" });
  });

  test("block still refuses when neither --reason nor --note names a reason", async () => {
    const dbPath = scratch();
    const db = openDb(dbPath);
    const id = await createItem(db, { type: "task", title: "no reason" });
    const r = await runCli(dbPath, ["block", id]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("block requires --reason <r> (or --note <r>)");
  });
});

describe("spinoff rows (1515)", () => {
  const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
    ticketRef: "1",
    repo: "/r/acme",
    branch: "1",
    mode: "interactive",
    brief: "dispatch note",
    ...over,
  });

  test("enqueue records the dispatch decision, with the tier rationale and the row id", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "dispatched" });
    const { row } = await enqueueSpinoff(db, input({ tier: "complex", decision: { note: "tier complex: migration + leases", actor: "architect-acme" } }));

    const [d] = await decisionsForItem(db, id);
    expect(d).toMatchObject({
      who: "architect-acme",
      from: "—",
      to: "queued",
      note: "tier complex: migration + leases",
      spinoff_row: row.id,
    });
  });

  test("a stamp moves launching → building on the same trail; a land without a note still records", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "stamped" });
    const { row } = await enqueueSpinoff(db, input());
    // OB-1920: a launch stamp needs a claimed row, as every drain makes; the claim itself writes no trail row.
    await claimSpinoffRow(db, row.id);
    await stampSpinoff(db, { id: row.id, outcome: "launched", worktree: "/tmp/wt", decision: { actor: "drain" } });

    const trail = await decisionsForItem(db, id);
    expect(trail.map((d) => `${d.from} → ${d.to}`)).toEqual(["launching → building", "— → queued"]);
    expect(trail[0]!.note).toBeNull();
    expect(trail[0]!.who).toBe("drain");
  });

  test("the drain's note travels with every stamp it makes, not only with its land", async () => {
    const written: string[][] = [];
    const steps = remoteSpinoffSteps(
      { write: (argv: string[]) => { written.push(argv); return { ok: true, stdout: "{}", code: 0, message: null } as never; } },
      "",
      { note: "drained after the gate", actor: "drain" },
    );
    await steps.stamp({ id: 7, outcome: "launched", worktree: "/tmp/wt" });
    await steps.stamp({ id: 8, outcome: "failed", error: "boom" });
    expect(written).toHaveLength(2);
    for (const argv of written) {
      expect(argv).toContain("--note");
      expect(argv).toContain("drained after the gate");
      expect(argv).toContain("--holder");
      expect(argv).toContain("drain");
    }
    // A stamp that names its own decision wins over the sweep's.
    await steps.stamp({ id: 9, outcome: "failed", decision: { note: "launch failed" } });
    expect(written[2]).toContain("launch failed");
    expect(written[2]).not.toContain("drained after the gate");
  });

  test("a sweep's note travels with its retire as argv, and the retire names the actor", () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    expect(landArgv(636, usage, { note: "merged on main", actor: "architect-acme" })).toContain("--note");
    expect(landArgv(636, usage, { note: "merged on main", actor: "architect-acme" })).toContain("merged on main");
    expect(landArgv(636, usage, { note: "merged on main", actor: "architect-acme" })).toContain("architect-acme");
    // No decision at all is still a valid land argv: the note is never a precondition.
    expect(landArgv(636, usage)).not.toContain("--note");
  });
});

describe("over the API (1515)", () => {
  async function withApi<T>(fn: (ctx: { store: Store; call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }> }) => Promise<T>): Promise<T> {
    const path = scratch();
    const store = await openStore({ kind: "sqlite", path, create: true });
    const api = createObApi({
      store: async () => store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    const call = async (p: string, opts: { method?: string; body?: unknown } = {}) => {
      const res = await api(
        new Request(`${BASE}${OB_API_PREFIX}${p}`, {
          method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
          headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        }),
      );
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
    };
    try {
      return await fn({ store, call });
    } finally {
      await store.close();
    }
  }

  // OB-1825: the same three ways in, over the wire, against the real handlers and a real store.
  const GO_SHEET = {
    does: "Adds a gate.",
    files: ["a.ts"],
    questions: [],
    scores: { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 },
  };
  const READY_BODY = "Need.\n\n## Drilled\n- read the code\n\n## Done when\n- a test shows it";

  test("the CLI's own API route carries --note and the --no-check reason onto the trail, and `check` too (OB-1825)", async () => {
    const path = scratch();
    const store = await openStore({ kind: "sqlite", path, create: true });
    const server = createObApi({
      store: async () => store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    // The real client against the real server. Only the socket and this machine's checkout map are faked:
    // a path does not cross the wire (217), so the client needs a slug for the repo.
    const wire: ApiTransport = async (req: ApiRequest) => {
      if (req.url.endsWith("/spinoffs/config")) {
        return { status: 200, body: JSON.stringify({ config: { repo_checkouts: { acme: repo }, launcher: "t3", launcher_by_repo: {}, engine: "claude" } }) };
      }
      const res = await server(new Request(req.url, { method: req.method, headers: req.headers, ...(req.body === undefined ? {} : { body: req.body }) }));
      return { status: res.status, body: await res.text() };
    };
    const repo = mkdtempSync(join(tmpdir(), "ob-1825-repo-"));
    mkdirSync(join(repo, ".git"));
    const opts = { api: { base: BASE, token: TOKEN, transport: wire } };
    try {
      const id = await createItem(store, { type: "task", title: "the real route", body: READY_BODY });
      const argv = ["spinoff", "queue", String(id), "--repo", "acme", "--branch", "b1825", "--brief", "b", "--note", "why this dispatch", "--no-check", "the spike ran", "--holder", "architect-acme"];
      const queued = await runCli(scratch(), argv, opts);
      expect(queued.err).toBe("");
      expect(queued.code).toBe(0);
      const trail = await decisionsForItem(store, id);
      expect(trail.find((d) => d.to === "no-check")).toMatchObject({ note: "the spike ran", who: "architect-acme" });
      expect(trail.some((d) => d.note === "why this dispatch")).toBe(true);

      const other = await createItem(store, { type: "task", title: "checked over the wire", body: READY_BODY });
      const sheet = JSON.stringify(GO_SHEET);
      const checked = await runCli(scratch(), ["spinoff", "check", String(other), "--architect", sheet, "--reviewer", sheet], opts);
      expect(checked.code).toBe(0);
      expect(checked.out).toContain("go:");
      expect((await decisionsForItem(store, other))[0]).toMatchObject({ from: "check", to: "go" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      await store.close();
    }
  });

  test("POST /spinoffs refuses an unchecked ticket and an empty reason, leaving no row (OB-1825)", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "over the api", body: READY_BODY });
      const send = (extra: object) => call("/spinoffs", { body: { ticket_ref: String(id), repo: "/r/acme", branch: "b1825", mode: "agent", brief: "do it", ...extra } });
      const unchecked = await send({});
      expect(unchecked.status, JSON.stringify(unchecked.body)).toBe(409);
      expect(JSON.stringify(unchecked.body)).toContain("no measure-twice check");
      const empty = await send({ no_check: "  " });
      expect(empty.status).toBe(400);
      expect(JSON.stringify(empty.body)).toContain("--no-check needs a reason");
      expect((await call("/spinoffs")).body.spinoffs ?? []).toEqual([]);
    });
  });

  test("POST /spinoffs refuses a ticket with no `## Drilled`, naming it, leaving no row (OB-1980)", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "undrilled over the api", body: "Need.\n\n## Done when\n- a test shows it" });
      const sent = await call("/spinoffs", { body: { ticket_ref: String(id), repo: "/r/acme", branch: "b1980", mode: "agent", brief: "do it" } });
      expect(sent.status, JSON.stringify(sent.body)).toBe(409);
      expect(JSON.stringify(sent.body)).toContain("'## Drilled' section");
      expect(JSON.stringify(sent.body)).not.toContain("no '## Done when'");
      expect((await call("/spinoffs")).body.spinoffs ?? []).toEqual([]);
    });
  });

  test("the note travels with the transition and comes back on the item detail", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "api trail" });
      const closed = await call(`/items/${id}/close`, { body: { note: "gated: tests x2", actor: "architect-acme" } });
      expect(closed.status).toBe(200);

      const detail = await call(`/items/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.item.decisions).toHaveLength(1);
      expect(detail.body.item.decisions[0]).toMatchObject({
        who: "architect-acme",
        from: "open",
        to: "done",
        note: "gated: tests x2",
        spinoff_row: null,
      });

      // `ob show` from another machine renders the same section.
      expect(renderItemDetail(detail.body.item, "human")).toContain("Decisions:");
      expect(renderItemDetail(detail.body.item, "human")).toContain("gated: tests x2");

      const reopened = await call(`/items/${id}/reopen`, { body: { note: "issue reopened" } });
      expect(reopened.status).toBe(200);
      const after = await call(`/items/${id}`);
      expect(after.body.item.decisions.map((d: { to: string }) => d.to)).toEqual(["open", "done"]);
      expect(after.body.item.decisions[0].who).toBe("human");
    });
  });

  test("a state move and a block take the note too", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "state trail" });
      const started = await call(`/items/${id}/state`, { body: { action: "start", note: "picking it up", actor: "1515" } });
      expect(started.status).toBe(200);
      const blocked = await call(`/items/${id}/state`, { body: { action: "block", reason: "waiting", note: "waiting on CI" } });
      expect(blocked.status).toBe(200);
      const detail = await call(`/items/${id}`);
      expect(detail.body.item.decisions.map((d: { from: string; to: string; note: string }) => `${d.from}→${d.to}:${d.note}`)).toEqual([
        "in_progress→blocked:waiting on CI",
        "open→in_progress:picking it up",
      ]);
    });
  });

  test("a block that names its reason only as a note is accepted, exactly like the CLI", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "note-only block" });
      const blocked = await call(`/items/${id}/state`, { body: { action: "block", note: "waiting on CI" } });
      expect(blocked.status).toBe(200);
      const detail = await call(`/items/${id}`);
      expect(detail.body.item.block_reason).toBe("waiting on CI");
      expect(detail.body.item.decisions[0]).toMatchObject({ from: "open", to: "blocked", note: "waiting on CI" });
    });
  });

  test("an older host neither fails on the note nor is required to have recorded it", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "old host" });
      // An old host read `github` and nothing else: the extra keys are ordinary JSON to it, so a client
      // that sends them is not asking the host to understand them. The move still happens.
      const old = await call(`/items/${id}/close`, { body: { github: false } });
      expect(old.status).toBe(200);
      const detail = await call(`/items/${id}`);
      expect(detail.body.item.decisions).toHaveLength(1);
      expect(detail.body.item.decisions[0].note).toBeNull();

      // And the other direction: a field this build has never heard of is ignored, not refused.
      await call(`/items/${id}/reopen`, { body: { note: "back", a_field_from_the_future: true } });
      const after = await call(`/items/${id}`);
      expect(after.body.item.decisions[0].note).toBe("back");

      // An old host's detail payload has no `decisions` at all: `ob show` prints no section, never fails.
      const { decisions: _dropped, ...oldDetail } = detail.body.item;
      const rendered = renderItemDetail(oldDetail as typeof detail.body.item, "human");
      expect(rendered).not.toContain("Decisions:");
      expect(rendered).toContain("old host");
    });

    // A client sending `--note` to a host that ignores it: the canned answer has no decision in it, and
    // the close still succeeds — the note is a remark on the move, never a precondition for it.
    const calls: ApiRequest[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const transport: ApiTransport = async (req) => {
      calls.push(req);
      bodies.push(req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {});
      // An old host's answers, verbatim: a close with no decision in it, and no rows to serve.
      const path = req.url.slice((BASE + OB_API_PREFIX).length);
      if (path === "/spinoffs/serving") return { status: 200, body: JSON.stringify({ spinoffs: [] }) };
      return { status: 200, body: JSON.stringify({ id: "42", status: "done", issue: null, issue_error: null }) };
    };
    const r = await runCli(scratch(), ["close", "42", "-m", "why this closed"], { api: { base: BASE, token: TOKEN, transport } });
    expect(r.code).toBe(0);
    expect(bodies[calls.findIndex((c) => c.url.includes("/items/42/close"))]).toMatchObject({ note: "why this closed" });
  });
});
