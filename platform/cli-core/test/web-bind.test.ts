import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { DEFAULTS, setting } from "../../../apps/cli/src/settings.ts";
import {
  WEB_BIND_DEFAULT,
  WEB_BIND_ENV,
  displayHost,
  isLoopbackBind,
  resolveWebBind,
  webBindFor,
  webServeEnv,
} from "../../../apps/cli/src/web-bind.ts";
import { startRealtimeServer } from "../../../apps/cli/src/realtime.ts";

// 192: `ob web` binds an address instead of whatever Bun picks. Every test here stays on loopback:
// nothing binds a public interface and nothing reaches the network.

describe("the default bind is loopback (192)", () => {
  test("the resolver with no source at all is 127.0.0.1", () => {
    expect(WEB_BIND_DEFAULT).toBe("127.0.0.1");
    expect(resolveWebBind()).toBe("127.0.0.1");
    expect(resolveWebBind({ flag: undefined, env: undefined, configured: undefined })).toBe("127.0.0.1");
  });

  test("the config default is loopback, so a fresh DB serves nobody but this machine", async () => {
    expect(DEFAULTS.web_bind).toBe("127.0.0.1");
    const db = freshDb();
    const store = sqliteStoreFor(db);
    expect(setting(db, "web_bind")).toBe("127.0.0.1");
    expect(await webBindFor(store)).toBe("127.0.0.1");
    expect(isLoopbackBind(await webBindFor(store))).toBe(true);
  });

  test("a blank flag, env or config row never widens the default", () => {
    expect(resolveWebBind({ flag: "", env: "  ", configured: "" })).toBe("127.0.0.1");
  });
});

describe("a configured bind is honoured (192)", () => {
  test("the web_bind config row is used when nothing overrides it", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setConfig(db, "web_bind", "10.0.0.30");
    expect(await webBindFor(store)).toBe("10.0.0.30");
    expect(isLoopbackBind("10.0.0.30")).toBe(false);
  });

  test("--bind beats the env var, which beats the config row", () => {
    expect(resolveWebBind({ flag: "10.0.0.1", env: "10.0.0.2", configured: "10.0.0.3" })).toBe("10.0.0.1");
    expect(resolveWebBind({ env: "10.0.0.2", configured: "10.0.0.3" })).toBe("10.0.0.2");
    expect(resolveWebBind({ configured: "10.0.0.3" })).toBe("10.0.0.3");
  });

  test("the env var is read live, and the flag still outranks it", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setConfig(db, "web_bind", "10.0.0.3");
    const prev = process.env[WEB_BIND_ENV];
    try {
      process.env[WEB_BIND_ENV] = "10.0.0.30";
      expect(await webBindFor(store)).toBe("10.0.0.30");
      expect(await webBindFor(store, "127.0.0.1")).toBe("127.0.0.1");
    } finally {
      if (prev === undefined) delete process.env[WEB_BIND_ENV];
      else process.env[WEB_BIND_ENV] = prev;
    }
  });

  test("a wildcard bind is reported as non-loopback and printed as a dialable host", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(displayHost("0.0.0.0")).toBe("localhost");
    expect(displayHost("10.0.0.30")).toBe("10.0.0.30");
  });

  test("the dashboard child server is handed the same bind through its env", () => {
    expect(webServeEnv("10.0.0.30")).toEqual({ HOST: "10.0.0.30", PORT: "5050" });
    expect(webServeEnv(WEB_BIND_DEFAULT)).toEqual({ HOST: "127.0.0.1", PORT: "5050" });
  });
});

describe("the realtime sidecar takes the same treatment (192)", () => {
  test("it binds loopback by default", () => {
    const rt = startRealtimeServer({ port: 0, store: sqliteStoreFor(freshDb()) });
    try {
      expect(rt.hostname).toBe("127.0.0.1");
    } finally {
      rt.stop();
    }
  });

  test("it binds the hostname it is given, and serves there", async () => {
    const rt = startRealtimeServer({ port: 0, hostname: "localhost", store: sqliteStoreFor(freshDb()) });
    try {
      expect(rt.hostname).toBe("localhost");
      const res = await fetch(`http://localhost:${rt.port}/`);
      expect(res.status).toBe(200);
    } finally {
      rt.stop();
    }
  });
});
