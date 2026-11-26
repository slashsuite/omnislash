import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { closeAndLand } from "../../../../apps/cli/src/close.ts";
import { blockItem, moveItem, reopenItem, unblockItem } from "../../../../apps/cli/src/workflow.ts";

export const TRANSITIONS = ["start", "ready", "block", "unblock", "move", "close", "reopen"] as const;
export type TransitionAction = (typeof TRANSITIONS)[number];

export type ItemTransition = { id: string; action: TransitionAction; reason?: string | undefined; owner?: string | undefined; to?: string | undefined };

async function close(store: Store, id: string): Promise<void> {
  const landed = await closeAndLand(store, id);
  if (landed.error) console.error(`[dashboard] close ${id}: spinoff land failed: ${landed.error}`);
}

/**
 * The body of the dashboard's transitionItem, taking the store so a test can drive it on a fixture.
 * A close goes through `closeAndLand` like the CLI and API closes (OB-1973): the item's spinoff rows are
 * marked landed too. The land half is best effort: a land error is logged and the close stands. The
 * dashboard sends nothing to GitHub.
 */
export async function applyItemTransition(store: Store, data: ItemTransition): Promise<void> {
  switch (data.action) {
    // OB-1939: start and ready go through the generic move, so leaving `blocked` by either clears the
    // block (reason and owner) like `ob state` does, instead of a plain status write that keeps it.
    case "start":
      await moveItem(store, data.id, "in_progress");
      break;
    case "ready":
      await moveItem(store, data.id, "ready");
      break;
    case "unblock":
      // No target: the status the trail says it was blocked from, else open.
      await unblockItem(store, data.id);
      break;
    case "move": {
      const to = data.to?.trim();
      if (!to) throw new Error("move requires a target status");
      // A move to done is a close: it lands the item's spinoff rows, as the `close` action does.
      if (to === "done") await close(store, data.id);
      else await moveItem(store, data.id, to);
      break;
    }
    case "close":
      await close(store, data.id);
      break;
    case "reopen":
      await reopenItem(store, data.id);
      break;
    case "block": {
      const reason = data.reason?.trim();
      if (!reason) throw new Error("block requires a reason");
      await blockItem(store, data.id, reason, data.owner?.trim() || null);
      break;
    }
  }
}
