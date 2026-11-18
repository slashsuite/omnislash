import { type Ctx, requireItem } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print } from "../output.ts";
import {
  candidatePairs,
  checkoutRepoSlug,
  clearRef,
  computeDrift,
  getIssueLink,
  gitToplevel,
  issueClashMessage,
  itemForIssue,
  landedIn,
  linkedItems,
  linkIssue,
  listIssues,
  parseIssueArg,
  readRepoState,
  sameRepo,
  ticketRefMention,
  trackerRepo,
  unlinkedOpenItems,
  type CheckedRef,
  type LandedAnswer,
  type LandedReport,
} from "../tracker-link.ts";
import { DEFAULT_KEY, equivalentRefs, resolveItemId } from "../refs.ts";

// 77: `ob issue`: the seam between ob item numbers and GitHub issue numbers.
//   link/unlink  pair an EXISTING item with an EXISTING issue (the ob 55 vs gh#110 case: work that
//                already had a GitHub ticket but was added to ob without --issue); unlink clears
//                whichever reference the item holds, GitHub or Linear (138), and keeps the item
//   list         the current pairs, so drift is visible at a glance
//   landed       "is this already on main?", the pre-dispatch check that replaces remembering
//   reconcile    candidate unlinked pairs for a HUMAN to confirm (never links anything itself)
//   drift        open issues whose feature is already on main, and closed issues whose ob item is open
// Only `link`'s effect and `ob close`'s mirror write anything; everything else here is read-only.

/**
 * The checkout whose git state answers "already on main?". Two refusals, both because a wrong answer here
 * is worse than no answer:
 *  - an explicit `--repo` that is not a git checkout (git would fail, every signal would come back empty,
 *    and the command would confidently report "no evidence" for work that is in fact merged);
 *  - a checkout that is not `wayfinder_repo`. `ob` is on PATH everywhere, so `cd ~/dev/cue-frontend &&
 *    ob issue landed 55` would otherwise read a completely unrelated repo's history and answer from it.
 */
export function resolveTrackerCheckout(opts: { cwd: string; explicit?: string; trackerRepo: string }): string {
  const explicit = opts.explicit;
  let root: string | null;
  if (explicit) {
    root = gitToplevel(explicit);
    if (!root) throw new AppError(`--repo '${explicit}' is not a git checkout (it must be a path, not a project name)`);
  } else {
    root = gitToplevel(opts.cwd);
    if (!root) throw new AppError("not inside a git checkout; pass --repo <path> to the repo to inspect");
  }
  const slug = checkoutRepoSlug(root);
  if (!slug || !sameRepo(slug, opts.trackerRepo)) {
    throw new AppError(
      `${root} is ${slug ? `the '${slug}' checkout` : "a checkout with no recognisable GitHub remote"}, not the ` +
        `tracker repo '${opts.trackerRepo}'. The ob<->issue numbering only means anything there, so this would answer from ` +
        `the wrong history. Run it from a ${opts.trackerRepo} checkout, or pass --repo <path> to one.`,
    );
  }
  return root;
}

async function checkoutFor(ctx: Ctx): Promise<string> {
  return resolveTrackerCheckout({
    cwd: process.cwd(),
    explicit: ctx.flags.repo,
    trackerRepo: await trackerRepo(ctx.db),
  });
}

/**
 * The refs to check for a target, each tagged with its NAMESPACE. `#<n>` / a URL is an issue; a bare value
 * is an ob item id. The other namespace is added ONLY when a link proves the two are the same ticket:
 * without that, `ob 75`'s merge is not evidence about gh#75, which is an unrelated open ticket.
 */
