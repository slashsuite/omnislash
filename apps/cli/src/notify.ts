import { AppError } from "./errors.ts";
import type { Store } from "./db/store.ts";
import { defaultMasterKey, getSecret } from "./secrets.ts";
import { settingFor } from "./settings.ts";

// -----------------------------------------------------------------------------
// The one phone push `ob` sends on its own (1655): the 08:00 alert digest to the owner's phone through Home
// Assistant. Everything else that reaches the owner is a ticket or a line they read. This is the single place that
// speaks to `notify.*`, so the token handling and the "never print it" rule live in one function.
// -----------------------------------------------------------------------------

export interface NotifyDeps {
  /** Tests inject; production omits (global fetch). Nothing in a test ever reaches Home Assistant. */
  fetch?: typeof fetch;
}

/**
 * POST one message to Home Assistant's notify service. The host is the `ha_host` setting, the bearer token
 * is the `ha` secret, and neither the token nor the response body is ever echoed: a failure names the HTTP
 * status and the host, nothing a provider could have reflected back.
 */
export async function sendHaNotify(
  store: Store,
  message: { title: string; body: string },
  deps: NotifyDeps = {},
): Promise<void> {
  const token = await getSecret(store, "ha", defaultMasterKey().get());
  if (!token) throw new AppError("cannot notify: no `ha` token in the store (ob secret set ha)");
  const host = await settingFor(store, "ha_host");
  // The HA notify service the digest goes to, `notify.<ha_notify_service>` (a phone's `mobile_app_<device>`).
  const service = await settingFor(store, "ha_notify_service");
  if (!host || !service) throw new AppError("cannot notify: set ha_host and ha_notify_service (ob config set)");
  const http = deps.fetch ?? fetch;
  let status: number;
  try {
    const res = await http(`http://${host}:8123/api/services/notify/${service}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: message.title, message: message.body }),
    });
    status = res.status;
  } catch (err) {
    // A thrown fetch's message can carry the URL, never a header; the URL holds no secret.
    throw new AppError(`Home Assistant at ${host} could not be reached: ${(err as Error).message}`);
  }
  if (status < 200 || status >= 300) {
    throw new AppError(`Home Assistant at ${host} answered HTTP ${status} to the notify call`);
  }
}
