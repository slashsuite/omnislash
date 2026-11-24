// OB-2205: the BUILT OB dashboard behind serve-handler.ts, on a real Bun.serve with a sidecar on a temp
// SQLite store. moon's ob-dashboard:test depends on ob-dashboard:build, so dist/ is there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb } from "../../cli/test/helpers.ts";
import { sqliteStoreFor } from "../../cli/src/db/store.ts";
import { createSidecar, REALTIME_WS_PATH, type SidecarMount } from "../../cli/src/realtime.ts";
import { stampedServiceWorker, swVersionFor } from "../../../platform/dashboard-kit/src/server/sw-version.ts";
import { provideStore } from "../provided-store.ts";
import { createItem, setBlocked } from "../../cli/src/items.ts";
import { createObHandler } from "../serve-handler.ts";
import { toJSON } from "seroval";

const APP = fileURLToPath(new URL("..", import.meta.url));
const CLIENT_DIR = join(APP, "dist", "client");

let server: ReturnType<typeof Bun.serve>;
let sidecar: SidecarMount;
let base: string;
const sidecarCalls: string[] = [];
// OB-2207: the fixture the Alerts page reads: two blocked items with no movement for 10 days (rule 4).
let ackId: string;
let snoozeId: string;
let priorFrontier: string | undefined;

beforeAll(async () => {
  // The snapshot the socket sends reads the frontier from GitHub unless it is disabled; keep it local.
  priorFrontier = process.env.OMNISLASH_DISABLE_FRONTIER;
  process.env.OMNISLASH_DISABLE_FRONTIER = "1";
  const ssr = (await import(join(APP, "dist", "server", "server.js"))).default;
  const db = freshDb();
  const store = sqliteStoreFor(db);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  ackId = await createItem(db, { type: "task", title: "waiting on the ack", priority: 2 });
  snoozeId = await createItem(db, { type: "task", title: "waiting on the snooze", priority: 2 });
  for (const id of [ackId, snoozeId]) {
    await setBlocked(db, id, "open", "waiting on infra", "ops");
    db.query("UPDATE item SET updated_at = ? WHERE id = ?").run(tenDaysAgo, id);
  }
  // The server functions in the built bundle read this, never the live store (serve.ts provides the real one).
  provideStore(async () => store);
  const real = createSidecar({ store, pollMs: 60_000, upgradeOnRoot: false });
  // Record every path the handler hands the sidecar, so a test can say which paths never reach it.
  sidecar = {
    ...real,
    fetch: (req, upgrade) => {
      sidecarCalls.push(new URL(req.url).pathname);
      return real.fetch(req, upgrade);
    },
  };
  const handler = createObHandler({ clientDir: CLIENT_DIR, ssr, sidecar, swSource: stampedServiceWorker(CLIENT_DIR) });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: handler.websocket, fetch: handler.fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  sidecar?.stop();
  await server?.stop(true);
  if (priorFrontier === undefined) delete process.env.OMNISLASH_DISABLE_FRONTIER;
  else process.env.OMNISLASH_DISABLE_FRONTIER = priorFrontier;
});

