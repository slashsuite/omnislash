// OB-2205 (OB-2199 step 3): production self-host for the BUILT OB dashboard under Bun, the short sibling
// of apps/dashboard/serve.ts. It hosts the realtime socket, the stamped sw.js, the static client and SSR,
// and nothing else: no consent pages, no ob API, no WhatsApp routes (serve-handler.ts).
// `ob web --app ob-dashboard` starts it with PORT and HOST (and the TLS pair when one is configured).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "../cli/src/db/store.ts";
import { createSidecar } from "../cli/src/realtime.ts";
import { startSentry } from "../cli/src/sentry/report.ts";
import { stampedServiceWorker } from "../../platform/dashboard-kit/src/server/sw-version.ts";
import { provideStore } from "./provided-store.ts";
import { createObHandler } from "./serve-handler.ts";

const CLIENT_DIR = fileURLToPath(new URL("./dist/client", import.meta.url));
const ssr = (await import(new URL("./dist/server/server.js", import.meta.url).href)).default as {
  fetch: (req: Request) => Response | Promise<Response>;
};
const swSource = existsSync(join(CLIENT_DIR, "sw.js")) ? stampedServiceWorker(CLIENT_DIR) : null;

// No default port: production's :5070 comes from its unit (OB-2199 step 4) and a dev port from `ob ports next`.
const PORT = Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error("ob-dashboard: set PORT");
// Loopback unless `ob web` hands down a LAN bind, as apps/dashboard/serve.ts does (ob 192).
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const TLS_CERT = process.env.OMNISLASH_WEB_TLS_CERT?.trim() || "";
const TLS_KEY = process.env.OMNISLASH_WEB_TLS_KEY?.trim() || "";
const tls = TLS_CERT && TLS_KEY ? { cert: readFileSync(TLS_CERT, "utf8"), key: readFileSync(TLS_KEY, "utf8") } : null;

// `migrate: false`, as the personal dashboard does (OB-1617): the deploy migrates before it restarts us.
const store = () => getStore({ migrate: false });
// OB-2207: the server functions inside the SSR bundle read the store through this, never opening one.
provideStore(store);

// The same Sentry project (omnislash-web) as the personal dashboard; this app's unit sets its own
// OMNISLASH_SENTRY_ENVIRONMENT (step 4), which is how its errors are told apart.
await startSentry("web", store);

const handler = createObHandler({
  clientDir: CLIENT_DIR,
  ssr,
  sidecar: createSidecar({ store }),
  swSource,
});

Bun.serve({
  port: PORT,
  hostname: HOST,
  ...(tls ? { tls } : {}),
  // SSR streaming responses can outlast Bun's default 10s idle window.
  idleTimeout: 255,
  websocket: handler.websocket,
  fetch: handler.fetch,
});

console.log(`ob-dashboard (built): ${tls ? "https" : "http"}://${HOST}:${PORT}`);
