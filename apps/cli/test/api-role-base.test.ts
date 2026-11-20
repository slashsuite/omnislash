import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError, ROLE_ROUTE } from "../src/api/client.ts";
import {
  ACCESS_CLIENT_ID_ENV,
  ACCESS_CLIENT_SECRET_ENV,
  ACCESS_FILE_ENV,
  ROLE_API_ENV,
  ROLE_API_FILE_ENV,
  resolveRoleApiBase,
} from "../src/api/config.ts";

// OS-76 — the team role routes can go to a second server (the role base), and every other route stays on the
// main base. Offline by construction: both servers are real Bun servers bound to 127.0.0.1 and nothing else.

const TOKEN = "os76-token-value-must-never-print";

interface Seen {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  accessId: string | null;
  accessSecret: string | null;
}

interface Fake {
  url: string;
  seen: Seen[];
  server: ReturnType<typeof Bun.serve>;
  reply: { status: number; body: string };
}

function fakeServer(): Fake {
  const seen: Seen[] = [];
  const reply = { status: 200, body: "{}" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        auth: req.headers.get("authorization"),
        accessId: req.headers.get("cf-access-client-id"),
        accessSecret: req.headers.get("cf-access-client-secret"),
      });
      return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
    },
  });
  // `reply` is the same object the handler reads, so a test sets `fake.reply` to change what comes back.
  return { url: `http://127.0.0.1:${server.port}`, seen, server, reply };
}

type Call = (c: ApiClient) => Promise<unknown>;

// The ten method and path pairs of the team role routes (contract.ts, the team role section).
const ROLE_CALLS: Array<{ method: string; path: string; call: Call }> = [
  { method: "GET", path: "/api/ob/teams/omnibus/runs", call: (c) => c.roleRuns("omnibus") },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/runs",
    call: (c) => c.roleRunMark("omnibus", { role: "architect", t3_host: "desk" }),
  },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/runs/7",
    call: (c) => c.roleRunUpdate("omnibus", 7, { thread_id: "thread-1" }),
  },
  { method: "POST", path: "/api/ob/teams/omnibus/runs/7/note-shown", call: (c) => c.roleNoteShown("omnibus", 7) },
  { method: "GET", path: "/api/ob/teams/omnibus/tick", call: (c) => c.roleTick("omnibus") },
  { method: "GET", path: "/api/ob/teams/omnibus/brief", call: (c) => c.roleBrief("omnibus", "architect") },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/notes",
    call: (c) => c.roleNote("omnibus", { role: "architect", body: "a note" }),
  },
  { method: "GET", path: "/api/ob/teams/omnibus/inbox", call: (c) => c.roleMessages("omnibus", "architect", true) },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/inbox",
    call: (c) => c.roleMessageSend("omnibus", { role: "architect", from: "builder", body: "hello" }),
  },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/inbox/read",
    call: (c) => c.roleMessagesRead("omnibus", "architect", [1], "architect"),
  },
];

// Routes that are NOT role routes: the team itself, its handoffs, and a non-team route.
const MAIN_CALLS: Array<{ method: string; path: string; call: Call }> = [
  { method: "GET", path: "/api/ob/teams", call: (c) => c.teams() },
  { method: "GET", path: "/api/ob/teams/omnibus", call: (c) => c.team("omnibus") },
  {
    method: "POST",
    path: "/api/ob/teams/omnibus/handoffs",
    call: (c) => c.teamHandoffCreate("omnibus", "architect", "handoff body"),
  },
  { method: "GET", path: "/api/ob/brief", call: (c) => c.brief() },
];

const ENV_KEYS = [
  ROLE_API_ENV,
  ROLE_API_FILE_ENV,
  ACCESS_FILE_ENV,
  ACCESS_CLIENT_ID_ENV,
  ACCESS_CLIENT_SECRET_ENV,
];

let saved: Record<string, string | undefined> = {};
let dir = "";
let main: Fake;
let role: Fake;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "os76-role-base-"));
  // Point the role file and the Access file at paths that do not exist, so the real home folder is never read.
  process.env[ROLE_API_FILE_ENV] = join(dir, "absent-role-url");
  process.env[ACCESS_FILE_ENV] = join(dir, "absent-access.json");
  main = fakeServer();
  role = fakeServer();
});

