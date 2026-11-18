import type { Ctx } from "../ctx.ts";
import { runCloudflare } from "../cloudflare.ts";
import { defaultMasterKey, getSecret } from "../secrets.ts";
import { sqliteStoreFor } from "../db/store.ts";

// -----------------------------------------------------------------------------
// `ob cloudflare zones | dns list|add|rm` (1756). The logic is in src/cloudflare.ts; this is the local
// entry, which reads the token from this machine's secret store. The API-client entry (apiCloudflare)
// reads it over the API instead.
// -----------------------------------------------------------------------------

export async function cmdCloudflare(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? sqliteStoreFor(ctx.db);
  await runCloudflare(ctx.args, ctx.flags, ctx.mode, {
    fetch: ctx.cloudflareFetch ?? fetch,
    secret: (name) => getSecret(store, name, defaultMasterKey().get()),
  });
}
