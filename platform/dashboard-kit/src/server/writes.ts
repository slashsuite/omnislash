// OB-2204: the ob writes both dashboard apps make, as plain functions behind the same-origin guard.
//
// Each app wraps these in its own `createServerFn` (validator plus a one-line handler), so the TanStack
// Start compiler never transforms a file outside an app. Every function here calls `assertSameOrigin`
// on the request FIRST and only then opens the store: a POST from a page on another site throws
// `CrossSiteRequestError` before anything is read or written. A server cannot prove a click was human;
// this only proves the request came from the app's own page.
//
// The store is passed as a getter, not a handle, so "refused before the store was touched" is
// something a test can see (writes-guard.test.ts). Nothing here sends anything outside the machine,
// except `checkCredential`, which asks the one provider named, from an explicit "Check now" click.

import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { getFocusProject } from "../../../../apps/cli/src/config.ts";
import { computeAlerts, filterSnoozed, snoozeAlert as snoozeAlertCore, type Alert } from "../../../../apps/cli/src/commands/alerts.ts";
import {
  credentialInventory,
  originFromRequest,
  runCredentialCheck,
  storeCredential,
  type CredentialStatus,
} from "../../../../apps/cli/src/credentials.ts";
import { itemDetail } from "../../../../apps/cli/src/detail.ts";
import { editItem } from "../../../../apps/cli/src/items.ts";
import {
  setQueueOrder as setQueueOrderCore,
  setTodayRank as setTodayRankCore,
  type QueueMove,
  type QueueOrderResult,
} from "../../../../apps/cli/src/workflow.ts";
import { beginPairing } from "../../../cli-whatsapp/src/whatsapp/qr.ts";
import { applyItemTransition, type ItemTransition } from "./item-transition.ts";
import { configIo } from "./config-io.ts";
import { saveReviewersValue, type SaveResult } from "./reviewers.ts";
import { assertSameOrigin } from "./same-origin.ts";
import type { ItemDetail } from "../lib/types.ts";

/** OS-26: who a dashboard priority change is recorded as on the Decisions trail. */
const DASHBOARD_ACTOR = "dashboard";

/** What every write needs: the incoming request (for the guard) and a way to open the store. */
export interface WriteContext {
  request: Request;
  store: () => Promise<Store>;
}

/** The guard, then the store. Every write below starts here, so none can reach the store unguarded. */
function open(ctx: WriteContext): Promise<Store> {
  assertSameOrigin(ctx.request);
  return ctx.store();
}

async function suppressAlert(ctx: WriteContext, key: string): Promise<Alert[]> {
  const s = await open(ctx);
  const focus = await getFocusProject(s);
  await snoozeAlertCore(s, key, focus);
  return await filterSnoozed(s, await computeAlerts(s, { focusProject: focus }));
}

/** Ack an alert: an alert_ack pinned to its current state_hash. Returns the fresh alert list. */
export function ackAlert(ctx: WriteContext, key: string): Promise<Alert[]> {
  return suppressAlert(ctx, key);
}

/** Snooze an alert: the same write as ackAlert, offered under its own name. Returns the fresh alert list. */
export function snoozeAlert(ctx: WriteContext, key: string): Promise<Alert[]> {
  return suppressAlert(ctx, key);
}

/** Run one provider's live check and record the verdict. Returns the fresh inventory, never a value. */
export async function checkCredential(ctx: WriteContext, name: string): Promise<CredentialStatus[]> {
  const s = await open(ctx);
  await runCredentialCheck(s, name);
  return await credentialInventory(s);
}

/** Store a pasted credential. storeCredential refuses a cleartext connection, read from the request itself. */
export async function setCredential(ctx: WriteContext, name: string, value: string): Promise<CredentialStatus[]> {
  const s = await open(ctx);
  await storeCredential(s, name, value, { origin: originFromRequest(ctx.request) });
  return await credentialInventory(s);
}

/** Open the WhatsApp pairing window (beginPairing starts the bridge only when it is down). The app reads
 *  and renders the QR itself, so the payload never leaves its server fn. */
export async function startWhatsappPairing(ctx: WriteContext): Promise<{ ok: boolean; message: string }> {
  const result = await beginPairing(await open(ctx));
  return { ok: result.ok, message: result.ok ? result.note : result.reason };
}

/** Move an item through the shared workflow cores. Returns the fresh detail. */
export async function transitionItem(ctx: WriteContext, data: ItemTransition): Promise<ItemDetail> {
  const s = await open(ctx);
  await applyItemTransition(s, data);
  return await itemDetail(s, data.id);
}

/** Rank an item into Today (explicit rank, or the next slot). Returns the fresh detail. */
export async function setTodayRank(ctx: WriteContext, data: { id: string; rank?: number | undefined }): Promise<ItemDetail> {
  const s = await open(ctx);
  await setTodayRankCore(s, data.id, data.rank);
  return await itemDetail(s, data.id);
}

/** OS-25: place an item in its project's queue (`ob order`): top (optionally into a band), or before / after
 *  another open item, whose band it takes. */
export async function setQueueOrder(ctx: WriteContext, data: { id: string; move: QueueMove }): Promise<QueueOrderResult> {
  return await setQueueOrderCore(await open(ctx), data.id, data.move, { actor: DASHBOARD_ACTOR });
}

/** OS-25: set an item's priority (`ob edit --priority`). Its queue rank is left as it is. Returns the fresh detail. */
export async function setPriority(ctx: WriteContext, data: { id: string; priority: number }): Promise<ItemDetail> {
  const s = await open(ctx);
  await editItem(s, data.id, { priority: data.priority }, { actor: DASHBOARD_ACTOR });
  return await itemDetail(s, data.id);
}

/** Store the review_readers setting after the CLI's own checks. */
export async function saveReviewers(ctx: WriteContext, value: unknown): Promise<SaveResult> {
  return await saveReviewersValue(configIo(await open(ctx)), value);
}
