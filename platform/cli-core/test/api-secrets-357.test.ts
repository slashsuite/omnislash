// ob 357: `ob secret` and `ob creds` over the API.
//
// This is the one endpoint family where a SECRET VALUE crosses the wire, so the bar here is higher than
// anywhere else in this API and it is written as NEGATIVE assertions. A test that a listing returns the
// right names would pass just as happily if the listing also returned every value, which is the single
// worst bug available on this path -- so what is asserted below is what must NOT be there:
//
//   - a listing carries no value, checked over the SERIALISED body rather than field by field;
//   - no url the client ever builds carries a value OR a name;
//   - an error that arrives carrying a value is redacted before it reaches stderr;
//   - 401 covers every new endpoint, and answers before the store is touched.
//
// Every value below is synthetic and generated per-run. No real token appears in this file, and the
// master key is an in-memory one: the real provider refuses under a test runner (`realKeychainBlocked`)
// precisely so a suite can never contend for the developer's login Keychain.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { inMemoryMasterKey, listSecrets, setSecret } from "../../../apps/cli/src/secrets.ts";
import { redactSecrets, type ApiRequest, type ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { OB_API_PREFIX, OB_API_ROUTES, type ObApiErrorBody } from "../../../apps/cli/src/api/contract.ts";
import { API_ROUTED_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import type { Probes } from "../../../apps/cli/src/credentials.ts";

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const OTHER_TOKEN = "a-different-bearer-token-of-similar-size";
const BUDGET = spawnBudget(4);
const KEY = inMemoryMasterKey();

/** A synthetic value, distinctive enough that finding it anywhere is unambiguous. Never a real token. */
function fakeValue(label: string): string {
  return `SYNTHETIC-${label}-${randomUUID()}`;
}

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface Call {
  method?: string;
  body?: unknown;
  /** Omit for the good token; pass null for NO Authorization header at all. */
  token?: string | null;
}

interface ApiCtx {
  store: Store;
  call(path: string, opts?: Call): Promise<{ status: number; body: any; text: string }>;
}

/** The probes the credential inventory reads this machine through. Nothing here touches the machine. */
function fakeProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    fileState: () => ({ exists: false, bytes: 0, mode: null }),
    keychainItem: () => false,
    onPath: () => false,
    env: () => undefined,
    ...overrides,
  };
}

