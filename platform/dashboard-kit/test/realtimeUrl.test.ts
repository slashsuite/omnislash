import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REALTIME_WS_PATH, realtimeWsUrl, sidecarBaseUrl } from "../src/lib/realtimeUrl.ts";
import { REALTIME_WS_PATH as SERVER_WS_PATH, isSidecarPath } from "../../../apps/cli/src/realtime.ts";

// 358: the page reaches the sidecar on its OWN origin under a path. The rule this file exists to stop
// regressing is narrow and absolute: no URL the browser builds for the sidecar may name a port of our
// choosing. It used to name 5051, which was right on the LAN and unreachable through the Cloudflare
// tunnel (354), and that single wrong URL cost the WhatsApp thread, the avatars, the media and the
// live badge at once.

describe("the sidecar is reached on the page's own origin (358)", () => {
  test("the http proxies are root-relative, so there is no host and no port at all", () => {
    expect(sidecarBaseUrl()).toBe("");
    expect(`${sidecarBaseUrl()}/api/whatsapp/thread`).toBe("/api/whatsapp/thread");
  });

  test("a tunnel-served page builds a wss URL with no port", () => {
    const url = realtimeWsUrl({ protocol: "https:", host: "example.test" });
    expect(url).toBe("wss://example.test/api/realtime");
    expect(new URL(url).port).toBe("");
  });

  test("a LAN-served page keeps the page's OWN port, and never a second one", () => {
    const url = realtimeWsUrl({ protocol: "http:", host: "10.0.0.30:5050" });
    expect(url).toBe("ws://10.0.0.30:5050/api/realtime");
    expect(new URL(url).port).toBe("5050");
  });

  test("a laptop page still dials its own localhost origin", () => {
    expect(realtimeWsUrl({ protocol: "http:", host: "localhost:5050" })).toBe(
      "ws://localhost:5050/api/realtime",
    );
  });

  test("no sidecar URL ever names 5051", () => {
    for (const loc of [
      { protocol: "https:", host: "example.test" },
      { protocol: "http:", host: "10.0.0.30:5050" },
      { protocol: "http:", host: "localhost:5050" },
    ]) {
      expect(realtimeWsUrl(loc)).not.toContain("5051");
    }
    expect(sidecarBaseUrl()).not.toContain("5051");
    // and the module itself carries no port constant to drift back in.
    const src = readFileSync(new URL("../src/lib/realtimeUrl.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/REALTIME_PORT/);
  });

  test("the client's socket path is the one the server mounts", () => {
    expect(REALTIME_WS_PATH).toBe(SERVER_WS_PATH);
    expect(isSidecarPath(REALTIME_WS_PATH)).toBe(true);
  });

  test("the server claims every path the page builds, and nothing the router owns", () => {
    for (const p of [
      "/api/whatsapp/thread",
      "/api/whatsapp/media",
      "/api/whatsapp/avatar",
      "/api/whatsapp/transcribe",
      "/api/whatsapp/status",
    ]) {
      expect(isSidecarPath(p)).toBe(true);
    }
    for (const p of ["/", "/whatsapp", "/api/ob/items", "/assets/app.js"]) {
      expect(isSidecarPath(p)).toBe(false);
    }
  });
});
