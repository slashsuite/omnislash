// OB-2255: the T3 half of teams, apart from ./team.ts so the store and filter half does not load the T3 client.
// Opening or adopting a role thread is `ensureTeamThread` (./t3/dispatch.ts); this file lets threads go.
import { t3Seam, type T3Seam } from "./t3/dispatch.ts";

/**
 * Unpin the threads a team let go of (`ob t3 sentinel|muse <team> --remove`, `ob t3 team rm --force`). The row is
 * already dropped; an unpin that fails is said on `warn` and the rest carry on. Never throws.
 */
export async function unpinTeamThreads(threadIds: string[], warn: (line: string) => void, seam?: T3Seam): Promise<void> {
  if (threadIds.length === 0) return;
  let s: T3Seam;
  try {
    s = seam ?? (await t3Seam());
  } catch (err) {
    warn(`ob: could not reach T3 to unpin ${threadIds.join(", ")} (${(err as Error).message}); unpin it by hand`);
    return;
  }
  for (const id of threadIds) {
    try {
      await s.unpin(id);
    } catch (err) {
      warn(`ob: could not unpin thread ${id} (${(err as Error).message}); unpin it by hand`);
    }
  }
}
