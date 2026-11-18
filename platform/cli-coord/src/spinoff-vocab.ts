/**
 * The spinoff vocabulary (1513): one word per step.
 *
 *   builder verdict  `State: landable`        (was `State: ready`)
 *   human handoff    `ob spinoff handoff`     (was `ob spinoff ready`), row `handed-off` (was `ready-for-gate`)
 *   on main          row `landed`             (was `merged`); the TICKET's own `done` is unchanged
 *   row lifecycle    queued → launching → building → handed-off → landed  (+ failed)
 *
 * The STORED row values do not change (read-side mapping, no migration): the `idx_spinoff_active` partial
 * index names `pending`/`launching`, and the wire (`GET /spinoffs`, `/spinoffs/:id/ready`) keeps carrying
 * stored values, so an older host or client keeps working against a newer one in both directions. The new
 * words are what a human reads: every print site maps through `spinoffStatusWord`, and every filter a human
 * types goes through `toStoredSpinoffStatus`, which accepts either spelling.
 */

/** Stored row value → the word printed. Pure. */
const DISPLAY: Record<string, string> = {
  pending: "queued",
  launching: "launching",
  launched: "building",
  "ready-for-gate": "handed-off",
  merged: "landed",
  failed: "failed",
};

/** The printed lifecycle, in order. */
export const SPINOFF_STATUS_WORDS = ["queued", "launching", "building", "handed-off", "landed", "failed"] as const;

/** The word a stored status prints as. An unknown value is printed as it is, never hidden. */
export function spinoffStatusWord(stored: string): string {
  return DISPLAY[stored] ?? stored;
}

/**
 * Either spelling (new word or stored/old value) → the stored value, or null when it is neither. The
 * old spellings are input aliases and stay accepted for good: in-flight builders and old scripts use them.
 */
export function toStoredSpinoffStatus(input: string): string | null {
  if (Object.hasOwn(DISPLAY, input)) return input;
  for (const [stored, word] of Object.entries(DISPLAY)) if (word === input) return stored;
  return null;
}

/** A row object with its `status` mapped to the printed word (for `--json` output). */
export function withStatusWord<T extends { status: string }>(row: T): T {
  return { ...row, status: spinoffStatusWord(row.status) };
}

/**
 * The `State:` tokens that mean "mergeable as-is": `landable` is the word, `ready` the alias every commit
 * before 1513 carries — an old `State: ready` commit stays landable.
 */
export const LANDABLE_STATE_TOKENS = ["landable", "ready"] as const;

/**
 * Every verdict word a builder may end a commit with: the four current words plus the pre-1513 alias
 * `ready`. `ready-for-gate` is not one (OB-1924): it is the stored spelling of the handed-off ROW, never a
 * builder verdict, so a `State: ready-for-gate` line is prose like any unknown word. A `State:` line whose
 * word is not in this list is prose, not a verdict (1639): only these count.
 */
export const STATE_VERDICT_TOKENS = ["landable", "needs-human", "blocked", "partial", "ready"] as const;

/** Row statuses (stored spellings) that mean a build is still in flight: it serves its ticket, so it is not a failed or finished one. */
export const IN_FLIGHT = new Set(["pending", "launching", "launched", "ready-for-gate"]);

export function isLandableToken(token: string | null): boolean {
  return token !== null && (LANDABLE_STATE_TOKENS as readonly string[]).includes(token);
}
