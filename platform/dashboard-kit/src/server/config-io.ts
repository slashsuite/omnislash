// The store's config table as the ConfigIO the review-readers code takes. Its own file, not reviewers.ts:
// that one stays free of the store so its test (and a client bundle) never loads the Postgres driver.
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { getConfig, setConfig } from "../../../../apps/cli/src/config.ts";
import type { ConfigIO } from "../../../../apps/cli/src/review-readers.ts";

export function configIo(s: Store): ConfigIO {
  return { get: (k) => getConfig(s, k), set: (k, v) => setConfig(s, k, v) };
}
