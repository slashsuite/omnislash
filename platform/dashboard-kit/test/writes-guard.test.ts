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
  setQueueOrder: (c) => writes.setQueueOrder(c, { id: "1", move: { top: true } }),
  setPriority: (c) => writes.setPriority(c, { id: "1", priority: 2 }),
  pauseSchedule: (c) => writes.pauseSchedule(c, "nightly"),
  resumeSchedule: (c) => writes.resumeSchedule(c, "nightly"),
  runScheduleNow: (c) => writes.runScheduleNow(c, "nightly"),
  deleteSchedule: (c) => writes.deleteSchedule(c, "nightly"),
};

test("the fourteen ob writes are all here, and nothing else is exported as a write", () => {
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

// OS-312: a scheduled job may run a shell command, so its writes also refuse plain HTTP to a host that is not this
// machine, before the store is opened; loopback over HTTP gets through.
// The four schedule wrappers share one guard, and the loop above proves each goes through it; one write shows it.
{
  const name = "pauseSchedule";
  describe(`${name} over the network`, () => {
    test("plain HTTP to a LAN host is refused with a reason, and the store is never opened", async () => {
      const req = new Request("http://192.168.0.20:5197/_serverFn/write", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
      const { c, calls } = ctx(req);
      const res = (await WRAPPERS[name]!(c)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toContain("refusing to change a scheduled job over http://192.168.0.20");
      expect(calls.store).toBe(0);
    });

    test("plain HTTP on loopback gets through to the store", async () => {
      const req = new Request("http://127.0.0.1:5197/_serverFn/write", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
      const { c, calls } = ctx(req);
      await expect(WRAPPERS[name]!(c)).rejects.toBeInstanceOf(StoreOpened);
      expect(calls.store).toBe(1);
    });
  });
}