describe("the built OB dashboard (OB-2205)", () => {
  test("serves its home page from SSR", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>OB</title>");
    expect(html).toContain("To review");
    expect(html).toContain('rel="manifest"');
  });

  // OB-2261: the deploy reads this to prove what it restarted is what serves. Nothing of it renders. With
  // BUILD_COMMIT set (CI, the deploy) the build carries exactly that; a local build without it names a SHA
  // (a moon cache hit may replay an older one, which is why this is not compared to HEAD).
  test("names its build commit in a head meta that nothing renders", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const head = html.slice(0, html.indexOf("</head>"));
    const metas = [...html.matchAll(/<meta name="build-commit" content="([^"]*)"/g)].map((m) => m[1]);
    expect(metas.length).toBe(1);
    expect(head).toContain('<meta name="build-commit"');
    const want = process.env.BUILD_COMMIT?.trim();
    if (want) expect(metas[0]).toBe(want);
    else expect(metas[0]).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
  });

  test("serves its own manifest: name OB, id /ob, start_url /", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const m = await res.json();
    expect({ name: m.name, short_name: m.short_name, id: m.id, start_url: m.start_url }).toEqual({
      name: "OB",
      short_name: "OB",
      id: "/ob",
      start_url: "/",
    });
  });

  test("serves a stamped sw.js with its own cache prefix", async () => {
    const res = await fetch(`${base}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    const body = await res.text();
    expect(body).not.toContain("__SW_VERSION__");
    expect(body).toContain(`const VERSION = "${swVersionFor(CLIENT_DIR)}"`);
    expect(body).toContain('"ob-shell-"');
  });

  test("a realtime socket connects on the app's own origin and receives a snapshot", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${REALTIME_WS_PATH}`);
    const first = await new Promise<{ data: { at: string } }>((resolve, reject) => {
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))));
      ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    expect(typeof first.data.at).toBe("string");
    expect(sidecar.clientCount()).toBe(1);
    ws.close();
  });

  test("/api/whatsapp/* answers 404 and never reaches the sidecar", async () => {
    sidecarCalls.length = 0;
    for (const path of ["/api/whatsapp/media/1", "/api/whatsapp/thread"]) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(sidecarCalls).toEqual([]);
  });

  test("/api/ob/ is not the ob API: no JSON, no auth challenge, the router's 404", async () => {
    const res = await fetch(`${base}/api/ob/items`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

// OB-2207: a server function's id, read from the built server bundle by its name. The client calls
// POST /_serverFn/<id> with a seroval-encoded `{ data }`, which is what `callServerFn` sends.
function serverFnId(name: string): string {
  const dir = join(APP, "dist", "server", "assets");
  for (const f of readdirSync(dir)) {
    const m = new RegExp(`id: "([0-9a-f]+)",\\s*name: "${name}",\\s*filename: "src/server/alerts.ts"`).exec(readFileSync(join(dir, f), "utf8"));
    if (m) return m[1]!;
  }
  throw new Error(`no server function ${name} in the build`);
}

function callServerFn(name: string, data: unknown, site: "same-origin" | "cross-site"): Promise<Response> {
  return fetch(`${base}/_serverFn/${serverFnId(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tsr-serverFn": "true", "sec-fetch-site": site },
    body: JSON.stringify(toJSON({ data })),
  });
}

describe("Alerts on the OB dashboard (OB-2207)", () => {
  test("GET /alerts renders the alert list from the store, with the header bell linking to it", async () => {
    const res = await fetch(`${base}/alerts`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("waiting on the ack");
    expect(html).toContain("waiting on the snooze");
    // The bell: an icon link to /alerts, labelled by the count (0 until the socket's first push).
    expect(html).toMatch(/<a[^>]*href="\/alerts"[^>]*aria-label="No alerts"|<a[^>]*aria-label="No alerts"[^>]*href="\/alerts"/);
  });

  test("the live count the bell reads rides the socket's snapshot", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${REALTIME_WS_PATH}`);
    const first = await new Promise<{ data: { alertCount: number } }>((resolve, reject) => {
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))));
      ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    ws.close();
    expect(first.data.alertCount).toBe(2);
  });

  test("a cross-site ack is refused and the alert stays", async () => {
    const res = await callServerFn("ackAlert", { key: `blocked:${ackId}` }, "cross-site");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await (await fetch(`${base}/alerts`)).text()).toContain("waiting on the ack");
  });

  test("ack and snooze through the app's server functions drop each alert from the next list", async () => {
    const acked = await callServerFn("ackAlert", { key: `blocked:${ackId}` }, "same-origin");
    expect(acked.status).toBe(200);
    let html = await (await fetch(`${base}/alerts`)).text();
    expect(html).not.toContain("waiting on the ack");
    expect(html).toContain("waiting on the snooze");

    const snoozed = await callServerFn("snoozeAlert", { key: `blocked:${snoozeId}` }, "same-origin");
    expect(snoozed.status).toBe(200);
    html = await (await fetch(`${base}/alerts`)).text();
    expect(html).not.toContain("waiting on the snooze");
    expect(html).toContain("All clear");
  });
});

describe("the OB dashboard opens no store of its own (OB-2205)", () => {
  test("no file under src calls getStore; serve.ts is the one place", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const hits = walk(join(APP, "src")).filter((f) => readFileSync(f, "utf8").includes("getStore"));
    expect(hits).toEqual([]);
    expect(readFileSync(join(APP, "serve.ts"), "utf8")).toContain("getStore(");
    expect(readFileSync(join(APP, "serve-handler.ts"), "utf8")).not.toContain("getStore");
  });
});
