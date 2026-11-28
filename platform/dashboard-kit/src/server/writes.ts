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
  writeGate,
  type CredentialStatus,
  type RequestOrigin,
} from "../../../../apps/cli/src/credentials.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import {
  deleteScheduledJob,
  listSchedulesWithRuns,
  runScheduledJobNow,
  updateScheduledJob,
  type ScheduledJobWithRuns,
} from "../../../../apps/cli/src/scheduled-jobs.ts";
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

// --- OS-312: the /schedules page's writes ---------------------------------------------------------------------

/** What a schedule write returns: the fresh list of jobs, or why it was refused (shown on the card, not thrown). */
export type ScheduleWriteResult = { ok: true; schedules: ScheduledJobWithRuns[] } | { ok: false; error: string };

function scheduleRefusal(origin: RequestOrigin): string {
  return `refusing to change a scheduled job over ${origin.proto}//${origin.hostname}: a job runs commands on your machines, so it is only changed over https or on the machine itself. Use \`ob schedule\` there`;
}

/**
 * The guard, then the TLS-or-loopback gate, then the store: a scheduled job may run a shell command, so pausing or
 * firing one is refused over plain HTTP to another host, as a credential paste is. A refusal never opens the store.
 * An AppError from the core (no such job, a paused job run now) comes back as `ok: false`.
 */
async function scheduleWrite(ctx: WriteContext, change: (s: Store) => Promise<unknown>): Promise<ScheduleWriteResult> {
  assertSameOrigin(ctx.request);
  const gate = writeGate(originFromRequest(ctx.request), scheduleRefusal);
  if (!gate.allowed) return { ok: false, error: gate.reason };
  const s = await ctx.store();
  try {
    await change(s);
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, schedules: await listSchedulesWithRuns(s) };
}

/** Pause a job (`ob schedule pause`): it keeps its next time but does not fire. */
export function pauseSchedule(ctx: WriteContext, ref: string): Promise<ScheduleWriteResult> {
  return scheduleWrite(ctx, (s) => updateScheduledJob(s, ref, { enabled: false }));
}

/** Resume a paused job (`ob schedule resume`): its next time is recomputed from now. */
export function resumeSchedule(ctx: WriteContext, ref: string): Promise<ScheduleWriteResult> {
  return scheduleWrite(ctx, (s) => updateScheduledJob(s, ref, { enabled: true }));
}

/** Make a job due now (`ob schedule run`): only its next time moves. The next `ob role tick` fires it; nothing runs here. */
export function runScheduleNow(ctx: WriteContext, ref: string): Promise<ScheduleWriteResult> {
  return scheduleWrite(ctx, (s) => runScheduledJobNow(s, ref));
}

/** Delete a job and its runs (`ob schedule delete`). */
export function deleteSchedule(ctx: WriteContext, ref: string): Promise<ScheduleWriteResult> {
  return scheduleWrite(ctx, (s) => deleteScheduledJob(s, ref));
}
