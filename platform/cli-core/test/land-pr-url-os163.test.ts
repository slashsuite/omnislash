// OS-163: the dashboard timeline draws a Merged line for a landed spinoff row only when the row's landed
// transition carries `pr_url`. Every land path now reads the branch's merged PR (`gh pr list --head <branch>
// --state merged`, in the repo checkout, where gh is: the client in API mode) and records it on that event.
//
// Hermetic: gh is the `sh` seam, stubbed; the API is the real server over a temp sqlite store, called in-process as
// the client's transport. No network, no live DB.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { item, spinoff } from "../../../apps/cli/src/db/schema.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { closeAndLand } from "../../../apps/cli/src/close.ts";
import { DECISION_SOURCE, DECISION_TYPE } from "../../../apps/cli/src/decisions.ts";
import { eventsForItemFor } from "../../../apps/cli/src/events.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { __setSh, enqueueSpinoff, getSpinoffRow, landArgv, localMergedPrUrl, mergedPrUrlFor, reconcileSpinoffs, type Sh } from "../../cli-coord/src/commands/spinoff.ts";
import { buildTimeline, type TimelineEvent } from "../../../apps/ob-dashboard/src/lib/timeline.ts";

const BASE = "https://ob.example.test";
const TOKEN = "a-test-bearer-token-that-is-long-enough";
const PR = "https://github.com/o/acme/pull/163";

let dir: string;
let repo: string;
let restoreSh: (() => void) | null = null;
/** Every gh call the stub saw, with the directory it ran in. */
let ghCalls: { cmd: string[]; cwd: string | undefined }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "os-163-"));
  repo = join(dir, "acme"); // the repo checkout, on this machine
  mkdirSync(repo, { recursive: true });
  ghCalls = [];
});
afterEach(() => {
  restoreSh?.();
  restoreSh = null;
  rmSync(dir, { recursive: true, force: true });
});

/** gh answers `merged` for `gh pr list --state merged`; anything else fails, as a missing tool would. */
function stubGh(merged: { url: string }[] | "fail"): void {
  const fake: Sh = (cmd, cwd) => {
    if (cmd[0] === "gh") ghCalls.push({ cmd: [...cmd], cwd });
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list" && cmd.includes("merged")) {
      return merged === "fail" ? { ok: false, err: "gh: not logged in", out: "" } : { ok: true, err: "", out: JSON.stringify(merged) };
    }
    return { ok: false, err: `not stubbed: ${cmd.join(" ")}`, out: "" };
  };
  restoreSh = __setSh(fake);
}

async function seed(opts: { path?: string; status?: "launched" | "ready-for-gate"; spike?: boolean } = {}) {
  const path = opts.path ?? freshDbPath();
  const db = openDb(path);
  const store = asStore(db);
  const id = await createItem(db, { type: "task", title: "ship it" });
  if (opts.spike) await addTags(db, id, ["spike"]);
  const worktree = join(dir, `acme.os-${id}`);
  const branch = `os-${id}`;
  const { row } = await enqueueSpinoff(db, { ticketRef: id, repo, branch, mode: "interactive", brief: "b", worktree });
  orm(db).update(spinoff).set({ status: opts.status ?? "ready-for-gate", agent_id: branch, worktree }).where(eq(spinoff.id, row.id)).run();
  return { path, db, store, id, rowId: row.id, branch };
}

/** The payload of the item's landed transition (`→ landed`), or null when there is none. */
async function landedPayload(store: Store, itemId: string): Promise<Record<string, unknown> | null> {
  const events = await eventsForItemFor(store, itemId, 50, { source: DECISION_SOURCE, type: DECISION_TYPE });
  for (const e of events) {
    const p = JSON.parse(String(e.payload)) as Record<string, unknown>;
    if (p.to === "landed") return p;
  }
  return null;
}

