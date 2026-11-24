import { AppError } from "../../../apps/cli/src/errors.ts";
import type { SpinoffRow } from "./commands/spinoff.ts";

// Spikes (OB-1826): a bounded investigation run when a ticket cannot score 7 on the measure-twice check
// (OB-1825) because what is missing takes running something to find out. A spike is an ordinary ticket
// tagged `spike`, linked to the ticket it serves. It may edit, test and run commands in its worktree, and it
// never commits code: its answers go on the parent with `ob note`. It may commit documentation (OB-2227), a
// report under `docs/`, which it ships as a PR the architect merges like a chart.
//
// A spike has no commit to gate and no PR to land, so none of the build lifecycle fits it, and a new status
// word would be a migration for one case (the reason spinoff-abandon.ts gives). It reuses the abandon
// pattern: the end is an ordinary `failed` row whose error carries a marker prefix, which `spinoff mix`
// reads. Handoff leaves the row `launched` (so it can never reach `gateable`), and `ob close` retires it.

export const SPIKE_TAG = "spike";
export const SPIKE_PREFIX = "spike:";
/** The relation from the spike (from) to the ticket it serves (to): `ob link <spike> spun_off_from <parent>`. */
export const SPIKE_LINK = "spun_off_from";
/** The three sections a spike's body must carry, in the order the architect writes them. */
export const SPIKE_SECTIONS = ["Questions", "Box", "Done when"] as const;

/** Is this item a spike? The tag is matched exactly: `spike-mechanism` is not one. Pure. */
export function isSpikeTagged(tags: readonly string[]): boolean {
  return tags.some((t) => t.trim().toLowerCase() === SPIKE_TAG);
}

/** The non-empty items under a `## <title>` heading, up to the next heading. A bullet marker, checkbox or empty line is not content; a sub-heading is not an item. Pure. */
export function sectionItems(body: string | null | undefined, title: string): string[] {
  const want = title.toLowerCase();
  const lines: string[] = [];
  let inside = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(line)) {
      // A suffix after the title still counts (`## Done when (live)`, `## Done when: all green`), as it did before.
      inside = new RegExp(`^${want}(?![\\w-])`).test(line.replace(/^#+\s+/, "").trim().toLowerCase());
      continue;
    }
    if (!inside || /^#+\s/.test(line)) continue;
    const text = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, "").trim();
    if (text) lines.push(text);
  }
  return lines;
}

/** The required `## ` sections a spike body lacks or leaves empty, by name. Pure. */
export function missingSpikeSections(body: string | null | undefined): string[] {
  return SPIKE_SECTIONS.filter((s) => sectionItems(body, s).length === 0).map((s) => `## ${s}`);
}

/** What the spike gate names when the body or the links are not enough. Pure. */
export function spikeGateMissing(body: string | null | undefined, hasParentLink: boolean): string[] {
  const missing = missingSpikeSections(body);
  if (!hasParentLink) missing.push(`the ${SPIKE_LINK} link to the ticket it serves (ob link <spike> ${SPIKE_LINK} <parent>)`);
  return missing;
}

/** What the close records as the row's error: the marker, then the close's note. */
export function spikeEndError(note: string | null | undefined): string {
  const text = (note ?? "").trim();
  return `${SPIKE_PREFIX} ${text || "closed with no note"}`;
}

/** Was this row retired by the close of a spike (as opposed to a launch that genuinely failed)? */
export function isSpikeEnd(row: Pick<SpinoffRow, "status" | "error">): boolean {
  return row.status === "failed" && (row.error ?? "").startsWith(SPIKE_PREFIX);
}

/**
 * The roots a spike may not touch, even with a `.md` file (OB-2227). Code lives under the first four, and
 * `skills/` is agent behaviour, which goes through the architect. Anything else ending in `.md` is documentation.
 */
export const SPIKE_CODE_ROOTS = ["apps/", "platform/", "domains/", "skills/", "ops/"] as const;

