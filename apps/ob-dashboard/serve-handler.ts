// OB-2205: the OB dashboard's request handling, kept apart from serve.ts so a test can drive it with its
// own sidecar and a temp store. serve.ts opens the store, starts Sentry and calls Bun.serve; this file
// opens nothing.
//
// The order is apps/dashboard/serve.ts's, with less in it: no consent pages and no ob API (those stay on
// the personal dashboard), and of the sidecar's three paths only the realtime socket. `/api/whatsapp/*`
// is never handed to the sidecar here, so they fall through to SSR's 404.
import type { Server } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { REALTIME_WS_PATH, type SidecarMount } from "../cli/src/realtime.ts";

export interface ObHandlerDeps {
  /** The built client directory (`dist/client`). */
  clientDir: string;
  /** The SSR fetch handler (`dist/server/server.js`'s default export). */
  ssr: { fetch: (req: Request) => Response | Promise<Response> };
  sidecar: SidecarMount;
  /** The stamped service worker, or null when the build has none. */
  swSource: string | null;
}

/** Map a request path to a real file under the client directory, or null (traversal guarded). */
function resolveStatic(clientDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = normalize(join(clientDir, decoded));
  if (full !== clientDir && !full.startsWith(clientDir + "/")) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

export function createObHandler({ clientDir, ssr, sidecar, swSource }: ObHandlerDeps) {
  return {
    websocket: {
      open: sidecar.websocket.open,
      close: sidecar.websocket.close,
      message() {
        sidecar.websocket.message();
      },
    },
    // `undefined` is an upgraded socket, which has no Response (Bun's contract for an upgrade).
    async fetch(req: Request, srv: Server<undefined>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === REALTIME_WS_PATH) {
        const res = await sidecar.fetch(req, (r) => srv.upgrade(r, { data: undefined }));
        if (res !== null) return res;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname === "/sw.js" && swSource) {
          return new Response(req.method === "HEAD" ? null : swSource, {
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
              "Service-Worker-Allowed": "/",
            },
          });
        }
        const file = resolveStatic(clientDir, url.pathname);
        if (file) {
          const headers: Record<string, string> = {};
          if (url.pathname.startsWith("/assets/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
          if (url.pathname === "/manifest.webmanifest") {
            headers["Content-Type"] = "application/manifest+json";
            headers["Cache-Control"] = "no-cache";
          }
          return new Response(Bun.file(file), { headers });
        }
      }
      return ssr.fetch(req);
    },
  };
}
