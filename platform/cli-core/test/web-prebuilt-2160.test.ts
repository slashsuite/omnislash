import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import { cmdWeb, type WebDeps } from "../../../apps/cli/src/commands/web.ts";

// OB-2160: `ob web --prebuilt` serves the dist on disk and never builds, so a deploy's restart is down for the
// process start, not the vite build. A missing dist is a refusal, never a quiet build. A fake spawn and a fake
// realtime server: no port is bound and nothing is built.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function webDir(withDist: "both" | "server-only" | "none"): string {
  const d = mkdtempSync(join(tmpdir(), "ob-web-2160-"));
  dirs.push(d);
  if (withDist !== "none") {
    mkdirSync(join(d, "dist", "server"), { recursive: true });
    writeFileSync(join(d, "dist", "server", "server.js"), "export default {};\n");
  }
  if (withDist === "both") mkdirSync(join(d, "dist", "client"), { recursive: true });
  return d;
}

function ctxFor(prebuilt: boolean): Ctx {
  const db = freshDb();
  return { db, store: sqliteStoreFor(db), dbPath: ":memory:", mode: "text", flags: prebuilt ? { prebuilt: true } : {}, args: [] } as unknown as Ctx;
}

function fakeDeps(dir: string): { deps: WebDeps; calls: string[][]; realtime: { started: number } } {
  const calls: string[][] = [];
  const realtime = { started: 0 };
  const deps: WebDeps = {
    webDir: dir,
    spawn: (cmd) => {
      calls.push(cmd);
      // Every child exits 0 at once: the serve child's clean exit ends cmdWeb.
      return { exited: Promise.resolve(0), kill() {} };
    },
    startRealtime: () => {
      realtime.started += 1;
      return { stop() {} };
    },
    onSignal: { on() {}, off() {} },
  };
  return { deps, calls, realtime };
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

describe("ob web --prebuilt (OB-2160)", () => {
  test("serves without running bun run build", async () => {
    const dir = webDir("both");
    const { deps, calls } = fakeDeps(dir);
    const out = await capture(() => cmdWeb(ctxFor(true), deps));
    expect(calls).toEqual([["bun", "run", "serve"]]);
    expect(out).toContain(`serving the prebuilt dashboard in ${join(dir, "dist")} (no build)`);
    expect(out).toContain("serving OmniSlash dashboard (built)");
    expect(out).not.toContain("building OmniSlash dashboard");
  });

  test("refuses to start, naming apps/dashboard/dist, when the dist is missing", async () => {
    const dir = webDir("none");
    const { deps, calls, realtime } = fakeDeps(dir);
    const err = await cmdWeb(ctxFor(true), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`no built dashboard at ${join(dir, "dist")}`);
    expect((err as Error).message).toContain(join(dir, "dist", "server", "server.js"));
    expect((err as Error).message).toContain("moon run dashboard:build");
    // Nothing was built, nothing served, and neither listener was opened.
    expect(calls).toEqual([]);
    expect(realtime.started).toBe(0);
  });

  test("refuses half a dist (the SSR handler but no client statics)", async () => {
    const dir = webDir("server-only");
    const { deps, calls } = fakeDeps(dir);
    const err = await cmdWeb(ctxFor(true), deps).catch((e: unknown) => e);
    expect((err as Error).message).toContain(join(dir, "dist", "client"));
    expect(calls).toEqual([]);
  });

  test("plain ob web still builds first, then serves", async () => {
    const dir = webDir("none");
    const { deps, calls } = fakeDeps(dir);
    await capture(() => cmdWeb(ctxFor(false), deps));
    expect(calls).toEqual([["bun", "run", "build"], ["bun", "run", "serve"]]);
  });
});