/** Is this changed path documentation a spike may commit? A `.md` file outside the code roots, and nothing else. Pure. */
export function isSpikeDocPath(path: string): boolean {
  const p = path.trim().replace(/^\.\//, "");
  if (!p.toLowerCase().endsWith(".md")) return false;
  return !SPIKE_CODE_ROOTS.some((root) => p.startsWith(root));
}

/**
 * The refusal a spike's handoff earns when its branch changes anything but documentation (OB-1826, OB-2227).
 * `paths` is every path the branch changes past `base_sha`, deletions and both sides of a rename included, so
 * deleting or moving a code file is refused like an edit. An empty list is a spike with no commit. `null` means
 * git could not say (no base_sha, or an unreadable worktree), and that is refused too: an unreadable branch is
 * not evidence of a clean one. No hook can refuse a commit, so the handoff is where a code commit is caught.
 */
export function spikeCommitRefusal(row: Pick<SpinoffRow, "ticket_ref" | "branch" | "worktree">, paths: readonly string[] | null): string | null {
  if (paths === null) {
    return `spike ${row.ticket_ref}: cannot tell what ${row.branch} changes (no base_sha, or git could not read ${row.worktree}); a spike may commit documentation only. Nothing was handed off`;
  }
  const code = paths.filter((p) => p.trim() && !isSpikeDocPath(p));
  if (code.length === 0) return null;
  return (
    `spike ${row.ticket_ref}: ${row.branch} changes ${code.length} path(s) that are not documentation, and a spike may commit ` +
    `documentation only (a .md file outside ${SPIKE_CODE_ROOTS.join(", ")}): ${code.join(", ")}. ` +
    `Drop those changes from the branch in ${row.worktree} (keep the answers on the parent with 'ob note <parent>'), ` +
    `and hand off again. Nothing was handed off`
  );
}

/** Refuse a spike handoff whose branch changes anything but documentation. */
export function assertSpikeDocsOnly(row: Pick<SpinoffRow, "ticket_ref" | "branch" | "worktree">, paths: readonly string[] | null): void {
  const refusal = spikeCommitRefusal(row, paths);
  if (refusal) throw new AppError(refusal);
}

/** What a spike's handoff prints: a docs commit and its PR, when there are any (OB-2227). Pure. */
export function formatSpikeReport(
  row: Pick<SpinoffRow, "ticket_ref" | "branch" | "worktree">,
  doc: { committed?: boolean; prUrl?: string | null } = {},
): string {
  const head = !doc.committed
    ? `${row.ticket_ref} spike answered (no commit, no PR)`
    : doc.prUrl
      ? `${row.ticket_ref} spike answered (a documentation commit, PR ${doc.prUrl})`
      : `${row.ticket_ref} spike answered (a documentation commit, no open PR found)`;
  const architect = doc.committed
    ? "  next:      the sentinel, else the architect, reads the answers on the parent ticket (ob show <parent>), merges the doc PR like a chart, then closes the spike with ob close"
    : "  next:      the sentinel, else the architect, reads the answers on the parent ticket (ob show <parent>), then closes the spike with ob close";
  return [
    head,
    `  ticket:    ${row.ticket_ref}`,
    `  branch:    ${row.branch}`,
    `  worktree:  ${row.worktree}`,
    ...(doc.prUrl ? [`  pr:        ${doc.prUrl}`] : []),
    architect,
  ].join("\n");
}

/**
 * The refusal a spike's handoff earns without a clean claims review (OS-180), or null when the note carries one.
 * A spike runs the skeptical review's claims mode on its report and notes before handoff, and says so with a
 * `claims-review: <N> cut, 0 open (<legs>)` line in `--note` (text from `--report` counts: the CLI merges them).
 * No line, or a line with open findings, is refused. Pure.
 */
export function spikeClaimsReviewMissing(note: string | null | undefined): string | null {
  const m = /claims-review:\s*(\d+) cut, (\d+) open/.exec(note ?? "");
  if (!m) return "spike handoff needs a 'claims-review: N cut, 0 open' line in --note (run the claims review in ob-skeptical-review first). Nothing was handed off";
  const open = Number(m[2]);
  if (open > 0) return `claims review still has ${open} open: fix or strike each in the report or with a new ob note on the parent, then hand off again. Nothing was handed off`;
  return null;
}
