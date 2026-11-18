import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampedServiceWorker, swVersionFor } from "../src/server/sw-version.ts";

const dirs: string[] = [];
function client(files: Record<string, string>): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-sw-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("service worker version stamp", () => {
  const sw = 'const VERSION = "__SW_VERSION__";';

  test("replaces the placeholder with the build version", () => {
    const dir = client({ "sw.js": sw, "assets/app-1.js": "a" });
    const out = stampedServiceWorker(dir);
    expect(out).toBe(`const VERSION = "${swVersionFor(dir)}";`);
    expect(swVersionFor(dir)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is stable for the same build and changes when a built file changes", () => {
    const a = client({ "sw.js": sw, "assets/app-1.js": "a" });
    const same = client({ "sw.js": sw + "// edited", "assets/app-1.js": "a" });
    const renamed = client({ "sw.js": sw, "assets/app-2.js": "a" });
    const resized = client({ "sw.js": sw, "assets/app-1.js": "ab" });
    const edited = client({ "sw.js": sw, "assets/app-1.js": "b" });
    expect(swVersionFor(same)).toBe(swVersionFor(a));
    expect(swVersionFor(renamed)).not.toBe(swVersionFor(a));
    expect(swVersionFor(resized)).not.toBe(swVersionFor(a));
    expect(swVersionFor(edited)).not.toBe(swVersionFor(a)); // same size, different bytes
  });

  test("refuses a worker with no placeholder", () => {
    expect(() => stampedServiceWorker(client({ "sw.js": "x" }))).toThrow("__SW_VERSION__");
  });
});
