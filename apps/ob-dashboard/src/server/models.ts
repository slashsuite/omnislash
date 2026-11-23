import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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
import { providedStore } from "../../provided-store.ts";

// OS-146: the Models page's server functions over OS-145's `model_routes` setting. The store comes from serve.ts
// (providedStore), never opened here. Every check of a value is model-routes.ts's, inside the kit's editModels; the
// validators below only check the request's shape. This host's models file is read to show what it overrides and
// is never written.

export type { ModelsView, ModelsOp, ModelsEditResult };

export interface ModelsPage {
  view: ModelsView;
  /** Why this host's models file was not read (it does not parse), or why the asked profile was not shown. */
  notes: string[];
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
  .validator((d: { profile?: string } | undefined) => ({ profile: typeof d?.profile === "string" && d.profile ? d.profile : undefined }))
  .handler(async ({ data }): Promise<ModelsPage> => {
    const notes: string[] = [];
    const file = hostFile(notes);
    const io = configIo(await providedStore());
    try {
      return { view: await loadModelsView(io, file, { profile: data.profile, filePath: modelsFilePath() }), notes };
    } catch (e) {
      if (!(e instanceof ModelRoutesError) || data.profile === undefined) throw e;
      notes.push(e.message);
      return { view: await loadModelsView(io, file, { filePath: modelsFilePath() }), notes };
    }
  });

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
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
    case "readerTier":
      if (!Array.isArray(o.legs)) throw new Error("legs must be a list");
      return { op: "readerTier", profile, tier: str(o.tier, "tier"), legs: o.legs.map((l) => str(l, "leg")) };
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
