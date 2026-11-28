import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  T3Client,
  T3Error,
  base64UrlEncode,
  channelForVersion,
  credentialPath,
  credentialStatus,
  decodeTokenClaims,
  mintCredential,
  readCredential,
  remedyForToolError,
  writeCredential,
  type FetchLike,
  type T3Credential,
} from "../src/t3/client.ts";
import { renderT3Doctor, type T3DoctorReport } from "../src/commands/t3.ts";

// ob 1102 — the ob→T3 transport seam. These tests are the offline half: every
// network call is a stubbed `fetchImpl`, so the suite needs no T3 server and no
// credential on the machine. The live proof is apps/cli/src/t3/probe.ts.

const dirs: string[] = [];
function tmpEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ob-t3-test-"));
  dirs.push(dir);
  return { OB_T3_CREDENTIAL_FILE: join(dir, "credential.json") } as NodeJS.ProcessEnv;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A token shaped like T3's: base64url(json-claims).base64url(signature). Pure. */
function fakeToken(claims: Record<string, unknown>): string {
  return `${base64UrlEncode(JSON.stringify(claims))}.sig-not-checked-locally`;
}

function cred(overrides: Partial<T3Credential> = {}): T3Credential {
  const baseUrl = "http://127.0.0.1:3773";
  return {
    version: 1,
    baseUrl,
    accessToken: fakeToken({ kind: "session", sub: "mcp-client", sid: "s-1", scopes: ["orchestration:read"], rtc: "full-access", iat: 1_700_000_000_000, exp: 4_100_000_000_000 }),
    tokenType: "Bearer",
    access: "full-access",
    scopes: ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"],
    issuedAt: "2026-10-17T15:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Route requests by path; each handler returns a Response. */
function stubFetch(routes: Record<string, (init: RequestInit | undefined) => Response | Promise<Response>>): FetchLike {
  return async (input, init) => {
    const path = new URL(input).pathname;
    const handler = routes[path];
    if (!handler) throw new Error(`no stub for ${path}`);
    return await handler(init);
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Await a promise that must reject with a T3Error, and return that error typed. */
async function fails<T>(promise: Promise<T>): Promise<T3Error> {
  try {
    await promise;
  } catch (err) {
    return err as T3Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("credential file (1102)", () => {
  test("writeCredential lands mode 600 outside the repo and round-trips", () => {
    const env = tmpEnv();
    const path = writeCredential(cred(), env);
    expect(path).toBe(credentialPath(env));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = readCredential(env);
    expect(back?.accessToken).toBe(cred().accessToken);
  });

  test("a missing file reads as null; a malformed one throws a named error", () => {
    const env = tmpEnv();
    expect(readCredential(env)).toBeNull();
    writeCredential(cred(), env);
    // Corrupt it in place.
    writeFileSync(credentialPath(env), JSON.stringify({ version: 1 }), { mode: 0o600 });
    expect(() => readCredential(env)).toThrow(T3Error);
  });

  test("credentialStatus reads the claim: valid, then expired", () => {
    const env = tmpEnv();
    const valid = cred();
    expect(credentialStatus(valid, 1_800_000_000_000, env).expired).toBe(false);
    expect(credentialStatus(valid, 4_200_000_000_000, env).expired).toBe(true);
    expect(credentialStatus(null, Date.now(), env).present).toBe(false);
  });

  test("decodeTokenClaims returns the ms-expiry claim", () => {
    const claims = decodeTokenClaims(fakeToken({ sid: "abc", exp: 123 }));
    expect(claims.sid).toBe("abc");
    expect(claims.exp).toBe(123);
  });
});

describe("mintCredential (1102)", () => {
  const base = "http://127.0.0.1:3773";

  test("runs register → approval → decision → token and writes the credential", async () => {
    const env = tmpEnv();
    const token = fakeToken({ kind: "session", sub: "mcp-client", sid: "s-9", scopes: ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"], rtc: "full-access", iat: 1_700_000_000_000, exp: 4_100_000_000_000 });
    const seen: string[] = [];
    const fetchImpl = stubFetch({
      "/oauth/mcp/register": () => { seen.push("register"); return json({ client_id: "client-1", redirect_uris: ["http://127.0.0.1:9/callback"] }); },
      "/oauth/mcp/approval": () => { seen.push("approval"); return json({ clientName: "ob", redirectHost: "127.0.0.1:9", environmentHost: "127.0.0.1:3773" }); },
      "/oauth/mcp/decision": () => { seen.push("decision"); return json({ redirectTo: "http://127.0.0.1:9/callback?code=abc&state=x" }); },
      "/oauth/mcp/token": () => { seen.push("token"); return json({ access_token: token, token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read orchestration:operate settings:write source-control:write" }); },
    });
    const needsPairing: string[] = [];
    const { credential, path, steps } = await mintCredential({
      baseUrl: base,
      env,
      deps: { fetchImpl, createPairingCode: (ttl) => { needsPairing.push(ttl); return "PAIRCODE"; } },
    });
    expect(seen).toEqual(["register", "approval", "decision", "token"]);
    expect(needsPairing).toEqual(["10m"]);
    expect(credential.access).toBe("full-access");
    expect(credential.scopes).toContain("source-control:write");
    expect(path).toBe(credentialPath(env));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(readCredential(env)?.accessToken).toBe(token);
  });

  test("an insufficient pairing code surfaces the server's refusal as a named error", async () => {
    const env = tmpEnv();
    const fetchImpl = stubFetch({
      "/oauth/mcp/register": () => json({ client_id: "client-1" }),
      "/oauth/mcp/approval": () => json({}),
      "/oauth/mcp/decision": () => json({ _tag: "AuthMcpApprovalError", message: "That pairing code cannot grant this access, and it is now used up." }, 400),
    });
    const err = await fails(mintCredential({ baseUrl: base, env, deps: { fetchImpl, createPairingCode: () => "X" } }));
    expect(err).toBeInstanceOf(T3Error);
    expect(err.kind).toBe("refused");
    expect(err.message).toContain("cannot grant this access");
    expect(err.remedy).toContain("standard scopes");
  });

  test("write:false mints without touching the credential path (the probe's renewal step)", async () => {
    const env = tmpEnv();
    const fetchImpl = stubFetch({
      "/oauth/mcp/register": () => json({ client_id: "client-1" }),
      "/oauth/mcp/approval": () => json({}),
      "/oauth/mcp/decision": () => json({ redirectTo: "http://127.0.0.1:9/callback?code=abc" }),
      "/oauth/mcp/token": () => json({ access_token: fakeToken({ exp: 4_100_000_000_000, scopes: [] }), token_type: "Bearer", expires_in: 2592000 }),
    });
    const out = await mintCredential({ baseUrl: base, env, write: false, deps: { fetchImpl, createPairingCode: () => "X" } });
    expect(out.path).toBeNull();
    expect(readCredential(env)).toBeNull();
  });
});

describe("T3Client error surfacing (1102)", () => {
  const base = "http://127.0.0.1:3773";
  const initOk = () => json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "T3 Code", version: "0.1.0" } } }, 200, { "mcp-session-id": "sess-1" });

  test("an explicit `credential: null` is an unauthenticated client, not a file read", async () => {
    const env = tmpEnv();
    // A malformed file on disk must not be touched by a reachability probe.
    writeFileSync(credentialPath(env), "not json", { mode: 0o600 });
    const client = new T3Client({ baseUrl: base, env, credential: null });
    expect(client.credential).toBeNull();
  });

  test("initialize captures the server version and session id", async () => {
    const fetchImpl = stubFetch({ "/mcp": (init) => (JSON.parse(String(init?.body)).method === "initialize" ? initOk() : json({ jsonrpc: "2.0" })) });
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl });
    const out = await client.initialize();
    expect(out.serverVersion).toBe("0.1.0");
    expect(out.sessionId).toBe("sess-1");
  });

  test("a tool-level isError surfaces the upstream {_tag, code, message}", async () => {
    const fetchImpl = stubFetch({
      "/mcp": (init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "initialize") return initOk();
        if (body.method === "notifications/initialized") return json({ jsonrpc: "2.0" });
        return json({
          jsonrpc: "2.0",
          id: 2,
          result: { isError: true, content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code: "thread_not_found", message: "Thread mcp:x is no longer available." }) }] },
        });
      },
    });
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl });
    const err = await fails(client.read("mcp:x"));
    expect(err).toBeInstanceOf(T3Error);
    expect(err.kind).toBe("refused");
    expect(err.message).toContain("no longer available");
    expect(err.remedy).toBe("the thread was deleted or the id is stale; re-read the tree");
  });

  test("a 401 on a tool call names the credential and the remedy", async () => {
    const fetchImpl = stubFetch({
      "/mcp": (init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "initialize") return initOk();
        return json({ error: "invalid_mcp_credential" }, 401);
      },
    });
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl });
    const err = await fails(client.settle("mcp:x"));
    expect(err).toBeInstanceOf(T3Error);
    expect(err.kind).toBe("credential_rejected");
    expect(err.remedy).toContain("ob t3 login");
  });

  test("an unreachable server raises 'unreachable', never a silent no-op", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl });
    const err = await fails(client.initialize());
    expect(err.kind).toBe("unreachable");
    expect(err.remedy).toContain("T3");
  });

  test("OS-203: a call T3 never answers raises 'timeout' naming the tool and the wait, not 'unreachable'", async () => {
    // A fetch that never settles on its own, only on the client's abort: T3 took the connection and went quiet.
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") return initOk();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    };
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl, timeoutMs: 30 });
    const err = await fails(client.callTool("t3_thread_launch", {}));
    expect(err).toBeInstanceOf(T3Error);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("T3 slow");
    expect(err.message).toContain("t3_thread_launch");
    expect(err.message).toMatch(/within 30ms \(gave up after \d+ms\)/);
    expect(err.message).not.toContain("not reachable");
  });

  test("OS-203: a refused connection on a tool call still raises 'unreachable'", async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") return initOk();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      throw new Error("connect ECONNREFUSED 127.0.0.1:3773");
    };
    const client = new T3Client({ baseUrl: base, env: tmpEnv(), credential: cred(), fetchImpl, timeoutMs: 30 });
    const err = await fails(client.callTool("t3_thread_launch", {}));
    expect(err.kind).toBe("unreachable");
    expect(err.message).toContain("ECONNREFUSED");
  });

  test("connected() refuses a missing credential by name", async () => {
    const err = await fails(T3Client.connected({ baseUrl: base, env: tmpEnv() }));
    expect(err.kind).toBe("credential_missing");
    expect(err.remedy).toContain("ob t3 login");
  });

  test("connected() refuses an expired credential before any launch", async () => {
    const env = tmpEnv();
    writeCredential(cred({ accessToken: fakeToken({ exp: 1_000 }), expiresAt: "1970-01-01T00:00:01.000Z" }), env);
    const err = await fails(T3Client.connected({ baseUrl: base, env }));
    expect(err.kind).toBe("credential_expired");
    expect(err.remedy).toContain("renew");
  });
});

