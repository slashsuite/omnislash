import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { lastCredentialCheck, type CredentialCheckRow } from "../../../cli/src/credentials.ts";
import { ModelRoutesError } from "../../../cli/src/model-routes.ts";
import { ModelsFileError, loadModelsFile, modelsFilePath, type ModelsFile } from "../../../cli/src/models-file.ts";
import { configIo } from "../../../../platform/dashboard-kit/src/server/config-io.ts";
import {
  editModels,
  loadModelsView,
  type ModelsEditResult,
  type ModelsOp,
  type ModelsView,
} from "../../../../platform/dashboard-kit/src/server/model-routes.ts";
import { loadFavorites, type T3Favorites } from "../../../cli/src/t3-favorites.ts";
import { providedStore } from "../../provided-store.ts";

// OS-146: the Models page's server functions over OS-145's `model_routes` setting. The store comes from serve.ts
// (providedStore), never opened here. Every check of a value is model-routes.ts's, inside the kit's editModels; the
// validators below only check the request's shape. This host's models file is read to show what it overrides and
// is never written. OS-23: the page also carries the OpenCode Go credit state, the last recorded
// `ob creds check opencode-go` (the paid review readers run on it); the page never calls the provider itself.

export type { ModelsView, ModelsOp, ModelsEditResult };

export interface ModelsPage {
  view: ModelsView;
  /** Why this host's models file was not read (it does not parse), or why the asked profile was not shown. */
  notes: string[];
  /** The last recorded `ob creds check opencode-go`, or null when it was never checked. */
  credit: CredentialCheckRow | null;
  /** OS-240: the T3 favourite models `ob models sync-favorites` last stored, the model dropdowns' options; null when never synced. */
  favourites: T3Favorites | null;
}

/** This host's models file, or null with the reason it could not be read (shown, not thrown). */
function hostFile(notes: string[]): ModelsFile | null {
  try {
    return loadModelsFile();
  } catch (e) {
    if (!(e instanceof ModelsFileError)) throw e;
    notes.push(`${e.message}; showing the server's routes without it`);
    return null;
  }
}

export const getModels = createServerFn({ method: "GET" })
  .validator((d: { profile?: string | undefined } | undefined) => ({ profile: typeof d?.profile === "string" && d.profile ? d.profile : undefined }))
  .handler(async ({ data }): Promise<ModelsPage> => {
    const notes: string[] = [];
    const file = hostFile(notes);
    const store = await providedStore();
    const io = configIo(store);
    const credit = await lastCredentialCheck(store, "opencode-go");
    const favourites = await loadFavorites(io);
    try {
      return { view: await loadModelsView(io, file, { profile: data.profile, filePath: modelsFilePath() }), notes, credit, favourites };
    } catch (e) {
      if (!(e instanceof ModelRoutesError) || data.profile === undefined) throw e;
      notes.push(e.message);
      return { view: await loadModelsView(io, file, { filePath: modelsFilePath() }), notes, credit, favourites };
    }
  });

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
};

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number") throw new Error(`${name} must be a number`);
  return v;
};

const list = (v: unknown, name: string): Array<Record<string, unknown>> => {
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
  return v.map((e) => (e ?? {}) as Record<string, unknown>);
};

/** The op's shape only: the values themselves are model-routes.ts's to judge. */
function shapeOf(d: unknown): ModelsOp {
  const o = (d ?? {}) as Record<string, unknown>;
  const profile = str(o.profile, "profile");
  switch (o.op) {
    case "setRoute":
      return { op: "setRoute", profile, route: str(o.route, "route"), chain: str(o.chain, "chain"), ...(o.effort ? { effort: str(o.effort, "effort") } : {}) };
    case "unsetRoute":
      return { op: "unsetRoute", profile, route: str(o.route, "route") };
    case "use":
      return { op: "use", profile };
    case "readerAdd":
      return { op: "readerAdd", profile, leg: str(o.leg, "leg"), model: str(o.model, "model") };
    case "readerRemove":
      return { op: "readerRemove", profile, leg: str(o.leg, "leg") };
    case "readerFallback":
      return { op: "readerFallback", profile, leg: str(o.leg, "leg"), fallback: o.fallback === null || o.fallback === undefined ? null : str(o.fallback, "fallback") };
    case "builderRanges":
      return {
        op: "builderRanges",
        profile,
        ranges: list(o.ranges, "ranges").map((r) => ({ from: num(r.from, "from"), to: num(r.to, "to"), chain: str(r.chain, "chain"), ...(r.effort ? { effort: str(r.effort, "effort") } : {}) })),
      };
    case "readerRanges":
      return {
        op: "readerRanges",
        profile,
        ranges: list(o.ranges, "ranges").map((r) => ({ from: num(r.from, "from"), to: num(r.to, "to"), legs: list(r.legs, "legs").map((l) => str(l as unknown, "leg")) })),
      };
    default:
      throw new Error("unknown op");
  }
}

/** One edit of the server's model_routes. Refused over cleartext off this machine (the kit's write gate). */
export const saveModels = createServerFn({ method: "POST" })
  .validator(shapeOf)
  .handler(async ({ data }): Promise<ModelsEditResult> => {
    const file = hostFile([]);
    return await editModels({ request: getRequest(), store: providedStore }, data, file, modelsFilePath());
  });
