/**
 * The reason on a `State:` line (ob 1579).
 *
 * A builder's verdict used to be a wall of text: the gate result and the review tallies came first and the
 * reason the human is needed came last (or got cut off by a one-line reader). The convention now is one short
 * line, about 100 characters, phrased as what the owner must decide or look at:
 *
 *   State: needs-human — judge the fee levels (12% + R8 buyer fee) and the R650k ask
 *   Gate: green on Bun (check, typecheck, test 63 pass, build); skeptical-review: 11 cut, 0 open
 *   Look at: apps/site/src/fees.ts
 *
 * This module reads that reason back out. An old commit has no short reason, so it falls back to the first
 * sentence that is not the gate result or a review tally; failing that, the caller prints the State text as
 * it always did. Pure: no git, no network, so the shapes are testable from fixture strings.
 */

/** The longest reason a display line carries; a longer one is cut at a word boundary with an ellipsis. */
export const STATE_REASON_MAX = 100;

export interface StateReason {
  /** The verdict word as written (`landable`, `needs-human`, `blocked`, `partial`, or an alias). */
  token: string;
  /** The reason, cut to `STATE_REASON_MAX`; null when the State text holds nothing but a gate result. */
  reason: string | null;
}

/** Display label per verdict word; `landable` (and its `ready` aliases) has no reason line. */
const LABELS: Record<string, string> = {
  "needs-human": "needs you",
  blocked: "blocked on",
  partial: "missing",
};

/** A sentence that reports the gate or a review tally rather than a reason. */
const GATE_SENTENCE =
  /^(?:\(?gates?\b|gated\b|typecheck|nx\b|moon\b|bunx?\b|tests?\s+(?:\d|pass|green)|\d+ tests?\b|(?:build|lint)\s+(?:ok|clean|green|pass)|green\b|all green|skeptical[- ]review|docs only, no gate|no gate\b|\d+ (?:pass|cut)\b)/i;

/** Cut `text` to `max` characters at a word boundary, with an ellipsis; text that already fits is unchanged. */
export function cutAtWord(text: string, max = STATE_REASON_MAX): string {
  if (text.length <= max) return text;
  const room = max - 1; // one character for the ellipsis
  const head = text.slice(0, room + 1);
  // Cut at the last space inside the window; if the character after the window is a space, the window ended on a word.
  const space = head.endsWith(" ") ? room : head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : text.slice(0, room);
  return `${cut.replace(/[\s,;:.\-—]+$/, "")}…`;
}

/** Split into sentences, never inside parentheses (`(check, typecheck, test 63 pass; build)` stays whole). */
function sentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1] ?? " ")) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** Free text (a State line's rest, or an agent note) → its reason, or null when it holds only gate results. */
function reasonFromText(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // The new shape: one short line that is not a gate result. Taken whole, so "e.g." inside it is no boundary.
  if (flat.length <= STATE_REASON_MAX && !GATE_SENTENCE.test(flat)) return cutAtWord(flat.replace(/\.$/, ""));
  const first = sentences(flat).find((s) => !GATE_SENTENCE.test(s));
  return first ? cutAtWord(first.replace(/\.$/, "")) : null;
}

/**
 * Parse a `State:` line or paragraph. Null when it is not a `State:` verdict at all. The separator after the
 * verdict word (`—`, `-`, `:`, `,`) is not part of the reason.
 */
export function parseStateReason(state: string | null | undefined): StateReason | null {
  if (!state) return null;
  const m = state.match(/^\s*State:\s+([\w-]+)([\s\S]*)$/);
  if (!m) return null;
  const rest = (m[2] ?? "").replace(/^\s*[—–:,-]+\s*/, "");
  return { token: m[1]!, reason: reasonFromText(rest) };
}

/** The marker that makes the reason line the one the eye finds first (1579). */
const MARKERS: Record<string, string> = { "needs-human": "🙋", blocked: "⛔", partial: "🧩" };

/** The needs-human marker, shared with the T3 thread title so the two cannot drift apart. */
export const NEEDS_YOU_MARKER = MARKERS["needs-human"]!;

/** The label a verdict word prints its reason under, or null for a verdict that carries none (landable). */
function reasonLabel(token: string): string | null {
  return LABELS[token] ?? null;
}

/**
 * The labelled reason line (`needs you: judge the fee levels…`), or null when the verdict has no label
 * (landable) or the State text holds no reason. The caller then prints the State text as it always did.
 */
export function reasonLine(state: string | null | undefined): string | null {
  const parsed = parseStateReason(state);
  if (!parsed?.reason) return null;
  const label = reasonLabel(parsed.token);
  return label ? `${label}: ${parsed.reason}` : null;
}

/**
 * The reason line as a display prints it: the marker emoji, then the label and reason. `markdown` bolds the
 * label for a surface that renders it (the readying note in the architect's T3 thread); a terminal gets plain text.
 */
export function decoratedReasonLine(state: string | null | undefined, markdown = false): string | null {
  const parsed = parseStateReason(state);
  const label = parsed && reasonLabel(parsed.token);
  if (!parsed?.reason || !label) return null;
  const marker = MARKERS[parsed.token] ?? "";
  const body = parsed.reason;
  return markdown ? `${marker} **${label}:** ${body}` : `${marker} ${label}: ${body}`;
}

/**
 * The State lines a display prints, indented by `indent`: `State: <word>` plus the labelled reason, or the
 * State text verbatim when no reason can be read (landable, an old gate-only line, no State at all).
 */
export function stateDisplayLines(
  state: string | null | undefined,
  indent = "  ",
  none = "State:     (none — no State: line on the branch yet)",
  markdown = false,
): string[] {
  const parsed = parseStateReason(state);
  const line = decoratedReasonLine(state, markdown);
  if (parsed && line) return [`${indent}State: ${parsed.token}`, `${indent}${line}`];
  return [state ? `${indent}${state}` : `${indent}${none}`];
}

/**
 * The note an `ob agents` row prints. A `needs-human` agent's note is the reason it is parked on the owner, so it
 * prints as `needs you: <reason>`, cut at a word boundary; any other status keeps its note as written.
 */
export function agentNoteText(status: string, note: string): string {
  if (status !== "needs-human") return note;
  const stated = parseStateReason(note);
  const reason = stated ? stated.reason : reasonFromText(note);
  return reason ? `${NEEDS_YOU_MARKER} needs you: ${reason}` : note;
}