async function refsFor(ctx: Ctx, arg: string): Promise<{ refs: CheckedRef[]; itemId: string | null; issue: number | null }> {
  const repo = await trackerRepo(ctx.db);
  const refs: CheckedRef[] = [];
  let itemId: string | null = null;
  let issue: number | null = null;
  if (arg.startsWith("#") || arg.includes("://")) {
    const parsed = parseIssueArg(arg);
    issue = parsed.number;
    refs.push({ namespace: "issue", number: issue, via: "asked" });
    const linked = await itemForIssue(ctx.store, { repo: parsed.repo ?? repo, number: issue });
    if (linked) {
      itemId = linked.item_id;
      if (/^\d+$/.test(itemId)) refs.push({ namespace: "ob", number: Number(itemId), via: "link" });
    }
    return { refs, itemId, issue };
  }
  const item = await requireItem(ctx, arg);
  arg = item.id;
  itemId = item.id;
  if (/^\d+$/.test(itemId)) refs.push({ namespace: "ob", number: Number(itemId), via: "asked" });
  // 1949: the item's current ref and every alias a move left are the same ticket, so each is checked too.
  for (const r of await equivalentRefs(ctx.store, itemId)) {
    const m = ticketRefMention(r);
    if (m?.namespace === "ref") refs.push({ ...m, via: "asked" });
  }
  const link = await getIssueLink(ctx.store, itemId);
  if (link) {
    issue = link.number;
    refs.push({ namespace: "issue", number: issue, via: "link" });
  }
  return { refs, itemId, issue };
}

const ANSWER_HEADER: Record<LandedAnswer, string> = {
  landed: "ALREADY ON MAIN",
  "could-not-tell": "COULD NOT TELL",
  "no-evidence": "no evidence on main",
  "could-not-read": "COULD NOT READ",
};

/**
 * OB-1700: the line a bare number earns when the ticket shown under that number is another item. `1697` is
 * the internal item id; `OB-1697` is a different ticket once the two sequences drifted apart (id 1697 is
 * OB-1477, OB-1697 is id 2302), and the commits that name them (`(ob 1697)` vs `(OB-1697)`) are different
 * evidence. `rival` is the id the default-key ref `OB-<n>` resolves to; null when none. Pure.
 */
export function rivalRefNote(arg: string, rival: string | null): string | null {
  if (!/^\d+$/.test(arg) || rival === null || rival === arg) return null;
  return (
    `a bare number is the internal item id, so this checked item ${arg}; the ticket shown as ${DEFAULT_KEY}-${Number(arg)} ` +
    `is a different item (${rival}). If you meant that ticket, ask for it by its ref: 'ob issue landed ${DEFAULT_KEY}-${Number(arg)}'`
  );
}

/** The item id `OB-<n>` names, or null when no item holds that ref. */
async function itemOfDefaultRef(ctx: Ctx, n: string): Promise<string | null> {
  const ref = `${DEFAULT_KEY}-${Number(n)}`;
  const id = await resolveItemId(ctx.store ?? ctx.db, ref);
  return id === ref ? null : id;
}

export function renderLanded(report: LandedReport, target: string, linked: boolean, rivalNote: string | null = null): string {
  const lines: string[] = [];
  if (!report.readable) {
    lines.push(`${target}: COULD NOT READ ${report.checkout}`);
    lines.push(`  git error:  ${report.read_error ?? "unknown"}`);
    lines.push("  this is NOT 'no evidence': nothing was checked, so nothing can be concluded");
    return lines.join("\n");
  }
  lines.push(`${target}: ${ANSWER_HEADER[report.answer]}`);
  lines.push(`  checkout:    ${report.checkout} (${report.main})`);
  lines.push(`  checked as:  ${report.refs.length > 0 ? report.refs.join(", ") : "(nothing numeric to check)"}`);
  // Only the signals that actually produced evidence. Listing all four under an ALREADY ON MAIN header read
  // as "all four agree" when one had fired.
  lines.push(
    report.fired.length > 0
      ? `  signals hit: ${report.fired.join(", ")}  (of ${report.checked.join(", ")})`
      : `  signals hit: none (of ${report.checked.join(", ")})`,
  );
  for (const h of report.hits) lines.push(`  ${h.signal.padEnd(14)} ${h.ref}  ${h.detail}`);
  for (const a of report.ambiguous) lines.push(`  ambiguous:   ${a}`);
  if (report.clean) lines.push("  clean repo: subjects carry no ref, so only the spinoff row and the branch it recorded can answer");
  if (report.answer === "could-not-tell") {
    lines.push(
      "  this is NOT 'no evidence': the evidence above matches the NUMBER but not the numbering, so READ it " +
        "before dispatching, and fix the record (link the pair, or note which merge landed the item)",
    );
  }
  if (rivalNote) lines.push(`  note: ${rivalNote}`);
  if (!linked) {
    lines.push(
      "  note: only ONE numbering was checked (no ob<->issue link), and ob ids and issue numbers are " +
        "INDEPENDENT sequences: run 'ob issue reconcile' and link the pair for a two-sided check",
    );
  }
  if (report.landed) lines.push("  do NOT dispatch this without reading the merge first");
  return lines.join("\n");
}

