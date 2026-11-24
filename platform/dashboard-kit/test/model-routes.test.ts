// OS-146: the Models page's one write path. The same-origin guard runs before the store is opened, the
// TLS-or-loopback gate refuses a cleartext LAN request with nothing stored, and a value model-routes.ts rejects
// comes back as its own message with nothing stored.
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { getConfig, setConfig } from "../../../apps/cli/src/config.ts";
import { MODEL_ROUTES_KEY } from "../../../apps/cli/src/model-routes.ts";
import { editModels, type ModelsOp } from "../src/server/model-routes.ts";
import { CrossSiteRequestError } from "../src/server/same-origin.ts";

const SEED = JSON.stringify({
  active: "claude",
  profiles: { claude: { routes: { "builder.complex": { chain: ["opus"] } } } },
});

function world(): { store: Store; stored: () => Promise<string | null> } {
  const store = sqliteStoreFor(freshDb());
  return { store, stored: () => getConfig(store, MODEL_ROUTES_KEY) };
}

async function seeded() {
  const w = world();
  await setConfig(w.store, MODEL_ROUTES_KEY, SEED);
  return w;
}

const post = (url: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
  new Request(url, { method: "POST", headers });

const SET: ModelsOp = { op: "setRoute", profile: "claude", route: "builder.medium", chain: "sonnet, haiku" };

describe("editModels gate", () => {
  test("a cleartext request from the LAN is refused and model_routes is unchanged", async () => {
    const w = await seeded();
    const r = await editModels({ request: post("http://192.168.0.5/_serverFn/x"), store: async () => w.store }, SET, null, "/nowhere");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("refusing to change model routes over http://192.168.0.5");
    expect(await w.stored()).toBe(SEED);
  });

  for (const url of ["https://dash.example.test/_serverFn/x", "http://127.0.0.1:3000/_serverFn/x"]) {
    test(`${new URL(url).protocol}//${new URL(url).hostname} saves`, async () => {
      const w = await seeded();
      const r = await editModels({ request: post(url), store: async () => w.store }, SET, null, "/nowhere");
      expect(r.ok).toBe(true);
      const band = r.ok ? r.view.builder.bands.find((b) => b.from === 4 && b.to === 6) : undefined;
      expect(band).toMatchObject({ chain: ["sonnet", "haiku"], source: "server" });
      expect(JSON.parse((await w.stored()) ?? "{}").profiles.claude.routes["builder.medium"].chain).toEqual(["sonnet", "haiku"]);
    });
  }

  test("a cross-site request throws before the store getter runs", async () => {
    let opened = false;
    const ctx = {
      request: post("https://dash.example.test/_serverFn/x", { "sec-fetch-site": "cross-site" }),
      store: async () => {
        opened = true;
        return world().store;
      },
    };
    await expect(editModels(ctx, SET, null, "/nowhere")).rejects.toBeInstanceOf(CrossSiteRequestError);
    expect(opened).toBe(false);
  });
});

describe("editModels refusals come from model-routes.ts", () => {
  test("a chain with an empty model is refused with its message and nothing is stored", async () => {
    const w = await seeded();
    const r = await editModels({ request: post("https://d.test/"), store: async () => w.store }, { ...SET, chain: "a,,b" }, null, "/nowhere");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("empty") });
    expect(await w.stored()).toBe(SEED);
  });

  test("a bad profile name is refused with its message and nothing is stored", async () => {
    const w = await seeded();
    const r = await editModels({ request: post("https://d.test/"), store: async () => w.store }, { ...SET, profile: "Bad Name!" }, null, "/nowhere");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Bad Name!");
    expect(await w.stored()).toBe(SEED);
  });

  test("switching to a profile the server does not define is refused", async () => {
    const w = await seeded();
    const r = await editModels({ request: post("https://d.test/"), store: async () => w.store }, { op: "use", profile: "nope" }, null, "/nowhere");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("unknown profile 'nope'") });
    expect(await w.stored()).toBe(SEED);
  });
});


// OS-176: the range editor sends a profile's whole set of ranges at once.
describe("editModels range sets", () => {
  const ctx = (w: { store: Store }) => ({ request: post("https://d.test/"), store: async () => w.store });
  const builder = (ranges: Array<{ from: number; to: number; chain: string; effort?: string }>): ModelsOp => ({ op: "builderRanges", profile: "claude", ranges });

  test("the view shows the builder set as bands, and the other routes without builder.*", async () => {
    const w = await seeded();
    const r = await editModels(ctx(w), { op: "use", profile: "claude" }, null, "/nowhere");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.builder.bands.map((b) => [b.from, b.to, b.source])).toEqual([[1, 3, "default"], [4, 6, "default"], [7, 10, "server"]]);
    expect(r.view.builder.local).toBe(false);
    expect(r.view.routes.some((x) => x.route.startsWith("builder."))).toBe(false);
  });

  test("a whole builder set is stored in the range form, replacing the old tier keys", async () => {
    const w = await seeded();
    const r = await editModels(ctx(w), builder([{ from: 1, to: 4, chain: "haiku" }, { from: 5, to: 10, chain: "opus", effort: "high" }]), null, "/nowhere");
    expect(r.ok).toBe(true);
    expect(JSON.parse((await w.stored()) ?? "{}").profiles.claude.routes).toEqual({
      "builder.1-4": { chain: ["haiku"] },
      "builder.5-10": { chain: ["opus"], effort: "high" },
    });
  });

  test("a gap is refused with the CLI's message and nothing is stored", async () => {
    const w = await seeded();
    const r = await editModels(ctx(w), builder([{ from: 1, to: 3, chain: "haiku" }, { from: 5, to: 10, chain: "opus" }]), null, "/nowhere");
    expect(r).toEqual({ ok: false, error: "model_routes profile 'claude': builder ranges leave a gap at 4: the ranges must cover 1-10 with no gap" });
    expect(await w.stored()).toBe(SEED);
  });

  test("an overlap, even of two equal ranges, is refused", async () => {
    const w = await seeded();
    const r = await editModels(ctx(w), builder([{ from: 1, to: 10, chain: "haiku" }, { from: 1, to: 10, chain: "opus" }]), null, "/nowhere");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("builder ranges 1-10 and 1-10 overlap at 1-10") });
    expect(await w.stored()).toBe(SEED);
  });

  test("review ranges are replaced whole, and a gap is refused with the CLI's message", async () => {
    const w = await seeded();
    const ok = await editModels(ctx(w), { op: "readerRanges", profile: "claude", ranges: [{ from: 1, to: 5, legs: ["neon"] }, { from: 6, to: 10, legs: ["neon", "opus"] }] }, null, "/nowhere");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.view.review.value.tiers.map((t) => [t.from, t.to, t.legs])).toEqual([[1, 5, ["neon"]], [6, 10, ["neon", "opus"]]]);
    const before = await w.stored();
    const gap = await editModels(ctx(w), { op: "readerRanges", profile: "claude", ranges: [{ from: 1, to: 5, legs: ["neon"] }, { from: 7, to: 10, legs: ["opus"] }] }, null, "/nowhere");
    expect(gap).toEqual({ ok: false, error: "review ranges leave a gap at 6: the ranges must cover 1-10 with no gap" });
    expect(await w.stored()).toBe(before);
  });
});
