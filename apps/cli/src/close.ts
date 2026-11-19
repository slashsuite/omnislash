import type { Database } from "bun:sqlite";
import type { DecisionOpts } from "./decisions.ts";
import type { Store } from "./db/store.ts";
import { closeItem } from "./workflow.ts";
import { getItem } from "./items.ts";
import { withdrawHandoffs } from "./inbox.ts";
import { warn } from "./output.ts";
import type { TokenUsage } from "../../../platform/cli-coord/src/spinoff-tokens.ts";
import { landClosedItemSpinoffs } from "../../../platform/cli-coord/src/commands/spinoff.ts";

export type CloseAndLandResult = Awaited<ReturnType<typeof landClosedItemSpinoffs>>;

/**
 * The one close door for the store-side side effects (OB-1928): the validated close (which also clears the
 * triage flag), then the item's own spinoff rows marked landed (1589). Best effort on the land half: the
 * close stands whatever happens there, and a failure comes back in the result's `error`. `ob close`,
 * `ob state <id> done`, `ob triage reject` and the API's close and triage reject all come through here.
 * The GitHub mirror stays with each caller, since only the caller knows how to report it.
 */
export async function closeAndLand(
  db: Database | Store,
  id: string,
  decision: DecisionOpts = {},
  /** OB-1993: tokens the client read on its own machine, by spinoff row id; recorded instead of a read here. */
  tokensById: Record<number, TokenUsage> = {},
): Promise<CloseAndLandResult> {
  await closeItem(db, id, decision);
  const result = await landClosedItemSpinoffs(db, id, decision, tokensById);
  // The ticket's unread handoffs in any role's inbox are moot now. Best effort: the close stands whatever happens.
  try {
    const item = await getItem(db, id);
    await withdrawHandoffs(db, [id, item?.id ?? "", item?.ref ?? "", ...result.landed, ...result.ended]);
  } catch (err) {
    warn(`inbox: ${id} closed, but its unread handoffs were not withdrawn: ${(err as Error).message}`);
  }
  return result;
}