afterEach(async () => {
  await main.server.stop(true);
  await role.server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the role route matcher (OS-76)", () => {
  test("matches the ten role method and path pairs, with or without a sub-path or query", () => {
    for (const { path } of ROLE_CALLS) {
      const route = path.replace("/api/ob", "");
      expect(ROLE_ROUTE.test(route), route).toBe(true);
    }
    expect(ROLE_ROUTE.test("/teams/omnibus/runs?role=architect")).toBe(true);
  });

  test("leaves the team itself, its handoffs and non-team routes on the main base", () => {
    for (const { path } of MAIN_CALLS) {
      const route = path.replace("/api/ob", "");
      expect(ROLE_ROUTE.test(route), route).toBe(false);
    }
    expect(ROLE_ROUTE.test("/teams/omnibus/runsx")).toBe(false);
  });
});

describe("with a role base set, the role routes go to the role server (OS-76)", () => {
  test("each of the ten role routes reaches the role server and nothing reaches the main server", async () => {
    process.env[ROLE_API_ENV] = role.url;
    const client = new ApiClient({ base: main.url, token: TOKEN });
    for (const { method, path, call } of ROLE_CALLS) {
      await call(client);
      const last = role.seen.at(-1);
      expect(last?.method, path).toBe(method);
      expect(last?.path, path).toBe(path);
    }
    expect(role.seen).toHaveLength(ROLE_CALLS.length);
    expect(main.seen, "no role route may reach the main server").toEqual([]);
  });

  test("the team itself, its handoffs and a non-team route reach the main server", async () => {
    process.env[ROLE_API_ENV] = role.url;
    const client = new ApiClient({ base: main.url, token: TOKEN });
    for (const { method, path, call } of MAIN_CALLS) {
      await call(client);
      const last = main.seen.at(-1);
      expect(last?.method, path).toBe(method);
      expect(last?.path, path).toBe(path);
    }
    expect(main.seen).toHaveLength(MAIN_CALLS.length);
    expect(role.seen, "no non-role route may reach the role server").toEqual([]);
  });
});

describe("with no role base, every route reaches the main server as before (OS-76)", () => {
  test("env unset and the role file absent: all routes go to the main base", async () => {
    process.env[ROLE_API_ENV] = "";
    const client = new ApiClient({ base: main.url, token: TOKEN, roleBase: undefined });
    for (const { call } of [...ROLE_CALLS, ...MAIN_CALLS]) await call(client);
    expect(main.seen).toHaveLength(ROLE_CALLS.length + MAIN_CALLS.length);
    expect(role.seen).toEqual([]);
  });

  test("an empty role file is the same as no file: all routes go to the main base", async () => {
    const empty = join(dir, "empty-role-url");
    writeFileSync(empty, "\n");
    process.env[ROLE_API_FILE_ENV] = empty;
    const client = new ApiClient({ base: main.url, token: TOKEN });
    for (const { call } of ROLE_CALLS) await call(client);
    expect(main.seen).toHaveLength(ROLE_CALLS.length);
    expect(role.seen).toEqual([]);
  });

  test("an explicit null role base sends every route to the main base", async () => {
    process.env[ROLE_API_ENV] = role.url;
    const client = new ApiClient({ base: main.url, token: TOKEN, roleBase: null });
    for (const { call } of ROLE_CALLS) await call(client);
    expect(main.seen).toHaveLength(ROLE_CALLS.length);
    expect(role.seen).toEqual([]);
  });
});

