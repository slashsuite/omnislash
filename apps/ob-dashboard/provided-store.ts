// OB-2207: how the OB dashboard's server functions reach the store without opening one of their own.
//
// apps/ob-dashboard/serve.ts is the one place that opens the store (its serve test checks no file under
// src calls the store opener). It hands the getter over with `provideStore` before it serves, and the
// server functions inside the built SSR bundle read it back with `providedStore`. The bundle carries its
// own copy of this module, so the slot lives on `globalThis` under a registered symbol, which both copies
// see. A test provides a fixture store the same way, so a server function under test never opens the live DB.
import type { Store } from "../cli/src/db/store.ts";

const SLOT = Symbol.for("ob-dashboard.store");

type Slot = { [SLOT]?: () => Promise<Store> };

/** Hand the server functions their store getter. serve.ts calls it once, before Bun.serve. */
export function provideStore(get: () => Promise<Store>): void {
  (globalThis as Slot)[SLOT] = get;
}

/** The store serve.ts (or a test) provided. Throws when nothing was provided, rather than opening one. */
export function providedStore(): Promise<Store> {
  const get = (globalThis as Slot)[SLOT];
  if (!get) throw new Error("ob-dashboard: no store provided (serve.ts calls provideStore before it serves)");
  return get();
}
