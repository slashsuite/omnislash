// OS-146: the back door. Puts the e2e store's model_routes back to SEED_ROUTES, so each
// test starts from the same world. Run as a script by the specs' beforeEach, and called by e2e/serve.ts at start.
import { openDb } from "../../cli/src/db.ts";
import { sqliteStoreFor, type Store } from "../../cli/src/db/store.ts";
import { setConfig } from "../../cli/src/config.ts";
import { MODEL_ROUTES_KEY } from "../../cli/src/model-routes.ts";
import { DB_PATH, SEED_ROUTES } from "./world.ts";

export async function seed(store: Store): Promise<void> {
  await setConfig(store, MODEL_ROUTES_KEY, JSON.stringify(SEED_ROUTES));
}

if (import.meta.main) {
  const db = openDb(DB_PATH);
  await seed(sqliteStoreFor(db));
  db.close();
}
