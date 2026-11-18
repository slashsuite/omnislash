// OB-2153: a T3 thread waiting on a lease says so in its title.
//
// A builder queued in `ob lease run cpu:browser` or `ob lease acquire --wait` looked like it was running forever
// in the T3 sidebar: the only sign of the wait was a stderr line inside the thread. The waiting process now puts a
// `⏳<label>` marker in front of its own thread's title when the wait starts and takes it off when the wait ends,
// however it ends. The thread is the one T3 names in `T3CODE_THREAD_ID`, which T3 sets in every agent shell; a
// shell outside T3 has none, and then nothing is retitled and no T3 call is made.
//
// OB-2169: an `ob lease run` that holds its lease wears `🔒<label>` instead, from the grant until the release at
// the end, so the sidebar also shows which thread holds the slot a `⏳` thread waits for. A wait that turns into a
// hold swaps its own marker in place. Each resource has its own marker (`🔒🌐 ⏳🔌5101 · <title>`), and a run only
// ever moves its own. The label is `leaseLabel` (apps/cli/src/t3/lease-icon.ts). `lease acquire` never marks a
// hold (its process exits at once, so nothing would take the mark off on release or a lapsed TTL).
//
// Best effort throughout: a title is a label, so a failed T3 call prints one line and never fails, holds up or
// changes the lease.
import { syncLeaseTitle } from "../../../apps/cli/src/t3/dispatch.ts";

/** The env var T3 sets to the agent's own thread id in every shell it runs. */
export const T3_THREAD_ENV = "T3CODE_THREAD_ID";
/** The longest one retitle may hold up the wait or its end: a hung T3 must not stall the lease or the exit. */
const RETITLE_BOUND_MS = 5_000;

function bounded(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RETITLE_BOUND_MS);
  });
  return Promise.race([p, bound]).finally(() => clearTimeout(timer));
}

export interface LeaseWaitTitle {
  /** False when there is no thread to retitle: the wait then makes no T3 call and catches no signal. */
  readonly enabled: boolean;
  /** The wait has started (the first denied attempt): mark the title. Later calls do nothing. */
  waiting(): Promise<void>;
  /** The lease is held (OB-2169, `lease run` only): mark the title `🔒`, replacing a `⏳`. Later calls do nothing. */
  holding(): Promise<void>;
  /** The wait or the hold is over, for any reason: restore the title if it was marked. Idempotent; never throws. */
  done(): Promise<void>;
}

/** A title marker for one wait on `resource`. With no thread id it is a no-op that never calls T3. */
export function leaseWaitTitle(
  resource: string,
  log: (line: string) => void,
  threadId: string | undefined = process.env[T3_THREAD_ENV],
): LeaseWaitTitle {
  const id = threadId?.trim();
  // Every T3 call chains after the one before, so a slow mark can never land on top of a later one or the restore.
  let chain: Promise<void> | null = null;
  let waited = false;
  let held = false;
  let restored: Promise<void> | null = null;
  let warned = false;
  const sync = async (to: "waiting" | "holding" | null) => {
    const r = await syncLeaseTitle(id as string, resource, to);
    if (r.error && !warned) {
      warned = true;
      log(`could not retitle the thread: ${r.error}`);
    }
  };
  const mark = (state: "waiting" | "holding") => {
    const prev = chain;
    chain = prev ? prev.then(() => sync(state)) : sync(state);
    return bounded(chain);
  };
  return {
    enabled: !!id,
    waiting() {
      if (!id || waited || held || restored) return Promise.resolve();
      waited = true;
      return mark("waiting");
    },
    holding() {
      if (!id || held || restored) return Promise.resolve();
      held = true;
      return mark("holding");
    },
    done() {
      if (!chain) return Promise.resolve();
      // The restore gets its own bound after the marks before it settle (or their bound runs out): a slow hold mark
      // on a command that ends at once must not use up the restore's time and leave a stale `🔒` behind.
      restored ??= bounded(chain).then(() => bounded(sync(null)));
      return restored;
    },
  };
}