describe("the role base is read from the env first, then the file (OS-76)", () => {
  test("the env var wins over the file", () => {
    const file = join(dir, "role-url");
    writeFileSync(file, "http://127.0.0.1:9\n");
    process.env[ROLE_API_FILE_ENV] = file;
    process.env[ROLE_API_ENV] = "http://127.0.0.1:8/";
    expect(resolveRoleApiBase()).toBe("http://127.0.0.1:8");
  });

  test("with no env var the first line of the file is the base, trailing slashes trimmed", () => {
    const file = join(dir, "role-url");
    writeFileSync(file, "http://127.0.0.1:9/\nhttp://127.0.0.1:10\n");
    process.env[ROLE_API_FILE_ENV] = file;
    expect(resolveRoleApiBase()).toBe("http://127.0.0.1:9");
  });

  test("OMNISLASH_ROLE_API_URL_FILE moves the file: the file at that path is the one read", () => {
    const moved = join(dir, "moved-role-url");
    writeFileSync(moved, "http://127.0.0.1:7\n");
    process.env[ROLE_API_FILE_ENV] = moved;
    expect(resolveRoleApiBase()).toBe("http://127.0.0.1:7");
    // A path that does not exist is not read at all, so nothing is configured.
    process.env[ROLE_API_FILE_ENV] = join(dir, "not-there");
    expect(resolveRoleApiBase()).toBeNull();
  });

  test("the client picks the role base up from the file when no env var is set", async () => {
    const file = join(dir, "role-url");
    writeFileSync(file, `${role.url}\n`);
    process.env[ROLE_API_FILE_ENV] = file;
    const client = new ApiClient({ base: main.url, token: TOKEN });
    await client.roleTick("omnibus");
    expect(role.seen.map((s) => s.path)).toEqual(["/api/ob/teams/omnibus/tick"]);
    expect(main.seen).toEqual([]);
  });

  test("a role url carrying a username or password is refused, as the main base is", () => {
    process.env[ROLE_API_ENV] = "http://user:pw@127.0.0.1:9";
    expect(() => resolveRoleApiBase()).toThrow(/username or password/);
  });
});

describe("a bad role setting fails only the role routes (OS-76)", () => {
  test("a role url with no scheme refuses the role routes, while the main routes still work", async () => {
    process.env[ROLE_API_ENV] = "ob.example.org";
    const client = new ApiClient({ base: main.url, token: TOKEN });
    await expect(client.roleTick("omnibus")).rejects.toThrow(/not a url/);
    await client.team("omnibus");
    await client.teamHandoffCreate("omnibus", "architect", "handoff body");
    expect(main.seen.map((s) => s.path)).toEqual([
      "/api/ob/teams/omnibus",
      "/api/ob/teams/omnibus/handoffs",
    ]);
    expect(role.seen).toEqual([]);
  });
});

describe("the bearer token and the Access headers reach the role server (OS-76)", () => {
  test("both servers get the same bearer token and the same Access pair", async () => {
    process.env[ROLE_API_ENV] = role.url;
    process.env[ACCESS_CLIENT_ID_ENV] = "access-id-os76";
    process.env[ACCESS_CLIENT_SECRET_ENV] = "access-secret-os76";
    const client = new ApiClient({ base: main.url, token: TOKEN });
    await client.roleTick("omnibus");
    await client.team("omnibus");
    for (const seen of [role.seen[0], main.seen[0]]) {
      expect(seen?.auth).toBe(`Bearer ${TOKEN}`);
      expect(seen?.accessId).toBe("access-id-os76");
      expect(seen?.accessSecret).toBe("access-secret-os76");
    }
  });

  test("an error from the role server names the role base, not the main one, and scrubs the token", async () => {
    process.env[ROLE_API_ENV] = role.url;
    Object.assign(role.reply, { status: 500, body: `the role host failed while holding ${TOKEN}` });
    const client = new ApiClient({ base: main.url, token: TOKEN });
    const err = await client.roleRuns("omnibus").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    const message = (err as ApiError).message;
    expect(message).toContain(role.url);
    expect(message).not.toContain(main.url);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("<redacted>");
  });

  test("an error from the main server still names the main base", async () => {
    process.env[ROLE_API_ENV] = role.url;
    Object.assign(main.reply, { status: 500, body: "the main host failed" });
    const client = new ApiClient({ base: main.url, token: TOKEN });
    const err = await client.team("omnibus").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain(main.url);
    expect((err as ApiError).message).not.toContain(role.url);
  });
});
