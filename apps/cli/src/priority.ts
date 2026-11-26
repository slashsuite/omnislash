export const PRIORITY_NONE = 0;
export const PRIORITY_URGENT = 1;
export const PRIORITY_HIGH = 2;
export const PRIORITY_MEDIUM = 3;
export const PRIORITY_LOW = 4;
/**
 * OB-2060: a flaky test sits between urgent and high. It is important, but not as important as an urgent.
 *
 * STORED as 5, a NEW value, not a renumbering: high/medium/low keep 2/3/4, so no live row's priority
 * changes and there is no migration. The ordering that puts it second is `prioritySortRank`, not the int.
 */
export const PRIORITY_FLAKE = 5;
/**
 * OS-108: critical sits above urgent. It means an active bug in production that is affecting users now, and
 * it is the only level worked once the weekly Claude usage crosses the critical-only line (usage-gate.ts).
 *
 * STORED as 6, a NEW value like flake: no live row changes and no migration. `prioritySortRank` puts it first.
 */
export const PRIORITY_CRITICAL = 6;

const NAME_TO_INT: Record<string, number> = {
  none: PRIORITY_NONE,
  critical: PRIORITY_CRITICAL,
  urgent: PRIORITY_URGENT,
  flake: PRIORITY_FLAKE,
  high: PRIORITY_HIGH,
  medium: PRIORITY_MEDIUM,
  low: PRIORITY_LOW,
};

const INT_TO_NAME: Record<number, string> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
  5: "flake",
  6: "critical",
};

/** The accepted priorities, best first, as one phrase for every "must be one of" / "expected:" message. */
export const PRIORITY_OPTIONS = "critical|urgent|flake|high|medium|low|none (or 0-6)";

export function parsePriority(input: string): number | null {
  const lower = input.trim().toLowerCase();
  if (lower in NAME_TO_INT) return NAME_TO_INT[lower]!;
  const n = Number(lower);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  return null;
}

export function priorityName(value: number | null): string {
  if (value === null || value === undefined) return "none";
  return INT_TO_NAME[value] ?? "none";
}

/** Best first. The store's integers put flake and critical last; the work order puts critical first (OS-108), flake third (OB-2060). */
export const RANK_ORDER: readonly number[] = [
  PRIORITY_CRITICAL,
  PRIORITY_URGENT,
  PRIORITY_FLAKE,
  PRIORITY_HIGH,
  PRIORITY_MEDIUM,
  PRIORITY_LOW,
  PRIORITY_NONE,
];

export function prioritySortRank(value: number): number {
  const rank = RANK_ORDER.indexOf(value);
  return rank === -1 ? RANK_ORDER.length : rank;
}

const KIND_PRECEDENCE: Record<string, number> = {
  side: 1,
  home: 2,
  admin: 3,
  learning: 4,
};

export function kindRank(kind: string | null): number {
  if (kind === null || kind === undefined) return 5;
  return KIND_PRECEDENCE[kind] ?? 5;
}

export interface EffectivePriorityInput {
  priority: number | null;
  projectId: string | null;
  focusProject: string | null;
  /** OS-216: the priority an open dependent passes down the chain (dep-priority.ts); wins when it ranks better. */
  raised?: number | null | undefined;
}

export function effectivePriority(input: EffectivePriorityInput): number {
  const base = basePriority(input);
  const raised = input.raised;
  if (raised === null || raised === undefined) return base;
  return prioritySortRank(raised) < prioritySortRank(base) ? raised : base;
}

function basePriority(input: EffectivePriorityInput): number {
  if (input.priority !== null && input.priority !== undefined) return input.priority;
  if (input.projectId !== null && input.focusProject !== null && input.projectId === input.focusProject) {
    return PRIORITY_HIGH;
  }
  return PRIORITY_NONE;
}
