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

const NAME_TO_INT: Record<string, number> = {
  none: PRIORITY_NONE,
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
};

/** The accepted priorities, best first, as one phrase for every "must be one of" / "expected:" message. */
export const PRIORITY_OPTIONS = "urgent|flake|high|medium|low|none (or 0-5)";

export function parsePriority(input: string): number | null {
  const lower = input.trim().toLowerCase();
  if (lower in NAME_TO_INT) return NAME_TO_INT[lower]!;
  const n = Number(lower);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  return null;
}

export function priorityName(value: number | null): string {
  if (value === null || value === undefined) return "none";
  return INT_TO_NAME[value] ?? "none";
}

/** Best first. The store's integers put flake last; the work order puts it second (OB-2060). */
const RANK_ORDER = [
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
}

export function effectivePriority(input: EffectivePriorityInput): number {
  if (input.priority !== null && input.priority !== undefined) return input.priority;
  if (input.projectId !== null && input.focusProject !== null && input.projectId === input.focusProject) {
    return PRIORITY_HIGH;
  }
  return PRIORITY_NONE;
}