describe("pure helpers (1102)", () => {
  test("channelForVersion derives the release channel", () => {
    expect(channelForVersion("0.1.0")).toBe("release");
    expect(channelForVersion("0.1.1-preview.20261017.3254")).toBe("preview");
    expect(channelForVersion("0.1.2-nightly.20261017")).toBe("nightly");
  });

  test("remedyForToolError names the known failure classes", () => {
    expect(remedyForToolError("thread_not_found")).toContain("deleted");
    expect(remedyForToolError("invalid_request")).toContain("arguments");
    expect(remedyForToolError(undefined)).toContain("doctor");
  });
});

describe("doctor rendering (1102)", () => {
  const report: T3DoctorReport = {
    baseUrl: "http://127.0.0.1:3773",
    credentialPath: "/home/x/.omnislash/t3-mcp-credential.json",
    stages: [
      { stage: "server", ok: true, detail: "T3 Code responding" },
      { stage: "credential", ok: false, detail: "missing", remedy: "run `ob t3 login`" },
    ],
    version: null,
    channel: null,
    pinnedBuild: "0.1.1-preview.20261017.3254",
    pinnedChannel: "preview",
    versionDrift: false,
    projects: [],
    providers: [],
    tools: 0,
    expiresAt: null,
    ok: false,
  };

  test("human output names the failing stage, its remedy and the credential path", () => {
    const text = renderT3Doctor(report, "human");
    expect(text).toContain("FAILED");
    expect(text).toContain("missing");
    expect(text).toContain("ob t3 login");
    expect(text).toContain(report.credentialPath);
  });

  test("json output is the whole report", () => {
    const parsed = JSON.parse(renderT3Doctor(report, "json")) as T3DoctorReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.stages[1]?.remedy).toBe("run `ob t3 login`");
  });

  test("quiet output is one line per stage", () => {
    expect(renderT3Doctor(report, "quiet").split("\n")).toEqual(["server\tok", "credential\tfailed"]);
  });
});