async function cmdLink(ctx: Ctx): Promise<void> {
  let [itemArg, issueArg] = ctx.args.slice(1);
  if (!itemArg || !issueArg) throw new UsageError("issue link requires <item-id> <#n|url>");
  const item = await requireItem(ctx, itemArg);
  itemArg = item.id;
  const parsed = parseIssueArg(issueArg);
  const repo = parsed.repo ?? await trackerRepo(ctx.db);
  const clash = await issueClashMessage(ctx.store, { repo, number: parsed.number }, item.id);
  if (clash) throw new AppError(clash);
  const link = await linkIssue(ctx.store, item.id, { repo, number: parsed.number });
  if (ctx.mode === "json") print(JSON.stringify({ id: item.id, issue: link.number, url: link.url }));
  else if (ctx.mode === "quiet") print(item.id);
  else print(`ob ${item.id} <-> issue #${link.number}  ${link.url}`);
}

async function cmdUnlink(ctx: Ctx): Promise<void> {
  let itemArg = ctx.args[1];
  if (!itemArg) throw new UsageError("issue unlink requires an <item-id>");
  const item = await requireItem(ctx, itemArg);
  itemArg = item.id;
  const cleared = await clearRef(ctx.store, item.id);
  if (ctx.mode === "json") {
    print(
      JSON.stringify({
        id: item.id,
        unlinked: cleared?.kind === "issue" ? cleared.issue : null,
        cleared: cleared ? { kind: cleared.kind, url: cleared.url } : null,
      }),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(item.id);
    return;
  }
  if (!cleared) {
    print(`ob ${item.id} carries no reference to clear (nothing changed)`);
    return;
  }
  print(
    cleared.kind === "issue"
      ? `ob ${item.id} no longer linked to issue #${cleared.issue} (the item and everything attached to it is untouched)`
      : `ob ${item.id} no longer carries its Linear reference (${cleared.linear_id ?? "no id"} ${cleared.url}); ` +
          `nothing in Linear was touched, and the item and everything attached to it is untouched`,
  );
}

async function cmdList(ctx: Ctx): Promise<void> {
  const links = (await linkedItems(ctx.store)).sort((a, b) => a.ref.number - b.ref.number);
  if (ctx.mode === "json") {
    print(JSON.stringify(links.map((l) => ({ id: l.item_id, status: l.status, title: l.title, issue: l.ref.number, repo: l.ref.repo })), null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(links.map((l) => l.item_id).join("\n"));
    return;
  }
  if (links.length === 0) {
    print("No ob item is linked to a GitHub issue. Pair them with 'ob issue link <id> #<n>'.");
    return;
  }
  print(links.map((l) => `ob ${l.item_id}\t#${l.ref.number}\t${l.status}\t${l.title}`).join("\n"));
}

async function cmdLanded(ctx: Ctx): Promise<void> {
  const arg = ctx.args[1];
  if (!arg) throw new UsageError("issue landed requires an <item-id|#issue>");
  const { refs, itemId, issue } = await refsFor(ctx, arg);
  const state = await readRepoState(await checkoutFor(ctx), undefined, ctx.store);
  const report = landedIn(state, refs);
  const rivalNote = rivalRefNote(arg, /^\d+$/.test(arg) ? await itemOfDefaultRef(ctx, arg) : null);
  if (ctx.mode === "json") {
    print(JSON.stringify({ item: itemId, issue, ...report, ...(rivalNote ? { note: rivalNote } : {}) }, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(report.answer === "landed" ? "landed" : report.answer === "could-not-tell" ? "could-not-tell" : "not-landed");
    return;
  }
  print(renderLanded(report, arg, itemId !== null && issue !== null, rivalNote));
}

async function cmdReconcile(ctx: Ctx): Promise<void> {
  const repo = await trackerRepo(ctx.db);
  const issues = await listIssues(ctx.db, repo);
  const linked = new Set((await linkedItems(ctx.store)).map((l) => l.ref.number));
  const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 25;
  if (!Number.isFinite(limit) || limit <= 0) throw new UsageError(`invalid --limit '${ctx.flags.limit}'`);
  const candidates = candidatePairs(
    await unlinkedOpenItems(ctx.db),
    issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
    linked,
  ).slice(0, limit);
  if (ctx.mode === "json") {
    print(JSON.stringify({ repo, candidates }, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(candidates.map((c) => `${c.item_id} #${c.issue}`).join("\n"));
    return;
  }
  print(renderReconcile(repo, candidates));
}

export function renderReconcile(
  repo: string,
  candidates: Array<{
    item_id: string;
    item_status: string;
    item_title: string;
    issue: number;
    issue_state: string;
    issue_title: string;
    reasons: string[];
  }>,
): string {
  if (candidates.length === 0) return `No likely unlinked ob<->issue pairs in ${repo}.`;
  const lines = [`Candidate pairs in ${repo}, CONFIRM each by hand, nothing is linked automatically:`];
  for (const c of candidates) {
    lines.push(`  ob ${c.item_id} (${c.item_status})  ${c.item_title}`);
    lines.push(`    #${c.issue} (${c.issue_state})  ${c.issue_title}`);
    lines.push(`    why: ${c.reasons.join(" · ")}`);
    lines.push(`    link: ob issue link ${c.item_id} #${c.issue}`);
  }
  return lines.join("\n");
}

async function cmdDrift(ctx: Ctx): Promise<void> {
  const repo = await trackerRepo(ctx.db);
  const issues = await listIssues(ctx.db, repo);
  const rows = await computeDrift({
    checkout: await checkoutFor(ctx),
    trackerRepo: repo,
    issues,
    store: ctx.store,
  });
  if (ctx.mode === "json") {
    print(JSON.stringify({ repo, drift: rows }, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(rows.map((r) => `#${r.issue}`).join("\n"));
    return;
  }
  print(renderDrift(repo, rows));
}

export function renderDrift(
  repo: string,
  rows: Array<{ kind: string; issue: number; issue_title: string; item_id: string | null; detail: string }>,
): string {
  if (rows.length === 0) {
    return `No tracker drift: every open issue in ${repo} looks unbuilt, and every closed one has a closed ob item.`;
  }
  const landedRows = rows.filter((r) => r.kind === "issue-open-but-landed");
  const reverseRows = rows.filter((r) => r.kind === "issue-closed-but-item-open");
  const lines: string[] = [];
  if (landedRows.length > 0) {
    lines.push(`Open issues whose feature looks like it is already on main (${landedRows.length}):`);
    for (const r of landedRows) {
      lines.push(`  #${r.issue}  ${r.issue_title}${r.item_id ? `  (ob ${r.item_id})` : "  (no ob link)"}`);
      lines.push(`    ${r.detail}`);
      lines.push(`    close both: ob close ${r.item_id ?? "<id>"}   (or 'gh issue close ${r.issue}' when there is no ob item)`);
    }
  }
  if (reverseRows.length > 0) {
    lines.push(`Closed issues whose ob item is still open (${reverseRows.length}):`);
    for (const r of reverseRows) lines.push(`  #${r.issue}  ${r.issue_title}\n    ${r.detail}`);
  }
  return lines.join("\n");
}

const SUBS: Record<string, (ctx: Ctx) => void | Promise<void>> = {
  link: cmdLink,
  unlink: cmdUnlink,
  list: cmdList,
  landed: cmdLanded,
  reconcile: cmdReconcile,
  drift: cmdDrift,
};

export async function cmdIssue(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "list";
  const handler = SUBS[sub];
  if (!handler) {
    throw new UsageError(`unknown 'issue' subcommand '${sub}' (expected: ${Object.keys(SUBS).join(", ")})`);
  }
  await handler(ctx);
}
