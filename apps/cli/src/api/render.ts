// ob 353: rendering an API answer exactly as the local command renders the same thing.
//
// Two of these reuse the CLI's own pure renderers outright (`renderIssueSync`, `mirrorDriftWarning`,
// `renderStatusReport`) by adapting the wire shape back into the shape those
// renderers already take. The one that cannot -- `ob show` -- is written here against the contract's
// `ItemDetail`, line for line with cmdShow, because cmdShow renders from an ItemRow and the endpoint
// answers with the composed detail (352's `itemDetail`).
import { parseGithubIssueUrl } from "../tracker-link.ts";
import type { IssueSyncOutcome, SyncSkipReason } from "../tracker-link.ts";
import type { Mode } from "../output.ts";
import { renderDecision } from "../decisions.ts";
import type { ItemDetail, TrackerMoveResponse } from "./contract.ts";

/** `ob show`, from the detail payload alone. Pure. */
export function renderItemDetail(d: ItemDetail, mode: Mode): string {
	if (mode === "json") return JSON.stringify(d, null, 2);
	if (mode === "quiet") return d.ref ?? d.id;

	const lines: string[] = [];
	lines.push(`${d.ref ?? d.id}  ${d.title}`);
	// 1949: the legacy number stays the item's id, and a move leaves its old refs behind as aliases.
	if (d.ref) lines.push(`  id:        ${d.id}`);
	if (d.aliases && d.aliases.length > 0) lines.push(`  was:       ${d.aliases.join(", ")}`);
	lines.push(`  type:      ${d.type}`);
	lines.push(`  status:    ${d.status}`);
	lines.push(`  priority:  ${d.effective_priority}${d.priority ? " (explicit)" : " (derived)"}`);
	lines.push(`  project:   ${d.project ?? "-"}${d.kind ? ` (${d.kind})` : ""}`);
	if (d.today_rank !== null) lines.push(`  today:     rank ${d.today_rank}`);
	if (d.queue_rank !== null && d.queue_rank !== undefined) lines.push(`  queue:     rank ${d.queue_rank}`);
	if (d.status === "blocked") {
		lines.push(`  blocked:   ${d.block_reason ?? "-"}${d.block_owner ? ` (owner: ${d.block_owner})` : ""}`);
	}
	lines.push(`  created:   ${d.created_at}`);
	lines.push(`  updated:   ${d.updated_at}`);
	if (d.closed_at) lines.push(`  closed:    ${d.closed_at}`);
	if (d.tags.length > 0) lines.push(`  tags:      ${d.tags.join(", ")}`);
	// A GitHub issue link lives in the same ref row (77); label it for what it is so the two trackers are
	// legible here, instead of a GitHub URL reading as a `linear:` ref.
	const issueRef = d.linear ? parseGithubIssueUrl(d.linear.url) : null;
	if (issueRef) lines.push(`  issue:     #${issueRef.number}  ${d.linear!.url}`);
	else if (d.linear && d.linear.url) lines.push(`  linear:    ${d.linear.linear_id ?? "?"}  ${d.linear.url}`);
	if (d.detail) {
		for (const [k, v] of Object.entries(d.detail)) {
			if (k === "item_id" || v === null || v === undefined || v === "") continue;
			lines.push(`  ${k.padEnd(9)}: ${String(v)}`);
		}
	}
	for (const l of d.links) {
		const arrow = l.direction === "out" ? "->" : "<-";
		lines.push(`  link:      ${arrow} ${l.rel_type} ${l.other}`);
	}
	if (d.body) {
		lines.push("  body:");
		for (const bl of d.body.split("\n")) lines.push(`    ${bl}`);
	}
	// An older host sends no `decisions`; print nothing rather than failing.
	if (d.decisions && d.decisions.length > 0) {
		lines.push("  Decisions:");
		for (const dec of d.decisions) lines.push(`    ${renderDecision(dec)}`);
	}
	return lines.join("\n");
}

/**
 * The flat wire shape of a close/reopen, back into the outcome the CLI's own renderers take.
 *
 * The server flattens `IssueSyncOutcome` for the wire (352's TrackerMoveResponse) and this puts it back,
 * so `ob close` prints ONE wording whether the move happened here or over HTTP. `repo` is only read for
 * the foreign-repo line and the server does not carry it, so it is recovered from the issue url, which is
 * where it came from in the first place.
 */
export function outcomeFrom(res: TrackerMoveResponse): IssueSyncOutcome {
	const link =
		res.issue !== null && res.issue_url
			? { number: res.issue, url: res.issue_url, repo: parseGithubIssueUrl(res.issue_url)?.repo ?? "" }
			: null;
	return {
		link,
		skipped: (res.skipped as SyncSkipReason | null) ?? null,
		change:
			res.issue_state && link
				? { number: link.number, url: link.url, title: "", state: res.issue_state as "open" | "closed", already: res.already === true }
				: null,
		error: res.issue_error,
	};
}