function serverTransport(store: Store): { transport: ApiTransport; bodies: Record<string, unknown>[] } {
  const app = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const bodies: Record<string, unknown>[] = [];
  const transport: ApiTransport = async (req) => {
    const path = req.url.slice(BASE.length);
    if (req.body) bodies.push({ path, ...(JSON.parse(req.body) as Record<string, unknown>) });
    const res = await app(
      new Request(`http://api-host.local${path}`, {
        method: req.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: req.body,
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  return { transport, bodies };
}
const apiDeps = (transport: ApiTransport) => ({ api: { base: BASE, token: TOKEN, transport } });

describe("mergedPrUrlFor (OS-163)", () => {
  test("asks gh for the branch's merged PR in the repo checkout", () => {
    stubGh([{ url: PR }]);
    expect(mergedPrUrlFor(repo, "os-163")).toBe(PR);
    expect(ghCalls).toEqual([{ cmd: ["gh", "pr", "list", "--head", "os-163", "--state", "merged", "--json", "url", "--limit", "1"], cwd: repo }]);
  });

  test("no match, a gh failure, or no checkout on this machine is null, and no checkout never runs gh", () => {
    stubGh([]);
    expect(mergedPrUrlFor(repo, "b")).toBeNull();
    restoreSh!();
    stubGh("fail");
    expect(mergedPrUrlFor(repo, "b")).toBeNull();
    ghCalls = [];
    expect(mergedPrUrlFor(join(dir, "not-here"), "b")).toBeNull();
    expect(mergedPrUrlFor("acme", "b")).toBeNull(); // a slug that resolved to nothing here
    expect(ghCalls).toEqual([]);
  });
});

describe("the local land paths record the merged PR (OS-163)", () => {
  test("ob close: the landed event carries pr_url, and the timeline draws a Merged line from it", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed();
    await closeAndLand(store, id, {}, {}, localMergedPrUrl(store)); // what `ob close` passes
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    const payload = await landedPayload(store, id);
    expect(payload).toMatchObject({ from: "handed-off", to: "landed", spinoff_row: rowId, pr_url: PR });

    // The recorded event, as the dashboard reads it, into the timeline's fold.
    const events = (await eventsForItemFor(store, id, 50, { source: DECISION_SOURCE, type: DECISION_TYPE })) as TimelineEvent[];
    const day = new Date().toISOString().slice(0, 10);
    const item = { id, ref: id, title: "ship it", type: "task", status: "done", created_at: `${day}T00:00:00.000Z`, closed_at: null, block_reason: null };
    const view = buildTimeline([item], events, { from: day, to: day, builds: false });
    expect(view.feed.filter((e) => e.kind === "merge").map((e) => [e.detail, e.href])).toEqual([["merged, PR #163", PR]]);
  });

  test("ob close with no merged PR lands the row and records no pr_url", async () => {
    stubGh([]);
    const { store, id, rowId } = await seed();
    await closeAndLand(store, id, {}, {}, localMergedPrUrl(store));
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    const payload = await landedPayload(store, id);
    expect(payload).not.toBeNull();
    expect(payload!.pr_url).toBeUndefined();
  });

  test("a spike close retires the row as failed and records no pr_url", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed({ spike: true });
    const r = await closeAndLand(store, id, {}, {}, localMergedPrUrl(store));
    expect(r.ended).toHaveLength(1);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("failed");
    expect(await landedPayload(store, id)).toBeNull();
    expect(ghCalls).toEqual([]);
  });

  test("reconcile: a merged branch lands with its PR", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed({ status: "launched" });
    const rec = await reconcileSpinoffs(store, () => true, () => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 }), () => 1, "", undefined, () => []);
    expect(rec.merged).toHaveLength(1);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBe(PR);
  });

  test("ob close (the CLI) reads the merged PR in this machine's checkout", async () => {
    stubGh([{ url: PR }]);
    const { path, id } = await seed();
    expect((await runCli(path, ["close", id, "--no-github"])).code).toBe(0);
    expect((await landedPayload(asStore(openDb(path)), id))!.pr_url).toBe(PR);
  });

  test("a close that does not ask (the API server, triage reject, the dashboard) runs no gh and records no pr_url", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed();
    await closeAndLand(store, id);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBeUndefined();
    expect(ghCalls).toEqual([]);
  });

  test("a remote reconcile always sends --pr-url, empty when the client found none, so the writer never reads gh", () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    const at = (argv: string[]) => argv[argv.indexOf("--pr-url") + 1];
    expect(at(landArgv(1, zero, {}, PR))).toBe(PR);
    expect(at(landArgv(1, zero, {}, null))).toBe("");
  });

  test("ob spinoff land reads the PR here, and --pr-url (a reconcile elsewhere) is taken as given", async () => {
    stubGh([{ url: PR }]);
    const a = await seed();
    const r = await runCli(a.path, ["spinoff", "land", "--id", String(a.rowId)]);
    expect(r.code).toBe(0);
    expect((await landedPayload(asStore(openDb(a.path)), a.id))!.pr_url).toBe(PR);

    const b = await seed();
    ghCalls = [];
    const given = "https://github.com/o/acme/pull/7";
    expect((await runCli(b.path, ["spinoff", "land", "--id", String(b.rowId), "--pr-url", given])).code).toBe(0);
    expect((await landedPayload(asStore(openDb(b.path)), b.id))!.pr_url).toBe(given);

    const c = await seed();
    expect((await runCli(c.path, ["spinoff", "land", "--id", String(c.rowId), "--pr-url", ""])).code).toBe(0);
    expect((await landedPayload(asStore(openDb(c.path)), c.id))!.pr_url).toBeUndefined();
    expect(ghCalls).toEqual([]);
  });
});

