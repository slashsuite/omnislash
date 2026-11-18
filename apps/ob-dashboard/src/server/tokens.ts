import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { credentialInventory, type CredentialCheckRow, type CredentialStatus } from "../../../cli/src/credentials.ts";
import { readWhatsappQr, whatsappQrPath } from "../../../../platform/cli-whatsapp/src/whatsapp/qr.ts";
import {
  checkCredential as checkCredentialWrite,
  setCredential as setCredentialWrite,
  startWhatsappPairing as startWhatsappPairingWrite,
  type WriteContext,
} from "../../../../platform/dashboard-kit/src/server/writes.ts";
import { providedStore } from "../../provided-store.ts";
import type { WhatsappQrView } from "../lib/whatsappQr.ts";
import { renderWhatsappQr } from "./whatsappQr.ts";

// OB-2208 (OB-2199 step 6): the Tokens page's server functions, moved from the personal dashboard with the
// WhatsApp pairing panel. The store comes from serve.ts (providedStore), never opened here.
//
// ── Credentials (219: the tokens page over the credential inventory) ──────────────────────────────
// getCredentials surfaces the SAME read `ob creds` prints (credentialInventory) and checkCredential
// runs the SAME live check `ob creds check` runs, recording its verdict in credential_check so the page
// can say "checked 3 minutes ago" without calling the provider again. No check ever runs on a page load
// or on a timer: every one of them is a click. setCredential is the write path, and it is the reason
// this block reads the incoming REQUEST: a pasted token over plain HTTP would cross the house network
// in the clear (192), so the kit's write gate refuses anything that is neither TLS (220) nor loopback,
// here on the server rather than in the UI. No fn in this file ever returns, logs or renders a credential
// VALUE: the payloads are presence, timestamps and a sentence.

export type { CredentialStatus, CredentialCheckRow };

const writeCtx = (): WriteContext => ({ request: getRequest(), store: providedStore });

/** Every credential ob depends on, with presence, age and the last recorded verdict. Read-only. */
export const getCredentials = createServerFn({ method: "GET" }).handler(async (): Promise<CredentialStatus[]> => {
  return await credentialInventory(await providedStore());
});

/** Ask one provider whether the credential still works, and record the verdict. The ONE path on this
 *  page that leaves the machine, reached ONLY from the explicit "Check now" click. Returns the fresh
 *  inventory (the verdict lands on the row), never the value it checked with. */
export const checkCredential = createServerFn({ method: "POST" })
  .validator((d: { name: string }) => {
    if (!d || typeof d.name !== "string" || !d.name) throw new Error("name required");
    return { name: d.name };
  })
  .handler(async ({ data }): Promise<CredentialStatus[]> => await checkCredentialWrite(writeCtx(), data.name));

/** Store a pasted credential (the paste-refreshable static tokens only). REFUSES over a cleartext
 *  connection, refuses an empty value, and refuses a credential a paste cannot refresh. The value is
 *  encrypted straight into the store by the same setSecret the CLI uses; it is never logged and never
 *  returned. Returns the fresh inventory so the row's "updated" moves. */
export const setCredential = createServerFn({ method: "POST" })
  .validator((d: { name: string; value: string }) => {
    if (!d || typeof d.name !== "string" || !d.name) throw new Error("name required");
    if (typeof d.value !== "string") throw new Error("value must be a string");
    return { name: d.name, value: d.value };
  })
  // The kit reads the connection's own protocol from the request (originFromRequest), never a header.
  .handler(async ({ data }): Promise<CredentialStatus[]> => await setCredentialWrite(writeCtx(), data.name, data.value));

// ── The WhatsApp pairing QR (274) ─────────────────────────────────────────────────────────────────
// The bridge writes the CURRENT pairing payload to a file in its own store, and this is the read. The
// payload is stripped in `renderWhatsappQr`, which is the whole boundary: what leaves this fn is an image
// and a sentence, never the code. Whoever scans a live one links a device to the account.

/** The current pairing QR as an image plus a sentence. Local file read only; nothing leaves the machine. */
export const getWhatsappQr = createServerFn({ method: "GET" }).handler(async (): Promise<WhatsappQrView> => {
  return renderWhatsappQr(readWhatsappQr(await whatsappQrPath(await providedStore())));
});

/**
 * Open the pairing window, so the page can CAUSE a QR instead of only displaying one somebody else caused.
 * All the judgement is in the kit's `startWhatsappPairing` (beginPairing), which starts the bridge only when
 * it is DOWN and refuses with a reason otherwise: a healthy session is never restarted, and the destructive
 * "move the pairing store aside" step is never done from a web page. Returns the refusal reason rather than
 * throwing it, so the panel can render it as text.
 */
export const startWhatsappPairing = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean; message: string; qr: WhatsappQrView }> => {
    const result = await startWhatsappPairingWrite(writeCtx());
    const read = readWhatsappQr(await whatsappQrPath(await providedStore()));
    return { ...result, qr: await renderWhatsappQr(read) };
  },
);
