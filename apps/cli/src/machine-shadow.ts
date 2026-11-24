/**
 * The shadow check's event names (OS-169, spike OS-167 section 5 step 2). The shadow itself is gone: OS-172 made
 * the item machine the item check, and OS-173 moves spinoff rows by the spinoff machine's events, so nothing
 * writes `machine_would_refuse` any more. The names stay because rows logged before then still exist, and
 * `ob machine audit`, `ob show` and the brief read or filter them.
 */
export const MACHINE_SHADOW_SOURCE = "state-machine";
export const MACHINE_WOULD_REFUSE = "machine_would_refuse";