async function withApi(
  fn: (ctx: ApiCtx) => Promise<void>,
  deps: { probes?: Probes; http?: typeof fetch } = {},
): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    secrets: { masterKey: KEY },
    creds: {
      probes: deps.probes ?? fakeProbes(),
      check: {
        masterKey: KEY,
        probes: deps.probes ?? fakeProbes(),
        ...(deps.http ? { http: deps.http } : {}),
      },
    },
  });
  const call = async (path: string, opts: Call = {}) => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await api(
      new Request(url(path), {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null, text };
  };
  try {
    await fn({ store, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

// --- the server ---------------------------------------------------------------------------------------

describe("GET /secrets lists NAMES and never a value (357)", () => {
  test(
    "three stored secrets come back as names and ages, and NOT ONE BYTE of any value is in the body",
    async () => {
      await withApi(async ({ store, call }) => {
        const values = {
          linear: fakeValue("linear"),
          ha: fakeValue("ha"),
          "cloudflare-api-token": fakeValue("cf"),
        };
        for (const [name, value] of Object.entries(values)) await setSecret(store, name, value, KEY.get());

        const res = await call("/secrets");
        expect(res.status).toBe(200);
        expect(res.body.secrets.map((s: { name: string }) => s.name).sort()).toEqual([
          "cloudflare-api-token",
          "ha",
          "linear",
        ]);
        // Over the WHOLE serialised response, not field by field: a value smuggled in under any key, at
        // any depth, in any future field, fails here. That is the assertion this endpoint exists for.
        for (const value of Object.values(values)) expect(res.text).not.toContain(value);
        // Nor the ciphertext, iv or auth tag -- the encrypted form is still the secret, just in a coat.
        expect(res.text).not.toContain("ciphertext");
        expect(res.text).not.toContain("auth_tag");
        // And the row has exactly the two fields the contract names, so nothing can drift in unnoticed.
        for (const row of res.body.secrets) expect(Object.keys(row).sort()).toEqual(["name", "updated_at"]);
      });
    },
    BUDGET,
  );
});

describe("reading and writing one secret (357)", () => {
  test(
    "POST /secrets stores a value and POST /secrets/read decrypts it back, server-side",
    async () => {
      await withApi(async ({ store, call }) => {
        const value = fakeValue("round-trip");
        const set = await call("/secrets", { body: { name: "linear", value } });
        expect(set.status).toBe(200);
        expect(set.body).toEqual({ name: "linear", set: true, updated_at: expect.any(String) });
        // The write's own response carries no value: what comes back is the row, not the thing.
        expect(set.text).not.toContain(value);

        const read = await call("/secrets/read", { body: { name: "linear" } });
        expect(read.status).toBe(200);
        expect(read.body).toEqual({ name: "linear", value });

        // Read back through the STORE as well, so this proves a real encrypted row rather than an echo.
        const rows = await listSecrets(store);
        expect(rows.map((r) => r.name)).toEqual(["linear"]);
      });
    },
    BUDGET,
  );

  test(
    "a name that is not stored is a 404 in the same words `ob secret get` uses locally",
    async () => {
      await withApi(async ({ call }) => {
        const read = await call("/secrets/read", { body: { name: "nothing-here" } });
        expect(read.status).toBe(404);
        expect((read.body as ObApiErrorBody).error.code).toBe("not_found");
        expect((read.body as ObApiErrorBody).error.message).toBe("no secret `nothing-here` in the store");
      });
    },
    BUDGET,
  );

  test(
    "POST /secrets/remove deletes it, and removing what is not there is a 404 rather than a silent ok",
    async () => {
      await withApi(async ({ store, call }) => {
        await setSecret(store, "ha", fakeValue("ha"), KEY.get());
        const gone = await call("/secrets/remove", { body: { name: "ha" } });
        expect(gone.status).toBe(200);
        expect(gone.body).toEqual({ name: "ha", removed: true });
        expect(await listSecrets(store)).toEqual([]);

        const again = await call("/secrets/remove", { body: { name: "ha" } });
        expect(again.status).toBe(404);
      });
    },
    BUDGET,
  );

  test(
    "an empty or non-string value is refused BY FIELD NAME, and the refusal never quotes what it rejected",
    async () => {
      await withApi(async ({ call }) => {
        const value = fakeValue("rejected");
        for (const body of [{ name: "linear" }, { name: "linear", value: "" }, { name: "linear", value: 7 }]) {
          const res = await call("/secrets", { body });
          expect(res.status).toBe(400);
          expect((res.body as ObApiErrorBody).error.code).toBe("invalid_request");
          expect((res.body as ObApiErrorBody).error.message).toContain("'value'");
        }
        // A validation message that echoed the value back would put it in the client's stderr and in the
        // server's own error rendering. Prove the rejected shape is described, never quoted.
        const withValue = await call("/secrets", { body: { name: "", value } });
        expect(withValue.status).toBe(400);
        expect(withValue.text).not.toContain(value);
      });
    },
    BUDGET,
  );

  test(
    "a name full of percent-escapes is just data, because it never goes through a url (the 352 class)",
    async () => {
      await withApi(async ({ call }) => {
        const name = "weird%2f%name";
        const value = fakeValue("percent");
        expect((await call("/secrets", { body: { name, value } })).status).toBe(200);
        const read = await call("/secrets/read", { body: { name } });
        expect(read.status).toBe(200);
        expect(read.body.value).toBe(value);
      });
    },
    BUDGET,
  );
});

describe("auth runs before anything else on the secret path (357, map D5)", () => {
  test(
    "every secret and creds endpoint answers 401 without a token, and 401 identically with a wrong one",
    async () => {
      await withApi(async ({ store, call }) => {
        const value = fakeValue("guarded");
        await setSecret(store, "linear", value, KEY.get());
        const endpoints: Array<[string, Call]> = [
          ["/secrets", {}],
          ["/secrets/read", { body: { name: "linear" } }],
          ["/secrets", { body: { name: "linear", value: fakeValue("nope") } }],
          ["/secrets/remove", { body: { name: "linear" } }],
          ["/creds", {}],
          ["/creds/check", { body: { name: "linear" } }],
        ];
        for (const [path, opts] of endpoints) {
          const missing = await call(path, { ...opts, token: null });
          const wrong = await call(path, { ...opts, token: OTHER_TOKEN });
          expect(missing.status).toBe(401);
          expect(wrong.status).toBe(401);
          // Byte for byte the same: whether the token was absent or merely wrong is not the caller's
          // business, and telling them apart tells a guesser their guess had the right shape.
          expect(missing.text).toBe(wrong.text);
          // A 401 says nothing about the store, so it cannot leak the value it was reaching for.
          expect(missing.text).not.toContain(value);
          expect(missing.text).not.toContain("linear");
        }
        // The store is untouched by all of that: the refused `set` did not write, the refused `remove`
        // did not delete. Auth ran before the path was parsed, which is the point of the ordering.
        const rows = await listSecrets(store);
        expect(rows.map((r) => r.name)).toEqual(["linear"]);
      });
    },
    BUDGET,
  );
});

describe("GET /creds and POST /creds/check (357)", () => {
  test(
    "the inventory reports presence and age for a stored secret, and carries no value",
    async () => {
      await withApi(async ({ store, call }) => {
        const value = fakeValue("inventory");
        await setSecret(store, "github", value, KEY.get());
        const res = await call("/creds");
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(value);
        const github = res.body.credentials.find((c: { name: string }) => c.name === "github");
        expect(github.present).toBe(true);
        expect(github.presence_detail).toBe("in the encrypted store");
        const ha = res.body.credentials.find((c: { name: string }) => c.name === "ha");
        expect(ha.present).toBe(false);
      });
    },
    BUDGET,
  );

  test(
    "a live check records a verdict, and a provider that echoes the credential back gets it REDACTED",
    async () => {
      const value = fakeValue("echoed-back");
      const http = (async () => {
        return new Response(JSON.stringify({ login: `viewer ${value}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await withApi(
        async ({ store, call }) => {
          await setSecret(store, "github", value, KEY.get());
          const res = await call("/creds/check", { body: { name: "github" } });
          expect(res.status).toBe(200);
          expect(res.body.checks).toHaveLength(1);
          expect(res.body.checks[0].name).toBe("github");
          expect(res.body.checks[0].ok).toBe(true);
          expect(res.text).not.toContain(value);
          expect(res.body.checks[0].detail).toContain("[redacted]");
        },
        { http },
      );
    },
    BUDGET,
  );

  test(
    "`{}` is refused rather than checking nothing and answering 200 with an empty list",
    async () => {
      await withApi(async ({ call }) => {
        const neither = await call("/creds/check", { body: {} });
        expect(neither.status).toBe(400);
        expect((neither.body as ObApiErrorBody).error.message).toContain("give 'name' or 'all'");
        const both = await call("/creds/check", { body: { name: "github", all: true } });
        expect(both.status).toBe(400);
        expect((both.body as ObApiErrorBody).error.message).toContain("not both");
      });
    },
    BUDGET,
  );

  test(
    "a name that is not a credential is refused by name rather than recorded as a failed check",
    async () => {
      await withApi(async ({ call }) => {
        const res = await call("/creds/check", { body: { name: "not-a-credential" } });
        expect(res.status).toBe(400);
        expect((res.body as ObApiErrorBody).error.message).toContain("not a known credential");
      });
    },
    BUDGET,
  );
});

// --- the served surface -------------------------------------------------------------------------------

describe("the shape of the surface itself (357)", () => {
  test("NO secret or creds route has a `:param` segment: a name never appears in a url", () => {
    // The GET-vs-POST decision, made mechanical. `GET /secrets/:name` would put the inventory of which
    // tokens exist into Cloudflare's access logs, the tunnel's logs and every proxy between -- none of
    // which this repo controls, and all of which outlive the request. This test is what keeps it out.
    const guarded = OB_API_ROUTES.filter((r) => r.path.startsWith("/secrets") || r.path.startsWith("/creds"));
    expect(guarded.length).toBeGreaterThan(0);
    for (const route of guarded) expect(route.path).not.toContain(":");
    // And every route that NAMES one is a POST, so the name is in a body.
    for (const route of guarded) {
      if (route.path === "/secrets" && route.method === "GET") continue; // the listing names nothing
      if (route.path === "/creds" && route.method === "GET") continue;
      expect(route.method).toBe("POST");
    }
  });

  test("`secret` and `creds` are ROUTED, not local-only: that refusal is what ob 357 removed", () => {
    expect(API_ROUTED_COMMANDS.has("secret")).toBe(true);
    expect(API_ROUTED_COMMANDS.has("creds")).toBe(true);
  });
});

// --- the client -----------------------------------------------------------------------------------
//
// Stubbed transport: no network, no token file, no database. What matters here is what the client PUTS on
// the wire and what it prints when things go wrong.

const BASE = "https://ob.example.test";
const CLIENT_TOKEN = "test-token-do-not-log";

interface Stub {
  transport: ApiTransport;
  calls: ApiRequest[];
}

function stub(answers: Record<string, unknown>, fail?: (req: ApiRequest) => never): Stub {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    if (fail) fail(req);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
      };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

function api(s: Stub) {
  return { api: { base: BASE, token: CLIENT_TOKEN, transport: s.transport } };
}

/**
 * `runCli` captures console.log, and `ob secret get` writes the value with `printRaw` straight to
 * stdout -- deliberately, so the value is not put through a renderer. So stdout is captured here too,
 * or the one command whose whole output is the value would be invisible to its own test.
 */
async function runCliRaw(args: string[], deps: ReturnType<typeof api>) {
  const original = process.stdout.write.bind(process.stdout);
  let raw = "";
  (process.stdout.write as unknown) = (chunk: string) => {
    raw += chunk;
    return true;
  };
  try {
    const r = await runCli(freshDbPath(), args, deps);
    return { ...r, raw };
  } finally {
    (process.stdout.write as unknown) = original;
  }
}

/** Every url a set of calls produced must be free of these strings. The whole point of the design. */
function expectNothingInUrls(calls: ApiRequest[], forbidden: string[]): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    for (const value of forbidden) expect(call.url).not.toContain(value);
  }
}

describe("`ob secret` over the API (357)", () => {
  test("`ob secret get` prints the value verbatim, and neither the name nor the value is in the url", async () => {
    const value = fakeValue("client-get");
    const s = stub({ "POST /secrets/read": { name: "linear", value } });
    const r = await runCliRaw(["secret", "get", "linear"], api(s));
    expect(r.code).toBe(0);
    // Verbatim and newline-terminated: `$(ob secret get linear)` must be the same string it is locally.
    expect(r.raw).toBe(`${value}\n`);
    const call = s.calls[0]!;
    expect(call.url).toBe(`${BASE}${OB_API_PREFIX}/secrets/read`);
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body!)).toEqual({ name: "linear" });
    expectNothingInUrls(s.calls, [value, "linear", CLIENT_TOKEN]);
    expect(call.headers.authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
  });

  test("`ob secret set` sends the value in the BODY only, and prints no part of it", async () => {
    const value = fakeValue("client-set");
    const s = stub({ "POST /secrets": { name: "ha", set: true, updated_at: "2026-08-19T00:00:00.000Z" } });
    // stdin is the only way in: the value must never be in argv, where a shell history would keep it.
    const original = Bun.stdin.text;
    (Bun.stdin as unknown as { text: () => Promise<string> }).text = async () => `${value}\n`;
    try {
      const r = await runCliRaw(["secret", "set", "ha"], api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("set secret");
      expect(r.out).not.toContain(value);
      expect(JSON.parse(s.calls[0]!.body!)).toEqual({ name: "ha", value });
      expectNothingInUrls(s.calls, [value, "ha", CLIENT_TOKEN]);
    } finally {
      (Bun.stdin as unknown as { text: () => Promise<string> }).text = original;
    }
  });

  test("`ob secret list` renders names and ages, from the same renderer the local command uses", async () => {
    const s = stub({
      "GET /secrets": {
        secrets: [
          { name: "ha", updated_at: "2026-08-01T00:00:00.000Z" },
          { name: "linear", updated_at: "2026-08-02T00:00:00.000Z" },
        ],
      },
    });
    const r = await runCliRaw(["secret", "list"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ha\t2026-08-01T00:00:00.000Z");
    expect(r.out).toContain("linear\t2026-08-02T00:00:00.000Z");
    expect(s.calls[0]!.method).toBe("GET");
  });

  test("`ob secret rm` names what it removed", async () => {
    const s = stub({ "POST /secrets/remove": { name: "ha", removed: true } });
    const r = await runCliRaw(["secret", "rm", "ha"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed secret");
    expectNothingInUrls(s.calls, ["ha"]);
  });

  test("`ob secret import` REFUSES by name and makes no request: it is about this machine's files", async () => {
    const s = stub({});
    const r = await runCliRaw(["secret", "import"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("'ob secret import' is not available through the ob API");
    expect(r.err).toContain("the SERVER's files");
    // OB-1809: it says which files, so the refusal can be judged rather than taken on trust.
    expect(r.err).toContain("~/.google_token");
    expect(r.err).toContain("~/.ha_token");
    // A command that ran, exited 0 and imported the wrong machine's tokens is the failure being avoided.
    expect(s.calls).toEqual([]);
  });

  test("an unknown subcommand is a usage error before any request", async () => {
    const s = stub({});
    const r = await runCliRaw(["secret", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(s.calls).toEqual([]);
  });
});

describe("a value never reaches stderr, however it comes back (357)", () => {
  test("a TRANSPORT error whose message carries the value is redacted before it is printed", async () => {
    const value = fakeValue("transport-error");
    // fetch failures can carry the request back with them, and `secret set` puts the value in that
    // request. This is the leak that would otherwise print a live token into a terminal and a log.
    const s = stub({}, (req) => {
      throw new Error(`socket hang up while sending ${req.body}`);
    });
    const original = Bun.stdin.text;
    (Bun.stdin as unknown as { text: () => Promise<string> }).text = async () => `${value}\n`;
    try {
      const r = await runCliRaw(["secret", "set", "ha"], api(s));
      expect(r.code).toBe(1);
      expect(r.err).toContain("could not reach the ob API");
      expect(r.err).not.toContain(value);
      expect(r.err).toContain("<redacted>");
    } finally {
      (Bun.stdin as unknown as { text: () => Promise<string> }).text = original;
    }
  });

  test("a 500 whose BODY echoes the request back is redacted too", async () => {
    const value = fakeValue("echoed-500");
    const calls: ApiRequest[] = [];
    const transport: ApiTransport = async (req) => {
      calls.push(req);
      // A proxy or a framework error page that quotes what it was given. It is not this API's shape, so
      // the client falls through to the raw-snippet branch -- which is the branch that must be scrubbed.
      return { status: 500, body: `upstream rejected the payload ${req.body}` };
    };
    const original = Bun.stdin.text;
    (Bun.stdin as unknown as { text: () => Promise<string> }).text = async () => `${value}\n`;
    try {
      const r = await runCliRaw(["secret", "set", "ha"], { api: { base: BASE, token: CLIENT_TOKEN, transport } });
      expect(r.code).toBe(1);
      expect(r.err).not.toContain(value);
      expect(r.err).toContain("<redacted>");
    } finally {
      (Bun.stdin as unknown as { text: () => Promise<string> }).text = original;
    }
  });

  test("redactSecrets removes every occurrence of every value it is given, and tolerates an empty one", () => {
    const a = fakeValue("a");
    const b = fakeValue("b");
    expect(redactSecrets(`${a} and ${a} and ${b}`, [a, b])).toBe("<redacted> and <redacted> and <redacted>");
    // An empty string would otherwise match between every character and destroy the message entirely.
    expect(redactSecrets("nothing to hide", [""])).toBe("nothing to hide");
  });
});

describe("`ob creds` over the API (357)", () => {
  const status = (name: string, present: boolean) => ({
    name,
    label: name,
    home: "store",
    refresh: "paste",
    command: `ob secret set ${name}`,
    purpose: "a purpose",
    present,
    presence_detail: present ? "in the encrypted store" : "not in the encrypted store",
    updated_at: present ? "2026-08-01T00:00:00.000Z" : null,
    writable: true,
    checkable: true,
    last_check: null,
  });

  test("`ob creds` renders the host's inventory with the local renderer", async () => {
    const s = stub({ "GET /creds": { credentials: [status("linear", true), status("github", false)] } });
    const r = await runCliRaw(["creds"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("linear");
    expect(r.out).toContain("present");
    expect(r.out).toContain("1 missing: github");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/creds`);
  });

  test("`ob creds check --all` asks for all, and a named check puts the NAME in the body", async () => {
    const all = stub({ "POST /creds/check": { checks: [{ name: "linear", checked_at: "t", ok: true, detail: "fine" }] } });
    const r = await runCliRaw(["creds", "check", "--all"], api(all));
    expect(r.code).toBe(0);
    expect(r.out).toContain("linear");
    expect(JSON.parse(all.calls[0]!.body!)).toEqual({ all: true });

    // 1655: a FAILED verdict exits 1, the same contract as the local command.
    const one = stub({ "POST /creds/check": { checks: [{ name: "ha", checked_at: "t", ok: false, detail: "no" }] } });
    const r2 = await runCliRaw(["creds", "check", "ha"], api(one));
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("FAILED");
    expect(JSON.parse(one.calls[0]!.body!)).toEqual({ name: "ha" });
    expectNothingInUrls(one.calls, ["ha"]);
  });

  test("`ob creds check` with neither a name nor --all is a usage error before any request", async () => {
    const s = stub({});
    const r = await runCliRaw(["creds", "check"], api(s));
    expect(r.code).toBe(2);
    expect(s.calls).toEqual([]);
  });
});
