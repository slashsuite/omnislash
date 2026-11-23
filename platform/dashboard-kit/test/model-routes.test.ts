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
      const row = r.ok ? r.view.routes.find((x) => x.route === "builder.medium") : undefined;
      expect(row).toMatchObject({ chain: ["sonnet", "haiku"], source: "server" });
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

