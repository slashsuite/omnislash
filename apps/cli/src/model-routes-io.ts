// OS-145: where a CLI process reads and writes `model_routes`: the API server when this machine is a client
// (`OMNISLASH_API` / ~/.omnislash_api_url), else its own store. Kept apart from model-routes.ts, which stays pure
// so the dashboard server and standalone scripts load it without the store or the API client.

import type { Database } from "bun:sqlite";
import { ApiClient } from "./api/client.ts";
import { resolveApiBase, resolveApiToken } from "./api/config.ts";
import { getConfig, setConfig } from "./config.ts";
import { commandStore, getStore, type Store } from "./db/store.ts";
import { loadModelsFile } from "./models-file.ts";
import {
  ModelRoutesError,
  emptyRouteInputs,
  hasProfile,
  loadServerRoutes,
  profileOrderOf,
  resolveRoute,
  saveModelRoutes,
  type ModelRoutes,
  writeRoutesCache,
  type RouteInputs,
} from "./model-routes.ts";
import { warn } from "./output.ts";
import { ReviewReadersError, type ConfigIO } from "./review-readers.ts";

/** The store's config table as a ConfigIO. */
export function storeConfigIo(db: Database | Store): ConfigIO {
  return { get: (k) => getConfig(db, k), set: (k, v) => setConfig(db, k, v) };
}

/** The API server's config table as a ConfigIO. */
export function apiConfigIo(client: Pick<ApiClient, "config" | "configSet">): ConfigIO {
  return {
    get: async (k) => (await client.config(k)).config[0]?.value ?? null,
    set: async (k, v) => {
      await client.configSet({ key: k, value: v });
    },
  };
}

/**
 * The config this machine's routes come from: the API when it is a client, else `db` (the command's own handle,
 * following the store switch) or the process store.
 */
export async function machineConfigIo(db?: Database | Store): Promise<ConfigIO> {
  const base = resolveApiBase();
  if (base) return apiConfigIo(new ApiClient({ base, token: resolveApiToken() }));
  if (db) return storeConfigIo("kind" in db ? db : await commandStore(db));
  return storeConfigIo(await getStore());
}

/**
 * The resolver's inputs on this machine. The local file is read first, and a malformed one throws its
 * `ModelsFileError` (never a silent launch on the defaults). A server that cannot be read leaves the local file and
 * the defaults, with ONE stderr line saying so (a stored value that does not parse throws its `ModelRoutesError`); `quiet` drops that line (pacing, `show`'s own report).
 */
export async function loadRouteInputs(io: ConfigIO | null, opts: { quiet?: boolean; lenient?: boolean } = {}): Promise<RouteInputs & { serverError: string | null }> {
  const file = loadModelsFile();
  if (!io) return { ...emptyRouteInputs({ file }), serverError: "no server to read" };
  let inputs: RouteInputs;
  try {
    const sr = await loadServerRoutes(io);
    writeRoutesCache(sr);
    inputs = { file, server: sr.server, legacyReaders: sr.legacyReaders, tierModels: sr.tierModels };
  } catch (e) {
    // A stored value that does not parse is refused by name, never skipped.
    if (e instanceof ModelRoutesError || e instanceof ReviewReadersError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    if (!opts.quiet) warn(`model_routes could not be read from the server (${reason}); using ${file ? "the local models file and " : ""}the defaults`);
    return { ...emptyRouteInputs({ file }), serverError: reason };
  }
  // Both layers were read, so a profile named as active or fallback that neither defines is a typo: refused by
  // name, never a silent run on the defaults. `lenient` (`ob models show`) reports it instead.
  if (!opts.lenient) {
    const missing = profileOrderOf(inputs).filter((name) => !hasProfile(inputs, name));
    if (missing.length > 0) {
      throw new ModelRoutesError(`profile ${missing.map((m) => `'${m}'`).join(", ")} is named as active or fallback but neither ${file ? file.path : "the models file"} nor the server's model_routes defines it`);
    }
  }
  return { ...inputs, serverError: null };
}

/**
 * The model a NEW team thread (`ob t3 architect`, `ob t3 team restart`) opens on: route `role.<role>`, or
 * undefined (the T3 project's default model, as before OS-145) when no layer above the defaults names it.
 */
export async function teamRoleModelFrom(io: ConfigIO | null, role: string): Promise<string | undefined> {
  const r = resolveRoute(await loadRouteInputs(io), `role.${role}`);
  return r.source === "default" ? undefined : r.chain[0];
}

/**
 * Read `model_routes`, apply `edit` and write the result back (validated). Unlike a read, a write never falls back:
 * a server that cannot be read or written throws, so a change is never reported that did not land.
 */
export async function editModelRoutes(io: ConfigIO, edit: (inputs: RouteInputs) => ModelRoutes): Promise<{ next: ModelRoutes; inputs: RouteInputs }> {
  const file = loadModelsFile();
  const sr = await loadServerRoutes(io);
  const inputs: RouteInputs = { file, server: sr.server, legacyReaders: sr.legacyReaders, tierModels: sr.tierModels };
  const next = await saveModelRoutes(io, edit(inputs));
  writeRoutesCache({ ...sr, server: next, raw: JSON.stringify(next) });
  return { next, inputs: { ...inputs, server: next } };
}
