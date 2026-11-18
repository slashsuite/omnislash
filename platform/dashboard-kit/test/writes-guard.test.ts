import { describe, expect, test } from "bun:test";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { CrossSiteRequestError } from "../src/server/same-origin.ts";
import * as writes from "../src/server/writes.ts";

// OB-2204: every guarded write refuses a cross-site POST before it opens the store, so it cannot write.
// The store getter records whether it was called: refused means never called. A same-origin request
// does reach it (the getter then throws a sentinel, so no real store is ever opened here).

const URL_ = "https://ob.example.test/_serverFn/write";
const crossSite = () => new Request(URL_, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
const foreignOrigin = () => new Request(URL_, { method: "POST", headers: { origin: "https://evil.example.test" } });
const sameOrigin = () => new Request(URL_, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });

class StoreOpened extends Error {}
function ctx(request: Request) {
  const calls = { store: 0 };
  const c: writes.WriteContext = {
    request,
    store: async (): Promise<Store> => {
      calls.store++;
      throw new StoreOpened("store opened");
    },
  };
  return { c, calls };
}

const WRAPPERS: Record<string, (c: writes.WriteContext) => Promise<unknown>> = {
  ackAlert: (c) => writes.ackAlert(c, "k"),
  snoozeAlert: (c) => writes.snoozeAlert(c, "k"),
  checkCredential: (c) => writes.checkCredential(c, "github"),
  setCredential: (c) => writes.setCredential(c, "github", "value"),
  startWhatsappPairing: (c) => writes.startWhatsappPairing(c),
  transitionItem: (c) => writes.transitionItem(c, { id: "1", action: "close" }),
  setTodayRank: (c) => writes.setTodayRank(c, { id: "1", rank: 1 }),
  saveReviewers: (c) => writes.saveReviewers(c, { medium: ["opus"] }),
};

test("the eight ob writes are all here, and nothing else is exported as a write", () => {
  const exported = Object.keys(writes).sort();
  expect(exported).toEqual(Object.keys(WRAPPERS).sort());
});

for (const [name, call] of Object.entries(WRAPPERS)) {
  describe(name, () => {
    test("a cross-site request throws CrossSiteRequestError and never opens the store", async () => {
      for (const req of [crossSite(), foreignOrigin()]) {
        const { c, calls } = ctx(req);
        await expect(call(c)).rejects.toBeInstanceOf(CrossSiteRequestError);
        expect(calls.store).toBe(0);
      }
    });

    test("a same-origin request gets past the guard to the store", async () => {
      const { c, calls } = ctx(sameOrigin());
      await expect(call(c)).rejects.toBeInstanceOf(StoreOpened);
      expect(calls.store).toBe(1);
    });
  });
}
