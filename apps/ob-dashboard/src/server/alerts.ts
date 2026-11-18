import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getFocusProject } from "../../../cli/src/config.ts";
import { computeAlerts, filterSnoozed, type Alert } from "../../../cli/src/commands/alerts.ts";
import { providedStore } from "../../provided-store.ts";
import { ackAlert as ackAlertWrite, snoozeAlert as snoozeAlertWrite, type WriteContext } from "../../../../platform/dashboard-kit/src/server/writes.ts";

// OB-2207: the Alerts page's server functions, moved from the personal dashboard. The list is the SAME
// derivation `ob alerts` shows (computeAlerts filtered by filterSnoozed). Ack and snooze go through the
// kit's guarded writes, which refuse a cross-site POST before they open the store; this file adds no write
// of its own. Every path here is local-only: nothing is ever sent.

export type { Alert };

const writeCtx = (): WriteContext => ({ request: getRequest(), store: providedStore });

const keyOnly = (d: { key: string }) => {
  if (!d || typeof d.key !== "string" || !d.key) throw new Error("key required");
  return { key: d.key };
};

/** The current (un-acked) alerts: the SSR loader for /alerts. Read-only. */
export const getAlerts = createServerFn({ method: "GET" }).handler(async (): Promise<Alert[]> => {
  const s = await providedStore();
  return await filterSnoozed(s, await computeAlerts(s, { focusProject: await getFocusProject(s) }));
});

/** Ack (dismiss) an alert until its underlying state changes. Returns the fresh list. */
export const ackAlert = createServerFn({ method: "POST" })
  .validator(keyOnly)
  .handler(async ({ data }): Promise<Alert[]> => await ackAlertWrite(writeCtx(), data.key));

/** Snooze an alert: the same write as ack, offered under its own name. Returns the fresh list. */
export const snoozeAlert = createServerFn({ method: "POST" })
  .validator(keyOnly)
  .handler(async ({ data }): Promise<Alert[]> => await snoozeAlertWrite(writeCtx(), data.key));
