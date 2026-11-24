// OS-146: Playwright's webServer. Builds a fresh world (a migrated temp SQLite store seeded with SEED_ROUTES, and
// this host's models file) and serves the BUILT app on it, the way serve.ts serves production, on loopback.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../cli/src/db.ts";
import { sqliteStoreFor } from "../../cli/src/db/store.ts";
import { createSidecar } from "../../cli/src/realtime.ts";
import { provideStore } from "../provided-store.ts";
import { createObHandler } from "../serve-handler.ts";
import { seed } from "./seed.ts";
import { cliEnv, DB_PATH, E2E_DIR, MODELS_FILE, MODELS_FILE_TEXT, PORT } from "./world.ts";

// First, so the store and the server functions read this world (SQLite here, this models file) through the same
// env the CLI does, whatever store the shell that started Playwright points at.
Object.assign(process.env, cliEnv());
delete process.env.OMNISLASH_API;

rmSync(E2E_DIR, { recursive: true, force: true });
mkdirSync(dirname(MODELS_FILE), { recursive: true });
writeFileSync(MODELS_FILE, MODELS_FILE_TEXT);

const store = sqliteStoreFor(openDb(DB_PATH, { create: true })); // a fresh path: openDb creates and migrates it
await seed(store);
provideStore(async () => store);

const ssr = (await import(fileURLToPath(new URL("../dist/server/server.js", import.meta.url)))).default as {
  fetch: (req: Request) => Response | Promise<Response>;
};
const handler = createObHandler({
  clientDir: fileURLToPath(new URL("../dist/client", import.meta.url)),
  ssr,
  sidecar: createSidecar({ store: async () => store, pollMs: 500, upgradeOnRoot: false }),
  swSource: null,
});

Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 255, websocket: handler.websocket, fetch: handler.fetch });
console.log(`ob-dashboard e2e: http://127.0.0.1:${PORT} on ${DB_PATH}`);
