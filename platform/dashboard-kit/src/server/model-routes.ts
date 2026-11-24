// OS-146: the OB dashboard's Models page over OS-145's model routing.
//
// The page reads and edits the server's `model_routes` setting through the SAME pure functions `ob models` uses
// (apps/cli/src/model-routes.ts), so model-routes.ts is the only judge of a value: nothing here re-checks one. It
// never writes the models file (a per-machine override the server cannot see), the legacy `review_readers` key or
// `spinoff_tier_models`. The dashboard host's models file is shown read-only: a route it overrides says so, and its
// editor writes the server value underneath.
//
// model-routes-io.ts is deliberately not imported: it pulls in the API client and the store opener.

import { originFromRequest, writeGate } from "../../../../apps/cli/src/credentials.ts";
import { EFFORT_LEVELS, type ModelsFile } from "../../../../apps/cli/src/models-file.ts";
import {
  ModelRoutesError,
  activeProfileOf,
  addReader,
  checkEffort,
  loadServerRoutes,
  parseChain,
  profileOrderOf,
  removeReader,
  resolveRouteIn,
  routeNames,
  saveModelRoutes,
  serverReview,
  setReaderTier,
  sourceLabel,
  useProfile,
  withProfileReview,
  withRoute,
  withoutRoute,
  writeProfile,
  type ActiveProfile,
  type RouteInputs,
  type RouteSource,
} from "../../../../apps/cli/src/model-routes.ts";
import { REVIEW_TIERS, ReviewReadersError, type ConfigIO, type ReviewReaders } from "../../../../apps/cli/src/review-readers.ts";
import { configIo } from "./config-io.ts";
import { assertSameOrigin } from "./same-origin.ts";
import type { WriteContext } from "./writes.ts";

export interface ModelsRouteRow {
  route: string;
  chain: string[];
  effort: string | null;
  source: RouteSource;
  /** `sourceLabel`: `local`, `server`, `default`, or `default (builder.complex)`. */
  label: string;
  /** What the server itself sets for this route in the profile shown, under any local override. */
  server: { chain: string[]; effort: string | null } | null;
}

export interface ModelsView {
  /** The dashboard host's models file: shown, never written. */
  file: { path: string; present: boolean };
  active: ActiveProfile;
  order: string[];
  /** The profiles the server defines. */
  profiles: string[];
  /** The profile these rows resolve in and every edit lands on. */
  profile: string;
  routes: ModelsRouteRow[];
  /** The readers this profile runs on the server (what the reader edits change), and the file's local legs. */
  review: { source: "server" | "legacy" | "default"; value: ReviewReaders; local: Record<string, string> };
  efforts: string[];
  tiers: string[];
}

export type ModelsOp =
  | { op: "setRoute"; profile: string; route: string; chain: string; effort?: string }
  | { op: "unsetRoute"; profile: string; route: string }
  | { op: "use"; profile: string }
  | { op: "readerAdd"; profile: string; leg: string; model: string }
  | { op: "readerRemove"; profile: string; leg: string }
  | { op: "readerTier"; profile: string; tier: string; legs: string[] };

export type ModelsEditResult = { ok: true; view: ModelsView } | { ok: false; error: string };

async function loadInputs(io: ConfigIO, file: ModelsFile | null): Promise<RouteInputs> {
  const sr = await loadServerRoutes(io);
  return { file, server: sr.server, legacyReaders: sr.legacyReaders, tierModels: sr.tierModels };
}

/** The inputs as if `profile` were active everywhere, so the resolver's own route list and labels apply to it. */
function as(inputs: RouteInputs, profile: string): RouteInputs {
  return { ...inputs, server: { ...inputs.server, active: profile }, file: inputs.file ? { ...inputs.file, active: profile } : null };
}

function viewOf(inputs: RouteInputs, file: { path: string; present: boolean }, named?: string): ModelsView {
  const profile = writeProfile(inputs, named);
  const shown = as(inputs, profile);
  const serverRoutes = inputs.server.profiles[profile]?.routes ?? {};
  const routes = routeNames(shown).map((route): ModelsRouteRow => {
    const r = resolveRouteIn(shown, route, profile);
    const own = serverRoutes[route];
    return {
      route,
      chain: r.chain,
      effort: r.effort ?? null,
      source: r.source,
      label: sourceLabel(r),
      server: own ? { chain: [...own.chain], effort: own.effort ?? null } : null,
    };
  });
  const review = serverReview(inputs, profile);
  return {
    file,
    active: activeProfileOf(inputs),
    order: profileOrderOf(inputs),
    profiles: Object.keys(inputs.server.profiles).sort(),
    profile,
    routes,
    review: { source: review.source, value: review.value, local: { ...inputs.file?.profiles[profile]?.review } },
    efforts: [...EFFORT_LEVELS],
    tiers: [...REVIEW_TIERS],
  };
}

/**
 * Everything the Models page shows, resolved in `profile` (default: the profile a write lands on, the active one).
 * `filePath` is where the host's models file would be when `file` is null.
 */
export async function loadModelsView(io: ConfigIO, file: ModelsFile | null, opts: { profile?: string; filePath: string }): Promise<ModelsView> {
  return viewOf(await loadInputs(io, file), { path: file?.path ?? opts.filePath, present: file !== null }, opts.profile);
}

/** The model-routes write's refusal over cleartext, beside the credential one (the same gate). */
function routesRefusal(origin: { proto: string; hostname: string }): string {
  return `refusing to change model routes over ${origin.proto}//${origin.hostname}: a model_routes write changes every machine, so it is taken only over https or on the machine itself. Reach the dashboard over https, or run \`ob models\` there`;
}

function apply(inputs: RouteInputs, op: ModelsOp) {
  const profile = writeProfile(inputs, op.profile);
  const review = (change: (v: ReviewReaders) => ReviewReaders) => withProfileReview(inputs.server, profile, change(serverReview(inputs, profile).value));
  switch (op.op) {
    case "setRoute":
      return withRoute(inputs.server, profile, op.route, parseChain(op.chain), op.effort ? checkEffort(op.effort) : undefined, inputs.tierModels);
    case "unsetRoute":
      return withoutRoute(inputs.server, profile, op.route);
    case "use":
      return useProfile(inputs, profile);
    case "readerAdd":
      return review((v) => addReader(v, op.leg, op.model));
    case "readerRemove":
      return review((v) => removeReader(v, op.leg));
    case "readerTier":
      return review((v) => setReaderTier(v, op.tier, op.legs));
  }
}

/**
 * One edit of the server's `model_routes`: the same-origin guard, then the TLS-or-loopback gate, then the store,
 * then model-routes.ts's pure edit and its validated save. A refusal (the gate, or a value model-routes.ts rejects)
 * comes back as `{ok: false, error}` with nothing stored; a cross-site request throws before the store is opened.
 */
export async function editModels(ctx: WriteContext, op: ModelsOp, file: ModelsFile | null, filePath: string): Promise<ModelsEditResult> {
  assertSameOrigin(ctx.request);
  const gate = writeGate(originFromRequest(ctx.request), routesRefusal);
  if (!gate.allowed) return { ok: false, error: gate.reason };
  const io = configIo(await ctx.store());
  try {
    const inputs = await loadInputs(io, file);
    const next = await saveModelRoutes(io, apply(inputs, op));
    return { ok: true, view: viewOf({ ...inputs, server: next }, { path: file?.path ?? filePath, present: file !== null }, op.profile) };
  } catch (e) {
    if (e instanceof ModelRoutesError || e instanceof ReviewReadersError) return { ok: false, error: e.message };
    throw e;
  }
}
