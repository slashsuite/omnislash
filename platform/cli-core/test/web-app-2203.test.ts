import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import { cmdWeb, type WebDeps } from "../../../apps/cli/src/commands/web.ts";

// OB-2199 step 1: `ob web --app <name> --port <n> --no-sidecar-port`. A named app is served from apps/<name>
// on its own port, and `--no-sidecar-port` opens no standalone :5051 listener. Fake spawn and fake realtime,
// as in the 2160 tests: no port is bound and nothing is built.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary apps/ directory holding the named apps, each with a dist (or without one). */
function appsDirWith(apps: Record<string, "dist" | "none">): string {
  const root = mkdtempSync(join(tmpdir(), "ob-web-2199-"));
  dirs.push(root);
  for (const [name, dist] of Object.entries(apps)) {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "serve.ts"), "export {};\n");
    if (dist === "dist") {
      mkdirSync(join(d, "dist", "server"), { recursive: true });
      writeFileSync(join(d, "dist", "server", "server.js"), "export default {};\n");
      mkdirSync(join(d, "dist", "client"), { recursive: true });
    }
  }
  return root;
}

function ctxFor(flags: Record<string, unknown>): Ctx {
  const db = freshDb();
  return { db, store: sqliteStoreFor(db), dbPath: ":memory:", mode: "text", flags, args: [] } as unknown as Ctx;
}

interface Spawned {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined> | undefined;
}

function fakeDeps(extra: Partial<WebDeps>): { deps: WebDeps; spawned: Spawned[]; realtime: { started: number } } {
  const spawned: Spawned[] = [];
  const realtime = { started: 0 };
  const deps: WebDeps = {
    spawn: (cmd, opts) => {
      spawned.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exited: Promise.resolve(0), kill() {} };
    },
    startRealtime: () => {
      realtime.started += 1;
      return { stop() {} };
    },
    onSignal: { on() {}, off() {} },
    ...extra,
  };
  return { deps, spawned, realtime };
}

async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe("ob web with no --app or --port keeps today's behaviour (OB-2199 step 1)", () => {
  test("the default dashboard on 5050 with the 5051 sidecar, as before", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const out = await capture(() => cmdWeb(ctxFor({}), deps));
    expect(realtime.started).toBe(1);
    expect(out).toContain(":5051 (pushes on DB change)");
    expect(out).toContain("http://127.0.0.1:5050");
    expect(spawned[0]?.cmd).toEqual(["bun", "run", "build"]);
    expect(spawned[1]?.cwd).toBe(join(root, "dashboard"));
    expect(spawned[1]?.env?.PORT).toBe("5050");
  });
});