describe("the API land paths carry the PR the client read (OS-163)", () => {
  test("ob close over the API sends pr_url inside the row's landById entry, and the host records it", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed();
    const { transport, bodies } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["close", id, "--no-github"], apiDeps(transport));
    expect(r.code).toBe(0);
    const close = bodies.find((b) => String(b.path).endsWith(`/items/${id}/close`))!;
    expect((close.landById as Record<string, { pr_url?: string }>)[String(rowId)]!.pr_url).toBe(PR);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBe(PR);
  });

  test("ob close over the API with no merged PR lands the row with no pr_url", async () => {
    stubGh([]);
    const { store, id, rowId } = await seed();
    const { transport } = serverTransport(store);
    expect((await runCli(freshDbPath(), ["close", id, "--no-github"], apiDeps(transport))).code).toBe(0);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBeUndefined();
  });

  test("the API close never reads a PR on the server for a row the client did not send", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed();
    const { transport } = serverTransport(store);
    const res = await transport({ method: "POST", url: `${BASE}${OB_API_PREFIX}/items/${id}/close`, headers: {}, body: JSON.stringify({ github: false }) });
    expect(res.status).toBe(200);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBeUndefined();
    expect(ghCalls).toEqual([]);
  });

  test("ob spinoff reconcile over the API sends the PR it read here, and the host records it", async () => {
    stubGh([{ url: PR }]);
    const { db, store, id, rowId } = await seed();
    orm(db).update(item).set({ status: "done" }).where(eq(item.id, id)).run(); // closed elsewhere, row not yet landed
    const { transport, bodies } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["spinoff", "reconcile"], apiDeps(transport));
    expect(r.code).toBe(0);
    expect(bodies.find((b) => String(b.path).endsWith("/spinoffs/land"))!.pr_url).toBe(PR);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
    expect((await landedPayload(store, id))!.pr_url).toBe(PR);
  });

  test("ob spinoff land over the API sends the PR it read here", async () => {
    stubGh([{ url: PR }]);
    const { store, id, rowId } = await seed();
    const { transport, bodies } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["spinoff", "land", "--id", String(rowId)], apiDeps(transport));
    expect(r.code).toBe(0);
    expect(bodies.find((b) => String(b.path).endsWith("/spinoffs/land"))!.pr_url).toBe(PR);
    expect((await landedPayload(store, id))!.pr_url).toBe(PR);
  });
});