describe("ob web --app <name> (OB-2199 step 1)", () => {
  test("serves the named app's directory on the default port, with the sidecar", async () => {
    const root = appsDirWith({ dashboard: "dist", "ob-dashboard": "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const out = await capture(() => cmdWeb(ctxFor({ app: "ob-dashboard", prebuilt: true }), deps));
    expect(spawned.map((s) => s.cmd)).toEqual([["bun", "run", "serve"]]);
    expect(spawned[0]?.cwd).toBe(join(root, "ob-dashboard"));
    expect(spawned[0]?.env?.PORT).toBe("5050");
    expect(realtime.started).toBe(1);
    expect(out).toContain("http://127.0.0.1:5050");
  });

  test("refuses a name with no directory under apps/, by name, before anything is built or bound", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(ctxFor({ app: "nope" }), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain('no app named "nope"');
    expect(spawned).toEqual([]);
    expect(realtime.started).toBe(0);
  });

  test("refuses a name that is not one directory name (no path escape)", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(ctxFor({ app: "../dashboard" }), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain('"../dashboard" is not an app name');
    expect(spawned).toEqual([]);
  });

  test("--prebuilt refuses when apps/<name>/dist is missing, naming moon run <name>:build", async () => {
    const root = appsDirWith({ "ob-dashboard": "none" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(ctxFor({ app: "ob-dashboard", prebuilt: true }), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`no built ob-dashboard at ${join(root, "ob-dashboard", "dist")}`);
    expect((err as Error).message).toContain("moon run ob-dashboard:build");
    expect(spawned).toEqual([]);
    expect(realtime.started).toBe(0);
  });

  test("plain --app (no --prebuilt) builds the named app first, then serves it", async () => {
    const root = appsDirWith({ "ob-dashboard": "none" });
    const { deps, spawned } = fakeDeps({ appsDir: root });
    await capture(() => cmdWeb(ctxFor({ app: "ob-dashboard" }), deps));
    expect(spawned.map((s) => s.cmd)).toEqual([["bun", "run", "build"], ["bun", "run", "serve"]]);
    expect(spawned[0]?.cwd).toBe(join(root, "ob-dashboard"));
  });
});

describe("ob web --port <n> (OB-2199 step 1)", () => {
  test("hands the port to the child and prints that port, not 5050", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned } = fakeDeps({ appsDir: root });
    const out = await capture(() => cmdWeb(ctxFor({ port: "5199", prebuilt: true }), deps));
    expect(spawned[0]?.env?.PORT).toBe("5199");
    expect(out).toContain("http://127.0.0.1:5199");
    expect(out).not.toContain(":5050");
  });

  test("a value that is not a port is refused before anything starts", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    for (const bad of ["abc", "0", "65536", "51.5"]) {
      const err = await cmdWeb(ctxFor({ port: bad, prebuilt: true }), deps).catch((e: unknown) => e);
      expect((err as Error).message).toContain(`"${bad}" is not a port`);
    }
    expect(spawned).toEqual([]);
    expect(realtime.started).toBe(0);
  });
});

describe("ob web --app and --port refusals (OB-2199 step 1)", () => {
  test("a --port that is the sidecar's own 5051 is refused before anything starts", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(ctxFor({ port: "5051", prebuilt: true }), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain("that is the realtime sidecar's port");
    expect(spawned).toEqual([]);
    expect(realtime.started).toBe(0);
  });

  test("a directory under apps/ with no serve.ts is refused by name, not run", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    mkdirSync(join(root, "bare"));
    const { deps, spawned } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(ctxFor({ app: "bare" }), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain('"bare" is not a served app (no serve.ts');
    expect(spawned).toEqual([]);
  });

  test("an unusable configured certificate refuses under --app too, before any listener opens", async () => {
    const root = appsDirWith({ "ob-dashboard": "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const err = await cmdWeb(
      ctxFor({ app: "ob-dashboard", port: "5199", "tls-cert": join(root, "missing.pem"), "tls-key": join(root, "missing.key") }),
      deps,
    ).catch((e: unknown) => e);
    // The refusal is the certificate's own (it names the missing path), not some other throw.
    expect((err as Error).message).toContain("missing.pem");
    expect(spawned).toEqual([]);
    expect(realtime.started).toBe(0);
  });
});

describe("ob web --no-sidecar-port (OB-2199 step 1)", () => {
  test("starts no standalone :5051 listener and prints no realtime line", async () => {
    const root = appsDirWith({ dashboard: "dist" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root });
    const out = await capture(() => cmdWeb(ctxFor({ app: "dashboard", port: "5199", "no-sidecar-port": true, prebuilt: true }), deps));
    expect(realtime.started).toBe(0);
    expect(out).not.toContain("realtime:");
    expect(out).not.toContain(":5051");
    expect(spawned.map((s) => s.cmd)).toEqual([["bun", "run", "serve"]]);
    expect(spawned[0]?.env?.PORT).toBe("5199");
  });

  test("with --no-sidecar-port the build path still stops cleanly, with no sidecar to stop", async () => {
    const root = appsDirWith({ "ob-dashboard": "none" });
    const { deps, spawned, realtime } = fakeDeps({ appsDir: root, spawn: (cmd, opts) => {
      spawned.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exited: Promise.resolve(1), kill() {} };
    } });
    let err: unknown;
    await capture(async () => {
      err = await cmdWeb(ctxFor({ app: "ob-dashboard", "no-sidecar-port": true }), deps).catch((e: unknown) => e);
    });
    expect((err as Error).message).toContain("ob-dashboard build failed (exit 1)");
    expect(spawned.map((s) => s.cmd)).toEqual([["bun", "run", "build"]]);
    expect(realtime.started).toBe(0);
  });
});
